import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import COS from 'cos-nodejs-sdk-v5';

// --- Load .env ---
function loadEnv() {
  const envPath = '.env';
  if (!existsSync(envPath)) {
    console.error('Error: .env file not found. Copy .env.example to .env and fill in credentials.');
    process.exit(1);
  }
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const val = trimmed.slice(eqIdx + 1).trim();
    if (val) process.env[key] = val;
  }
}

loadEnv();

const { COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, COS_REGION } = process.env;

if (!COS_SECRET_ID || !COS_SECRET_KEY || !COS_BUCKET || !COS_REGION) {
  console.error('Error: Missing COS config in .env. Required: COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, COS_REGION');
  process.exit(1);
}

// --- Parse CLI args ---
const args = process.argv.slice(2);
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const tripId = getArg('--trip');
const configOverride = getArg('--config');

let tripConfig = null;
if (configOverride) {
  tripConfig = JSON.parse(readFileSync(configOverride, 'utf8'));
} else if (tripId) {
  const cfgPath = `trips/${tripId}/trip-config.json`;
  if (existsSync(cfgPath)) {
    tripConfig = JSON.parse(readFileSync(cfgPath, 'utf8'));
  }
}

// Derive prefix from config or env
let prefix = process.env.COS_TRIP_PREFIX;
if (tripConfig?.assetBaseUrl) {
  // Extract prefix from assetBaseUrl like https://bucket.cos.region.myqcloud.com/trips/2025-japan/
  const match = tripConfig.assetBaseUrl.match(/myqcloud\.com\/(.+?)\/?$/);
  if (match) prefix = match[1];
}
if (!prefix && tripId) prefix = `trips/${tripId}`;
if (!prefix) {
  console.error('Error: Cannot determine COS prefix. Provide --trip, --config, or set COS_TRIP_PREFIX in .env');
  process.exit(1);
}

// Determine directories from config or defaults
const tripRoot = tripConfig ? `trips/${tripConfig.id || tripId}` : null;
const previewsDir = tripConfig?.generatedDirs?.previews
  || (tripRoot ? `${tripRoot}/generated/previews` : 'public/generated/previews');
const postersDir = tripConfig?.generatedDirs?.videoPosters
  || (tripRoot ? `${tripRoot}/generated/video-posters` : 'public/generated/video-posters');
const tripDataDir = tripConfig?.outputPaths?.tripData
  ? tripConfig.outputPaths.tripData.replace(/\/trip-data\.json$/, '')
  : tripRoot ? `${tripRoot}/data` : 'public/data';
const geocodingCachePath = tripConfig?.outputPaths?.geocodingCache
  || (tripRoot ? `${tripRoot}/data/geocoding-cache.json` : 'data/geocoding-cache.json');

const cos = new COS({ SecretId: COS_SECRET_ID, SecretKey: COS_SECRET_KEY });

// --- Helpers ---
function contentType(filePath) {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.json') return 'application/json; charset=utf-8';
  if (ext === '.png') return 'image/png';
  return 'application/octet-stream';
}

function collectFiles(dir) {
  const results = [];
  if (!existsSync(dir)) return results;
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      results.push(...collectFiles(full));
    } else {
      results.push(full);
    }
  }
  return results;
}

function uploadFile(localPath, cosKey) {
  return new Promise((resolve, reject) => {
    cos.putObject(
      {
        Bucket: COS_BUCKET,
        Region: COS_REGION,
        Key: cosKey,
        Body: readFileSync(localPath),
        ContentType: contentType(localPath),
      },
      (err, data) => {
        if (err) reject(err);
        else resolve(data);
      }
    );
  });
}

function headObject(cosKey) {
  return new Promise((resolve, reject) => {
    cos.headObject(
      { Bucket: COS_BUCKET, Region: COS_REGION, Key: cosKey },
      (err, data) => {
        if (err) reject(err);
        else resolve(data);
      }
    );
  });
}

