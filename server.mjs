import http from 'node:http';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { createWriteStream, existsSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';
import { join, extname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import Busboy from 'busboy';

const root = fileURLToPath(new URL('.', import.meta.url));
const JOBS_FILE = join(root, 'data', 'import-jobs.json');
const PORT = 5174;

const ALLOWED_MEDIA_EXT = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif']);
const ALLOWED_VIDEO_EXT = new Set(['.mov', '.mp4', '.m4v']);
const ALLOWED_RECEIPT_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.heic', '.heif']);
const VALID_TYPES = new Set(['media', 'receipts', 'vlog']);

// --- Helpers ---

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function json(res, status, data) {
  setCors(res);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function error(res, status, message) {
  json(res, status, { error: message });
}

function generateId(prefix) {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${prefix}-${ts}${rand}`;
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

function pinyinFallback() {
  return 'trip-' + Date.now().toString(36).slice(-4);
}

function sanitizeFilename(name) {
  // Remove path separators and null bytes
  let safe = basename(name).replace(/[/\\:*?"<>|\x00]/g, '_');
  // Prevent hidden files
  if (safe.startsWith('.')) safe = '_' + safe.slice(1);
  return safe || 'unnamed';
}

async function uniqueFilePath(dir, filename) {
  const ext = extname(filename);
  const base = basename(filename, ext);
  let candidate = join(dir, filename);
  let i = 1;
  try {
    while (true) {
      await stat(candidate);
      candidate = join(dir, `${base}_${i}${ext}`);
      i++;
    }
  } catch {
    // File doesn't exist — this is our target
  }
  return candidate;
}

function countFiles(dir) {
  return readdir(dir).then(
    (files) => files.filter((f) => !f.startsWith('.')).length,
    () => 0
  );
}

// --- Job persistence ---

async function loadJobs() {
  try {
    return JSON.parse(await readFile(JOBS_FILE, 'utf8'));
  } catch {
    return [];
  }
}

async function saveJobs(jobs) {
  await writeFile(JOBS_FILE, JSON.stringify(jobs, null, 2) + '\n');
}

async function findJob(jobId) {
  const jobs = await loadJobs();
  return { jobs, job: jobs.find((j) => j.jobId === jobId) || null };
}

// --- Generate trip-config.json ---

function buildTripConfig(job) {
  const { tripId, title, subtitle, dateRange, timezoneOffsetHours, defaultMapCenter, defaultPlaceName, cover, jobId } = job;
  // Derive assetBaseUrl from existing japan config pattern
  const assetBaseUrl = `https://travel-memory-assets-1437597724.cos.ap-beijing.myqcloud.com/trips/${tripId}/`;
  return {
    id: tripId,
    title,
    subtitle: subtitle || '',
    dateRange: dateRange || [],
    timezoneOffsetHours: timezoneOffsetHours ?? 0,
    defaultMapCenter: defaultMapCenter || [0, 0],
    defaultPlaceName: defaultPlaceName || '',
    geocodeLanguages: 'zh-CN,zh,en',
    cover: cover || '',
    assetBaseUrl,
    sourceDirs: {
      media: `imports/${jobId}/raw/media`,
      receipts: `imports/${jobId}/raw/receipts`,
      vlog: `imports/${jobId}/raw/vlog`
    },
    outputPaths: {
      tripData: `trips/${tripId}/data/trip-data.json`,
      geocodingCache: `trips/${tripId}/data/geocoding-cache.json`,
      notes: 'data/manual-notes/trip-notes.json'
    },
    generatedDirs: {
      previews: `trips/${tripId}/generated/previews`,
      videoPosters: `trips/${tripId}/generated/video-posters`
    },
    cityRegions: []
  };
}

// --- Route handlers ---

async function handleCreateJob(req, res) {
  const body = await readJsonBody(req);
  if (!body) return error(res, 400, 'Missing request body');

  const title = body.title || '未命名旅行';
  const jobId = generateId('job');

  // Generate tripId: YYYY-slug or YYYY-trip-<short>
  const year = body.dateRange?.[0]?.slice(0, 4) || new Date().getFullYear().toString();
  const slug = slugify(title);
  const tripId = slug ? `${year}-${slug}` : `${year}-${pinyinFallback()}`;

  const job = {
    jobId,
    tripId,
    title,
    subtitle: body.subtitle || '',
    dateRange: body.dateRange || [],
    timezoneOffsetHours: body.timezoneOffsetHours ?? 0,
    defaultMapCenter: body.defaultMapCenter || [0, 0],
    defaultPlaceName: body.defaultPlaceName || '',
    cover: body.cover || '',
    status: 'created',
    phase: 'created',
    progressMessage: '',
    counts: { media: 0, receipts: 0, vlog: 0 },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    error: null,
    result: null,
    logs: []
  };

  // Create directories
  const dirs = [
    `imports/${jobId}/raw/media`,
    `imports/${jobId}/raw/receipts`,
    `imports/${jobId}/raw/vlog`,
    `trips/${tripId}/data`,
    `trips/${tripId}/generated/previews`,
    `trips/${tripId}/generated/video-posters`
  ];
  for (const d of dirs) {
    await mkdir(join(root, d), { recursive: true });
  }

  // Write job.json
  await writeFile(join(root, `imports/${jobId}/job.json`), JSON.stringify(job, null, 2) + '\n');

  // Write trip-config.json
  const tripConfig = buildTripConfig(job);
  await writeFile(join(root, `trips/${tripId}/trip-config.json`), JSON.stringify(tripConfig, null, 2) + '\n');

  // Save to jobs index
  const jobs = await loadJobs();
  jobs.push(job);
  await saveJobs(jobs);

  json(res, 201, {
    jobId,
    tripId,
    status: 'created',
    upload: {
      media: `/api/import-jobs/${jobId}/files?type=media`,
      receipts: `/api/import-jobs/${jobId}/files?type=receipts`,
      vlog: `/api/import-jobs/${jobId}/files?type=vlog`
    }
  });
}

async function handleUpload(req, res, jobId, type) {
  if (!VALID_TYPES.has(type)) return error(res, 400, `Invalid type: ${type}. Allowed: media, receipts, vlog`);

  const { jobs, job } = await findJob(jobId);
  if (!job) return error(res, 404, `Job not found: ${jobId}`);

  const targetDir = join(root, `imports/${jobId}/raw/${type}`);

  // Parse allowed extensions for this type
  let allowed;
  if (type === 'media') allowed = new Set([...ALLOWED_MEDIA_EXT, ...ALLOWED_VIDEO_EXT]);
  else if (type === 'receipts') allowed = ALLOWED_RECEIPT_EXT;
  else allowed = new Set([...ALLOWED_MEDIA_EXT, ...ALLOWED_VIDEO_EXT]); // vlog

  const saved = [];

  try {
    const files = await parseMultipart(req, targetDir, allowed);
    saved.push(...files);
  } catch (err) {
    return error(res, 400, err.message);
  }

  // Update counts
  job.counts.media = await countFiles(join(root, `imports/${jobId}/raw/media`));

  // Background: pre-index uploaded files with mdls and cache results
  if (type === 'media' && saved.length > 0) {
    const mediaDir = join(root, `imports/${jobId}/raw/media`);
    const cachePath = join(root, `imports/${jobId}/exif-cache.json`);
    console.log(`[bg] starting exif cache for ${jobId}`);
    readdir(mediaDir).then(async (files) => {
      const imageFiles = files.filter((f) => !f.startsWith('.') && ['.jpg', '.jpeg', '.png', '.heic', '.heif'].includes(extname(f).toLowerCase()));
      console.log(`[bg] found ${imageFiles.length} images to index`);
      const cache = {};
      const tasks = imageFiles.map(async (f) => {
        const out = await runCommand('mdls', [
          '-name', 'kMDItemLatitude', '-name', 'kMDItemLongitude',
          '-name', 'kMDItemContentCreationDate', join(mediaDir, f)
        ], 120000);
        console.log(`[bg] ${f}: ${out.trim().slice(0, 60)}`);
        const gps = {};
        const latM = out.match(/kMDItemLatitude\s*=\s*([\d.]+)/);
        const lngM = out.match(/kMDItemLongitude\s*=\s*([\d.]+)/);
        if (latM && lngM) { gps.lat = parseFloat(latM[1]); gps.lng = parseFloat(lngM[1]); }
        const dateM = out.match(/kMDItemContentCreationDate\s*=\s*(\d{4}-\d{2}-\d{2})[\sT ](\d{2}:\d{2}:\d{2})/);
        cache[f] = { gps: Object.keys(gps).length ? gps : null, capturedAt: dateM ? `${dateM[1]}T${dateM[2]}` : null };
      });
      await Promise.all(tasks);
      console.log(`[bg] writing cache to ${cachePath}`);
      try { await writeFile(cachePath, JSON.stringify(cache, null, 2)); } catch (e) { console.error('[bg] cache write error:', e.message); }
    }).catch((e) => { console.error('[bg] readdir error:', e.message); });
  }
  job.counts.receipts = await countFiles(join(root, `imports/${jobId}/raw/receipts`));
  job.counts.vlog = await countFiles(join(root, `imports/${jobId}/raw/vlog`));
  job.status = job.counts.media > 0 ? 'ready' : 'uploading';
  job.updatedAt = new Date().toISOString();

  // Update jobs index
  const idx = jobs.findIndex((j) => j.jobId === jobId);
  if (idx !== -1) {
    jobs[idx] = { ...jobs[idx], ...job };
    await saveJobs(jobs);
  }

  // Update job.json
  await writeFile(join(root, `imports/${jobId}/job.json`), JSON.stringify(job, null, 2) + '\n');

  json(res, 200, {
    jobId,
    type,
    saved,
    counts: job.counts
  });
}

// --- Background job runner ---

const runningJobs = new Map(); // jobId -> child process

async function handleRunJob(req, res, jobId) {
  const body = await readJsonBody(req).catch(() => ({}));
  const doUpload = body?.upload === true;
  const doCleanup = body?.cleanupRaw === true;

  const { jobs, job } = await findJob(jobId);
  if (!job) return error(res, 404, `Job not found: ${jobId}`);
  if (job.counts.media === 0) return error(res, 400, 'At least one media file is required');
  if (job.status === 'processing') {
    return json(res, 200, { jobId, tripId: job.tripId, status: 'processing' });
  }
  if (job.status === 'done') {
    return json(res, 200, { jobId, tripId: job.tripId, status: 'done' });
  }

  // Start background processing
  job.status = 'processing';
  job.phase = 'generating';
  job.progressMessage = '正在生成旅行回顾';
  job.startedAt = new Date().toISOString();
  job.finishedAt = null;
  job.error = null;
  job.result = null;
  job.logs = [];
  job.updatedAt = new Date().toISOString();

  const idx = jobs.findIndex((j) => j.jobId === jobId);
  if (idx !== -1) jobs[idx] = { ...jobs[idx], ...job };
  saveJobs(jobs);
  writeFile(join(root, `imports/${jobId}/job.json`), JSON.stringify(job, null, 2) + '\n');

  // Spawn import-trip.mjs (without --upload, will upload separately after)
  const tripId = job.tripId;
  const importArgs = ['scripts/import-trip.mjs', '--trip', tripId, '--reverse-geocode'];
  if (doCleanup) importArgs.push('--cleanup-raw');

  // Backup existing trip-data.json
  const tripDataPath = join(root, 'trips', tripId, 'data', 'trip-data.json');
  const backupPath = join(root, 'trips', tripId, 'data', 'trip-data.backup.json');
  let hasBackup = false;
  try {
    if (existsSync(tripDataPath)) {
      writeFileSync(backupPath, readFileSync(tripDataPath));
      hasBackup = true;
    }
  } catch {}

  const child = spawn('node', importArgs, {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  runningJobs.set(jobId, child);

  const MAX_LOGS = 100;
  function appendLog(line) {
    job.logs.push(line);
    if (job.logs.length > MAX_LOGS) job.logs = job.logs.slice(-MAX_LOGS);
  }

  child.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) {
      appendLog(line);
      // Parse phase markers: [phase:X/Y]
      const phaseMatch = line.match(/\[phase:(\d+)\/(\d+)\]/);
      if (phaseMatch) {
        const current = parseInt(phaseMatch[1], 10);
        const total = parseInt(phaseMatch[2], 10);
        job.phase = `step-${current}-of-${total}`;
        job.progressPercent = Math.round((current / total) * 100);
        job.progressMessage = line.replace(/\[phase:\d+\/\d+\]\s*/, '');
      } else if (line.includes('扫描媒体') || line.includes('generate-index')) {
        job.phase = 'generating';
        job.progressMessage = '正在扫描媒体和生成数据';
      } else if (line.includes('预览') || line.includes('preview')) {
        job.phase = 'generating';
        job.progressMessage = '正在生成预览图和视频封面';
      } else if (line.includes('改写') || line.includes('rewrite')) {
        job.phase = 'rewriting';
        job.progressMessage = '正在改写媒体路径';
      } else if (line.includes('index') || line.includes('索引')) {
      job.phase = 'indexing';
        job.progressMessage = '正在更新旅行索引';
      }
    }
  });

  child.stderr.on('data', (data) => {
    const lines = data.toString().split('\n').filter(Boolean);
    for (const line of lines) appendLog(`[stderr] ${line}`);
  });

  child.on('close', (code) => {
    if (code === 0) {
      job.status = 'done';
      job.phase = 'done';
      job.progressMessage = '旅行回顾已生成';
      job.result = {
        tripId,
        url: `/?trip=${tripId}`,
        tripDataPath: `trips/${tripId}/data/trip-data.json`
      };
      // Clean up backup on success
      try { if (existsSync(backupPath)) rmSync(backupPath); } catch {}
    } else {
      job.status = 'failed';
      job.phase = 'failed';
      job.progressMessage = '生成失败';
      job.error = job.logs.filter((l) => l.includes('[stderr]')).slice(-5).join('\n') || `Exit code: ${code}`;
      // Restore backup on failure
      if (hasBackup && existsSync(backupPath)) {
        try {
          writeFileSync(tripDataPath, readFileSync(backupPath));
          rmSync(backupPath);
          appendLog('[恢复] 已从备份恢复 trip-data.json');
        } catch {}
      }
    }
    job.finishedAt = new Date().toISOString();
    job.updatedAt = new Date().toISOString();
    runningJobs.delete(jobId);

    // Background COS upload if requested
    if (code === 0 && doUpload) {
      job.phase = 'uploading';
      job.progressMessage = '正在上传到 COS...';
      appendLog('[phase:5/5] 上传到 COS...');
      findJob(jobId).then(({ jobs: freshJobs }) => {
        const i = freshJobs.findIndex((j) => j.jobId === jobId);
        if (i !== -1) freshJobs[i] = { ...freshJobs[i], ...job };
        saveJobs(freshJobs);
        writeFile(join(root, `imports/${jobId}/job.json`), JSON.stringify(job, null, 2) + '\n');
      });

      const uploadChild = spawn('node', ['scripts/upload-cos.mjs', '--trip', tripId], {
        cwd: root,
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 600000
      });
      uploadChild.stdout.on('data', (d) => {
        d.toString().split('\n').filter(Boolean).forEach((l) => appendLog(l));
      });
      uploadChild.stderr.on('data', (d) => {
        d.toString().split('\n').filter(Boolean).forEach((l) => appendLog(`[err] ${l}`));
      });
      uploadChild.on('close', (uploadCode) => {
        if (uploadCode === 0) {
          appendLog('COS 上传完成');
        } else {
          appendLog('COS 上传失败（本地数据仍可用）');
        }
        findJob(jobId).then(({ jobs: freshJobs }) => {
          const i = freshJobs.findIndex((j) => j.jobId === jobId);
          if (i !== -1) {
            freshJobs[i].phase = uploadCode === 0 ? 'done' : 'upload-failed';
            freshJobs[i].progressMessage = uploadCode === 0 ? '已完成' : 'COS 上传失败';
          }
          saveJobs(freshJobs);
        });
      });
    } else {
      findJob(jobId).then(({ jobs: freshJobs }) => {
        const i = freshJobs.findIndex((j) => j.jobId === jobId);
        if (i !== -1) freshJobs[i] = { ...freshJobs[i], ...job };
        saveJobs(freshJobs);
        writeFile(join(root, `imports/${jobId}/job.json`), JSON.stringify(job, null, 2) + '\n');
      });
    }
  });

  child.on('error', (err) => {
    job.status = 'failed';
    job.phase = 'failed';
    job.progressMessage = '启动失败';
    job.error = err.message;
    job.finishedAt = new Date().toISOString();
    job.updatedAt = new Date().toISOString();
    findJob(jobId).then(({ jobs: freshJobs }) => {
      const i = freshJobs.findIndex((j) => j.jobId === jobId);
      if (i !== -1) freshJobs[i] = { ...freshJobs[i], ...job };
      saveJobs(freshJobs);
      writeFile(join(root, `imports/${jobId}/job.json`), JSON.stringify(job, null, 2) + '\n');
    });
  });

  return json(res, 200, { jobId, tripId, status: 'processing' });
}

function parseMultipart(req, targetDir, allowed, skipped) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers, limits: { files: 100 }, defCharset: 'utf8' });
    const saved = [];
    const pending = [];

    bb.on('file', (fieldname, stream, info) => {
      let { filename, encoding, mimeType } = info;
      // Fix garbled Chinese filenames: Busboy decodes UTF-8 as Latin-1
      try {
        const buf = Buffer.from(filename, 'latin1');
        const decoded = buf.toString('utf8');
        // Only use decoded version if it contains valid UTF-8 multibyte sequences
        if (decoded.includes('�') === false && decoded !== filename) {
          filename = decoded;
        }
      } catch { /* keep original */ }
      const safeName = sanitizeFilename(filename);
      const ext = extname(safeName).toLowerCase();

      if (!allowed.has(ext)) {
        stream.resume(); // drain
        pending.push(Promise.reject(new Error(`Unsupported file type: ${ext} (${safeName})`)));
        return;
      }

      // Check if file already exists
      const existingPath = join(targetDir, safeName);
      const fileExists = existsSync(existingPath);

      // If skipped array provided and file exists, skip it
      if (fileExists && skipped) {
        stream.resume(); // drain
        skipped.push(safeName);
        pending.push(Promise.resolve());
        return;
      }

      // Use uniqueFilePath to avoid overwriting (adds suffix if needed)
      const p = uniqueFilePath(targetDir, safeName).then((filePath) => {
        return new Promise((res, rej) => {
          const ws = createWriteStream(filePath);
          let size = 0;
          stream.on('data', (chunk) => { size += chunk.length; });
          stream.pipe(ws);
          ws.on('finish', () => {
            saved.push({
              fileName: basename(filePath),
              path: filePath.replace(root, '').replace(/^\//, ''),
              size
            });
            res();
          });
          ws.on('error', rej);
          stream.on('error', rej);
        });
      });
      pending.push(p);
    });

    bb.on('error', (err) => reject(err));
    bb.on('finish', () => {
      Promise.all(pending)
        .then(() => resolve(saved))
        .catch(reject);
    });

    req.pipe(bb);
  });
}

