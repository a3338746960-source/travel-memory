import { readFileSync, existsSync } from 'node:fs';

// --- Load .env ---
function loadEnv() {
  if (!existsSync('.env')) {
    console.error('Error: .env file not found.');
    process.exit(1);
  }
  for (const line of readFileSync('.env', 'utf8').split('\n')) {
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

let baseUrl = process.env.COS_ASSET_BASE_URL;
let dataPath = 'public/data/trip-data.json';

if (tripId) {
  const cfgPath = `trips/${tripId}/trip-config.json`;
  if (existsSync(cfgPath)) {
    const config = JSON.parse(readFileSync(cfgPath, 'utf8'));
    baseUrl = config.assetBaseUrl || baseUrl;
    dataPath = config.outputPaths?.tripData || `trips/${tripId}/data/trip-data.json`;
  }
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

// Sample URLs to check
const urls = [];

// trip-data.json itself
urls.push(`${baseUrl}/data/trip-data.json`);

// A few photos
const photos = data.media.filter((m) => m.type === 'photo' && m.src).slice(0, 5);
for (const p of photos) {
  urls.push(`${baseUrl}/${p.src}`);
}

// A few video posters
const videos = data.media.filter((m) => m.type === 'video' && m.posterSrc).slice(0, 5);
for (const v of videos) {
  urls.push(`${baseUrl}/${v.posterSrc}`);
}

console.log(`Checking ${urls.length} sample URLs for ${tripId || 'default'}...\n`);

let ok = 0;
let fail = 0;

for (const url of urls) {
  try {
    const res = await fetch(url, { method: 'HEAD' });
    if (res.ok) {
      ok++;
      console.log(`  OK  ${url.split('/').pop()}`);
    } else {
      fail++;
      console.log(`  FAIL (${res.status}) ${url.split('/').pop()}`);
    }
  } catch (err) {
    fail++;
    console.log(`  FAIL (${err.message}) ${url.split('/').pop()}`);
  }
}

console.log(`\n=== Results ===`);
console.log(`OK: ${ok}/${urls.length}`);
console.log(`Failed: ${fail}/${urls.length}`);

if (fail === 0) {
  console.log('\nAll sample URLs accessible.');
} else {
  console.log('\nSome URLs failed. Do NOT delete local files yet.');
  process.exit(1);
}