// --- Main ---
async function main() {
  const tasks = [];

  // 1. Collect files
  const previewFiles = collectFiles(previewsDir);
  const posterFiles = collectFiles(postersDir);
  const tripDataFile = join(tripDataDir, 'trip-data.json');
  const tripDataFiles = existsSync(tripDataFile) ? [tripDataFile] : [];
  const cacheFiles = existsSync(geocodingCachePath) ? [geocodingCachePath] : [];

  // Build upload tasks — strip trip-root prefix for COS key
  function cosKeyFor(localPath, baseDir) {
    const rel = relative(baseDir, localPath).replace(/\\/g, '/');
    return `${prefix}/${relative(tripRoot || '', baseDir).replace(/\\/g, '/')}/${rel}`;
  }

  for (const f of previewFiles) {
    const rel = relative(previewsDir, f).replace(/\\/g, '/');
    tasks.push({ local: f, key: `${prefix}/generated/previews/${rel}` });
  }
  for (const f of posterFiles) {
    const rel = relative(postersDir, f).replace(/\\/g, '/');
    tasks.push({ local: f, key: `${prefix}/generated/video-posters/${rel}` });
  }
  for (const f of tripDataFiles) {
    tasks.push({ local: f, key: `${prefix}/data/trip-data.json` });
  }
  for (const f of cacheFiles) {
    tasks.push({ local: f, key: `${prefix}/data/geocoding-cache.json` });
  }

  if (tasks.length === 0) {
    console.log('No files to upload. Check that generated directories exist.');
    process.exit(1);
  }

  // Stats before upload
  const totalSize = tasks.reduce((sum, t) => sum + statSync(t.local).size, 0);
  console.log(`Files to upload: ${tasks.length}`);
  console.log(`Total size: ${(totalSize / 1024 / 1024).toFixed(1)} MB`);
  console.log(`Target: ${COS_BUCKET}/${prefix}/\n`);

  // Upload with concurrency limit
  const CONCURRENCY = 10;
  let uploaded = 0;
  let failed = 0;
  const errors = [];

  async function worker(items) {
    for (const item of items) {
      try {
        await uploadFile(item.local, item.key);
        uploaded++;
      } catch (err) {
        failed++;
        errors.push({ key: item.key, error: err.message });
      }
      if ((uploaded + failed) % 200 === 0 || uploaded + failed === tasks.length) {
        process.stdout.write(`  ${uploaded + failed}/${tasks.length}\r`);
      }
    }
  }

  const chunks = Array.from({ length: CONCURRENCY }, () => []);
  tasks.forEach((t, i) => chunks[i % CONCURRENCY].push(t));

  console.log('Uploading...');
  await Promise.all(chunks.map(worker));
  console.log(`\nUploaded: ${uploaded}, Failed: ${failed}\n`);

  if (failed > 0) {
    console.error('Upload errors:');
    for (const e of errors.slice(0, 10)) {
      console.error(`  ${e.key}: ${e.error}`);
    }
    if (errors.length > 10) console.error(`  ... and ${errors.length - 10} more`);
    console.error('\nAborting: fix errors before proceeding.');
    process.exit(1);
  }

  // Verify sample URLs
  console.log('Verifying sample files...');
  const verifySamples = [
    `${prefix}/data/trip-data.json`,
    ...previewFiles.slice(0, 2).map((f) => `${prefix}/generated/previews/${relative(previewsDir, f).replace(/\\/g, '/')}`),
    ...posterFiles.slice(0, 2).map((f) => `${prefix}/generated/video-posters/${relative(postersDir, f).replace(/\\/g, '/')}`),
  ];

  let verified = 0;
  for (const key of verifySamples) {
    try {
      await headObject(key);
      verified++;
    } catch {
      console.error(`  FAILED: ${key}`);
    }
  }
  console.log(`Verified: ${verified}/${verifySamples.length}\n`);

  const baseUrl = `https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com/${prefix}`;
  console.log('=== Upload Complete ===');
  console.log(`COS base URL: ${baseUrl}`);
  console.log(`trip-data.json: ${baseUrl}/data/trip-data.json`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