async function handleGetJob(req, res, jobId) {
  const { job } = await findJob(jobId);
  if (!job) return error(res, 404, `Job not found: ${jobId}`);
  json(res, 200, {
    jobId: job.jobId,
    tripId: job.tripId,
    title: job.title,
    status: job.status,
    phase: job.phase || job.status,
    progressMessage: job.progressMessage || '',
    progressPercent: job.progressPercent || 0,
    counts: job.counts,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    startedAt: job.startedAt || null,
    finishedAt: job.finishedAt || null,
    error: job.error || null,
    result: job.result || null,
    logs: (job.logs || []).slice(-20),
    tripConfigPath: `trips/${job.tripId}/trip-config.json`
  });
}

async function handleListJobs(req, res) {
  const jobs = await loadJobs();
  const list = jobs.map((j) => ({
    jobId: j.jobId,
    tripId: j.tripId,
    title: j.title,
    status: j.status,
    counts: j.counts,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt
  }));
  json(res, 200, { jobs: list });
}

async function handlePatchJob(req, res, jobId) {
  const body = await readJsonBody(req);
  if (!body) return error(res, 400, 'Missing request body');

  const { jobs, job } = await findJob(jobId);
  if (!job) return error(res, 404, `Job not found: ${jobId}`);

  // Update allowed fields
  if (body.title !== undefined) job.title = body.title;
  if (body.subtitle !== undefined) job.subtitle = body.subtitle;
  if (body.dateRange !== undefined) job.dateRange = body.dateRange;
  job.updatedAt = new Date().toISOString();

  // Persist
  const idx = jobs.findIndex((j) => j.jobId === jobId);
  if (idx !== -1) jobs[idx] = { ...jobs[idx], ...job };
  await saveJobs(jobs);
  await writeFile(join(root, `imports/${jobId}/job.json`), JSON.stringify(job, null, 2) + '\n');

  json(res, 200, { ok: true });
}

