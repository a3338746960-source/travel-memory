import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const jpgGpsReader = join(root, 'scripts/read-jpg-gps.py');
const pdfTextReader = join(root, 'scripts/extract-pdf-text.py');
const imageTextReader = join(root, 'scripts/extract-image-text.swift');

// --- Parse CLI args ---
const isCheck = process.argv.includes('--check');
const notesOnly = process.argv.includes('--notes-only');
const reuseMedia = process.argv.includes('--reuse-media');
const reverseGeocodeEnabled = process.argv.includes('--reverse-geocode');

function getArgValue(flag) {
  const idx = process.argv.indexOf(flag);
  return idx !== -1 && idx + 1 < process.argv.length ? process.argv[idx + 1] : null;
}

// --- Load trip config ---
let tripConfig = null;
const configPath = getArgValue('--config');
const tripId = getArgValue('--trip');

if (configPath) {
  tripConfig = JSON.parse(readFileSync(join(root, configPath), 'utf8'));
} else if (tripId) {
  const autoPath = join(root, 'trips', tripId, 'trip-config.json');
  if (existsSync(autoPath)) {
    tripConfig = JSON.parse(readFileSync(autoPath, 'utf8'));
  }
}

// Config-driven or fallback paths
const mediaDir = tripConfig ? join(root, tripConfig.sourceDirs.media) : join(root, 'public/raw/iphone-media');
const vlogDir = tripConfig ? join(root, tripConfig.sourceDirs.vlog) : join(root, 'public/raw/vlog');
const receiptDir = tripConfig
  ? join(root, tripConfig.sourceDirs.receipts || tripConfig.sourceDirs.orders)
  : join(root, 'public/raw/receipts');
const previewDir = tripConfig?.generatedDirs?.previews
  ? join(root, tripConfig.generatedDirs.previews)
  : tripId
    ? join(root, 'trips', tripId, 'generated', 'previews')
    : join(root, 'public/generated/previews');
const notesPath = tripConfig
  ? join(root, tripConfig.outputPaths.notes)
  : join(root, 'data/manual-notes/trip-notes.json');
const geocodingCachePath = tripConfig
  ? join(root, tripConfig.outputPaths.geocodingCache)
  : join(root, 'data/geocoding-cache.json');
const outputPath = tripConfig
  ? join(root, tripConfig.outputPaths.tripData)
  : join(root, 'public/data/trip-data.json');
const compatOutputPath = tripConfig?.outputPaths?.compatTripData
  ? join(root, tripConfig.outputPaths.compatTripData)
  : null;
const outputDir = join(root, relative(root, outputPath).split('/').slice(0, -1).join('/'));

// Config values
const timezoneOffsetMs = (tripConfig?.timezoneOffsetHours ?? 0) * 60 * 60 * 1000;
const dateRangeStart = tripConfig?.dateRange?.[0] ?? '2000-01-01';
const dateRangeEnd = tripConfig?.dateRange?.[1] ?? '2099-12-31';
const defaultPlaceName = tripConfig?.defaultPlaceName ?? '旅行地点';
const tripTitle = tripConfig?.title ?? '旅行';
const tripSubtitle = tripConfig?.subtitle ?? '';
const geocodeLanguages = tripConfig?.geocodeLanguages ?? 'zh-CN,zh,en';

// Load POI anchors from config or use empty
let POI_ANCHORS = [];
if (Array.isArray(tripConfig?.poiAnchors)) {
  POI_ANCHORS = tripConfig.poiAnchors;
} else if (tripConfig?.poiAnchors || tripConfig?.poiAnchorsPath) {
  const poiPath = join(root, tripConfig.poiAnchorsPath || tripConfig.poiAnchors);
  if (existsSync(poiPath)) {
    POI_ANCHORS = JSON.parse(readFileSync(poiPath, 'utf8'));
  }
}

// Load city regions from config
const cityRegions = tripConfig?.cityRegions ?? [];

const checkSampleRatio = 0.1;
const TARGET_PLACES_PER_DAY = 15;
const GEOCODE_DELAY_MS = 1100;
const GEOCODE_USER_AGENT = 'travel-memory-map/0.1 contact:local-codex-project';

const imageExts = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif']);
const videoExts = new Set(['.mov', '.mp4', '.m4v']);
const geocodingCache = readJsonFile(geocodingCachePath, {});
let lastGeocodeRequestAt = 0;

// --- Order/Receipt scanning ---

const LODGING_KEYWORDS = ['入住凭证', '入住时间', '退房时间', '酒店', 'hotel', '住宿', 'check-in', 'check-out', '房型', '客房'];
const TRANSPORT_KEYWORDS = ['航班', '机票', '火车', '高铁', '新干线', '巴士', '客车', '车票', '登机', '出发时间', '到达时间', 'flight', 'train', 'bus', 'departure', 'arrival'];
const TICKET_KEYWORDS = ['门票', '入场券', '预约', '参观', '景区', '博物馆', '展览', 'ticket', 'admission', 'reservation'];

function scanOrderDirectory(dir) {
  if (!existsSync(dir)) return [];
  const paths = walk(dir);
  const selectedPaths = isCheck ? samplePaths(paths, checkSampleRatio) : paths;
  return selectedPaths
    .map((path) => {
      const ext = extname(path).toLowerCase();
      if (basename(path).startsWith('.')) return null;
      if (!imageExts.has(ext) && ext !== '.pdf') return null;
      try {
        return parseOrderFile(path);
      } catch (error) {
        console.warn(`Could not parse order ${relative(root, path)}: ${error.message}`);
        return null;
      }
    })
    .filter(Boolean);
}

function parseOrderFile(path) {
  const ext = extname(path).toLowerCase();
  let rawText = '';
  if (ext === '.pdf') {
    rawText = readPdfText(path) || '';
  } else if (imageExts.has(ext)) {
    rawText = readImageText(path) || '';
  }

  const text = normalizeRepeatedText(rawText);
  const fileName = basename(path);
  const category = classifyOrderType(text);
  // Use file modification year as fallback for dates without year
  const fileYear = String(new Date(statSync(path).mtime).getFullYear());

  let event;
  switch (category) {
    case 'lodging': event = parseLodgingEvent(text, fileName, fileYear); break;
    case 'transport': event = parseTransportEvent(text, fileName); break;
    case 'ticket': event = parseTicketEvent(text, fileName); break;
    default: event = {
      category: 'other',
      title: `未分类订单：${titleFromFilename(path)}`,
      startAt: extractEventDate(text) || fallbackDateFromName(path) || null,
      endAt: null,
      summary: `未分类订单：${fileName}`
    };
  }

  const startAt = event.startAt;
  const dayId = startAt ? `day-${tripDateFromCapturedAt(startAt)}` : null;

  return {
    id: slug(`event-${fileName}`),
    ...event,
    dayId,
    sourceFileName: fileName,
    rawText
  };
}

