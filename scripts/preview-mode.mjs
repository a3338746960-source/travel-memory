import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

// --- Parse CLI args ---
const args = process.argv.slice(2);
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}
function hasArg(flag) {
  return args.includes(flag);
}

const tripId = getArg('--trip');
const configOverride = getArg('--config');
const doCleanup = hasArg('--cleanup-raw');

// --- Load config ---
let tripConfig = null;
if (configOverride) {
  tripConfig = JSON.parse(readFileSync(join(root, configOverride), 'utf8'));
} else if (tripId) {
  const cfgPath = join(root, 'trips', tripId, 'trip-config.json');
  if (existsSync(cfgPath)) {
    tripConfig = JSON.parse(readFileSync(cfgPath, 'utf8'));
  }
}

// --- Resolve paths from config or legacy defaults ---
const tripDataPath = tripConfig
  ? join(root, tripConfig.outputPaths.tripData)
  : join(root, 'public/data/trip-data.json');

const previewDir = tripConfig?.generatedDirs?.previews
  ? join(root, tripConfig.generatedDirs.previews)
  : tripId
    ? join(root, 'trips', tripId, 'generated', 'previews')
    : join(root, 'public/generated/previews');

const posterDir = tripConfig?.generatedDirs?.videoPosters
  ? join(root, tripConfig.generatedDirs.videoPosters)
  : tripId
    ? join(root, 'trips', tripId, 'generated', 'video-posters')
    : join(root, 'public/generated/video-posters');

const rawMediaDir = tripConfig
  ? join(root, tripConfig.sourceDirs.media)
  : join(root, 'public/raw/iphone-media');

const rawVlogDir = tripConfig
  ? join(root, tripConfig.sourceDirs.vlog)
  : join(root, 'public/raw/vlog');

const posterWorkDir = join(previewDir, '..', '.poster-work');
const maxPhotoSize = '1600';

const imageExts = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif']);
const videoExts = new Set(['.mov', '.mp4', '.m4v']);
const compressScript = join(root, 'scripts', 'compress-jpeg.py');
const heicConvertScript = join(root, 'scripts', 'heic-to-jpeg.py');

if (!existsSync(tripDataPath)) {
  console.error(`Error: ${tripDataPath} not found. Run generate-index.mjs first.`);
  process.exit(1);
}

const data = JSON.parse(readFileSync(tripDataPath, 'utf8'));
const media = data.media || [];
const mediaById = new Map(media.map((item) => [item.id, item]));
const warnings = [];
let photoPreviews = 0;
let videoPosters = 0;
let hiddenVideos = 0;

mkdirSync(previewDir, { recursive: true });
mkdirSync(posterDir, { recursive: true });
mkdirSync(posterWorkDir, { recursive: true });

for (const item of media) {
  if (item.type === 'vlog') {
    item.hidden = true;
    continue;
  }

  const originalPath = resolveOriginalPath(item);
  if (item.type === 'photo' || item.type === 'receipt') {
    if (!originalPath || !existsSync(originalPath)) {
      warnings.push(`Missing original image for ${item.id}`);
      continue;
    }
    const previewPath = ensureImagePreview(originalPath);
    delete item.originalSrc;
    item.src = browserSrc(previewPath);
    photoPreviews += 1;
    continue;
  }

  if (item.type === 'video') {
    if (!originalPath || !existsSync(originalPath)) {
      warnings.push(`Missing original video for ${item.id}`);
      item.hidden = true;
      hiddenVideos += 1;
      continue;
    }
    const posterPath = ensureVideoPoster(originalPath);
    if (posterPath) {
      delete item.originalSrc;
      item.src = browserSrc(posterPath);
      item.posterSrc = browserSrc(posterPath);
      videoPosters += 1;
    } else {
      item.hidden = true;
      hiddenVideos += 1;
    }
  }
}

// Remove vlog entries and clean day media references
data.media = media.filter((item) => item.type !== 'vlog');
const validIds = new Set(data.media.filter((item) => !item.hidden).map((item) => item.id));
for (const day of data.days || []) {
  day.media = (day.media || []).filter((id) => {
    const item = mediaById.get(id);
    return item && item.type !== 'vlog' && validIds.has(id);
  });
}

writeFileSync(tripDataPath, `${JSON.stringify(data, null, 2)}\n`);
rmSync(posterWorkDir, { recursive: true, force: true });

console.log(`Photo previews ready: ${photoPreviews}`);
console.log(`Video posters ready: ${videoPosters}`);
console.log(`Videos hidden without poster: ${hiddenVideos}`);
console.log(`Warnings: ${warnings.length}`);
warnings.slice(0, 40).forEach((warning) => console.warn(warning));