// --- GPS extraction ---

function runCommand(cmd, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    const timer = setTimeout(() => { child.kill(); resolve(''); }, timeoutMs);
    child.on('close', () => { clearTimeout(timer); resolve(stdout); });
    child.on('error', () => { clearTimeout(timer); resolve(''); });
  });
}

async function extractGpsAndDate(filePath) {
  const ext = extname(filePath).toLowerCase();
  let gps = null;
  let capturedAt = null;

  if (ext === '.jpg' || ext === '.jpeg') {
    try {
      const out = (await runCommand('python3', [join(root, 'scripts/read-jpg-gps.py'), filePath], 10000)).trim();
      if (out) gps = JSON.parse(out);
    } catch (e) {
      console.error(`[gps] failed for ${basename(filePath)}:`, e.message);
    }
  }

  const mdls = await runCommand('mdls', [
    '-name', 'kMDItemLatitude', '-name', 'kMDItemLongitude',
    '-name', 'kMDItemContentCreationDate', filePath
  ], 60000);

  if (!gps && mdls) {
    const latMatch = mdls.match(/kMDItemLatitude\s*=\s*([\d.]+)/);
    const lngMatch = mdls.match(/kMDItemLongitude\s*=\s*([\d.]+)/);
    if (latMatch && lngMatch) gps = { lat: parseFloat(latMatch[1]), lng: parseFloat(lngMatch[1]) };
  }
  if (mdls) {
    const dateMatch = mdls.match(/kMDItemContentCreationDate\s*=\s*(\d{4}-\d{2}-\d{2})[\sT](\d{2}:\d{2}:\d{2})/);
    if (dateMatch) capturedAt = `${dateMatch[1]}T${dateMatch[2]}`;
    if (!capturedAt) {
      const altMatch = mdls.match(/kMDItemContentCreationDate\s*=\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})/);
      if (altMatch) capturedAt = `${altMatch[1]}T${altMatch[2]}`;
    }
  }
  return { gps, capturedAt };
}