function classifyOrderType(text) {
  const lower = text.toLowerCase();
  if (LODGING_KEYWORDS.some((kw) => lower.includes(kw))) return 'lodging';
  if (TRANSPORT_KEYWORDS.some((kw) => lower.includes(kw))) return 'transport';
  if (TICKET_KEYWORDS.some((kw) => lower.includes(kw))) return 'ticket';
  return 'other';
}

function parseLodgingEvent(text, fileName, defaultYear) {
  const checkIn = extractEventDate(text, null, defaultYear);
  const checkOut = checkIn ? extractEventDateAfter(text, checkIn) : null;

  const title = extractLodgingTitle(text) || '住宿';
  const address = extractField(text, ['地址', 'address']);
  const orderNumber = extractField(text, ['订单号', 'order']);
  const confirmationNumber = extractField(text, ['确号', '确认号', 'confirmation']);

  const numDays = checkIn && checkOut
    ? Math.round((new Date(checkOut) - new Date(checkIn)) / 86400000)
    : null;

  return {
    category: 'lodging',
    title,
    startAt: checkIn ? `${checkIn}T15:00:00` : null,
    endAt: checkOut ? `${checkOut}T11:00:00` : null,
    provider: title,
    locationName: title,
    address: address || null,
    orderNumber: orderNumber || null,
    confirmationNumber: confirmationNumber || null,
    summary: `住宿：${title}${checkIn ? `，${checkIn} 入住` : ''}${checkOut ? `，${checkOut} 退房` : ''}${numDays ? `，${numDays} 晚` : ''}。`
  };
}

function parseTransportEvent(text, fileName) {
  const { departureDate, arrivalDate } = extractTransportDates(text);

  const provider = extractTransportProvider(text) || '交通';
  const departureFrom = extractField(text, ['出发', '始发', 'from', 'departure']);
  const arrivalTo = extractField(text, ['到达', '目的', 'to', 'arrival']);
  const orderNumber = extractField(text, ['订单号', 'order']);

  return {
    category: 'transport',
    title: `${provider}${departureFrom ? ` ${departureFrom}` : ''}${arrivalTo ? `→${arrivalTo}` : ''}`,
    startAt: departureDate ? `${departureDate}T09:00:00` : null,
    endAt: arrivalDate ? `${arrivalDate}T18:00:00` : null,
    provider,
    locationName: [departureFrom, arrivalTo].filter(Boolean).join(' → ') || null,
    address: null,
    orderNumber: orderNumber || null,
    confirmationNumber: null,
    summary: `交通：${provider}${departureDate ? `，${departureDate} 出发` : ''}${departureFrom ? `，${departureFrom}` : ''}${arrivalTo ? ` → ${arrivalTo}` : ''}。`
  };
}

function parseTicketEvent(text, fileName) {
  const eventDate = extractEventDate(text);
  const title = extractTicketTitle(text) || '门票';
  const locationName = extractField(text, ['景区', '景点', '场馆', 'venue']);
  const orderNumber = extractField(text, ['订单号', 'order']);

  return {
    category: 'ticket',
    title,
    startAt: eventDate ? `${eventDate}T09:00:00` : null,
    endAt: null,
    provider: title,
    locationName: locationName || title,
    address: null,
    orderNumber: orderNumber || null,
    confirmationNumber: null,
    summary: `门票：${title}${eventDate ? `，${eventDate}` : ''}。`
  };
}

// --- Text extraction helpers ---

function extractEventDate(text, skipPrefix, defaultYear) {
  if (!text) return null;
  let searchFrom = 0;
  if (skipPrefix) {
    const prefixIdx = text.search(skipPrefix);
    if (prefixIdx !== -1) {
      // Find end of the line containing the prefix, search after it
      const lineEnd = text.indexOf('\n', prefixIdx);
      searchFrom = lineEnd !== -1 ? lineEnd + 1 : prefixIdx + skipPrefix.source.length;
    }
  }
  // Try full date: YYYY年M月D日
  const dateRe = /(\d{4})[ \t]*[年\/\-.][ \t]*(\d{1,2})[ \t]*[月\/\-.][ \t]*(\d{1,2})[ \t]*日?/g;
  let match;
  while ((match = dateRe.exec(text)) !== null) {
    if (match.index < searchFrom) continue;
    const year = match[1];
    const month = match[2].padStart(2, '0');
    const day = match[3].padStart(2, '0');
    if (Number(year) < 2000 || Number(year) > 2099) continue;
    return `${year}-${month}-${day}`;
  }
  // Fallback: try no-year pattern M月D日 with defaultYear
  if (defaultYear) {
    const noYearRe = /(\d{1,2})\s*月\s*(\d{1,2})\s*日/g;
    while ((match = noYearRe.exec(text)) !== null) {
      if (match.index < searchFrom) continue;
      const month = match[1].padStart(2, '0');
      const day = match[2].padStart(2, '0');
      return `${defaultYear}-${month}-${day}`;
    }
  }
  return null;
}

function extractEventDateAfter(text, firstDate) {
  if (!text || !firstDate) return null;
  const [year, month] = firstDate.split('-');
  // Search for the first date in various formats
  const searchPatterns = [
    `${year}年${Number(month)}月`,
    `${year}-${month}`,
    `${year}/${month}`
  ];
  let firstIdx = -1;
  let matchLen = 0;
  for (const pat of searchPatterns) {
    const idx = text.indexOf(pat);
    if (idx !== -1 && (firstIdx === -1 || idx < firstIdx)) {
      firstIdx = idx;
      matchLen = pat.length;
    }
  }
  if (firstIdx === -1) return null;
  return extractEventDate(text.slice(firstIdx + matchLen));
}