// --- Cleanup raw (only with --cleanup-raw) ---
if (doCleanup) {
  const rawRefs = findRawMediaRefs(data);
  if (rawRefs.length) {
    console.error(`\nRefusing to delete originals: ${rawRefs.length} raw media refs remain in trip-data.json.`);
    rawRefs.slice(0, 20).forEach((ref) => console.error(`- ${ref}`));
    process.exit(1);
  }

  for (const dir of [rawMediaDir, rawVlogDir]) {
    if (existsSync(dir)) {
      console.log(`Removing ${relative(root, dir)}/`);
      rmSync(dir, { recursive: true, force: true });
    }
  }
  console.log('Raw files cleaned up.');
} else {
  console.log('\nRaw files preserved. Use --cleanup-raw to delete after verifying data.');
}

// --- Helpers ---
function resolveOriginalPath(item) {
  const candidates = [item.originalSrc, item.src]
    .filter(Boolean)
    .map((src) => src.replace(/^\.\//, ''))
    .map((src) => join(root, src));

  // Also try to find the file in the source directory by matching the filename
  if (rawMediaDir && item.id) {
    const idParts = item.id.split('-');
    const imgIdx = idParts.findIndex((p) => /^img$/i.test(p));
    if (imgIdx !== -1) {
      const numPart = idParts[imgIdx + 1];
      const extPart = idParts[imgIdx + 2] || 'jpg';
      const patterns = [
        `IMG_${numPart}.${extPart.toUpperCase()}`,
        `IMG_${numPart}.${extPart.toLowerCase()}`,
        `IMG_E${numPart}.${extPart.toUpperCase()}`,
        `IMG_E${numPart}.${extPart.toLowerCase()}`,
      ];
      for (const name of patterns) {
        const fullPath = join(rawMediaDir, name);
        if (existsSync(fullPath)) return fullPath;
      }
    }
  }

  return candidates.find((path) => existsSync(path)) || candidates[0] || null;
}

function ensureImagePreview(path) {
  const previewPath = join(previewDir, `${slug(relative(root, path))}.jpg`);
  if (isUsableImage(previewPath)) return previewPath;
  const ext = extname(path).toLowerCase();
  if (!imageExts.has(ext)) throw new Error(`Unsupported image: ${path}`);

  if (ext === '.heic' || ext === '.heif') {
    // HEIC: use Pillow which correctly handles rotation
    execFileSync('python3', [heicConvertScript, path, previewPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 30000
    });
  } else {
    // JPG/PNG: use sips
    execFileSync('sips', ['-s', 'format', 'jpeg', '-Z', maxPhotoSize, path, '--out', previewPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 30000
    });
    // Compress to reduce file size
    try {
      execFileSync('python3', [compressScript, previewPath, previewPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 10000
      });
    } catch { /* keep uncompressed if compression fails */ }
  }
  return previewPath;
}

function ensureVideoPoster(path) {
  const posterPath = join(posterDir, `${slug(relative(root, path))}.jpg`);
  if (isUsableImage(posterPath)) return posterPath;
  const ext = extname(path).toLowerCase();
  if (!videoExts.has(ext)) return null;
  const before = new Set(existsSync(posterWorkDir) ? readdirSync(posterWorkDir) : []);
  try {
    execFileSync('qlmanage', ['-t', '-s', '800', '-o', posterWorkDir, path], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'pipe'],
      timeout: 30000
    });
  } catch (error) {
    warnings.push(`Could not create poster for ${relative(root, path)}: ${error.message}`);
    return null;
  }
  const created = readdirSync(posterWorkDir)
    .filter((name) => !before.has(name))
    .map((name) => join(posterWorkDir, name))
    .find(isUsableImage);
  if (!created) {
    warnings.push(`Quick Look did not return a usable poster for ${relative(root, path)}`);
    return null;
  }
  renameSync(created, posterPath);
  // Compress poster
  try {
    execFileSync('python3', [compressScript, posterPath, posterPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'ignore', 'ignore'],
      timeout: 10000
    });
  } catch { /* keep uncompressed */ }
  return posterPath;
}

function isUsableImage(path) {
  if (!existsSync(path)) return false;
  try {
    const output = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000
    });
    const width = Number(output.match(/pixelWidth:\s*(\d+)/)?.[1]);
    const height = Number(output.match(/pixelHeight:\s*(\d+)/)?.[1]);
    return Number.isFinite(width) && Number.isFinite(height) && width >= 32 && height >= 32;
  } catch {
    return false;
  }
}

function findRawMediaRefs(value, refs = []) {
  if (typeof value === 'string') {
    if (value.includes('public/raw/') || (tripConfig && Object.values(tripConfig.sourceDirs || {}).some((dir) => value.includes(dir)))) {
      refs.push(value);
    }
    return refs;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => findRawMediaRefs(item, refs));
    return refs;
  }
  if (value && typeof value === 'object') {
    Object.entries(value).forEach(([key, item]) => {
      if (key === 'originalSrc') return;
      findRawMediaRefs(item, refs);
    });
  }
  return refs;
}

function browserSrc(path) {
  return `./${relative(root, path).replaceAll('\\', '/')}`;
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
