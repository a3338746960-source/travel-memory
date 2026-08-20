import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const posterDir = 'public/generated/video-posters';
const backupDir = 'public/generated/video-posters-backup';
const QUALITY = 60;
const MAX_DIM = 800;
const MIN_VALID_BYTES = 5000; // 低于此视为损坏

const files = readdirSync(posterDir).filter((f) => f.endsWith('.jpg'));
console.log(`Found ${files.length} poster files\n`);

// --- 统计压缩前 ---
const beforeStats = files.map((f) => statSync(join(posterDir, f)).size);
const beforeTotal = beforeStats.reduce((a, b) => a + b, 0);
console.log(`Before: ${(beforeTotal / 1024 / 1024).toFixed(1)} MB total, avg ${(beforeTotal / files.length / 1024).toFixed(0)} KB/file\n`);

// --- 备份 ---
if (!existsSync(backupDir)) {
  mkdirSync(backupDir, { recursive: true });
  console.log('Backing up originals...');
  for (const f of files) {
    copyFileSync(join(posterDir, f), join(backupDir, f));
  }
  console.log('Backup done.\n');
} else {
  console.log('Backup directory already exists, skipping backup.\n');
}

// --- 压缩到临时目录 ---
const tmpDir = 'public/generated/video-posters-tmp';
if (existsSync(tmpDir)) {
  // 清理旧的临时目录
  const oldFiles = readdirSync(tmpDir);
  for (const f of oldFiles) {
    unlinkSync(join(tmpDir, f));
  }
}
mkdirSync(tmpDir, { recursive: true });

let compressed = 0;
let failed = 0;
const failedFiles = [];

console.log('Compressing...');
for (let i = 0; i < files.length; i++) {
  const f = files[i];
  const src = join(posterDir, f);
  const tmp = join(tmpDir, f);

  try {
    execFileSync('sips', [
      '-s', 'format', 'jpeg',
      '-s', 'formatOptions', String(QUALITY),
      '-Z', String(MAX_DIM),
      src, '--out', tmp,
    ], { encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 15000 });

    // 验证输出
    if (!existsSync(tmp) || statSync(tmp).size < MIN_VALID_BYTES) {
      throw new Error(`output too small or missing`);
    }

    compressed++;
  } catch (err) {
    failed++;
    failedFiles.push(f);
    // 原样复制不压缩
    copyFileSync(src, tmp);
  }

  if ((i + 1) % 100 === 0 || i === files.length - 1) {
    process.stdout.write(`  ${i + 1}/${files.length}\r`);
  }
}
console.log(`\nCompressed: ${compressed}, Failed: ${failed}\n`);

// --- 覆盖原文件 ---
console.log('Replacing originals...');
for (const f of files) {
  renameSync(join(tmpDir, f), join(posterDir, f));
}

// --- 统计压缩后 ---
const afterStats = files.map((f) => statSync(join(posterDir, f)).size);
const afterTotal = afterStats.reduce((a, b) => a + b, 0);
const maxFile = Math.max(...afterStats);
const maxFileName = files[afterStats.indexOf(maxFile)];

console.log('\n=== Results ===');
console.log(`Files:        ${files.length}`);
console.log(`Before:       ${(beforeTotal / 1024 / 1024).toFixed(1)} MB`);
console.log(`After:        ${(afterTotal / 1024 / 1024).toFixed(1)} MB`);
console.log(`Saved:        ${((1 - afterTotal / beforeTotal) * 100).toFixed(1)}%`);
console.log(`Avg/file:     ${(afterTotal / files.length / 1024).toFixed(0)} KB`);
console.log(`Largest:      ${(maxFile / 1024).toFixed(0)} KB (${maxFileName})`);
console.log(`Backup at:    ${backupDir}`);

if (failedFiles.length > 0) {
  console.log(`\nFailed files (copied uncompressed): ${failedFiles.join(', ')}`);
}