function guessTimezone(lng) {
  // Simple timezone guess: UTC offset = round(lng / 15)
  return Math.round(lng / 15);
}

async function handleCancelJob(req, res, jobId) {
  const child = runningJobs.get(jobId);
  if (!child) return error(res, 400, 'Job is not running');

  child.kill('SIGTERM');
  runningJobs.delete(jobId);

  const { jobs, job } = await findJob(jobId);
  if (job) {
    job.status = 'failed';
    job.phase = 'cancelled';
    job.progressMessage = '已取消';
    job.finishedAt = new Date().toISOString();
    job.updatedAt = new Date().toISOString();
    const idx = jobs.findIndex((j) => j.jobId === jobId);
    if (idx !== -1) jobs[idx] = { ...jobs[idx], ...job };
    await saveJobs(jobs);
    await writeFile(join(root, `imports/${jobId}/job.json`), JSON.stringify(job, null, 2) + '\n');
  }

  json(res, 200, { ok: true, status: 'cancelled' });
}

async function handleGetMedia(req, res, jobId) {
  const { job } = await findJob(jobId);
  if (!job) return error(res, 404, `Job not found: ${jobId}`);

  const mediaDir = join(root, `imports/${jobId}/raw/media`);
  let files = [];
  try {
    files = (await readdir(mediaDir)).filter((f) => !f.startsWith('.'));
  } catch { /* empty */ }

  const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.heic', '.heif']);
  const VIDEO_EXT = new Set(['.mov', '.mp4', '.m4v']);

  // Process all files - mdls for EXIF, fallback to mtime
  const results = await Promise.all(files.map(async (file) => {
    const ext = extname(file).toLowerCase();
    const isImage = IMAGE_EXT.has(ext);
    const isVideo = VIDEO_EXT.has(ext);
    let gps = null;
    let capturedAt = null;

    // Try mdls for GPS and date (works for images and videos)
    try {
      const mdlsOut = await runCommand('mdls', [
        '-name', 'kMDItemLatitude', '-name', 'kMDItemLongitude',
        '-name', 'kMDItemContentCreationDate', join(mediaDir, file)
      ], 60000);
      if (mdlsOut) {
        const latM = mdlsOut.match(/kMDItemLatitude\s*=\s*([\d.]+)/);
        const lngM = mdlsOut.match(/kMDItemLongitude\s*=\s*([\d.]+)/);
        if (latM && lngM) gps = { lat: parseFloat(latM[1]), lng: parseFloat(lngM[1]) };
        const dateM = mdlsOut.match(/kMDItemContentCreationDate\s*=\s*(\d{4}-\d{2}-\d{2})[\sT ](\d{2}:\d{2}:\d{2})/);
        if (dateM) capturedAt = `${dateM[1]}T${dateM[2]}`;
      }
    } catch { /* ignore */ }

    // Fallback: use file mtime for date
    if (!capturedAt) {
      try {
        const st = await stat(join(mediaDir, file));
        capturedAt = new Date(st.mtime).toISOString().slice(0, 19);
      } catch { /* ignore */ }
    }

    return { fileName: file, isImage, isVideo, gps, capturedAt };
  }));

  const gpsPoints = [];
  const dates = [];
  for (const r of results) {
    if (r.gps && Number.isFinite(r.gps.lat) && Number.isFinite(r.gps.lng)) gpsPoints.push(r.gps);
    if (r.capturedAt) dates.push(r.capturedAt);
  }

  // Auto-detect settings
  const autoSettings = {};
  if (gpsPoints.length > 0) {
    const avgLat = gpsPoints.reduce((s, p) => s + p.lat, 0) / gpsPoints.length;
    const avgLng = gpsPoints.reduce((s, p) => s + p.lng, 0) / gpsPoints.length;
    autoSettings.defaultMapCenter = [Math.round(avgLat * 10000) / 10000, Math.round(avgLng * 10000) / 10000];
    autoSettings.timezoneOffsetHours = guessTimezone(avgLng);
  }
  if (dates.length > 0) {
    dates.sort();
    autoSettings.dateRange = [dates[0].slice(0, 10), dates[dates.length - 1].slice(0, 10)];
  }

  json(res, 200, { files: results, autoSettings });
}

