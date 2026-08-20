import { readFileSync, writeFileSync, existsSync } from 'node:fs';

// --- Load .env ---
function loadEnv() {
  const envPath = '.env';
  if (!existsSync(envPath)) {
    console.error('Error: .env file not found.');
    process.exit(1);
  }
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    if (v) process.env[k] = v;
  }
}

loadEnv();

// --- Parse CLI args ---
const args = process.argv.slice(2);
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const tripId = getArg('--trip');
const configOverride = getArg('--config');

let tripConfig = null;
let dataPath = 'public/data/trip-data.json';
let baseUrl = process.env.COS_ASSET_BASE_URL;

if (configOverride) {
  tripConfig = JSON.parse(readFileSync(configOverride, 'utf8'));
} else if (tripId) {
  const cfgPath = `trips/${tripId}/trip-config.json`;
  if (existsSync(cfgPath)) {
    tripConfig = JSON.parse(readFileSync(cfgPath, 'utf8'));
  }
}

if (tripConfig) {
  dataPath = tripConfig.outputPaths?.tripData || dataPath;
  baseUrl = tripConfig.assetBaseUrl || baseUrl;
}

if (!baseUrl) {
  console.error('Error: No assetBaseUrl found. Set in trip-config.json or COS_ASSET_BASE_URL in .env');
  process.exit(1);
}

if (!existsSync(dataPath)) {
  console.error(`Error: ${dataPath} not found`);
  process.exit(1);
}

const data = JSON.parse(readFileSync(dataPath, 'utf8'));

// Add assetBaseUrl to trip object
data.trip = data.trip || {};
data.trip.assetBaseUrl = baseUrl.replace(/\/$/, '') + '/';

// Strip prefixes from a media path:
//   ./public/generated/... → generated/...
//   ./trips/<id>/generated/... → generated/...
//   ./trips/<id>/data/... → data/...
function stripPrefix(src) {
  if (!src) return src;
  let s = src.replace(/^\.\//, '');
  if (s.startsWith('public/raw/iphone-media/')) {
    const slugged = slug(s);
    if (isVideoPath(s)) return `generated/video-posters/${slugged}.jpg`;
    return `generated/previews/${slugged}.jpg`;
  }
  // Old format: public/generated/...
  if (s.startsWith('public/')) {
    return s.replace(/^public\//, '');
  }
  // New format: trips/<id>/...
  if (s.startsWith('trips/')) {
    const slash = s.indexOf('/', 6); // skip "trips/"
    if (slash !== -1) return s.slice(slash + 1);
  }
  return s;
}

function isVideoPath(src) {
  return /\.(mov|mp4|m4v)$/i.test(src);
}

function slug(value) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

let changed = 0;

for (const item of data.media) {
  if (item.src) {
    const old = item.src;
    item.src = stripPrefix(item.src);
    if (item.src !== old) changed++;
  }
  if (item.type === 'video') {
    const poster = item.posterSrc || item.src;
    item.posterSrc = stripPrefix(poster);
    item.src = item.posterSrc;
  } else if (item.posterSrc) {
    item.posterSrc = stripPrefix(item.posterSrc);
  }
  delete item.originalSrc;
}

// Also rewrite places[].images[] if they exist
if (data.days) {
  for (const day of Object.values(data.days)) {
    if (day.images) {
      for (const img of day.images) {
        if (img.src) {
          img.src = stripPrefix(img.src);
        }
      }
    }
  }
}

writeFileSync(dataPath, JSON.stringify(data, null, 2) + '\n');

console.log(`Rewrote ${changed} media paths in ${dataPath}`);
console.log(`Added trip.assetBaseUrl: ${data.trip.assetBaseUrl}`);
console.log(`Sample src: ${data.media[0]?.src}`);