function extractTransportDates(text) {
  if (!text) return { departureDate: null, arrivalDate: null };
  const dateRe = /(\d{4})[ \t]*[年\/\-.][ \t]*(\d{1,2})[ \t]*[月\/\-.][ \t]*(\d{1,2})[ \t]*日?/g;
  const candidates = [];
  let match;
  while ((match = dateRe.exec(text)) !== null) {
    const year = match[1];
    const month = match[2].padStart(2, '0');
    const day = match[3].padStart(2, '0');
    if (Number(year) < 2000 || Number(year) > 2099) continue;
    const restOfLine = text.slice(match.index + match[0].length).split('\n')[0];
    // Skip dates with time on the same line (order timestamps like "2026-5-20 11:10")
    const hasTimeOnSameLine = /\d{1,2}:\d{2}/.test(restOfLine);
    // Check if the NEXT line (not same line) is a time pattern (travel time like "22:20")
    const afterLine = text.slice(match.index + match[0].length + restOfLine.length);
    const nextLine = afterLine.split('\n').find((l) => l.trim());
    const hasTimeOnNextLine = nextLine && /^\d{1,2}:\d{2}$/.test(nextLine.trim());
    candidates.push({ date: `${year}-${month}-${day}`, hasTimeOnSameLine, hasTimeOnNextLine });
  }
  // Prefer dates that have time on the next line but NOT on the same line (travel dates)
  const travelDates = candidates.filter((c) => c.hasTimeOnNextLine && !c.hasTimeOnSameLine);
  const pool = travelDates.length >= 1 ? travelDates : candidates;
  return {
    departureDate: pool[0]?.date || null,
    arrivalDate: pool[1]?.date || null
  };
}

function extractField(text, keys) {
  if (!text) return null;
  for (const key of keys) {
    const re = new RegExp(key + '[：:\\s]+(.+)');
    const match = text.match(re);
    if (match) return match[1].trim().split('\n')[0].trim();
  }
  return null;
}

function extractLodgingTitle(text) {
  if (!text) return null;
  const lines = text.split('\n').filter((l) => l.trim());
  // Strategy 1: find line right before "酒店详情" or "酒店确认函"
  for (let i = 1; i < lines.length; i++) {
    if (/酒店详情|酒店确认函/.test(lines[i])) {
      const candidate = lines[i - 1].trim();
      if (candidate && /[一-龥]{2,}/.test(candidate) && candidate.length < 30) {
        return candidate;
      }
    }
  }
  // Strategy 2: scan for hotel name line
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^[地址电话入住退房订单确认价格包含增值税可住房间餐食房型取消联系在线]/.test(trimmed)) continue;
    if (/入住凭证|入住时间|退房时间|晚数|周[一二三四五六日]/.test(trimmed)) continue;
    if (/酒店当地时间|价格详情|在线付|已支付|包含：|可入住|房间信息|房型设施|取消政策|联系我们/.test(trimmed)) continue;
    if (/携程|去哪儿|飞猪|美团|booking|agoda|trip\.com/i.test(trimmed)) continue;
    if (/距本酒店|¥\d+|\d+分[超很还]|起$/.test(trimmed)) continue;
    if (/[⋯…]$/.test(trimmed)) continue;
    if (trimmed.length < 3) continue;
    if (/^[Cc¢]\s*[一-龥]/.test(trimmed)) continue;
    if (/[一-龥]{2,}/.test(trimmed) && trimmed.length < 30 && !/^[地址：]/.test(trimmed)) {
      return trimmed;
    }
  }
  return null;
}

function extractTransportProvider(text) {
  if (!text) return null;
  // Specific airline/rail names first, generic terms last
  const providers = [
    'JR', 'ANA', 'JAL', '春秋航空', '全日空', '东海道', '新干线',
    '西部航空', '南方航空', '东方航空', '国际航空', '海南航空', '厦门航空',
    '深圳航空', '四川航空', '山东航空', '吉祥航空', '华夏航空', '长龙航空',
    '新海航', '海航', '南航', '东航', '国航',
    '巴士', '航班'
  ];
  for (const p of providers) {
    if (text.includes(p)) return p;
  }
  return null;
}

function extractTicketTitle(text) {
  if (!text) return null;
  const match = text.match(/(?:门票|入场券|预约|景点)[：:\s]*(.+)/);
  if (match) return match[1].trim().split('\n')[0].trim();
  const lines = text.split('\n').filter((l) => l.trim());
  for (const line of lines.slice(0, 5)) {
    if (/[一-龥]{2,}/.test(line) && !/门票|价格|订单|时间/.test(line)) {
      return line.trim();
    }
  }
  return null;
}

function normalizeRepeatedText(text) {
  if (!text) return '';
  const lines = text.split('\n');
  return lines.map((line) => {
    if (line.length < 4) return line;
    // Split by whitespace into segments, dedup each segment independently
    const segments = line.split(/(\s+)/);
    return segments.map((seg) => {
      if (seg.length < 4 || seg.length % 2 !== 0 || /^\s+$/.test(seg)) return seg;
      // Only dedup if majority of chars are CJK (avoid mangling ASCII codes)
      const cjkCount = (seg.match(/[一-龥]/g) || []).length;
      const digitCount = (seg.match(/\d/g) || []).length;
      if (cjkCount === 0 && digitCount > 2) return seg;
      let result = '';
      for (let i = 0; i < seg.length; i += 2) {
        if (seg[i] !== seg[i + 1]) return seg;
        result += seg[i];
      }
      return result;
    }).join('');
  }).join('\n');
}

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function matchConfiguredPoi(location) {
  if (!location || !POI_ANCHORS.length) return null;
  const { lat, lng } = location;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const rankedAnchors = POI_ANCHORS
    .map((anchor) => ({
      anchor,
      distance: haversineDistance(lat, lng, anchor.lat, anchor.lng)
    }))
    .sort((a, b) => a.distance - b.distance);

  const match = rankedAnchors.find(({ anchor, distance }) => distance <= anchor.threshold);
  if (!match) return null;
  return {
    name: match.anchor.name,
    note: match.anchor.note,
    lat: match.anchor.lat,
    lng: match.anchor.lng,
    distance: match.distance
  };
}

const notes = readTripNotes();
const baseData = (notesOnly || reuseMedia) ? readExistingTripData() : null;

// Safety: if source dir is empty but existing data has media, force reuse
const scannedMedia = [
  ...scanDirectory(mediaDir, classifyMedia),
  ...scanDirectory(vlogDir, () => 'vlog', { datePriority: 'filename' })
];
const hasSourceFiles = scannedMedia.length > 0;
let existingData = null;
try { existingData = readExistingTripData(); } catch { /* no existing data */ }
const hasExistingMedia = (baseData?.media?.length || existingData?.media?.length) > 0;
const effectiveReuseMedia = reuseMedia || (!hasSourceFiles && hasExistingMedia);
const effectiveBaseData = effectiveReuseMedia ? (baseData || existingData) : baseData;