async function handleUpdateConfig(req, res, jobId) {
  const body = await readJsonBody(req);
  if (!body) return error(res, 400, 'Missing request body');

  const { jobs, job } = await findJob(jobId);
  if (!job) return error(res, 404, `Job not found: ${jobId}`);

  const tripId = job.tripId;
  const configPath = join(root, `trips/${tripId}/trip-config.json`);
  let config;
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    return error(res, 500, 'Cannot read trip-config.json');
  }

  // Update allowed fields
  if (body.title !== undefined) config.title = body.title;
  if (body.subtitle !== undefined) config.subtitle = body.subtitle;
  if (body.dateRange !== undefined) config.dateRange = body.dateRange;
  if (body.cover !== undefined) config.cover = body.cover;
  if (body.defaultMapCenter) config.defaultMapCenter = body.defaultMapCenter;
  if (body.timezoneOffsetHours !== undefined) config.timezoneOffsetHours = body.timezoneOffsetHours;
  if (body.defaultPlaceName) config.defaultPlaceName = body.defaultPlaceName;

  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');

  json(res, 200, { ok: true, config });
}

// --- Body parsing ---

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// --- Trip supplement handlers ---

// Track running trip generations
const tripRunStatus = {};

async function handleTripCheckFiles(req, res, tripId) {
  const body = await readJsonBody(req);
  if (!body?.files?.length) return error(res, 400, 'Missing files list');

  const configPath = join(root, 'trips', tripId, 'trip-config.json');
  let config;
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    return error(res, 404, `Trip not found: ${tripId}`);
  }

  const mediaDir = join(root, config.sourceDirs?.media || `trips/${tripId}/raw/media`);
  const existingFiles = new Set();
  try {
    const files = await readdir(mediaDir);
    files.forEach((f) => existingFiles.add(f));
  } catch { /* directory doesn't exist yet */ }

  const duplicates = body.files.filter((f) => existingFiles.has(f));

  json(res, 200, { tripId, duplicates, existingCount: existingFiles.size });
}

async function handleTripUpload(req, res, tripId) {
  const configPath = join(root, 'trips', tripId, 'trip-config.json');
  let config;
  try {
    config = JSON.parse(await readFile(configPath, 'utf8'));
  } catch {
    return error(res, 404, `Trip not found: ${tripId}`);
  }

  // Upload to the original source directory (don't change sourceDirs)
  const mediaDir = join(root, config.sourceDirs?.media || `trips/${tripId}/raw/media`);
  await mkdir(mediaDir, { recursive: true });

  // Check for replace mode from query string
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const replaceMode = url.searchParams.get('replace') === 'true';

  let allowed = new Set([...ALLOWED_MEDIA_EXT, ...ALLOWED_VIDEO_EXT]);
  const saved = [];
  const skipped = [];

  try {
    const files = await parseMultipart(req, mediaDir, allowed, replaceMode ? null : skipped);
    saved.push(...files);
  } catch (err) {
    return error(res, 400, err.message);
  }

  json(res, 200, { tripId, saved, skipped, count: saved.length });
}

