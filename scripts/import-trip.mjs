import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
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
const doUpload = hasArg('--upload');
const doCleanup = hasArg('--cleanup-raw');
const doReverseGeocode = hasArg('--reverse-geocode');

if (!tripId && !configOverride) {
  console.error('Usage: node scripts/import-trip.mjs --trip <trip-id> [--upload] [--cleanup-raw]');
  console.error('   or: node scripts/import-trip.mjs --config <path> [--upload] [--cleanup-raw]');
  process.exit(1);
}

// --- Load config ---
let tripConfig;
let configPath;
if (configOverride) {
  configPath = join(root, configOverride);
  tripConfig = JSON.parse(readFileSync(configPath, 'utf8'));
} else {
  configPath = join(root, 'trips', tripId, 'trip-config.json');
  tripConfig = JSON.parse(readFileSync(configPath, 'utf8'));
}

const id = tripConfig.id;
const tripArgs = ['--trip', id];
console.log(`=== 导入旅行: ${tripConfig.title || id} (${id}) ===\n`);

// --- Step 1: 确保目录存在 ---
const tripDir = join(root, 'trips', id);
const dataDir = join(tripDir, 'data');
const previewsDir = tripConfig.generatedDirs?.previews
  ? join(root, tripConfig.generatedDirs.previews)
  : join(tripDir, 'generated', 'previews');
const postersDir = tripConfig.generatedDirs?.videoPosters
  ? join(root, tripConfig.generatedDirs.videoPosters)
  : join(tripDir, 'generated', 'video-posters');

for (const dir of [dataDir, previewsDir, postersDir]) {
  mkdirSync(dir, { recursive: true });
}
console.log('目录已就绪。');

// --- Step 2: 运行 generate-index.mjs（扫描媒体、生成 trip-data.json）---
console.log('\n[phase:1/4] 扫描媒体并生成旅行数据...');
try {
  const genArgs = ['scripts/generate-index.mjs', ...tripArgs];
  if (doReverseGeocode) genArgs.push('--reverse-geocode');
  const output = execFileSync('node', genArgs, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 600000
  });
  console.log(output.trimEnd());
} catch (err) {
  console.error('generate-index.mjs 失败:');
  console.error(err.stderr || err.message);
  process.exit(1);
}

// --- Step 3: 运行 preview-mode.mjs（生成预览图和视频封面）---
console.log('\n[phase:2/4] 生成预览图和视频封面...');
try {
  const previewArgs = ['scripts/preview-mode.mjs', ...tripArgs];
  const output = execFileSync('node', previewArgs, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 600000
  });
  console.log(output.trimEnd());
} catch (err) {
  console.error('preview-mode.mjs 失败:');
  console.error(err.stderr || err.message);
  process.exit(1);
}

// --- Step 4: 运行 rewrite-paths.mjs（路径改写为云端相对路径）---
console.log('\n[phase:3/4] 改写媒体路径为云端格式...');
try {
  const rewriteArgs = ['scripts/rewrite-paths.mjs', ...tripArgs];
  const output = execFileSync('node', rewriteArgs, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 30000
  });
  console.log(output.trimEnd());
} catch (err) {
  console.error('rewrite-paths.mjs 失败:');
  console.error(err.stderr || err.message);
  process.exit(1);
}

// --- Step 5: 更新 trips/index.json ---
console.log('\n[phase:4/4] 更新 trips/index.json...');
const indexPath = join(root, 'trips', 'index.json');
let index = { trips: [] };
if (existsSync(indexPath)) {
  try {
    index = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch { /* start fresh */ }
}

const tripDataPath = join(root, tripConfig.outputPaths.tripData);
const tripData = JSON.parse(readFileSync(tripDataPath, 'utf8'));

const stats = {
  days: tripData.days?.length || 0,
  photos: tripData.media?.filter((m) => m.type === 'photo' || m.type === 'receipt').length || 0,
  videos: tripData.media?.filter((m) => m.type === 'video').length || 0
};

// Auto-calculate dateRange from trip data if not in config
let dateRange = tripConfig.dateRange?.length >= 2 ? tripConfig.dateRange : null;
if (!dateRange && tripData.days?.length) {
  const dates = tripData.days.map((d) => d.date).filter(Boolean).sort();
  if (dates.length) dateRange = [dates[0], dates[dates.length - 1]];
}

// Fix cover: if it's a HEIC/HEIF file, use the generated JPEG preview instead
let coverPath = tripConfig.cover || null;
if (coverPath) {
  const coverSrc = coverPath.replace(/^\.\//, '');
  const coverExt = coverSrc.split('.').pop()?.toLowerCase();
  if (coverExt === 'heic' || coverExt === 'heif') {
    const previewDir = tripConfig.generatedDirs?.previews
      ? join(root, tripConfig.generatedDirs.previews)
      : join(root, 'trips', id, 'generated', 'previews');
    const slug = coverSrc.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
    const previewFile = join(previewDir, `${slug}.jpg`);
    if (existsSync(previewFile)) {
      coverPath = `./${relative(root, previewFile).replaceAll('\\', '/')}`;
      console.log(`封面已从 HEIC 更新为: ${coverPath}`);
    }
  }
}

const entry = {
  id,
  title: tripConfig.title || id,
  subtitle: tripConfig.subtitle || '',
  dateRange,
  dataUrl: `./trips/${id}/data/trip-data.json`,
  assetBaseUrl: tripConfig.assetBaseUrl || null,
  cover: coverPath,
  stats
};

const existingIdx = index.trips.findIndex((t) => t.id === id);
if (existingIdx >= 0) {
  index.trips[existingIdx] = { ...index.trips[existingIdx], ...entry };
  console.log(`已更新: ${id}`);
} else {
  index.trips.push(entry);
  console.log(`已添加: ${id}`);
}
writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n');

// --- Step 6: 可选上传到 COS ---
if (doUpload) {
  console.log('\n[phase:5/5] 上传到 COS...');
  try {
    const uploadArgs = ['scripts/upload-cos.mjs', ...tripArgs];
    const output = execFileSync('node', uploadArgs, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 600000
    });
    console.log(output.trimEnd());
  } catch (err) {
    console.error('上传失败:');
    console.error(err.stderr || err.message);
    console.error('\n中止：上传失败，不清理原始素材。');
    process.exit(1);
  }

  // Step 6b: 云端检查
  console.log('\n检查云端资源...');
  try {
    const checkArgs = ['scripts/check-cloud-assets.mjs', ...tripArgs];
    const output = execFileSync('node', checkArgs, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 60000
    });
    console.log(output.trimEnd());
  } catch (err) {
    console.error('云端检查失败:');
    console.error(err.stderr || err.message);
    console.error('\n中止：云端资源不可用，不清理原始素材。');
    process.exit(1);
  }
}