const media = normalizeMediaDayIds(effectiveBaseData?.media) || scannedMedia
  .sort((a, b) => new Date(a.capturedAt || 0) - new Date(b.capturedAt || 0));

// Orders/receipts → structured events (not media)
const events = (notesOnly && effectiveBaseData?.events) ? effectiveBaseData.events : scanOrderDirectory(receiptDir);

const days = await applyTripNotes(buildDays(media), notes, events);
const tripMeta = {
  ...(effectiveBaseData?.trip || {}),
  id: tripConfig?.id ?? effectiveBaseData?.trip?.id,
  title: tripConfig?.title ?? effectiveBaseData?.trip?.title ?? tripTitle,
  subtitle: tripConfig?.subtitle ?? effectiveBaseData?.trip?.subtitle ?? tripSubtitle,
  dateRange: tripConfig?.dateRange ?? effectiveBaseData?.trip?.dateRange,
  timezoneOffsetHours: tripConfig?.timezoneOffsetHours ?? effectiveBaseData?.trip?.timezoneOffsetHours ?? 0,
  defaultMapCenter: tripConfig?.defaultMapCenter ?? effectiveBaseData?.trip?.defaultMapCenter,
  defaultPlaceName: tripConfig?.defaultPlaceName ?? effectiveBaseData?.trip?.defaultPlaceName ?? defaultPlaceName,
  assetBaseUrl: tripConfig?.assetBaseUrl ?? effectiveBaseData?.trip?.assetBaseUrl,
  generatedAt: new Date().toISOString()
};
const data = {
  trip: tripMeta,
  days,
  media,
  events
};

if (!isCheck) {
  mkdirSync(outputDir, { recursive: true });
  mkdirSync(join(root, 'data'), { recursive: true });
  writeFileSync(geocodingCachePath, `${JSON.stringify(geocodingCache, null, 2)}\n`);
  writeFileSync(outputPath, `${JSON.stringify(data, null, 2)}\n`);
  if (compatOutputPath) {
    const compatDir = join(root, relative(root, compatOutputPath).split('/').slice(0, -1).join('/'));
    mkdirSync(compatDir, { recursive: true });
    writeFileSync(compatOutputPath, `${JSON.stringify(data, null, 2)}\n`);
    console.log(`Compat: ${relative(root, compatOutputPath)}`);
  }
}

console.log(`${isCheck ? 'Checked' : 'Generated'} ${relative(root, outputPath)}`);
console.log(`Media: ${media.length}`);
console.log(`Days: ${days.length}`);
console.log(`GPS places: ${days.reduce((sum, day) => sum + day.places.length, 0)}`);
console.log(`Events: ${events.length}`);

function scanDirectory(dir, classifier, options = {}) {
  if (!existsSync(dir)) return [];
  const paths = walk(dir);
  const selectedPaths = isCheck ? samplePaths(paths, checkSampleRatio) : paths;
  return selectedPaths
    .map((path) => {
      const type = classifier(path);
      if (!type) return null;
      const ext = extname(path).toLowerCase();
      const metadata = readMetadata(path, { allowSipsDate: type !== 'receipt' });
      const text = type === 'document' ? readPdfText(path) : null;
      let capturedAt;
      if (options.datePriority === 'filename') {
        capturedAt = fallbackDateFromName(path) || metadata.date || inferDateFromText(text);
      } else if (options.datePriority === 'text') {
        capturedAt = inferDateFromText(text) || fallbackDateFromName(path) || metadata.date;
      } else {
        capturedAt = metadata.date || fallbackDateFromName(path) || inferDateFromText(text);
      }
      if (capturedAt && (capturedAt < dateRangeStart || capturedAt > dateRangeEnd)) {
        console.warn(`Skipping ${path}: date ${capturedAt} outside trip window`);
        return null;
      }
      const src = browserSrcFor(path, ext);
      return {
        id: slug(`${type}-${relative(root, path)}`),
        type,
        title: titleFromFilename(path),
        src,
        originalSrc: src === relativeBrowserPath(path) ? undefined : relativeBrowserPath(path),
        capturedAt,
        dayId: capturedAt ? `day-${tripDateFromCapturedAt(capturedAt)}` : null,
        location: metadata.location,
        text
      };
    })
    .filter(Boolean);
}

function samplePaths(paths, ratio) {
  if (paths.length <= 20) return paths;
  const step = Math.max(1, Math.floor(1 / ratio));
  return paths.filter((_, index) => index % step === 0).slice(0, 60);
}

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    return entry.isDirectory() ? walk(path) : [path];
  });
}

function classifyMedia(path) {
  if (basename(path).startsWith('.')) return null;
  const ext = extname(path).toLowerCase();
  if (imageExts.has(ext)) return 'photo';
  if (videoExts.has(ext)) return 'video';
  return null;
}

function classifyReceipt(path) {
  if (basename(path).startsWith('.')) return null;
  const ext = extname(path).toLowerCase();
  if (imageExts.has(ext)) return 'receipt';
  if (ext === '.pdf') return 'document';
  return null;
}

function browserSrcFor(path, ext) {
  if (['.heic', '.heif'].includes(ext)) {
    return ensureJpegPreview(path);
  }
  return relativeBrowserPath(path);
}

function relativeBrowserPath(path) {
  return `./${relative(root, path).replaceAll('\\', '/')}`;
}

const MIN_PREVIEW_BYTES = 10000;

function isBrokenPreview(previewPath) {
  try {
    if (readFileSync(previewPath).length < MIN_PREVIEW_BYTES) return true;
    const info = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', previewPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000
    });
    const width = Number(info.match(/pixelWidth:\s*(\d+)/)?.[1]);
    const height = Number(info.match(/pixelHeight:\s*(\d+)/)?.[1]);
    return !Number.isFinite(width) || !Number.isFinite(height) || width < 32 || height < 32;
  } catch {
    return true;
  }
}

function ensureJpegPreview(path) {
  const rel = relative(root, path).replaceAll('\\', '/');
  const previewPath = join(previewDir, `${slug(rel)}.jpg`);
  const alreadyGood = existsSync(previewPath) && !isBrokenPreview(previewPath);
  if (!alreadyGood && !isCheck) {
    mkdirSync(previewDir, { recursive: true });
    try {
      execFileSync('sips', ['-s', 'format', 'jpeg', '-Z', '1600', path, '--out', previewPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: 15000
      });
    } catch (error) {
      console.warn(`Could not create preview for ${relative(root, path)}: ${error.message}`);
      return relativeBrowserPath(path);
    }
  }
  return relativeBrowserPath(previewPath);
}