function handleTripRun(req, res, tripId) {
  const configPath = join(root, 'trips', tripId, 'trip-config.json');
  if (!existsSync(configPath)) return error(res, 404, `Trip not found: ${tripId}`);

  // Check if source directory has files
  let config;
  try { config = JSON.parse(readFileSync(configPath, 'utf8')); } catch { return error(res, 500, 'Cannot read config'); }
  const mediaDir = join(root, config.sourceDirs?.media || `trips/${tripId}/raw/media`);
  try {
    const files = readdirSync(mediaDir).filter((f) => !f.startsWith('.'));
    if (files.length === 0) return error(res, 400, '源目录为空，请先上传素材');
  } catch { return error(res, 400, '源目录不存在，请先上传素材'); }

  if (tripRunStatus[tripId] === 'running') {
    return json(res, 200, { tripId, status: 'running' });
  }

  tripRunStatus[tripId] = 'running';

  // Backup existing trip-data.json before regeneration
  const tripDataPath = join(root, 'trips', tripId, 'data', 'trip-data.json');
  const backupPath = join(root, 'trips', tripId, 'data', 'trip-data.backup.json');
  let hasBackup = false;
  try {
    if (existsSync(tripDataPath)) {
      const data = readFileSync(tripDataPath);
      writeFileSync(backupPath, data);
      hasBackup = true;
    }
  } catch { /* ignore */ }

  const child = spawn('node', ['scripts/import-trip.mjs', '--trip', tripId, '--upload', '--reverse-geocode'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  const logs = [];
  child.stdout.on('data', (d) => {
    d.toString().split('\n').filter(Boolean).forEach((l) => {
      logs.push(l);
      if (logs.length > 100) logs.shift();
    });
  });
  child.stderr.on('data', (d) => {
    d.toString().split('\n').filter(Boolean).forEach((l) => {
      logs.push(`[err] ${l}`);
      if (logs.length > 100) logs.shift();
    });
  });

  child.on('close', (code) => {
    if (code === 0) {
      tripRunStatus[tripId] = 'done';
      // Clean up backup on success
      try { if (existsSync(backupPath)) rmSync(backupPath); } catch {}
    } else {
      tripRunStatus[tripId] = 'failed';
      console.error(`[trip-run] ${tripId} failed with code ${code}`);
      // Restore backup on failure
      if (hasBackup && existsSync(backupPath)) {
        try {
          writeFileSync(tripDataPath, readFileSync(backupPath));
          rmSync(backupPath);
          console.log(`[trip-run] ${tripId} restored trip-data.json from backup`);
        } catch (e) {
          console.error(`[trip-run] ${tripId} backup restore failed:`, e.message);
        }
      }
    }
  });
  child.on('error', (e) => {
    tripRunStatus[tripId] = 'failed';
    console.error(`[trip-run] ${tripId} error:`, e.message);
    // Restore backup on error
    if (hasBackup && existsSync(backupPath)) {
      try {
        writeFileSync(tripDataPath, readFileSync(backupPath));
        rmSync(backupPath);
      } catch {}
    }
  });

  json(res, 200, { tripId, status: 'running' });
}

function handleTripStatus(req, res, tripId) {
  const status = tripRunStatus[tripId] || 'idle';
  json(res, 200, { tripId, status });
}

async function handleTripPatch(req, res, tripId) {
  const body = await readJsonBody(req);
  if (!body) return error(res, 400, 'Missing request body');

  const configPath = join(root, 'trips', tripId, 'trip-config.json');
  let config;
  try { config = JSON.parse(await readFile(configPath, 'utf8')); }
  catch { return error(res, 404, `Trip not found: ${tripId}`); }

  if (body.title !== undefined) config.title = body.title;
  if (body.subtitle !== undefined) config.subtitle = body.subtitle;
  if (body.cover !== undefined) config.cover = body.cover;
  if (body.dateRange !== undefined) config.dateRange = body.dateRange;

  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n');

  // Update trips/index.json
  const indexPath = join(root, 'trips', 'index.json');
  try {
    const idx = JSON.parse(await readFile(indexPath, 'utf8'));
    const entry = idx.trips.find((t) => t.id === tripId);
    if (entry) {
      if (body.title !== undefined) entry.title = body.title;
      if (body.subtitle !== undefined) entry.subtitle = body.subtitle;
      if (body.cover !== undefined) entry.cover = body.cover;
      if (body.dateRange !== undefined) entry.dateRange = body.dateRange;
      await writeFile(indexPath, JSON.stringify(idx, null, 2) + '\n');
    }
  } catch { /* ignore */ }

  json(res, 200, { ok: true, config });
}

async function handleTripDelete(req, res, tripId) {
  // Prevent deleting 2025-japan
  if (tripId === '2025-japan') return error(res, 403, 'Cannot delete the default trip');

  const tripDir = join(root, 'trips', tripId);
  if (!existsSync(tripDir)) return error(res, 404, `Trip not found: ${tripId}`);

  // Remove trip directory
  const { rmSync } = await import('node:fs');
  try { rmSync(tripDir, { recursive: true, force: true }); } catch (e) {
    return error(res, 500, `Failed to delete trip directory: ${e.message}`);
  }

  // Remove associated import jobs
  try {
    const importsDir = join(root, 'imports');
    if (existsSync(importsDir)) {
      const jobs = readdirSync(importsDir).filter((f) => f.startsWith('job-'));
      for (const jobDir of jobs) {
        const jobJsonPath = join(importsDir, jobDir, 'job.json');
        try {
          const jobData = JSON.parse(readFileSync(jobJsonPath, 'utf8'));
          if (jobData.tripId === tripId) {
            rmSync(join(importsDir, jobDir), { recursive: true, force: true });
          }
        } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }

  // Remove from trips/index.json
  const indexPath = join(root, 'trips', 'index.json');
  try {
    const idx = JSON.parse(await readFile(indexPath, 'utf8'));
    idx.trips = idx.trips.filter((t) => t.id !== tripId);
    await writeFile(indexPath, JSON.stringify(idx, null, 2) + '\n');
  } catch { /* ignore */ }

  // Remove from import-jobs.json
  try {
    const jobsFile = join(root, 'data', 'import-jobs.json');
    const jobs = JSON.parse(await readFile(jobsFile, 'utf8'));
    const filtered = jobs.filter((j) => j.tripId !== tripId);
    await writeFile(jobsFile, JSON.stringify(filtered, null, 2) + '\n');
  } catch { /* ignore */ }

  json(res, 200, { ok: true, deleted: tripId });
}

async function handleDeleteMedia(req, res, tripId, mediaId) {
  const dataPath = join(root, 'trips', tripId, 'data', 'trip-data.json');
  let data;
  try { data = JSON.parse(await readFile(dataPath, 'utf8')); }
  catch { return error(res, 404, 'Trip data not found'); }

  const mediaIdx = data.media?.findIndex((m) => m.id === mediaId);
  if (mediaIdx === -1 || mediaIdx === undefined) return error(res, 404, 'Media not found');

  const mediaItem = data.media[mediaIdx];

  // Remove media from data
  data.media.splice(mediaIdx, 1);

  // Remove media ID from all days
  for (const day of (data.days || [])) {
    if (day.media) {
      day.media = day.media.filter((id) => id !== mediaId);
    }
  }

  // Remove associated GPS place if it was only used by this media
  if (mediaItem.location?.lat && mediaItem.location?.lng) {
    for (const day of (data.days || [])) {
      if (day.places) {
        day.places = day.places.filter((p) => {
          if (p.source !== 'gps') return true;
          // Remove if coordinates match closely
          const latDiff = Math.abs(p.lat - mediaItem.location.lat);
          const lngDiff = Math.abs(p.lng - mediaItem.location.lng);
          return !(latDiff < 0.0001 && lngDiff < 0.0001);
        });
      }
    }
  }

  await writeFile(dataPath, JSON.stringify(data, null, 2) + '\n');

  // Delete preview file if exists
  if (mediaItem.src) {
    const previewPath = join(root, mediaItem.src.replace(/^\.\//, ''));
    try { if (existsSync(previewPath)) rmSync(previewPath); } catch {}
  }

  json(res, 200, { ok: true, deleted: mediaId });
}

async function handleDeleteDay(req, res, tripId, dayId) {
  const dataPath = join(root, 'trips', tripId, 'data', 'trip-data.json');
  let data;
  try { data = JSON.parse(await readFile(dataPath, 'utf8')); }
  catch { return error(res, 404, 'Trip data not found'); }

  const dayIdx = data.days?.findIndex((d) => d.id === dayId);
  if (dayIdx === -1 || dayIdx === undefined) return error(res, 404, 'Day not found');

  const day = data.days[dayIdx];
  const mediaIds = new Set(day.media || []);

  // Remove day
  data.days.splice(dayIdx, 1);

  // Remove associated media
  if (mediaIds.size > 0) {
    data.media = data.media?.filter((m) => !mediaIds.has(m.id)) || [];
  }

  await writeFile(dataPath, JSON.stringify(data, null, 2) + '\n');

  json(res, 200, { ok: true, deleted: dayId, removedMedia: mediaIds.size });
}

async function handleGetPlaces(req, res, tripId) {
  const overridesPath = join(root, 'trips', tripId, 'data', 'place-overrides.json');
  try {
    const data = JSON.parse(await readFile(overridesPath, 'utf8'));
    json(res, 200, data);
  } catch {
    json(res, 200, { overrides: {} });
  }
}

async function handlePatchPlaces(req, res, tripId) {
  const body = await readJsonBody(req);
  if (!body?.placeId) return error(res, 400, 'Missing placeId');

  const overridesPath = join(root, 'trips', tripId, 'data', 'place-overrides.json');
  let overrides = {};
  try { overrides = JSON.parse(await readFile(overridesPath, 'utf8')); } catch { /* empty */ }

  if (!overrides.overrides) overrides.overrides = {};
  overrides.overrides[body.placeId] = {
    ...(overrides.overrides[body.placeId] || {}),
    ...body.fields,
    updatedAt: new Date().toISOString()
  };

  await writeFile(overridesPath, JSON.stringify(overrides, null, 2) + '\n');
  json(res, 200, { ok: true });
}

function handleTripThumbnails(req, res, tripId) {
  // Find preview directory
  const previewDirs = [
    join(root, 'trips', tripId, 'generated', 'previews'),
    join(root, 'public', 'generated', 'previews')
  ];

  let previewDir = null;
  for (const dir of previewDirs) {
    if (existsSync(dir)) { previewDir = dir; break; }
  }
  if (!previewDir) return json(res, 200, { thumbnails: [] });

  try {
    const files = readdirSync(previewDir)
      .filter((f) => !f.startsWith('.') && /\.(jpg|jpeg|png)$/i.test(f))
      .slice(0, 50)
      .map((f) => ({
        fileName: f,
        url: `/trips/${tripId}/generated/previews/${f}`
      }));
    json(res, 200, { thumbnails: files });
  } catch {
    json(res, 200, { thumbnails: [] });
  }
}

// --- Router ---

function parseUrl(req) {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  return { pathname: decodeURIComponent(url.pathname), query: Object.fromEntries(url.searchParams) };
}

const MIME_TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.mjs': 'application/javascript', '.json': 'application/json',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.heic': 'image/heic', '.heif': 'image/heif', '.gif': 'image/gif',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webp': 'image/webp',
  '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.m4v': 'video/x-m4v',
  '.pdf': 'application/pdf', '.woff2': 'font/woff2', '.woff': 'font/woff',
  '.ttf': 'font/ttf', '.txt': 'text/plain', '.xml': 'text/xml'
};

const server = http.createServer(async (req, res) => {
  try {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      setCors(res);
      res.writeHead(204);
      res.end();
      return;
    }

    const { pathname, query } = parseUrl(req);

    // Serve thumbnail (convert HEIC to JPEG on the fly)
    const thumbMatch = pathname.match(/^\/api\/import-jobs\/([^/]+)\/thumbnail\/(.+)$/);
    if (req.method === 'GET' && thumbMatch) {
      const jobId = thumbMatch[1];
      const fileName = decodeURIComponent(thumbMatch[2]);
      const filePath = join(root, 'imports', jobId, 'raw', 'media', fileName);
      if (!filePath.startsWith(join(root, 'imports', jobId))) { error(res, 403, 'Forbidden'); return; }
      try {
        await stat(filePath);
      } catch { error(res, 404, 'Not found'); return; }

      const ext = extname(fileName).toLowerCase();
      if (ext === '.heic' || ext === '.heif') {
        // Convert HEIC to JPEG using sips
        const tmpPath = join(root, 'imports', jobId, 'raw', 'media', `.thumb_${basename(fileName, ext)}.jpg`);
        try {
          execFileSync('sips', ['-s', 'format', 'jpeg', '-Z', '400', filePath, '--out', tmpPath], {
            stdio: ['ignore', 'ignore', 'ignore'], timeout: 10000
          });
          const { createReadStream } = await import('node:fs');
          const fileStat = await stat(tmpPath);
          setCors(res);
          res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': fileStat.size });
          createReadStream(tmpPath).pipe(res);
        } catch (e) {
          console.error('[thumb] conversion failed:', e.message);
          error(res, 500, 'Thumbnail conversion failed');
        }
      } else {
        // Serve directly for JPG/PNG
        try {
          const fileStat = await stat(filePath);
          const mime = MIME_TYPES[ext] || 'image/jpeg';
          setCors(res);
          res.writeHead(200, { 'Content-Type': mime, 'Content-Length': fileStat.size });
          const { createReadStream } = await import('node:fs');
          createReadStream(filePath).pipe(res);
        } catch {
          error(res, 404, 'Not found');
        }
      }
      return;
    }

    // Serve static files from imports/ directory
    if (req.method === 'GET' && pathname.startsWith('/imports/')) {
      const filePath = join(root, pathname);
      // Security: ensure the path is within imports/
      if (!filePath.startsWith(join(root, 'imports/'))) {
        error(res, 403, 'Forbidden');
        return;
      }
      try {
        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) { error(res, 404, 'Not found'); return; }
        const ext = extname(filePath).toLowerCase();
        const mime = MIME_TYPES[ext] || 'application/octet-stream';
        setCors(res);
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': fileStat.size });
        const { createReadStream } = await import('node:fs');
        createReadStream(filePath).pipe(res);
      } catch {
        error(res, 404, 'Not found');
      }
      return;
    }

    // Serve static files from trips/ directory (previews, generated)
    if (req.method === 'GET' && pathname.startsWith('/trips/')) {
      const filePath = join(root, pathname);
      if (!filePath.startsWith(join(root, 'trips/'))) { error(res, 403, 'Forbidden'); return; }
      try {
        const fileStat = await stat(filePath);
        if (!fileStat.isFile()) { error(res, 404, 'Not found'); return; }
        const ext = extname(filePath).toLowerCase();
        const mime = MIME_TYPES[ext] || 'application/octet-stream';
        setCors(res);
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': fileStat.size });
        const { createReadStream } = await import('node:fs');
        createReadStream(filePath).pipe(res);
      } catch {
        error(res, 404, 'Not found');
      }
      return;
    }

    // POST /api/import-jobs
    if (req.method === 'POST' && pathname === '/api/import-jobs') {
      return await handleCreateJob(req, res);
    }

    // POST /api/import-jobs/:jobId/files?type=xxx
    const uploadMatch = pathname.match(/^\/api\/import-jobs\/([^/]+)\/files$/);
    if (req.method === 'POST' && uploadMatch) {
      return await handleUpload(req, res, uploadMatch[1], query.type);
    }

    // POST /api/import-jobs/:jobId/run
    const runMatch = pathname.match(/^\/api\/import-jobs\/([^/]+)\/run$/);
    if (req.method === 'POST' && runMatch) {
      return handleRunJob(req, res, runMatch[1]);
    }

    // POST /api/import-jobs/:jobId/cancel
    const cancelMatch = pathname.match(/^\/api\/import-jobs\/([^/]+)\/cancel$/);
    if (req.method === 'POST' && cancelMatch) {
      return await handleCancelJob(req, res, cancelMatch[1]);
    }

    // GET /api/import-jobs/:jobId/media
    const mediaMatch = pathname.match(/^\/api\/import-jobs\/([^/]+)\/media$/);
    if (req.method === 'GET' && mediaMatch) {
      return await handleGetMedia(req, res, mediaMatch[1]);
    }

    // PATCH /api/import-jobs/:jobId/config
    const configMatch = pathname.match(/^\/api\/import-jobs\/([^/]+)\/config$/);
    if (req.method === 'PATCH' && configMatch) {
      return await handleUpdateConfig(req, res, configMatch[1]);
    }

    // PATCH /api/import-jobs/:jobId
    const jobPatchMatch = pathname.match(/^\/api\/import-jobs\/([^/]+)$/);
    if (req.method === 'PATCH' && jobPatchMatch) {
      return await handlePatchJob(req, res, jobPatchMatch[1]);
    }

    // GET /api/import-jobs/:jobId
    const jobMatch = pathname.match(/^\/api\/import-jobs\/([^/]+)$/);
    if (req.method === 'GET' && jobMatch) {
      return await handleGetJob(req, res, jobMatch[1]);
    }

    // GET /api/import-jobs
    if (req.method === 'GET' && pathname === '/api/import-jobs') {
      return await handleListJobs(req, res);
    }

    // POST /api/trips/:tripId/check-files — check for duplicate files
    const tripCheckMatch = pathname.match(/^\/api\/trips\/([^/]+)\/check-files$/);
    if (req.method === 'POST' && tripCheckMatch) {
      return await handleTripCheckFiles(req, res, tripCheckMatch[1]);
    }

    // POST /api/trips/:tripId/files — supplement existing trip
    const tripUploadMatch = pathname.match(/^\/api\/trips\/([^/]+)\/files$/);
    if (req.method === 'POST' && tripUploadMatch) {
      return await handleTripUpload(req, res, tripUploadMatch[1]);
    }

    // POST /api/trips/:tripId/run — re-generate existing trip
    const tripRunMatch = pathname.match(/^\/api\/trips\/([^/]+)\/run$/);
    if (req.method === 'POST' && tripRunMatch) {
      return handleTripRun(req, res, tripRunMatch[1]);
    }

    // GET /api/trips/:tripId/status — check generation status
    const tripStatusMatch = pathname.match(/^\/api\/trips\/([^/]+)\/status$/);
    if (req.method === 'GET' && tripStatusMatch) {
      return handleTripStatus(req, res, tripStatusMatch[1]);
    }

    // PATCH /api/trips/:tripId — update trip metadata
    const tripPatchMatch = pathname.match(/^\/api\/trips\/([^/]+)$/);
    if (req.method === 'PATCH' && tripPatchMatch) {
      return await handleTripPatch(req, res, tripPatchMatch[1]);
    }

    // DELETE /api/trips/:tripId — delete trip
    const tripDeleteMatch = pathname.match(/^\/api\/trips\/([^/]+)$/);
    if (req.method === 'DELETE' && tripDeleteMatch) {
      return await handleTripDelete(req, res, tripDeleteMatch[1]);
    }

    // GET /api/trips/:tripId/thumbnails — get preview thumbnails for cover selection
    const tripThumbsMatch = pathname.match(/^\/api\/trips\/([^/]+)\/thumbnails$/);
    if (req.method === 'GET' && tripThumbsMatch) {
      return handleTripThumbnails(req, res, tripThumbsMatch[1]);
    }

    // GET/PATCH /api/trips/:tripId/places — place name overrides
    const placesMatch = pathname.match(/^\/api\/trips\/([^/]+)\/places$/);
    if (placesMatch) {
      if (req.method === 'GET') return handleGetPlaces(req, res, placesMatch[1]);
      if (req.method === 'PATCH') return handlePatchPlaces(req, res, placesMatch[1]);
    }

    // DELETE /api/trips/:tripId/media/:mediaId — delete a media item and its GPS place
    const mediaDeleteMatch = pathname.match(/^\/api\/trips\/([^/]+)\/media\/([^/]+)$/);
    if (req.method === 'DELETE' && mediaDeleteMatch) {
      return handleDeleteMedia(req, res, mediaDeleteMatch[1], mediaDeleteMatch[2]);
    }

    // DELETE /api/trips/:tripId/days/:dayId — delete a day
    const dayDeleteMatch = pathname.match(/^\/api\/trips\/([^/]+)\/days\/([^/]+)$/);
    if (req.method === 'DELETE' && dayDeleteMatch) {
      return handleDeleteDay(req, res, dayDeleteMatch[1], dayDeleteMatch[2]);
    }

    // Serve static files from project root (index.html, src/*, public/*, etc.)
    if (req.method === 'GET' && !pathname.startsWith('/api/')) {
      let filePath = join(root, pathname === '/' ? 'index.html' : pathname);
      // Security: ensure path is within project root
      if (!filePath.startsWith(root)) { error(res, 403, 'Forbidden'); return; }
      try {
        const fileStat = await stat(filePath);
        if (fileStat.isDirectory()) filePath = join(filePath, 'index.html');
        if ((await stat(filePath)).isFile()) {
          const ext = extname(filePath).toLowerCase();
          const mime = MIME_TYPES[ext] || 'text/html';
          setCors(res);
          res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=3600' });
          const { createReadStream } = await import('node:fs');
          createReadStream(filePath).pipe(res);
          return;
        }
      } catch { /* not found, fall through to 404 */ }
    }

    error(res, 404, 'Not found');
  } catch (err) {
    console.error('Server error:', err);
    error(res, 500, 'Internal server error');
  }
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  旅行回顾服务已启动`);
  console.log(`  本地访问: http://localhost:${PORT}`);
  console.log(`  局域网:   http://0.0.0.0:${PORT}\n`);
  console.log(`  API:`);
  console.log(`    POST   /api/import-jobs`);
  console.log(`    POST   /api/import-jobs/:id/files`);
  console.log(`    POST   /api/import-jobs/:id/run`);
  console.log(`    GET    /api/import-jobs/:id/media`);
  console.log(`    PATCH  /api/import-jobs/:id/config`);
  console.log(`    GET    /api/import-jobs/:id`);
  console.log(`    GET    /api/import-jobs`);
  console.log(`    DELETE /api/trips/:tripId`);
  console.log(`    PATCH  /api/trips/:tripId`);
  console.log(`    GET    /api/trips/:tripId/thumbnails`);
  console.log(`    GET    /api/trips/:tripId/places`);
  console.log(`    PATCH  /api/trips/:tripId/places`);
});
