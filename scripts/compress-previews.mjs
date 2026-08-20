import { execFileSync } from 'node:child_process';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const compressScript = join(root, 'scripts', 'compress-jpeg.py');

const args = process.argv.slice(2);
function getArg(flag) {
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : null;
}

const tripId = getArg('--trip');
if (!tripId) {
  console.error('Usage: node scripts/compress-previews.mjs --trip <trip-id>');
  process.exit(1);
}

const previewDirs = [
  join(root, 'trips', tripId, 'generated', 'previews'),
  join(root, 'trips', tripId, 'generated', 'video-posters')
];

let compressed = 0;
let saved = 0;

for (const dir of previewDirs) {
  if (!existsSync(dir)) continue;
  const files = readdirSync(dir).filter((f) => !f.startsWith('.') && /\.(jpg|jpeg)$/i.test(f));
  for (const file of files) {
    const path = join(dir, file);
    const before = statSync(path).size;
    try {
      execFileSync('python3', [compressScript, path, path], {
        encoding: 'utf8',
        stdio: ['ignore', 'ignore', 'ignore'],
        timeout: 10000
      });
      const after = statSync(path).size;
      if (after < before) {
        compressed++;
        saved += before - after;
      }
    } catch { /* skip */ }
  }
}

console.log(`Compressed ${compressed} files, saved ${(saved / 1024 / 1024).toFixed(1)} MB`);