// --- Step 7: 可选清理原始素材 ---
if (doCleanup) {
  if (!doUpload) {
    console.error('\n错误：--cleanup-raw 必须搭配 --upload 使用，确保云端资源已就绪。');
    process.exit(1);
  }

  console.log('\n清理原始素材...');

  // 安全检查：trip-data.json 不能仍有 raw 引用
  const rawPatterns = ['public/raw', 'raw/iphone-media', 'raw/vlog', 'raw/receipts', 'imports/'];
  const tripDataStr = JSON.stringify(tripData);
  const hasRawRefs = rawPatterns.some((p) => tripDataStr.includes(p));
  if (hasRawRefs) {
    console.error('安全检查失败：trip-data.json 仍包含原始文件路径引用。');
    console.error('请先确认 rewrite-paths.mjs 已执行并改写路径。');
    process.exit(1);
  }

  const { rmSync } = await import('node:fs');
  let deletedSize = 0;
  const deletedDirs = [];

  // Clean up sourceDirs from trip-config
  const sourceDirs = tripConfig.sourceDirs || {};
  for (const [key, dir] of Object.entries(sourceDirs)) {
    const fullPath = join(root, dir);
    if (existsSync(fullPath)) {
      // Estimate size
      try {
        const files = collectFilesRecursive(fullPath);
        deletedSize += files.reduce((sum, f) => { try { return sum + statSync(f).size; } catch { return sum; } }, 0);
      } catch { /* ignore */ }
      console.log(`  删除 ${dir}/`);
      rmSync(fullPath, { recursive: true, force: true });
      deletedDirs.push(dir);
    }
  }

  // Clean up imports/<job-id>/raw/ parent if exists
  for (const dir of Object.values(sourceDirs)) {
    const parentRaw = join(root, dir, '..', '..');
    const rawDir = join(parentRaw, 'raw');
    if (existsSync(rawDir) && rawDir.includes('imports/')) {
      try {
        const files = collectFilesRecursive(rawDir);
        deletedSize += files.reduce((sum, f) => { try { return sum + statSync(f).size; } catch { return sum; } }, 0);
      } catch { /* ignore */ }
      console.log(`  删除 ${rawDir.replace(root, '').replace(/^\//, '')}/`);
      rmSync(rawDir, { recursive: true, force: true });
      deletedDirs.push(rawDir.replace(root, '').replace(/^\//, ''));
    }
  }

  console.log(`\n已清理 ${deletedDirs.length} 个目录，释放约 ${(deletedSize / 1024 / 1024).toFixed(1)} MB`);
  console.log('保留：trips/' + id + '/data/ 和 trips/' + id + '/generated/');
}

// --- 完成 ---
console.log('\n=== 导入完成 ===');
console.log(`旅行: ${tripConfig.title || id}`);
console.log(`数据: trips/${id}/data/trip-data.json`);
console.log(`天数: ${stats.days}，照片: ${stats.photos}，视频: ${stats.videos}`);
if (doUpload) {
  const assetBaseUrl = tripConfig.assetBaseUrl || `https://${process.env.COS_BUCKET || 'bucket'}.cos.${process.env.COS_REGION || 'region'}.myqcloud.com/trips/${id}/`;
  console.log(`\nCOS 地址: ${assetBaseUrl}`);
  console.log(`云端数据: ${assetBaseUrl}data/trip-data.json`);
}
console.log(`\n本地查看: http://localhost:5173/?trip=${id}`);

// --- Helper ---
function collectFilesRecursive(dir) {
  const results = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) results.push(...collectFilesRecursive(full));
    else results.push(full);
  }
  return results;
}