function readMetadata(path, options = {}) {
  const { allowSipsDate = true } = options;
  const ext = extname(path).toLowerCase();
  try {
    const output = execFileSync('mdls', [
      '-raw',
      '-name', 'kMDItemContentCreationDate',
      '-name', 'kMDItemLatitude',
      '-name', 'kMDItemLongitude',
      path
    ], { encoding: 'utf8', timeout: 1500 });
    const parts = output.trim().split(/\0|\n/);
    const dateRaw = parts[0];
    const latRaw = parts[1];
    const lngRaw = parts[2];
    const date = normalizeDate(dateRaw);
    const lat = Number.parseFloat(latRaw);
    const lng = Number.parseFloat(lngRaw);
    return {
      date: date || (allowSipsDate ? readSipsCreation(path) : null),
      location: Number.isFinite(lat) && Number.isFinite(lng)
        ? { lat, lng }
        : readJpgGps(path, ext)
    };
  } catch {
    return {
      date: allowSipsDate ? readSipsCreation(path) : null,
      location: readJpgGps(path, ext)
    };
  }
}

function normalizeDate(raw) {
  if (!raw || raw === '(null)') return null;
  const normalized = raw.replace(' +0000', 'Z').replace(' ', 'T');
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function readSipsCreation(path) {
  try {
    const output = execFileSync('sips', ['-g', 'creation', path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const match = output.match(/creation:\s*(.+)/);
    const value = match?.[1]?.trim();
    if (!value || value === '<nil>') return null;
    const parsed = value.match(/(\d{4}):(\d{2}):(\d{2})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (!parsed) return null;
    return `${parsed[1]}-${parsed[2]}-${parsed[3]}T${parsed[4]}:${parsed[5]}:${parsed[6]}`;
  } catch {
    return null;
  }
}

function readJpgGps(path, ext) {
  if (!['.jpg', '.jpeg'].includes(ext) || !existsSync(jpgGpsReader)) return null;
  try {
    const output = execFileSync('python3', [jpgGpsReader, path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return output ? JSON.parse(output) : null;
  } catch {
    return null;
  }
}

function readPdfText(path) {
  if (!existsSync(pdfTextReader)) return null;
  try {
    const output = execFileSync('python3', [pdfTextReader, path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return output || null;
  } catch {
    return null;
  }
}

function readImageText(path) {
  if (!existsSync(imageTextReader)) return null;
  try {
    const output = execFileSync('swift', [imageTextReader, path], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 30000 }).trim();
    return output || null;
  } catch {
    return null;
  }
}

function fallbackDateFromName(path) {
  const match = basename(path).match(/(20\d{2})[-_.]?([01]?\d)[-_.]?([0-3]?\d)/);
  if (!match) return null;
  const month = match[2].padStart(2, '0');
  const day = match[3].padStart(2, '0');
  return `${match[1]}-${month}-${day}T12:00:00`;
}

function inferDateFromText(text) {
  if (!text) return null;
  const match = text.match(/([0-9]{4,8})[年\/\-.]+\s*([0-9]{1,4})[月\/\-.]+\s*([0-9]{1,4})/);
  if (!match) return null;
  const year = normalizeRepeatedDigits(match[1]);
  const month = normalizeRepeatedDigits(match[2]).padStart(2, '0');
  const day = normalizeRepeatedDigits(match[3]).padStart(2, '0');
  return year.length === 4 ? `${year}-${month}-${day}T12:00:00` : null;
}

function normalizeRepeatedDigits(value) {
  if (value.length % 2 !== 0) return value;
  let compact = '';
  for (let index = 0; index < value.length; index += 2) {
    if (value[index] !== value[index + 1]) return value;
    compact += value[index];
  }
  return compact;
}

function buildDays(items) {
  const grouped = new Map();
  for (const item of items) {
    if (!item.dayId) continue;
    const date = item.dayId.replace(/^day-/, '');
    if (!grouped.has(item.dayId)) {
      grouped.set(item.dayId, {
        id: item.dayId,
        date,
        title: `${formatShortDate(date)} 的旅程`,
        city: inferCity(item.location),
        summary: '由 iPhone 拍摄时间与 GPS 自动生成，稍后可以按 vlog 内容补一句概况。',
        route: [],
        memoryTags: [],
        places: [],
        media: [],
        _gpsCandidates: []
      });
    }
    const day = grouped.get(item.dayId);
    day.media.push(item.id);
    if (item.location) {
      day._gpsCandidates.push({
        location: item.location,
        capturedAt: item.capturedAt,
        mediaId: item.id
      });
      day.city = inferCity(item.location);
    }
  }
  return [...grouped.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function tripDateFromCapturedAt(capturedAt) {
  if (!capturedAt) return null;
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(capturedAt)) {
    const timestamp = Date.parse(capturedAt);
    if (!Number.isNaN(timestamp)) {
      return new Date(timestamp + timezoneOffsetMs).toISOString().slice(0, 10);
    }
  }
  return capturedAt.slice(0, 10);
}

function readTripNotes() {
  if (!existsSync(notesPath)) return { days: {} };
  try {
    return JSON.parse(readFileSync(notesPath, 'utf8'));
  } catch (error) {
    console.warn(`Could not parse ${relative(root, notesPath)}: ${error.message}`);
    return { days: {} };
  }
}

function readExistingTripData() {
  if (!existsSync(outputPath)) {
    throw new Error('Cannot apply notes only before public/data/trip-data.json exists. Run npm run import:media first.');
  }
  return JSON.parse(readFileSync(outputPath, 'utf8'));
}

function normalizeMediaDayIds(items) {
  if (!items) return null;
  return items.map((item) => ({
    ...item,
    dayId: item.capturedAt ? `day-${tripDateFromCapturedAt(item.capturedAt)}` : item.dayId
  }));
}

async function applyTripNotes(days, notes, events) {
  const dayNotes = notes.days || {};

  // Build event lookup by dayId
  const eventsByDay = new Map();
  for (const event of events) {
    if (!event.dayId) continue;
    if (!eventsByDay.has(event.dayId)) eventsByDay.set(event.dayId, []);
    eventsByDay.get(event.dayId).push(event.id);
  }

  const enrichedDays = [];
  for (const day of days) {
    const note = dayNotes[day.date] || {};
    const places = await buildDensePlaces(day);
    const route = note.route?.length ? note.route : places.map((place) => place.name);
    const { _gpsCandidates, ...cleanDay } = day;
    enrichedDays.push({
      ...cleanDay,
      title: note.title || day.title,
      city: note.city || day.city,
      summary: note.summary || day.summary,
      route,
      memoryTags: note.memoryTags || day.memoryTags,
      places,
      events: eventsByDay.get(day.id) || []
    });
  }
  return enrichedDays;
}

async function buildDensePlaces(day) {
  const candidates = [...(day._gpsCandidates || [])]
    .sort((a, b) => (a.capturedAt || '').localeCompare(b.capturedAt || ''));
  const sampledCandidates = candidates.length >= TARGET_PLACES_PER_DAY
    ? sampleEvenly(candidates, TARGET_PLACES_PER_DAY)
    : candidates;

  const places = [];
  for (const [index, candidate] of sampledCandidates.entries()) {
    const enriched = await enrichGpsPlace(candidate.location, day, index, sampledCandidates);
    places.push({
      id: slug(`${day.date}-gps-${index + 1}`),
      name: enriched.displayName,
      displayName: enriched.displayName,
      lat: candidate.location.lat,
      lng: candidate.location.lng,
      note: enriched.displayNote,
      displayNote: enriched.displayNote,
      source: 'gps',
      geoSource: enriched.geoSource,
      nearbyLandmark: enriched.nearbyLandmark,
      capturedAt: candidate.capturedAt,
      mediaId: candidate.mediaId
    });
  }

  return places;
}

function sampleEvenly(items, count) {
  if (items.length <= count) return items;
  const result = [];
  for (let i = 0; i < count; i++) {
    const index = Math.round(i * (items.length - 1) / (count - 1));
    result.push(items[index]);
  }
  return result;
}

async function enrichGpsPlace(location, day, placeIndex, candidates) {
  const fallback = buildFallbackPlaceInfo(location, day, placeIndex, candidates);
  if (!location || !Number.isFinite(location.lat) || !Number.isFinite(location.lng)) {
    return fallback;
  }

  const key = geocodeCacheKey(location);
  const cachedGeocode = geocodingCache[key] || null;
  if (cachedGeocode) {
    const cachedInfo = selectMapPlaceInfo(cachedGeocode, location);
    if (cachedInfo) return buildEnrichedPlace(cachedInfo, location, day, placeIndex, candidates, 'reverse-cache');
  }

  if (!isCheck && reverseGeocodeEnabled) {
    const geocode = await reverseGeocode(location);
    const mapInfo = selectMapPlaceInfo(geocode, location);
    if (mapInfo) return buildEnrichedPlace(mapInfo, location, day, placeIndex, candidates, 'reverse-geocoded');
  }

  const configuredPoi = buildConfiguredPoiPlaceInfo(location);
  if (configuredPoi) return buildEnrichedPlace(configuredPoi, location, day, placeIndex, candidates, 'configured-poi');

  return fallback;
}

function buildEnrichedPlace(mapInfo, location, day, placeIndex, candidates, geoSource) {
  const displayName = makeUniqueName(
    mapInfo.name,
    day,
    placeIndex,
    candidates,
    location
  );
  return {
    displayName,
    displayNote: buildPlaceNote({
      displayName,
      location,
      day,
      placeIndex,
      candidates,
      mapInfo
    }),
    geoSource,
    nearbyLandmark: mapInfo.landmark || mapInfo.name
  };
}

function buildFallbackPlaceInfo(location, day, placeIndex, candidates) {
  const regionName = inferCity(location);
  const baseName = regionName && regionName !== defaultPlaceName ? `${regionName}区域` : defaultPlaceName;
  const displayName = makeUniqueName(baseName, day, placeIndex, candidates, location);
  return {
    displayName,
    displayNote: buildPlaceNote({
      displayName,
      location,
      day,
      placeIndex,
      candidates,
      mapInfo: {
        name: baseName,
        kind: regionName,
        source: 'region-fallback',
        typeLabel: '真实坐标'
      }
    }),
    geoSource: 'region-fallback',
    nearbyLandmark: null
  };
}

function buildConfiguredPoiPlaceInfo(location) {
  const matched = matchConfiguredPoi(location);
  if (!matched) return null;
  return {
    name: matched.name,
    landmark: matched.name,
    note: matched.note,
    city: inferCity(location),
    typeLabel: '配置地点',
    source: 'configured-poi'
  };
}

async function reverseGeocode(location) {
  const key = geocodeCacheKey(location);
  if (geocodingCache[key]) return geocodingCache[key];

  await waitForGeocodeSlot();
  const params = new URLSearchParams({
    format: 'jsonv2',
    lat: String(location.lat),
    lon: String(location.lng),
    zoom: '18',
    addressdetails: '1',
    namedetails: '1',
    extratags: '1',
    accept_language: geocodeLanguages
  });
  const url = `https://nominatim.openstreetmap.org/reverse?${params}`;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    const response = await fetch(url, {
      headers: { 'User-Agent': GEOCODE_USER_AGENT },
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const json = await response.json();
    geocodingCache[key] = normalizeGeocodeResult(json);
  } catch (error) {
    // Don't cache errors - allow retry on next run
    console.warn(`Reverse geocoding failed for ${key}: ${error.message}`);
  }

  return geocodingCache[key];
}

async function waitForGeocodeSlot() {
  const now = Date.now();
  const wait = Math.max(0, GEOCODE_DELAY_MS - (now - lastGeocodeRequestAt));
  if (wait) await new Promise((resolve) => setTimeout(resolve, wait));
  lastGeocodeRequestAt = Date.now();
}

function geocodeCacheKey(location) {
  // Round to ~100m precision to deduplicate nearby GPS points
  return `${location.lat.toFixed(3)},${location.lng.toFixed(3)}`;
}

function normalizeGeocodeResult(json) {
  const normalized = buildNormalizedGeocodeFields(json);
  return {
    fetchedAt: new Date().toISOString(),
    geocodeLanguages,
    osmType: json.osm_type,
    osmId: json.osm_id,
    category: json.category,
    type: json.type,
    name: json.name || '',
    displayName: json.display_name || '',
    namedetails: json.namedetails || {},
    extratags: json.extratags || {},
    address: json.address || {},
    normalized
  };
}

function selectMapPlaceInfo(geocode, location) {
  if (!geocode || geocode.error) return null;
  const address = geocode.address || {};
  const namedetails = geocode.namedetails || {};
  const normalized = geocode.normalized || buildNormalizedGeocodeFields(geocode);
  const rawNames = [
    normalized.station,
    normalized.railway,
    normalized.tourism,
    normalized.amenity,
    normalized.building,
    address.historic,
    normalized.road,
    normalized.neighbourhood,
    normalized.suburb,
    normalized.quarter,
    normalized.city,
    geocode.name,
    namedetails['name:zh'],
    namedetails['name:zh-Hans'],
    namedetails['name:ja'],
    namedetails.name
  ].filter(Boolean);

  const landmark = rawNames.find((name) => isUsefulPlaceName(name)) || null;
  if (!landmark) return null;

  const city = cleanPlaceName(normalized.city || inferCity(location), '');
  const road = normalized.road || '';
  const district = normalized.neighbourhood || normalized.suburb || normalized.quarter || '';
  const typeLabel = getGeocodeTypeLabel(geocode, address);
  return {
    name: cleanPlaceName(landmark, city),
    landmark: cleanPlaceName(landmark, city),
    road: cleanPlaceName(road, city),
    district: cleanPlaceName(district, city),
    city,
    typeLabel,
    category: geocode.category,
    type: geocode.type,
    source: 'nominatim'
  };
}

function buildNormalizedGeocodeFields(geocode) {
  const address = geocode.address || {};
  const namedetails = geocode.namedetails || {};
  return {
    preferredName: firstUsefulName([
      namedetails['name:zh'],
      namedetails['name:zh-Hans'],
      namedetails['name:ja'],
      namedetails.name,
      geocode.name
    ]),
    station: firstUsefulName([address.station, address.railway, address.public_transport]),
    railway: firstUsefulName([address.railway]),
    road: firstUsefulName([address.road, address.pedestrian, address.footway, address.path]),
    neighbourhood: firstUsefulName([address.neighbourhood]),
    suburb: firstUsefulName([address.suburb]),
    quarter: firstUsefulName([address.quarter]),
    city: firstUsefulName([address.city, address.town, address.village, address.county, address.state]),
    tourism: firstUsefulName([address.tourism, address.attraction]),
    amenity: firstUsefulName([address.amenity]),
    building: firstUsefulName([address.building])
  };
}

function firstUsefulName(names) {
  return names.find((name) => isUsefulPlaceName(name)) || '';
}

function isUsefulPlaceName(name) {
  const text = String(name || '').trim();
  if (text.length < 2) return false;
  if (/^\d/.test(text)) return false;
  if (/parking|駐車場|コイン|times|タイムズ|apartment|マンション|ビル$/i.test(text)) return false;
  return true;
}

function cleanPlaceName(name, city) {
  return String(name || '')
    .replace(/\s+/g, '')
    .replace(/,.*$/, '')
    .replace(new RegExp(`^${city}[都府県市区]*`), '')
    .trim();
}

function getGeocodeTypeLabel(geocode, address) {
  const category = geocode.category || '';
  const type = geocode.type || '';

  // Specific type mappings
  const typeMap = {
    library: '图书馆', hospital: '医院', clinic: '诊所', pharmacy: '药店',
    school: '学校', university: '大学', kindergarten: '幼儿园',
    restaurant: '餐厅', cafe: '咖啡馆', bar: '酒吧', fast_food: '快餐店',
    supermarket: '超市', marketplace: '市场', convenience: '便利店',
    bank: '银行', atm: '自动取款机', post_office: '邮局',
    police: '派出所', fire_station: '消防站',
    cinema: '电影院', theatre: '剧院', arts_centre: '艺术中心',
    place_of_worship: '宗教场所', church: '教堂', mosque: '清真寺', temple: '寺庙',
    parking: '停车场', fuel: '加油站',
    bus_station: '公交站', ferry_terminal: '码头',
    hotel: '酒店', guest_house: '民宿', hostel: '青旅',
    museum: '博物馆', gallery: '美术馆', viewpoint: '观景点',
    castle: '城堡', monument: '纪念碑', memorial: '纪念馆',
    attraction: '景点', theme_park: '游乐场', zoo: '动物园', aquarium: '水族馆',
    park: '公园', garden: '花园', playground: '游乐场',
    stadium: '体育场', sports_centre: '运动中心',
    cemetery: '墓地', fountain: '喷泉', bridge: '桥梁',
    tower: '塔楼', lighthouse: '灯塔', ruins: '遗迹'
  };

  if (typeMap[type]) return typeMap[type];

  // Category-level fallbacks
  if (category === 'railway' || address.railway || /station|platform/.test(type)) return '车站';
  if (category === 'tourism') return '景点';
  if (category === 'historic') return '历史建筑';
  if (category === 'amenity') return '公共设施';
  if (category === 'leisure') return '休闲场所';
  if (category === 'shop') return '商铺';
  if (address.road || address.pedestrian) return '街道路口';
  return '地点';
}

function makeUniqueName(baseName, day, placeIndex, candidates, location) {
  const cleanBase = baseName && !isGenericPlaceName(baseName)
    ? baseName
    : '';
  const earlier = new Set();
  for (let index = 0; index < placeIndex; index++) {
    const previous = candidates[index];
    const previousBase = previous._displayName || inferCity(previous.location) || defaultPlaceName;
    earlier.add(previous._displayName || previousBase);
  }

  let name = cleanBase || `${inferCity(location)}真实 GPS`;
  if (!earlier.has(name)) {
    candidates[placeIndex]._displayName = name;
    return name;
  }

  const detail = getCoordinateDetailSuffix(location, cleanBase);
  if (detail && !earlier.has(`${name}·${detail}`)) {
    name = `${name}·${detail}`;
    candidates[placeIndex]._displayName = name;
    return name;
  }

  let order = 2;
  while (earlier.has(`${name} ${order}`)) order++;
  name = `${name} ${order}`;
  candidates[placeIndex]._displayName = name;
  return name;
}

function isGenericPlaceName(name) {
  const text = String(name || '');
  return /(中心街区|周边|附近|方向)/.test(text) || text.endsWith(defaultPlaceName);
}

function getCoordinateDetailSuffix(location, baseName) {
  const matched = matchConfiguredPoi(location);
  if (!matched) return null;
  const direction = relativeDirection(matched.lat, matched.lng, location.lat, location.lng);
  return direction ? direction.replace('侧', '侧一带') : null;
}

function relativeDirection(fromLat, fromLng, toLat, toLng) {
  const dLat = toLat - fromLat;
  const dLng = toLng - fromLng;
  const absLat = Math.abs(dLat);
  const absLng = Math.abs(dLng);
  if (absLat < 0.00025 && absLng < 0.00025) return null;
  if (absLat > absLng * 1.4) return dLat > 0 ? '北侧' : '南侧';
  if (absLng > absLat * 1.4) return dLng > 0 ? '东侧' : '西侧';
  if (dLat > 0 && dLng > 0) return '东北侧';
  if (dLat > 0 && dLng < 0) return '西北侧';
  if (dLat < 0 && dLng > 0) return '东南侧';
  return '西南侧';
}

function buildPlaceNote({ displayName, location, placeIndex, candidates, mapInfo }) {
  const city = mapInfo.city || inferCity(location);
  const timeLabel = getJstTimeLabel(candidates[placeIndex]?.capturedAt);
  const seed = hashStr(displayName + location.lat) || placeIndex;

  if (mapInfo.note && mapInfo.source === 'configured-poi') {
    const detail = buildLocalAnchorDetail(displayName, location, placeIndex);
    return detail || mapInfo.note;
  }

  const category = mapInfo.category || '';
  const type = mapInfo.type || '';
  const typeLabel = mapInfo.typeLabel || '';
  const road = mapInfo.road && !displayName.includes(mapInfo.road) ? mapInfo.road : '';
  const district = mapInfo.district && !displayName.includes(mapInfo.district) ? mapInfo.district : '';
  const loc = [road, district].filter(Boolean).join('，');

  // Pick a description line based on place type
  const desc = pickTypeDesc(category, type, typeLabel, displayName, city, loc, seed);

  // Pick a time/location suffix
  const suffix = pickSuffix(timeLabel, loc, seed);

  return desc + (suffix ? '，' + suffix + '。' : '。');
}

function pickTypeDesc(category, type, typeLabel, name, city, loc, seed) {
  const r = (arr) => arr[seed % arr.length];
  const label = typeLabel || '地点';

  // Specific templates for known types
  const specific = {
    historic: [
      `${name}，${city}的历史建筑`,
      `${name}，这座老建筑见证了${city}的变迁`,
      `${name}，藏在${city}街巷里的历史痕迹`
    ],
    university: [
      `${name}，${city}的高等院校`,
      `${name}，校园里绿树成荫`,
      `${name}，${city}的学府，走在路上能感受到年轻气息`
    ],
    library: [
      `${name}，${loc || city}的图书馆`,
      `${name}，安静的阅读空间`,
      `${name}，适合坐下来翻几页书的地方`
    ],
    museum: [
      `${name}，${loc || city}的博物馆`,
      `${name}，值得慢慢看的展览空间`
    ],
    park: [
      `${name}，${loc || city}的公园绿地`,
      `${name}，适合散步放松`,
      `${name}，城市里的一片绿意`
    ]
  };

  // Check specific type first
  if (specific[type]) return r(specific[type]);
  if (category === 'tourism' || type === 'attraction') return r([
    `${name}，${city}的${label}`,
    `${name}，来${city}值得看看的地方`,
    `${name}，${city}的打卡地标`
  ]);
  if (category === 'leisure') return r(specific.park);

  // Generic templates that work with any typeLabel
  if (typeLabel) return r([
    `${name}，${label}`,
    `${name}，${city}的${label}`,
    `${name}，一处${label}`,
    `${name}，路过时留意到的${label}`
  ]);
  return name;
}

function pickSuffix(timeLabel, loc, seed) {
  const r = (arr) => arr[seed % arr.length];
  const parts = [];
  if (loc) parts.push(r([
    `在${loc}附近`,
    `靠近${loc}`,
    `坐落于${loc}`
  ]));
  if (timeLabel) parts.push(r([
    `${timeLabel}路过`,
    `${timeLabel}经过这里`,
    `拍下这张照片时正是${timeLabel}`
  ]));
  return parts.join('，');
}

function hashStr(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function buildLocalAnchorDetail(displayName, location, placeIndex) {
  const anchor = matchConfiguredPoi(location);
  if (!anchor) return '';
  const direction = relativeDirection(anchor.lat, anchor.lng, location.lat, location.lng);
  const distance = anchor.distance ?? haversineDistance(location.lat, location.lng, anchor.lat, anchor.lng);
  const detailPrefix = direction ? `坐标落在${anchor.name}${direction}` : `坐标贴近${anchor.name}`;
  const variants = [
    `${detailPrefix}，约 ${Math.round(distance * 1000)} 米范围内，适合把这一张照片和当天路线中的真实地标对上。`,
    `${detailPrefix}，周围街道、入口或参道比单纯景点名更能说明这一段移动。`,
    `${detailPrefix}，这是同一片地标附近的另一个 GPS 停留点，记录的是不同街角和步行动线。`
  ];
  return variants[placeIndex % variants.length];
}

function getRouteStageLabel(index, total) {
  if (total <= 1) return '';
  if (index === 0) return '起点';
  if (index === total - 1) return '尾声';
  if (index < total / 3) return '前段';
  if (index > total * 2 / 3) return '后段';
  return '中段';
}

function getJstTimeLabel(value) {
  if (!value) return '当日';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '当日';
  const tzHours = Math.round(timezoneOffsetMs / (60 * 60 * 1000));
  const hour = (date.getUTCHours() + tzHours) % 24;
  if (hour < 6) return '清晨';
  if (hour < 11) return '上午';
  if (hour < 15) return '午后';
  if (hour < 18) return '傍晚';
  return '夜间';
}

function readJsonFile(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    console.warn(`Could not parse ${relative(root, path)}: ${error.message}`);
    return fallback;
  }
}

function inferCity(location) {
  if (!location) return defaultPlaceName;
  const { lat, lng } = location;
  for (const r of cityRegions) {
    const [latMin, latMax, lngMin, lngMax] = r.bounds || [r.latMin, r.latMax, r.lngMin, r.lngMax];
    if (lat > latMin && lat < latMax && lng > lngMin && lng < lngMax) return r.name;
  }
  return defaultPlaceName;
}

function distance(a, b) {
  return Math.hypot(a.lat - b.lat, a.lng - b.lng);
}

function titleFromFilename(path) {
  return basename(path, extname(path))
    .replaceAll(/[_-]+/g, ' ')
    .replaceAll(/\s+/g, ' ')
    .trim();
}

function formatShortDate(date) {
  return new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' }).format(new Date(date));
}

function slug(value) {
  return value
    .toLowerCase()
    .replaceAll(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
    .replaceAll(/^-|-$/g, '');
}
