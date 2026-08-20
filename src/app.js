const DATA_URL = './public/data/trip-data.json';
const INDEX_URL = './trips/index.json';
const API_BASE = '';

function resolveAssetUrl(src, baseUrl) {
  if (!src) return src;
  if (src.startsWith('http://') || src.startsWith('https://')) return src;
  if (src.startsWith('./') || src.startsWith('/')) return src;
  const base = baseUrl || state.data?.trip?.assetBaseUrl;
  if (base) return base + src.replace(/^\.\//, '').replace(/^public\//, '');
  return src;
}

const fallbackData = {
  trip: {
    title: '旅行回顾',
    subtitle: '导入素材后自动生成',
    generatedAt: null
  },
  days: [],
  media: []
};

const state = {
  data: fallbackData,
  maps: [],
  mapObserver: null,
  photoPreviewEl: null,
  viewportRefreshBound: false,
  viewportRefreshFrame: null
};

const els = {
  summaryDays: document.querySelector('#summary-days'),
  summaryMedia: document.querySelector('#summary-media'),
  summaryPlaces: document.querySelector('#summary-places')
};

const MEDIA_PREVIEW_COUNT = 8;
const DEFAULT_MAP_CENTER = [30, 105];
const MAP_FIT_PADDING = [24, 24];
const MAP_SINGLE_POINT_ZOOM = 14;
const DEFAULT_TILE_LAYER = {
  url: 'https://tile.openstreetmap.de/{z}/{x}/{y}.png',
  options: {
    maxZoom: 18,
    attribution: '&copy; OpenStreetMap contributors'
  }
};

function photoTooltipFallback(imgEl) {
  const card = imgEl.closest('.photo-tooltip-card');
  if (!card) return;
  const candidates = JSON.parse(card.dataset.candidates || '[]');
  let index = parseInt(card.dataset.index || '0', 10) + 1;
  while (index < candidates.length) {
    card.dataset.index = String(index);
    imgEl.src = candidates[index];
    return;
  }
  // All images failed, show "no photo available" message
  card.classList.add('photo-tooltip-card--image-error');
  const label = card.querySelector('.photo-tooltip-label');
  if (label) {
    label.innerHTML = '<strong>' + escapeHtml(label.querySelector('strong')?.textContent || '地点') + '</strong><span>暂无可用照片</span>';
  }
}

async function init() {
  console.log('[init] URL:', window.location.href);
  const params = new URLSearchParams(window.location.search);
  const tripId = params.get('trip');

  if (params.has('import')) {
    console.log('[init] → import wizard, step:', importState.step, 'jobId:', importState.jobId);
    renderImportWizard();
  } else if (tripId) {
    console.log('[init] → trip:', tripId);
    await loadAndRenderTrip(tripId);
  } else {
    console.log('[init] → trip list');
    await renderTripList();
  }
}

async function loadAndRenderTrip(tripId) {
  let tripMeta = null;
  let dataUrl = DATA_URL;
  let assetBaseUrl = null;

  // Try to find trip in index
  try {
    const idxRes = await fetch(INDEX_URL, { cache: 'no-store' });
    if (idxRes.ok) {
      const idx = await idxRes.json();
      tripMeta = idx.trips.find((t) => t.id === tripId);
      if (tripMeta) {
        dataUrl = tripMeta.dataUrl;
        assetBaseUrl = tripMeta.assetBaseUrl;
      }
    }
  } catch { /* fallback */ }

  if (!tripMeta) {
    // Trip not found — show list
    await renderTripList();
    return;
  }

  const data = await loadData(dataUrl);
  if (assetBaseUrl && !data.trip?.assetBaseUrl) {
    data.trip = data.trip || {};
    data.trip.assetBaseUrl = assetBaseUrl;
  }

  // Load and merge place overrides
  try {
    const overridesRes = await fetch(`./trips/${tripId}/data/place-overrides.json`, { cache: 'no-store' });
    if (overridesRes.ok) {
      const overrides = await overridesRes.json();
      if (overrides.overrides) {
        for (const day of (data.days || [])) {
          for (const place of (day.places || [])) {
            const ov = overrides.overrides[place.id];
            if (ov) {
              if (ov.displayName) place.displayName = ov.displayName;
              if (ov.displayNote !== undefined) place.displayNote = ov.displayNote;
            }
          }
        }
      }
    }
  } catch { /* no overrides */ }

  state.data = normalizeTripData(data);
  state.tripId = tripId;

  // Update page title
  document.title = data.trip?.title || '旅行回顾';

  // Hide the static hero section from index.html
  const hero = document.querySelector('.hero');
  if (hero) hero.style.display = 'none';

  // Add supplement import button
  renderSupplementButton(tripId, tripMeta);

  renderJournal();
  setupNavObserver();
}

function renderSupplementButton(tripId, tripMeta) {
  const journal = document.querySelector('#journal');
  if (!journal) return;

  const existing = document.querySelector('.supplement-bar');
  if (existing) existing.remove();

  const bar = document.createElement('div');
  bar.className = 'supplement-bar';
  bar.id = 'supplement-bar';
  const dr = tripMeta?.dateRange;
  const dateText = dr && dr.length >= 2 ? `${dr[0]} — ${dr[1]}` : '';
  bar.innerHTML = `
    <div class="supplement-inner">
      <div class="supplement-left">
        <a class="import-btn secondary supplement-home" href="?">← 旅行库</a>
        <div class="supplement-info">
          <strong class="supplement-title" id="supplement-title" title="点击编辑">${escapeHtml(tripMeta?.title || tripId)}</strong>
          ${dateText ? `<span class="supplement-meta">${escapeHtml(dateText)}</span>` : ''}
        </div>
      </div>
      <nav class="supplement-nav" id="supplement-nav" aria-label="日期快速跳转"></nav>
      <div class="supplement-right">
        <button class="import-btn secondary supplement-cover-btn" id="supplement-cover-btn" title="更换封面">封面</button>
        <button class="import-btn primary supplement-btn" id="supplement-upload-btn">补充素材</button>
        <div class="supplement-menu-wrap">
          <button class="import-btn secondary supplement-menu-btn" id="supplement-menu-btn" title="更多">⋯</button>
          <div class="supplement-menu" id="supplement-menu">
            <button class="supplement-menu-item danger" id="supplement-delete-btn">删除旅记</button>
          </div>
        </div>
      </div>
    </div>
  `;
  journal.parentElement.insertBefore(bar, journal);

  // Title editing
  document.getElementById('supplement-title').addEventListener('click', () => {
    showTitleEditDialog(tripId, tripMeta);
  });

  // Cover change
  document.getElementById('supplement-cover-btn').addEventListener('click', () => {
    showCoverEditDialog(tripId, tripMeta);
  });

  document.getElementById('supplement-upload-btn').addEventListener('click', () => {
    showSupplementUpload(tripId);
  });

  // Menu toggle
  const menuBtn = document.getElementById('supplement-menu-btn');
  const menu = document.getElementById('supplement-menu');
  menuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    menu.classList.toggle('open');
  });
  document.addEventListener('click', () => menu.classList.remove('open'));

  // Delete trip
  document.getElementById('supplement-delete-btn').addEventListener('click', () => {
    menu.classList.remove('open');
    showDeleteConfirmDialog(tripId, tripMeta?.title || tripId);
  });
}

function showSupplementUpload(tripId) {
  // Find existing overlay or create one
  let overlay = document.querySelector('.supplement-overlay');
  if (overlay) overlay.remove();

  overlay = document.createElement('div');
  overlay.className = 'supplement-overlay';
  overlay.innerHTML = `
    <div class="supplement-dialog">
      <div class="supplement-dialog-header">
        <h2>补充素材</h2>
        <button class="supplement-close" id="supplement-close">&times;</button>
      </div>
      <div class="import-upload-group">
        <h3>照片 / 视频</h3>
        <p class="import-upload-desc">JPG、PNG、HEIC、MOV、MP4</p>
        <input type="file" id="supplement-files" multiple accept=".jpg,.jpeg,.png,.heic,.heif,.mov,.mp4,.m4v" />
        <label for="supplement-files" class="import-file-label">选择文件</label>
        <span class="import-file-count" id="supplement-count">未选择</span>
      </div>
      <div class="import-error" id="supplement-error"></div>
      <div class="supplement-progress" id="supplement-progress" style="display:none">
        <div class="import-progress"><div class="import-progress-bar"></div></div>
        <p class="import-progress-text" id="supplement-progress-text">上传中...</p>
      </div>
      <div class="import-actions">
        <button class="import-btn primary" id="supplement-submit">上传并重新生成</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // Close on overlay click
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  document.getElementById('supplement-close').addEventListener('click', () => overlay.remove());

  // File count
  const fileInput = document.getElementById('supplement-files');
  fileInput.addEventListener('change', () => {
    document.getElementById('supplement-count').textContent =
      fileInput.files.length > 0 ? `${fileInput.files.length} 个文件` : '未选择';
  });

  // Submit
  document.getElementById('supplement-submit').addEventListener('click', async () => {
    const errEl = document.getElementById('supplement-error');
    const progressEl = document.getElementById('supplement-progress');
    const progressText = document.getElementById('supplement-progress-text');
    const files = fileInput.files;

    if (files.length === 0) { errEl.textContent = '请先选择文件'; return; }
    errEl.textContent = '';

    const btn = document.getElementById('supplement-submit');
    btn.disabled = true;
    progressEl.style.display = '';

    try {
      // Step 1: Check for duplicates
      progressText.textContent = '检查重复文件...';
      const fileNames = Array.from(files).map((f) => f.name);
      const checkRes = await fetch(`${API_BASE}/api/trips/${encodeURIComponent(tripId)}/check-files`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ files: fileNames })
      });
      if (!checkRes.ok) {
        const d = await checkRes.json().catch(() => ({}));
        throw new Error(d.error || '检查失败');
      }
      const checkData = await checkRes.json();

      // Step 2: If duplicates found, ask user
      let replaceMode = false;
      if (checkData.duplicates.length > 0) {
        btn.textContent = '等待选择...';
        const choice = await showDuplicateDialog(checkData.duplicates);
        if (choice === 'cancel') {
          btn.disabled = false;
          btn.textContent = '上传并重新生成';
          progressEl.style.display = 'none';
          return;
        }
        replaceMode = choice === 'replace';
      }

      // Step 3: Upload files
      progressText.textContent = '上传文件中...';
      btn.textContent = '上传中...';
      const formData = new FormData();
      for (const f of files) formData.append('files', f);

      const uploadUrl = replaceMode
        ? `${API_BASE}/api/trips/${encodeURIComponent(tripId)}/files?replace=true`
        : `${API_BASE}/api/trips/${encodeURIComponent(tripId)}/files`;
      const uploadRes = await fetch(uploadUrl, {
        method: 'POST', body: formData
      });
      if (!uploadRes.ok) {
        const d = await uploadRes.json().catch(() => ({}));
        throw new Error(d.error || '上传失败');
      }
      const uploadData = await uploadRes.json();
      if (uploadData.skipped?.length) {
        progressText.textContent = `已上传 ${uploadData.count} 个文件，跳过 ${uploadData.skipped.length} 个重复文件`;
        await new Promise((r) => setTimeout(r, 1500));
      }

      // Trigger re-generation
      progressText.textContent = '正在重新生成旅记...';
      const runRes = await fetch(`${API_BASE}/api/trips/${encodeURIComponent(tripId)}/run`, {
        method: 'POST'
      });
      if (!runRes.ok) {
        const d = await runRes.json().catch(() => ({}));
        throw new Error(d.error || '生成失败');
      }

      // Poll until done
      let result = null;
      for (let i = 0; i < 60; i++) {
        progressText.textContent = `正在生成旅记... (${i + 1})`;
        await new Promise((r) => setTimeout(r, 2000));
        const statusRes = await fetch(`${API_BASE}/api/trips/${encodeURIComponent(tripId)}/status`);
        if (statusRes.ok) {
          const status = await statusRes.json();
          if (status.status === 'done') { result = status; break; }
          if (status.status === 'failed') throw new Error(status.error || '生成失败');
        }
      }

      if (!result) throw new Error('生成超时');

      // Reload page
      progressText.textContent = '完成！正在刷新...';
      await new Promise((r) => setTimeout(r, 1000));
      window.location.reload();

    } catch (err) {
      errEl.textContent = err.message;
      btn.disabled = false;
      btn.textContent = '上传并重新生成';
      progressEl.style.display = 'none';
    }
  });
}

function showDuplicateDialog(duplicates) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'supplement-overlay';
    overlay.innerHTML = `
      <div class="supplement-dialog">
        <div class="supplement-dialog-header">
          <h2>发现重复文件</h2>
        </div>
        <p class="import-hint">以下文件已存在：</p>
        <ul class="duplicate-list">
          ${duplicates.map((f) => `<li>${escapeHtml(f)}</li>`).join('')}
        </ul>
        <p class="import-hint">如何处理？</p>
        <div class="import-actions">
          <button class="import-btn secondary" id="dup-skip">跳过重复</button>
          <button class="import-btn primary" id="dup-replace">替换已有</button>
          <button class="import-btn secondary" id="dup-cancel">取消导入</button>
        </div>
      </div>
    `;
    document.body.appendChild(overlay);

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) { overlay.remove(); resolve('cancel'); }
    });

    document.getElementById('dup-skip').addEventListener('click', () => { overlay.remove(); resolve('skip'); });
    document.getElementById('dup-replace').addEventListener('click', () => { overlay.remove(); resolve('replace'); });
    document.getElementById('dup-cancel').addEventListener('click', () => { overlay.remove(); resolve('cancel'); });
  });
}

function showTitleEditDialog(tripId, tripMeta) {
  const overlay = document.createElement('div');
  overlay.className = 'supplement-overlay';
  const dr = tripMeta?.dateRange || [];
  overlay.innerHTML = `
    <div class="supplement-dialog">
      <div class="supplement-dialog-header">
        <h2>编辑旅记信息</h2>
        <button class="supplement-close" id="title-close">&times;</button>
      </div>
      <div class="import-field">
        <label>旅记标题</label>
        <input type="text" id="title-input" value="${escapeHtml(tripMeta?.title || '')}" />
      </div>
      <div class="import-field">
        <label>副标题</label>
        <input type="text" id="subtitle-input" value="${escapeHtml(tripMeta?.subtitle || '')}" placeholder="可选" />
      </div>
      <div class="import-row">
        <div class="import-field">
          <label>开始日期</label>
          <input type="date" id="title-date-start" value="${dr[0] || ''}" />
        </div>
        <div class="import-field">
          <label>结束日期</label>
          <input type="date" id="title-date-end" value="${dr[1] || ''}" />
        </div>
      </div>
      <div class="import-error" id="title-error"></div>
      <div class="import-actions">
        <button class="import-btn primary" id="title-save">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('title-close').addEventListener('click', () => overlay.remove());

  document.getElementById('title-save').addEventListener('click', async () => {
    const title = document.getElementById('title-input').value.trim();
    const subtitle = document.getElementById('subtitle-input').value.trim();
    const dateStart = document.getElementById('title-date-start').value;
    const dateEnd = document.getElementById('title-date-end').value;
    if (!title) { document.getElementById('title-error').textContent = '标题不能为空'; return; }

    const btn = document.getElementById('title-save');
    btn.disabled = true;
    btn.textContent = '保存中...';

    try {
      const body = { title, subtitle };
      if (dateStart && dateEnd) body.dateRange = [dateStart, dateEnd];
      const res = await fetch(`${API_BASE}/api/trips/${encodeURIComponent(tripId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) throw new Error('保存失败');
      overlay.remove();
      window.location.reload();
    } catch (err) {
      document.getElementById('title-error').textContent = err.message;
      btn.disabled = false;
      btn.textContent = '保存';
    }
  });
}

async function showCoverEditDialog(tripId, tripMeta) {
  const overlay = document.createElement('div');
  overlay.className = 'supplement-overlay';
  overlay.innerHTML = `
    <div class="supplement-dialog supplement-dialog-wide">
      <div class="supplement-dialog-header">
        <h2>更换封面</h2>
        <button class="supplement-close" id="cover-close">&times;</button>
      </div>
      <div id="cover-loading">加载中...</div>
      <div id="cover-grid" class="import-cover-grid" style="display:none"></div>
      <div class="import-error" id="cover-error"></div>
      <div class="import-actions">
        <button class="import-btn primary" id="cover-save" disabled>保存封面</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('cover-close').addEventListener('click', () => overlay.remove());

  let selectedCover = tripMeta?.cover || '';

  try {
    const res = await fetch(`${API_BASE}/api/trips/${encodeURIComponent(tripId)}/thumbnails`);
    if (!res.ok) throw new Error('加载失败');
    const data = await res.json();

    const gridEl = document.getElementById('cover-grid');
    const loadingEl = document.getElementById('cover-loading');

    if (data.thumbnails.length === 0) {
      loadingEl.textContent = '没有可用的封面图';
      return;
    }

    gridEl.innerHTML = data.thumbnails.map((t) => {
      const isSelected = selectedCover.includes(t.fileName);
      return `<div class="import-cover-thumb${isSelected ? ' selected' : ''}" data-path="${escapeHtml(t.url)}" data-filename="${escapeHtml(t.fileName)}">
        <img src="${API_BASE}${t.url}" alt="${escapeHtml(t.fileName)}" loading="lazy" />
      </div>`;
    }).join('');

    gridEl.querySelectorAll('.import-cover-thumb').forEach((el) => {
      el.addEventListener('click', () => {
        gridEl.querySelectorAll('.import-cover-thumb').forEach((t) => t.classList.remove('selected'));
        el.classList.add('selected');
        selectedCover = `./trips/${tripId}/generated/previews/${el.dataset.filename}`;
        document.getElementById('cover-save').disabled = false;
      });
    });

    loadingEl.style.display = 'none';
    gridEl.style.display = '';
  } catch (err) {
    document.getElementById('cover-error').textContent = err.message;
  }

  document.getElementById('cover-save').addEventListener('click', async () => {
    const btn = document.getElementById('cover-save');
    btn.disabled = true;
    btn.textContent = '保存中...';

    try {
      const res = await fetch(`${API_BASE}/api/trips/${encodeURIComponent(tripId)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cover: selectedCover })
      });
      if (!res.ok) throw new Error('保存失败');
      overlay.remove();
      window.location.reload();
    } catch (err) {
      document.getElementById('cover-error').textContent = err.message;
      btn.disabled = false;
      btn.textContent = '保存封面';
    }
  });
}

function showDeleteConfirmDialog(tripId, tripTitle) {
  const overlay = document.createElement('div');
  overlay.className = 'supplement-overlay';
  overlay.innerHTML = `
    <div class="supplement-dialog">
      <div class="import-form">
        <h2>删除旅记</h2>
        <p class="import-hint">确定要删除「${escapeHtml(tripTitle)}」吗？此操作不可撤销。</p>
        <p class="import-hint" style="color:#d84b2a">将删除：旅记数据、预览图、导入记录</p>
        <div class="import-error" id="delete-error"></div>
        <div class="import-actions">
          <button class="import-btn secondary" id="delete-cancel">取消</button>
          <button class="import-btn danger" id="delete-confirm">确认删除</button>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.getElementById('delete-cancel').addEventListener('click', () => overlay.remove());
  document.getElementById('delete-confirm').addEventListener('click', async () => {
    const btn = document.getElementById('delete-confirm');
    btn.disabled = true;
    btn.textContent = '删除中...';
    try {
      const res = await fetch(`${API_BASE}/api/trips/${encodeURIComponent(tripId)}`, { method: 'DELETE' });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || '删除失败');
      }
      overlay.remove();
      window.location.href = '?';
    } catch (err) {
      document.getElementById('delete-error').textContent = err.message;
      btn.disabled = false;
      btn.textContent = '确认删除';
    }
  });
}

async function handleDeleteDay(dayId) {
  if (!confirm('确定要删除这一天吗？该天的照片和地点也会被删除。')) return;
  try {
    const res = await fetch(`${API_BASE}/api/trips/${encodeURIComponent(state.tripId)}/days/${encodeURIComponent(dayId)}`, { method: 'DELETE' });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || '删除失败');
    }
    window.location.reload();
  } catch (err) {
    alert(err.message);
  }
}

async function handleDeleteMedia(mediaId) {
  if (!confirm('确定要删除这张照片吗？对应的 GPS 点位也会被删除。')) return;
  try {
    const res = await fetch(`${API_BASE}/api/trips/${encodeURIComponent(state.tripId)}/media/${encodeURIComponent(mediaId)}`, { method: 'DELETE' });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || '删除失败');
    }
    window.location.reload();
  } catch (err) {
    alert(err.message);
  }
}

async function loadData(url) {
  try {
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Missing data file: ${response.status}`);
    return await response.json();
  } catch {
    return fallbackData;
  }
}

/* ---- Trip List Homepage ---- */

async function renderTripList() {
  document.title = '旅行回顾库';
  const shell = document.querySelector('.app-shell');
  shell.innerHTML = '<section class="home"><p class="home-loading">加载中...</p></section>';

  let trips = [];
  try {
    const res = await fetch(INDEX_URL, { cache: 'no-store' });
    if (res.ok) {
      const idx = await res.json();
      trips = idx.trips || [];
    }
  } catch { /* empty */ }

  if (trips.length === 0) {
    shell.innerHTML = '<section class="home"><div class="home-empty"><p class="home-brand">Travel Library</p><h1>旅行回顾库</h1><p>导入素材后这里会出现旅程。</p></div></section>';
    return;
  }

  // Featured trip (first/only)
  const featured = trips[0];
  const coverUrl = featured.cover
    ? resolveAssetUrl(featured.cover, featured.assetBaseUrl)
    : '';
  const dateRange = featured.dateRange?.length >= 2
    ? `${featured.dateRange[0]} — ${featured.dateRange[1]}`
    : '';
  const stats = featured.stats || {};
  const statsParts = [];
  if (stats.days) statsParts.push(`${stats.days} 天`);
  if (stats.photos) statsParts.push(`${stats.photos} 张照片`);
  if (stats.videos) statsParts.push(`${stats.videos} 个视频`);

  const heroImg = coverUrl
    ? `<img class="home-hero-img" src="${encodeURI(coverUrl)}" alt="${escapeHtml(featured.title)}" />`
    : '';

  const tripCards = trips
    .slice()
    .sort((a, b) => (b.dateRange?.[0] || '').localeCompare(a.dateRange?.[0] || ''))
    .map((trip) => {
      const cUrl = trip.cover ? resolveAssetUrl(trip.cover, trip.assetBaseUrl) : '';
      const dRange = trip.dateRange?.length >= 2 ? `${trip.dateRange[0]} — ${trip.dateRange[1]}` : '';
      const st = trip.stats || {};
      const sp = [];
      if (st.days) sp.push(`${st.days} 天`);
      if (st.photos) sp.push(`${st.photos} 张照片`);
      if (st.videos) sp.push(`${st.videos} 个视频`);
      return `
        <a class="home-card" href="?trip=${encodeURIComponent(trip.id)}">
          <div class="home-card-img">${cUrl ? `<img src="${encodeURI(cUrl)}" alt="${escapeHtml(trip.title)}" loading="lazy" />` : ''}</div>
          <div class="home-card-body">
            <h3>${escapeHtml(trip.title)} <button class="home-card-edit" data-trip-id="${escapeHtml(trip.id)}" data-trip-title="${escapeHtml(trip.title)}" data-trip-subtitle="${escapeHtml(trip.subtitle || '')}" title="编辑标题" onclick="event.preventDefault(); event.stopPropagation();">✎</button></h3>
            <p class="home-card-sub">${escapeHtml(trip.subtitle || '')}</p>
            ${dRange ? `<p class="home-card-date">${escapeHtml(dRange)}</p>` : ''}
            ${sp.length ? `<p class="home-card-stats">${sp.join(' · ')}</p>` : ''}
          </div>
        </a>`;
  }).join('');
  const tripGridHtml = `<div class="home-others"><div class="home-others-header"><p class="home-others-label">已整理的旅程</p><a class="home-import-btn" href="?import=1">+ 导入新旅行</a></div><div class="home-others-grid">${tripCards}</div></div>`;

  shell.innerHTML = `
    <section class="home">
      <div class="home-topbar">
        <span class="home-brand">Travel Library</span>
      </div>
      <div class="home-hero">
        ${heroImg}
        <div class="home-hero-overlay"></div>
        <div class="home-hero-content">
          <p class="home-kicker">Travel Library</p>
          <h1>旅行回顾库</h1>
          <p class="home-hero-sub">用照片、GPS 和路线整理每一段旅程。</p>
        </div>
      </div>
      ${tripGridHtml}
    </section>
  `;

  // Bind title edit buttons
  document.querySelectorAll('.home-card-edit').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showTitleEditDialog(btn.dataset.tripId, {
        title: btn.dataset.tripTitle,
        subtitle: btn.dataset.tripSubtitle
      });
    });
  });
}

/* ---- Import Wizard ---- */

function isImportRoute() {
  return new URLSearchParams(window.location.search).has('import');
}

let importState = loadImportState();

function loadImportState() {
  try {
    const saved = JSON.parse(localStorage.getItem('importState') || '{}');
    return { step: saved.step || 1, jobId: saved.jobId || null, tripId: saved.tripId || null, uploadEndpoints: saved.uploadEndpoints || null };
  } catch { return { step: 1, jobId: null, tripId: null, uploadEndpoints: null }; }
}

function saveImportState() {
  try { localStorage.setItem('importState', JSON.stringify(importState)); } catch {}
}

function renderImportWizard() {
  document.title = '导入新旅行';
  const shell = document.querySelector('.app-shell');
  shell.innerHTML = `
    <section class="import-shell">
      <div class="import-topbar">
        <a class="import-back" href="?">← 返回旅行库</a>
        <span class="import-topbar-title">导入新旅行</span>
      </div>
      <div class="import-panel">
        <div class="import-steps">
          <div class="import-step active" data-step="1">1 上传素材</div>
          <div class="import-step" data-step="2">2 确认信息</div>
          <div class="import-step" data-step="3">3 生成回顾</div>
          <div class="import-step" data-step="4">4 完成</div>
        </div>
        <div class="import-body" id="import-body"></div>
      </div>
    </section>
  `;
  // Always start at step 1; reset stale state immediately
  if (importState.jobId && importState.step > 1) {
    // Optimistically reset to step 1
    const savedJobId = importState.jobId;
    const savedStep = importState.step;
    resetImportState();
    renderImportStep(1);
    // Then check if we should resume (only for active processing jobs)
    fetch(`${API_BASE}/api/import-jobs/${savedJobId}`)
      .then((r) => { if (!r.ok) return null; return r.json(); })
      .then((job) => {
        if (job && job.status === 'processing') {
          importState.jobId = savedJobId;
          importState.step = 3;
          saveImportState();
          renderImportStep(3);
        }
      })
      .catch(() => {});
  } else {
    renderImportStep(1);
  }
}

function resetImportState() {
  importState = { step: 1, jobId: null, tripId: null, uploadEndpoints: null };
  saveImportState();
}

function renderImportStep(step) {
  importState.step = step;
  saveImportState();
  const body = document.getElementById('import-body');
  console.log('[step]', step, 'body:', body);
  if (!body) return;

  // Update step indicators
  document.querySelectorAll('.import-step').forEach((el) => {
    const s = parseInt(el.dataset.step, 10);
    el.classList.toggle('active', s === step);
    el.classList.toggle('done', s < step);
  });

  switch (step) {
    case 1: renderImportStepUpload(body); break;
    case 2: renderImportStepCover(body); break;
    case 3: renderImportStepGenerate(body); break;
    case 4: renderImportStepDone(body); break;
  }
}

function renderImportStepUpload(body) {
  console.log('[upload] rendering, body:', body);
  body.innerHTML = `
    <div class="import-form">
      <h2>上传素材</h2>
      <p class="import-hint">至少上传一张照片或视频，订单和 vlog 可选。</p>
      <div class="import-upload-group">
        <h3>照片 / 视频 <span class="required">*</span></h3>
        <p class="import-upload-desc">JPG、PNG、HEIC、MOV、MP4</p>
        <input type="file" id="import-files-media" multiple accept=".jpg,.jpeg,.png,.heic,.heif,.mov,.mp4,.m4v" />
        <label for="import-files-media" class="import-file-label">选择文件</label>
        <span class="import-file-count" id="import-count-media">未选择</span>
      </div>
      <div class="import-upload-group">
        <h3>订单 / 票据</h3>
        <p class="import-upload-desc">PDF、JPG、PNG、HEIC</p>
        <input type="file" id="import-files-receipts" multiple accept=".pdf,.jpg,.jpeg,.png,.heic,.heif" />
        <label for="import-files-receipts" class="import-file-label">选择文件</label>
        <span class="import-file-count" id="import-count-receipts">未选择</span>
      </div>
      <div class="import-upload-group">
        <h3>Vlog</h3>
        <p class="import-upload-desc">MOV、MP4</p>
        <input type="file" id="import-files-vlog" multiple accept=".mov,.mp4,.m4v" />
        <label for="import-files-vlog" class="import-file-label">选择文件</label>
        <span class="import-file-count" id="import-count-vlog">未选择</span>
      </div>
      <div class="import-error" id="import-error"></div>
      <div class="import-actions">
        <button class="import-btn primary" id="import-upload-btn">上传并继续</button>
      </div>
    </div>
  `;

  // File count display
  ['media', 'receipts', 'vlog'].forEach((type) => {
    const input = document.getElementById(`import-files-${type}`);
    const countEl = document.getElementById(`import-count-${type}`);
    input.addEventListener('change', () => {
      const n = input.files.length;
      countEl.textContent = n > 0 ? `${n} 个文件` : '未选择';
    });
  });

  document.getElementById('import-upload-btn').addEventListener('click', handleUploadFiles);
}

async function handleUploadFiles() {
  const errEl = document.getElementById('import-error');
  const mediaFiles = document.getElementById('import-files-media').files;

  if (mediaFiles.length === 0) {
    errEl.textContent = '请至少选择一个照片或视频文件';
    return;
  }
  errEl.textContent = '';

  const btn = document.getElementById('import-upload-btn');
  btn.disabled = true;

  try {
    // Create job first if not exists
    if (!importState.jobId) {
      btn.textContent = '创建任务中...';
      const res = await fetch(`${API_BASE}/api/import-jobs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      if (!res.ok) throw new Error('创建任务失败');
      const data = await res.json();
      importState.jobId = data.jobId;
      importState.tripId = data.tripId;
      importState.uploadEndpoints = data.upload;
      saveImportState();
    }

    // Upload each type
    for (const type of ['media', 'receipts', 'vlog']) {
      const input = document.getElementById(`import-files-${type}`);
      if (input.files.length === 0) continue;

      btn.textContent = `上传${type === 'media' ? '照片/视频' : type === 'receipts' ? '订单' : 'vlog'}中...`;

      const formData = new FormData();
      for (const file of input.files) {
        formData.append('files', file);
      }

      const res = await fetch(`${API_BASE}/api/import-jobs/${importState.jobId}/files?type=${type}`, {
        method: 'POST',
        body: formData
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `上传失败 (${res.status})`);
      }
    }

    renderImportStep(2);
  } catch (err) {
    errEl.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '上传并继续';
  }
}

/* ---- Cover Selection Step ---- */

async function renderImportStepCover(body) {
  body.innerHTML = `
    <div class="import-form">
      <h2>确认旅行信息</h2>
      <div class="import-section" id="import-cover-gps">
        <p class="import-gps-line import-gps-loading">📍 正在识别GPS和日期...</p>
      </div>
      <div class="import-section">
        <div class="import-field">
          <label>旅行标题</label>
          <div class="import-skeleton" id="skel-title" style="height:40px"></div>
          <input type="text" id="import-cover-title" style="display:none" />
        </div>
        <div class="import-field">
          <label>副标题</label>
          <div class="import-skeleton" id="skel-subtitle" style="height:40px"></div>
          <input type="text" id="import-cover-subtitle" placeholder="可选" style="display:none" />
        </div>
        <div class="import-row">
          <div class="import-field">
            <label>开始日期</label>
            <div class="import-skeleton" id="skel-date1" style="height:40px"></div>
            <input type="date" id="import-cover-date-start" style="display:none" />
          </div>
          <div class="import-field">
            <label>结束日期</label>
            <div class="import-skeleton" id="skel-date2" style="height:40px"></div>
            <input type="date" id="import-cover-date-end" style="display:none" />
          </div>
        </div>
      </div>
      <div class="import-section">
        <p class="import-section-label">选择封面</p>
        <div class="import-cover-grid" id="import-cover-grid">
          <div class="import-skeleton import-skeleton-thumb"></div>
          <div class="import-skeleton import-skeleton-thumb"></div>
          <div class="import-skeleton import-skeleton-thumb"></div>
          <div class="import-skeleton import-skeleton-thumb"></div>
        </div>
      </div>
      <div class="import-error" id="import-error"></div>
      <div class="import-actions" id="import-cover-actions" style="display:none">
        <button class="import-btn secondary" onclick="renderImportStep(1)">上一步</button>
        <button class="import-btn primary" id="import-cover-confirm">确认并生成</button>
      </div>
    </div>
  `;

  let selectedCover = '';
  let autoSettings = {};
  const progressText = document.querySelector('.import-progress-text');

  try {
    // Fetch media info
    const res = await fetch(`${API_BASE}/api/import-jobs/${importState.jobId}/media`);
    if (!res.ok) throw new Error('获取媒体列表失败');
    const data = await res.json();

    autoSettings = data.autoSettings || {};
    const images = data.files.filter((f) => f.isImage);
    const gpsCount = data.files.filter((f) => f.gps).length;

    // Replace skeletons with real inputs
    ['skel-title', 'skel-subtitle', 'skel-date1', 'skel-date2'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.display = 'none';
    });
    ['import-cover-title', 'import-cover-subtitle', 'import-cover-date-start', 'import-cover-date-end'].forEach((id) => {
      const el = document.getElementById(id);
      if (el) el.style.display = '';
    });
    document.getElementById('import-cover-actions').style.display = '';

    // Auto-fill title from job info
    const titleInput = document.getElementById('import-cover-title');
    const subtitleInput = document.getElementById('import-cover-subtitle');
    const dateStartInput = document.getElementById('import-cover-date-start');
    const dateEndInput = document.getElementById('import-cover-date-end');

    // Auto-fill dates from EXIF
    if (autoSettings.dateRange) {
      dateStartInput.value = autoSettings.dateRange[0];
      dateEndInput.value = autoSettings.dateRange[1];
    }

    // Auto-fill title: GPS city > date range > default
    try {
      const jobRes = await fetch(`${API_BASE}/api/import-jobs/${importState.jobId}`);
      if (jobRes.ok) {
        const job = await jobRes.json();
        if (job.title && job.title !== '未命名旅行') {
          titleInput.value = job.title;
        } else if (autoSettings.defaultMapCenter) {
          const cityName = await reverseGeocode(autoSettings.defaultMapCenter[0], autoSettings.defaultMapCenter[1]);
          titleInput.value = cityName ? `${cityName}旅行` : '';
        }
        // If still empty, generate from dates
        if (!titleInput.value && autoSettings.dateRange) {
          const d = new Date(autoSettings.dateRange[0]);
          const month = d.getMonth() + 1;
          const day = d.getDate();
          if (autoSettings.dateRange[0] === autoSettings.dateRange[1]) {
            titleInput.value = `${d.getFullYear()}年${month}月${day}日 旅行`;
          } else {
            const d2 = new Date(autoSettings.dateRange[1]);
            titleInput.value = `${d.getFullYear()}年${month}月${day}日-${d2.getMonth() + 1}月${d2.getDate()}日 旅行`;
          }
        }
        subtitleInput.value = job.subtitle || '';
      }
    } catch { /* ignore */ }

    // Show GPS info as single line
    const gpsEl = document.getElementById('import-cover-gps');
    console.log('[cover] autoSettings:', JSON.stringify(autoSettings));
    console.log('[cover] gpsCount:', gpsCount);
    if (autoSettings.defaultMapCenter) {
      const tz = autoSettings.timezoneOffsetHours >= 0 ? '+' + autoSettings.timezoneOffsetHours : autoSettings.timezoneOffsetHours;
      let cityName = null;
      try {
        cityName = await reverseGeocode(autoSettings.defaultMapCenter[0], autoSettings.defaultMapCenter[1]);
      } catch { /* ignore */ }
      gpsEl.innerHTML = `<p class="import-gps-line">📍 ${cityName || '已定位'} · UTC${tz} · ${gpsCount}张GPS照片</p>`;
    } else {
      gpsEl.innerHTML = '<p class="import-gps-line import-gps-none">📍 未检测到GPS，将使用默认设置</p>';
      autoSettings.defaultMapCenter = [39.9042, 116.4074];
      autoSettings.timezoneOffsetHours = 8;
    }

    // Show thumbnails (limit to 12 for performance)
    const gridEl = document.getElementById('import-cover-grid');
    if (images.length > 0) {
      const sampled = sampleImages(images, 12);
      gridEl.innerHTML = sampled.map((img, i) => {
        const path = `imports/${importState.jobId}/raw/media/${img.fileName}`;
        const ext = img.fileName.split('.').pop().toLowerCase();
        const isHeic = ext === 'heic' || ext === 'heif';
        const thumbSrc = isHeic
          ? `${API_BASE}/api/import-jobs/${importState.jobId}/thumbnail/${encodeURIComponent(img.fileName)}`
          : `${API_BASE}/${path}`;
        return `<div class="import-cover-thumb" data-path="${escapeHtml(path)}" data-index="${i}">
          <img src="${thumbSrc}" alt="${escapeHtml(img.fileName)}" loading="lazy" />
        </div>`;
      }).join('');
      gridEl.querySelectorAll('.import-cover-thumb').forEach((el) => {
        el.addEventListener('click', () => {
          gridEl.querySelectorAll('.import-cover-thumb').forEach((t) => t.classList.remove('selected'));
          el.classList.add('selected');
          selectedCover = './' + el.dataset.path;
        });
      });
      gridEl.querySelector('.import-cover-thumb')?.click();
    } else {
      gridEl.innerHTML = '<p class="import-hint">未找到图片。</p>';
    }
  } catch (err) {
    document.getElementById('import-error').textContent = err.message;
  }

  document.getElementById('import-cover-confirm').addEventListener('click', async () => {
    const btn = document.getElementById('import-cover-confirm');
    btn.disabled = true;
    btn.textContent = '保存中...';

    try {
      // Update job title/subtitle if changed
      const title = document.getElementById('import-cover-title').value.trim() || '未命名旅行';
      const subtitle = document.getElementById('import-cover-subtitle').value.trim();
      const dateStart = document.getElementById('import-cover-date-start').value;
      const dateEnd = document.getElementById('import-cover-date-end').value;

      // Update trip-config
      const configBody = {
        title,
        cover: selectedCover,
        defaultMapCenter: autoSettings.defaultMapCenter,
        timezoneOffsetHours: autoSettings.timezoneOffsetHours,
        defaultPlaceName: title
      };
      const res = await fetch(`${API_BASE}/api/import-jobs/${importState.jobId}/config`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(configBody)
      });
      if (!res.ok) throw new Error('保存配置失败');

      // Update job title/subtitle/dateRange via a separate PATCH to the job
      await fetch(`${API_BASE}/api/import-jobs/${importState.jobId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, subtitle, dateRange: dateStart && dateEnd ? [dateStart, dateEnd] : undefined })
      }).catch(() => {/* ignore, not critical */});

      renderImportStep(3);
    } catch (err) {
      document.getElementById('import-error').textContent = err.message;
      btn.disabled = false;
      btn.textContent = '确认并生成';
    }
  });
}

function sampleImages(images, limit) {
  if (images.length <= limit) return images;
  const step = (images.length - 1) / (limit - 1);
  const result = [];
  for (let i = 0; i < limit; i++) {
    result.push(images[Math.round(i * step)]);
  }
  return result;
}

async function reverseGeocode(lat, lng) {
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=zh-CN`, {
      headers: { 'User-Agent': 'travel-memory-import/1.0' }
    });
    if (!res.ok) return null;
    const data = await res.json();
    const addr = data.address || {};
    const city = addr.city || addr.town || addr.village || null;
    // If city is a district (contains 区/县), prefer state (province/city name)
    if (city && /[区县]/.test(city)) return addr.state || city;
    return city || addr.state || addr.county || null;
  } catch { return null; }
}

let importPollTimer = null;

function stopImportPolling() {
  if (importPollTimer) { clearInterval(importPollTimer); importPollTimer = null; }
}

async function renderImportStepGenerate(body) {
  stopImportPolling();
  body.innerHTML = `
    <div class="import-form">
      <h2>生成旅行回顾</h2>
      <div class="import-progress-bar-wrap" id="import-progress-wrap" style="display:none">
        <div class="import-progress-bar-track">
          <div class="import-progress-bar-fill" id="import-progress-fill" style="width:0%"></div>
        </div>
        <span class="import-progress-percent" id="import-progress-percent">0%</span>
      </div>
      <div class="import-status" id="import-status-content">
        <div class="import-status-grid">
          <div class="import-status-item"><span class="import-status-label">状态</span><span class="import-status-value" id="import-gen-status">准备中</span></div>
          <div class="import-status-item"><span class="import-status-label">进度</span><span class="import-status-value" id="import-gen-progress">—</span></div>
        </div>
        <pre class="import-logs" id="import-gen-logs"></pre>
      </div>
      <div class="import-error" id="import-error"></div>
      <div class="import-actions" id="import-gen-actions">
        <button class="import-btn primary" id="import-run-btn">开始生成旅行回顾</button>
      </div>
    </div>
  `;

  document.getElementById('import-run-btn').addEventListener('click', handleRunJob);

  // Check if already processing or done, otherwise auto-start
  try {
    const res = await fetch(`${API_BASE}/api/import-jobs/${importState.jobId}`);
    if (res.ok) {
      const job = await res.json();
      if (job.status === 'processing') startImportPolling();
      else if (job.status === 'done') {
        document.getElementById('import-gen-status').textContent = '已完成';
        document.getElementById('import-gen-progress').textContent = '旅记已生成';
        const actionsEl = document.getElementById('import-gen-actions');
        if (actionsEl) {
          actionsEl.innerHTML = `
            <a class="import-btn secondary" href="?">返回旅行库</a>
            <a class="import-btn primary" href="?trip=${encodeURIComponent(importState.tripId)}">打开旅记</a>
          `;
        }
        return;
      }
      else { handleRunJob(); return; }
    }
  } catch { /* ignore */ }
}

async function handleRunJob() {
  const btn = document.getElementById('import-run-btn');
  const errEl = document.getElementById('import-error');
  if (btn) { btn.disabled = true; btn.textContent = '启动中...'; }
  errEl.textContent = '';

  // Show progress bar
  const progressWrap = document.getElementById('import-progress-wrap');
  if (progressWrap) progressWrap.style.display = '';

  try {
    const res = await fetch(`${API_BASE}/api/import-jobs/${importState.jobId}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ upload: true })
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `启动失败 (${res.status})`);
    }
    startImportPolling();
  } catch (err) {
    errEl.textContent = err.message;
    if (btn) { btn.disabled = false; btn.textContent = '重新尝试'; }
  }
}

async function handleCancelJob() {
  const errEl = document.getElementById('import-error');
  try {
    const res = await fetch(`${API_BASE}/api/import-jobs/${importState.jobId}/cancel`, { method: 'POST' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || '取消失败');
    }
    stopImportPolling();
    if (errEl) errEl.textContent = '已取消';
    const actionsEl = document.getElementById('import-gen-actions');
    if (actionsEl) {
      actionsEl.innerHTML = '<button class="import-btn primary" id="import-run-btn">重新尝试</button>';
      document.getElementById('import-run-btn').addEventListener('click', handleRunJob);
    }
  } catch (err) {
    if (errEl) errEl.textContent = err.message;
  }
}

function startImportPolling() {
  stopImportPolling();
  updateImportGenUI(); // immediate first poll
  importPollTimer = setInterval(updateImportGenUI, 2000);
}

async function updateImportGenUI() {
  const statusEl = document.getElementById('import-gen-status');
  const progressEl = document.getElementById('import-gen-progress');
  const logsEl = document.getElementById('import-gen-logs');
  const actionsEl = document.getElementById('import-gen-actions');
  const errEl = document.getElementById('import-error');
  const progressWrap = document.getElementById('import-progress-wrap');
  const progressFill = document.getElementById('import-progress-fill');
  const progressPercent = document.getElementById('import-progress-percent');
  if (!statusEl) { stopImportPolling(); return; }

  try {
    const res = await fetch(`${API_BASE}/api/import-jobs/${importState.jobId}`);
    if (!res.ok) throw new Error('查询失败');
    const job = await res.json();

    const statusLabels = { processing: '生成中', done: '已完成', failed: '失败' };
    const isUploading = job.phase === 'uploading';
    const displayStatus = isUploading ? '上传中' : (statusLabels[job.status] || job.status);
    statusEl.textContent = displayStatus;
    statusEl.className = `import-status-value import-status-${job.status}`;
    progressEl.textContent = job.progressMessage || '—';

    // Update progress bar (hide when done, show when processing/uploading)
    const pct = job.progressPercent || 0;
    if (progressWrap) progressWrap.style.display = (job.status === 'processing' || isUploading) ? '' : 'none';
    if (progressFill) progressFill.style.width = isUploading ? '100%' : pct + '%';
    if (progressPercent) progressPercent.textContent = isUploading ? '上传中' : pct + '%';

    if (logsEl && job.logs?.length) {
      logsEl.textContent = job.logs.slice(-15).join('\n');
      logsEl.scrollTop = logsEl.scrollHeight;
    }

    if (job.status === 'done') {
      stopImportPolling();
      renderImportStep(4);
    } else if (job.status === 'failed') {
      stopImportPolling();
      if (errEl) errEl.textContent = job.error || '生成失败';
      if (actionsEl) {
        actionsEl.innerHTML = '<button class="import-btn primary" id="import-run-btn">重新尝试</button>';
        document.getElementById('import-run-btn').addEventListener('click', handleRunJob);
      }
    } else if (job.status === 'processing') {
      if (actionsEl) {
        actionsEl.innerHTML = `
          <span class="import-processing-hint">正在处理，请稍候...</span>
          <button class="import-btn secondary" id="import-cancel-btn">取消</button>
        `;
        document.getElementById('import-cancel-btn').addEventListener('click', handleCancelJob);
      }
    }
  } catch (err) {
    if (errEl) errEl.textContent = err.message;
  }
}

function renderImportStepDone(body) {
  stopImportPolling();
  body.innerHTML = `
    <div class="import-form import-done">
      <h2>旅行回顾已生成</h2>
      <p class="import-done-id">Trip ID: <strong>${escapeHtml(importState.tripId)}</strong></p>
      <p class="import-done-hint">素材已整理为旅行页面，可以打开查看了。</p>
      <div class="import-actions">
        <a class="import-btn secondary" href="?">返回旅行库</a>
        <a class="import-btn primary" href="?trip=${encodeURIComponent(importState.tripId)}">打开旅行回顾</a>
      </div>
    </div>
  `;
}

/* ---- Journal Rendering ---- */

function renderJournal() {
  destroyAllMaps();

  const { days, media } = state.data;
  const allPlaces = days.flatMap((d) => d.places);

  els.summaryDays.textContent = `${days.length} days`;
  els.summaryMedia.textContent = `${media.length} media`;
  els.summaryPlaces.textContent = `${allPlaces.length} places`;

  renderNav(days);
  renderDayCards(days, media);
}

function renderNav(days) {
  const nav = document.querySelector('#supplement-nav') || document.querySelector('#journal-nav');
  if (!nav) return;

  nav.innerHTML = days
    .map((day, i) => {
      const label = `${formatDayLabel(day)} · ${escapeHtml(day.city || '')}`;
      return `<button type="button" data-target="day-${i}">${label}</button>`;
    })
    .join('');

  nav.querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = document.getElementById(btn.dataset.target);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  });
}

function renderDayCards(days, media) {
  const journal = document.querySelector('#journal');
  const heading = journal.querySelector('.section-heading');
  if (!journal) return;

  const cards = days
    .map((day, index) => {
      const dayMedia = getDayMedia(media, day);
      // Right panel: list each GPS point individually, sorted by capturedAt
      const gpsPlaces = day.places
        .filter((place) => place.source === 'gps')
        .sort((a, b) => (a.capturedAt || '').localeCompare(b.capturedAt || ''));
      const placeRows = gpsPlaces
        .map((place, placeIndex) => {
          const placeName = getDetailedGpsDisplayName(place);
          const placeNote = getDetailedGpsNote(place);
          const timeLabel = getJstTimeLabel(place.capturedAt) || '时间待定';
          const timeProgress = getJstTimeProgress(place.capturedAt);
          const timeStyle = timeProgress === null ? '' : ` style="--time-progress:${timeProgress}deg"`;
          return `
            <div class="place-row">
              <div class="place-dot place-dot--gps"></div>
              <div>
                <div class="place-name">
                  <span class="place-time" aria-label="拍摄时间段">
                    <span class="place-time-icon" aria-hidden="true"${timeStyle}></span>
                    <span>${escapeHtml(timeLabel)}</span>
                  </span>
                  <span class="place-name-text" data-place-id="${escapeHtml(place.id)}" data-field="displayName" title="点击编辑">${escapeHtml(placeName)}</span>
                </div>
                <div class="place-note place-note-text" data-place-id="${escapeHtml(place.id)}" data-field="displayNote" title="点击编辑">${escapeHtml(placeNote)}</div>
              </div>
            </div>
          `;
        })
        .join('');

      const tags =
        day.memoryTags && day.memoryTags.length
          ? `<ul class="memory-tags">${day.memoryTags.map((t) => `<li>${escapeHtml(t)}</li>`).join('')}</ul>`
          : '';

      const mediaHtml = renderDayMedia(dayMedia, index);

      // Events (lodging / transport / ticket)
      const dayEvents = getDayEvents(day);
      const eventsHtml = dayEvents.length
        ? `<div class="day-events">${dayEvents.map((ev) => renderEventChip(ev)).join('')}</div>`
        : '';

      return `
        <article class="day-card" id="day-${index}" style="--delay:${index * 90}ms" data-day-id="${escapeHtml(day.id)}">
          <div class="day-card-map-shell">
            <div class="day-card-map" id="map-day-${index}"></div>
          </div>
          <div class="day-card-body">
            <div class="day-card-header">
              <div class="day-card-header-top">
                <time datetime="${escapeHtml(day.date)}">${formatLongDayLabel(day)}</time>
                <button class="day-card-delete" data-day-id="${escapeHtml(day.id)}" title="删除这天">×</button>
              </div>
              <p class="city">${escapeHtml(day.city || '')}</p>
              <h3>${escapeHtml(day.title)}</h3>
              <p class="day-card-summary">${escapeHtml(day.summary || '')}</p>
            </div>
            ${tags}
            <div class="day-card-places">${placeRows}</div>
            ${eventsHtml}
            ${mediaHtml}
          </div>
        </article>
      `;
    })
    .join('');

  // Keep the heading, replace everything after it
  const existingCards = journal.querySelectorAll('.day-card');
  existingCards.forEach((c) => c.remove());

  heading.insertAdjacentHTML('afterend', cards);

  setupLazyDayMaps(days);
  bindViewportMapRefresh();

  // Bind media expand handlers
  journal.querySelectorAll('.media-more').forEach((btn) => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.day-card');
      const dayId = card.dataset.dayId;
      const day = state.data.days.find((d) => d.id === dayId);
      if (!day) return;
      const dayMedia = getDayMedia(state.data.media, day);
      const mediaGrid = card.querySelector('.day-card-media');
      mediaGrid.classList.add('is-expanded');
      mediaGrid.innerHTML = sortMediaForDisplay(dayMedia)
        .map((item) => mediaThumb(item))
        .join('');
    });
  });

  // Bind place edit handlers
  journal.querySelectorAll('.place-name-text, .place-note-text').forEach((el) => {
    el.addEventListener('click', () => {
      startPlaceEdit(el);
    });
  });

  // Bind day delete handlers
  journal.querySelectorAll('.day-card-delete').forEach((btn) => {
    btn.addEventListener('click', () => {
      handleDeleteDay(btn.dataset.dayId);
    });
  });

  // Bind media delete handlers
  journal.querySelectorAll('.media-delete').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      handleDeleteMedia(btn.dataset.mediaId);
    });
  });
}

function startPlaceEdit(el) {
  const placeId = el.dataset.placeId;
  const field = el.dataset.field;
  const currentText = el.textContent.trim();

  const input = document.createElement('textarea');
  input.value = currentText;
  input.className = 'place-edit-input';
  input.rows = field === 'displayNote' ? 3 : 1;

  el.replaceWith(input);
  input.focus();
  input.select();

  const save = async () => {
    const newText = input.value.trim();
    try {
      await fetch(`${API_BASE}/api/trips/${encodeURIComponent(state.tripId)}/places`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ placeId, fields: { [field]: newText } })
      });
      // Update local state
      for (const day of state.data.days) {
        const place = day.places?.find((p) => p.id === placeId);
        if (place) { place[field] = newText; break; }
      }
    } catch { /* ignore */ }

    const span = document.createElement('span');
    span.className = el.className;
    span.dataset.placeId = placeId;
    span.dataset.field = field;
    span.title = '点击编辑';
    span.textContent = newText || (field === 'displayName' ? '地点' : '');
    span.addEventListener('click', () => startPlaceEdit(span));
    input.replaceWith(span);
  };

  input.addEventListener('blur', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); save(); }
    if (e.key === 'Escape') { input.value = currentText; save(); }
  });
}

function renderDayMedia(dayMedia, dayIndex) {
  const displayMedia = dayMedia;
  if (!displayMedia.length) return '';

  const preview = pickDayMediaPreview(displayMedia, MEDIA_PREVIEW_COUNT);
  const remaining = displayMedia.length - preview.length;

  const thumbs = preview.map((item) => mediaThumb(item)).join('');
  const moreBtn =
    remaining > 0
      ? `<button type="button" class="media-more">+${remaining} 更多</button>`
      : '';

  return `<div class="day-card-media">${thumbs}${moreBtn}</div>`;
}

function pickDayMediaPreview(media, limit) {
  const displayable = media.filter((item) => item.type !== 'document' && hasBrowserDisplayableMedia(item));
  if (!displayable.length) return [];

  const photos = displayable.filter((item) => item.type === 'photo' || item.type === 'receipt');
  const videos = displayable.filter((item) => item.type === 'video' || item.type === 'vlog');
  const selected = [];
  const seen = new Set();

  timeSpreadSample(photos, limit).forEach((item) => {
    selected.push(item);
    seen.add(item.id);
  });

  if (selected.length < limit) {
    timeSpreadSample(videos.filter((item) => !seen.has(item.id)), limit - selected.length).forEach((item) => {
      selected.push(item);
      seen.add(item.id);
    });
  }

  return selected.sort((a, b) => getMediaTime(a) - getMediaTime(b));
}

function timeSpreadSample(media, limit) {
  if (media.length <= limit) return sortMediaByTime(media);
  const sorted = sortMediaByTime(media);
  const selected = [];
  const usedIndexes = new Set();

  for (let i = 0; i < limit; i++) {
    const target = Math.round((i * (sorted.length - 1)) / Math.max(1, limit - 1));
    let bestIndex = target;
    let offset = 0;
    while (usedIndexes.has(bestIndex) && offset < sorted.length) {
      offset += 1;
      const forward = target + offset;
      const backward = target - offset;
      if (forward < sorted.length && !usedIndexes.has(forward)) {
        bestIndex = forward;
        break;
      }
      if (backward >= 0 && !usedIndexes.has(backward)) {
        bestIndex = backward;
        break;
      }
    }
    usedIndexes.add(bestIndex);
    selected.push(sorted[bestIndex]);
  }

  return selected;
}

function hasBrowserDisplayableMedia(item) {
  const src = getMediaImageSrc(item);
  if (!src) return false;
  const ext = src.split('.').pop().toLowerCase();
  return !['heic', 'heif', 'aae'].includes(ext);
}

function mediaThumb(item) {
  if (item.type === 'document') {
    return `<div class="media-more" title="${escapeHtml(item.title)}">PDF</div>`;
  }
  const src = getMediaImageSrc(item);
  return `<div class="media-item" data-media-id="${escapeHtml(item.id)}" style="position:relative"><img src="${encodeURI(src)}" alt="${escapeHtml(item.title)}" loading="lazy" /><button class="media-delete" data-media-id="${escapeHtml(item.id)}" title="删除">×</button></div>`;
}

function getMediaImageSrc(item) {
  const src = (item.type === 'video' || item.type === 'vlog')
    ? item.posterSrc || item.src
    : item.src;
  return resolveAssetUrl(src);
}

function sortMediaForDisplay(media) {
  const priority = {
    photo: 0,
    receipt: 1,
    video: 2,
    vlog: 3,
    document: 4
  };
  return [...media].sort((a, b) => {
    const typeDiff = (priority[a.type] ?? 9) - (priority[b.type] ?? 9);
    if (typeDiff !== 0) return typeDiff;
    return new Date(a.capturedAt || 0) - new Date(b.capturedAt || 0);
  });
}

function sortMediaByTime(media) {
  return [...media].sort((a, b) => getMediaTime(a) - getMediaTime(b));
}

function getMediaTime(item) {
  const time = item.capturedAt ? new Date(item.capturedAt).getTime() : Number.NaN;
  return Number.isFinite(time) ? time : Number.MAX_SAFE_INTEGER;
}

function normalizeTripData(data) {
  const days = (data.days || []).filter((day) => {
    const hasPlaces = (day.places || []).length > 0;
    const hasMedia = (day.media || []).length > 0;
    return hasPlaces || hasMedia;
  });
  return { ...data, days };
}

function getDayMedia(media, day) {
  const dayIds = new Set(day.sourceDayIds || [day.id]);
  return media.filter((item) => dayIds.has(item.dayId));
}

function getDayEvents(day) {
  const events = state.data?.events || [];
  const eventIds = new Set(day.events || []);
  return events
    .filter((ev) => eventIds.has(ev.id))
    .sort((a, b) => (a.startAt || '').localeCompare(b.startAt || ''));
}

const EVENT_TYPE_LABELS = { lodging: '住宿', transport: '交通', ticket: '门票', other: '订单' };

function renderEventChip(ev) {
  const label = EVENT_TYPE_LABELS[ev.category] || '订单';
  const dateInfo = ev.startAt
    ? formatDateShort(ev.startAt) + (ev.endAt ? ` → ${formatDateShort(ev.endAt)}` : '')
    : '';
  return `
    <div class="event-chip event-${ev.category}">
      <span class="event-type">${escapeHtml(label)}</span>
      <strong>${escapeHtml(ev.title)}</strong>
      ${dateInfo ? `<p>${escapeHtml(dateInfo)}</p>` : ''}
      ${ev.summary ? `<p class="event-summary">${escapeHtml(ev.summary)}</p>` : ''}
    </div>
  `;
}

function formatDateShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/* ---- Day Map ---- */

function renderDayMap(day, index) {
  const containerId = `map-day-${index}`;
  const el = document.getElementById(containerId);
  if (!el || !window.L) return;
  if (el.dataset.mapReady === 'true') return;
  el.dataset.mapReady = 'true';

  // Only real GPS points from media go on the map. Manual/supplement never enter the map.
  const mapPlaces = day.places.filter((place) => place.source === 'gps');
  const routePlaces = [...mapPlaces].sort((a, b) => {
    const aTime = a.capturedAt || `${day.date}T99:99:99`;
    const bTime = b.capturedAt || `${day.date}T99:99:99`;
    return aTime.localeCompare(bTime);
  });
  const latLngs = mapPlaces.map((p) => [p.lat, p.lng]);
  const routeLatLngs = (routePlaces.length > 1 ? routePlaces : mapPlaces).map((p) => [p.lat, p.lng]);
  const map = window.L.map(el, {
    zoomControl: true,
    scrollWheelZoom: false
  });
  const mapState = {
    map,
    latLngs: getMapFitLatLngs(routeLatLngs, latLngs),
    hasUserMoved: false,
    hasInitialFit: false
  };
  map.on('zoomstart dragstart', (event) => {
    if (event.originalEvent) {
      mapState.hasUserMoved = true;
    }
  });

  map.setView(getLatLngCenter(mapState.latLngs), mapState.latLngs.length ? 10 : 5);

  const tileLayerConfig = state.data?.trip?.tileLayer || DEFAULT_TILE_LAYER;
  const tileLayer = window.L.tileLayer(tileLayerConfig.url, {
    ...DEFAULT_TILE_LAYER.options,
    ...(tileLayerConfig.options || {})
  });
  tileLayer.on('load', () => settleMapLayout(mapState));
  tileLayer.addTo(map);

  const color = '#d84b2a';
  const dayImages = getImageMediaForDay(state.data.media, day);
  const imageAssignments = assignDistinctImagesToPlaces(mapPlaces, dayImages, 5);
  const photoPreviewItems = [];

  mapPlaces.forEach((place, placeIndex) => {
    const style = markerStyle(place.source);
    const sourceLabel = sourceLabelText(place.source);
    const placeName = getDetailedGpsDisplayName(place);
    const placeNote = getDetailedGpsNote(place);
    const marker = window.L.circleMarker([place.lat, place.lng], style)
      .addTo(map)
      .bindPopup(
        `<strong>${escapeHtml(placeName)}</strong>` +
        (sourceLabel ? `<br><small style="opacity:.6">${sourceLabel}</small>` : '') +
        (placeNote
          ? `<br><small>${escapeHtml(placeNote)}</small>`
          : '')
      );
    const nearestImages = imageAssignments.get(place) || [];
    if (nearestImages.length) {
      photoPreviewItems.push({ place, day, sequence: mapPlaces, images: nearestImages });
      attachPhotoPreview(marker, place, day, mapPlaces, nearestImages);
    }
  });

  attachMapPhotoHover(map, photoPreviewItems);

  if (routeLatLngs.length > 1) {
    const segments = breakLongSegments(routeLatLngs, 80);
    segments.forEach((seg) => {
      window.L.polyline(seg, {
        color,
        weight: 5,
        opacity: 0.9,
        dashArray: '8 8',
        lineCap: 'round',
        lineJoin: 'round',
        pane: 'overlayPane'
      }).addTo(map);
    });
  }

  state.maps.push(mapState);
  settleMapLayout(mapState);
}

function destroyAllMaps() {
  if (state.mapObserver) {
    state.mapObserver.disconnect();
    state.mapObserver = null;
  }
  state.maps.forEach(({ map }) => map.remove());
  state.maps = [];
}

function setupLazyDayMaps(days) {
  if (!window.IntersectionObserver) {
    window.setTimeout(() => {
      days.forEach((day, index) => renderDayMap(day, index));
    }, 0);
    return;
  }

  state.mapObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const index = Number.parseInt(entry.target.dataset.mapIndex, 10);
        if (Number.isNaN(index)) return;
        renderDayMap(days[index], index);
        state.mapObserver.unobserve(entry.target);
      });
    },
    { rootMargin: '420px 0px', threshold: 0.01 }
  );

  days.forEach((_, index) => {
    const el = document.getElementById(`map-day-${index}`);
    if (!el) return;
    el.dataset.mapIndex = String(index);
    state.mapObserver.observe(el);
  });
}

function getMapCenter() {
  return state.data?.trip?.defaultMapCenter || DEFAULT_MAP_CENTER;
}

function getLatLngCenter(latLngs) {
  if (!latLngs.length) return getMapCenter();
  const totals = latLngs.reduce(
    (sum, point) => [sum[0] + point[0], sum[1] + point[1]],
    [0, 0]
  );
  return [totals[0] / latLngs.length, totals[1] / latLngs.length];
}

function getMapFitLatLngs(routeLatLngs, allLatLngs) {
  const routeSegments = breakLongSegments(routeLatLngs, 80);
  const longestSegment = routeSegments.sort((a, b) => b.length - a.length)[0];
  return longestSegment && longestSegment.length > 1 ? longestSegment : allLatLngs;
}

function getMapFitMaxZoom(latLngs) {
  const spanKm = getLatLngSpanKm(latLngs);
  if (spanKm <= 3) return 14;
  if (spanKm <= 10) return 13;
  if (spanKm <= 35) return 12;
  if (spanKm <= 80) return 11;
  return 10;
}

function getLatLngSpanKm(latLngs) {
  if (latLngs.length < 2) return 0;
  let maxDistance = 0;
  for (let i = 0; i < latLngs.length; i++) {
    for (let j = i + 1; j < latLngs.length; j++) {
      maxDistance = Math.max(maxDistance, haversineKm(latLngs[i], latLngs[j]));
    }
  }
  return maxDistance;
}

function settleMapLayout(mapState) {
  const { map, latLngs } = mapState;
  const refresh = () => {
    if (!map.getContainer().isConnected) return;
    map.invalidateSize({ animate: false });
    if (mapState.hasUserMoved || mapState.hasInitialFit) return;
    if (latLngs.length > 1) {
      map.fitBounds(latLngs, { padding: MAP_FIT_PADDING, maxZoom: getMapFitMaxZoom(latLngs), animate: false });
    } else if (latLngs.length === 1) {
      map.setView(latLngs[0], MAP_SINGLE_POINT_ZOOM, { animate: false });
    } else {
      map.setView(getMapCenter(), 5, { animate: false });
    }
    mapState.hasInitialFit = true;
  };

  requestAnimationFrame(() => {
    refresh();
    requestAnimationFrame(refresh);
  });

  [80, 240, 620].forEach((delay) => {
    window.setTimeout(refresh, delay);
  });
}

function bindViewportMapRefresh() {
  if (state.viewportRefreshBound) return;
  state.viewportRefreshBound = true;

  const schedule = () => {
    if (state.viewportRefreshFrame) return;
    state.viewportRefreshFrame = requestAnimationFrame(() => {
      state.viewportRefreshFrame = null;
      state.maps.forEach((mapState) => {
        const { map } = mapState;
        if (!isMapNearViewport(map)) return;
        map.invalidateSize({ animate: false });
      });
    });
  };

  window.addEventListener('scroll', schedule, { passive: true });
  window.addEventListener('resize', schedule);
}

function isMapNearViewport(map) {
  const rect = map.getContainer().getBoundingClientRect();
  return rect.bottom > -240 && rect.top < window.innerHeight + 240;
}

function markerStyle() {
  return { radius: 8, color: '#fff7eb', weight: 4, fillColor: '#d84b2a', fillOpacity: 1, opacity: 1, pane: 'markerPane' };
}

function sourceLabelText(source) {
  switch (source) {
    case 'gps': return '照片 GPS';
    case 'manual': return '行程地点';
    default: return '';
  }
}

// --- GPS place detailed naming ---

function getRelativeDirection(fromLat, fromLng, toLat, toLng) {
  const dLat = toLat - fromLat;
  const dLng = toLng - fromLng;
  const absLat = Math.abs(dLat);
  const absLng = Math.abs(dLng);
  if (absLat < 0.0003 && absLng < 0.0003) return null;
  if (absLat > absLng * 1.5) return dLat > 0 ? '北侧' : '南侧';
  if (absLng > absLat * 1.5) return dLng > 0 ? '东侧' : '西侧';
  if (dLat > 0 && dLng > 0) return '东北侧';
  if (dLat > 0 && dLng < 0) return '西北侧';
  if (dLat < 0 && dLng > 0) return '东南侧';
  return '西南侧';
}

function getDetailedGpsDisplayName(place) {
  return place.displayName || place.name || '';
}

function getDetailedGpsNote(place) {
  return place.displayNote || place.note || '';
}

function getTripTimezoneHours() {
  return Number(state.data?.trip?.timezoneOffsetHours ?? 9);
}

function getJstTimeLabel(value) {
  if (!value) return '';
  const utcDate = new Date(value);
  const hour = (utcDate.getUTCHours() + getTripTimezoneHours()) % 24;
  if (hour < 6) return '清晨';
  if (hour < 11) return '上午';
  if (hour < 15) return '午后';
  if (hour < 18) return '傍晚';
  return '夜间';
}

function getJstTimeProgress(value) {
  if (!value) return null;
  const utcDate = new Date(value);
  if (Number.isNaN(utcDate.getTime())) return null;
  const hour = (utcDate.getUTCHours() + getTripTimezoneHours()) % 24;
  const minutes = hour * 60 + utcDate.getUTCMinutes();
  return Math.round((minutes / 1440) * 360);
}

/* ---- Place Photo Tooltip ---- */

function getImageMediaForDay(media, day) {
  const dayIds = new Set(day.sourceDayIds || [day.id]);
  return media.filter((item) => {
    if (!dayIds.has(item.dayId)) return false;
    if (item.type !== 'photo' && item.type !== 'receipt') return false;
    if (!item.src) return false;
    const ext = item.src.split('.').pop().toLowerCase();
    if (['heic', 'heif'].includes(ext)) return false;
    if (!item.location || !Number.isFinite(item.location.lat) || !Number.isFinite(item.location.lng)) return false;
    return true;
  });
}

function findNearestImagesForPlace(place, images, limit) {
  return images
    .filter(img => img.location && Number.isFinite(img.location.lat) && Number.isFinite(img.location.lng))
    .map((img) => ({
      img,
      dist: haversineKm([place.lat, place.lng], [img.location.lat, img.location.lng]),
      timeDiff: getMediaPlaceTimeDiff(place, img)
    }))
    .sort((a, b) => (a.dist - b.dist) || (a.timeDiff - b.timeDiff))
    .slice(0, limit)
    .map((entry) => entry.img);
}

function assignDistinctImagesToPlaces(places, images, limit) {
  const assignments = new Map();
  const usedPrimaryIds = new Set();
  const candidatesByPlace = new Map();

  places.forEach((place) => {
    candidatesByPlace.set(place, findImageCandidatesForPlace(place, images, Math.max(limit * 4, 16)));
  });

  places.forEach((place) => {
    const candidates = candidatesByPlace.get(place) || [];
    const primary = candidates.find((img) => !usedPrimaryIds.has(img.id || img.src)) || candidates[0];
    if (!primary) {
      assignments.set(place, []);
      return;
    }

    usedPrimaryIds.add(primary.id || primary.src);
    const rest = candidates
      .filter((img) => (img.id || img.src) !== (primary.id || primary.src))
      .slice(0, Math.max(0, limit - 1));
    assignments.set(place, [primary, ...rest]);
  });

  return assignments;
}

function findImageCandidatesForPlace(place, images, limit) {
  return images
    .filter(img => img.location && Number.isFinite(img.location.lat) && Number.isFinite(img.location.lng))
    .map((img) => {
      const distance = haversineKm([place.lat, place.lng], [img.location.lat, img.location.lng]);
      const timeDiff = getMediaPlaceTimeDiff(place, img);
      return {
        img,
        // Distance dominates, but time helps separate bursts around the same GPS cluster.
        score: distance + Math.min(timeDiff / (1000 * 60 * 60 * 24), 1) * 0.01
      };
    })
    .sort((a, b) => a.score - b.score)
    .slice(0, limit)
    .map((entry) => entry.img);
}

function getMediaPlaceTimeDiff(place, img) {
  const placeTime = place.capturedAt ? new Date(place.capturedAt).getTime() : Number.NaN;
  const mediaTime = img.capturedAt ? new Date(img.capturedAt).getTime() : Number.NaN;
  if (!Number.isFinite(placeTime) || !Number.isFinite(mediaTime)) return Number.MAX_SAFE_INTEGER;
  return Math.abs(placeTime - mediaTime);
}

function renderPlacePhotoTooltip(place, day, sequence, images) {
  const placeName = escapeHtml(getDetailedGpsDisplayName(place));
  const srcs = images.map((img) => encodeURI(resolveAssetUrl(img.src)));
  const first = images[0];
  const title = escapeHtml(first.title || '照片');
  const time = first.capturedAt
    ? `<small>${escapeHtml(new Date(first.capturedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }))}</small>`
    : '';
  return `
    <div class="photo-tooltip-card" data-candidates='${escapeHtml(JSON.stringify(srcs))}' data-index="0">
      <img src="${srcs[0]}" alt="${title}" loading="lazy" onerror="photoTooltipFallback(this)" />
      <div class="photo-tooltip-label">
        <strong>${placeName}</strong>
        <span>${title}${time}</span>
      </div>
    </div>
  `;
}

function attachPhotoPreview(marker, place, day, sequence, images) {
  const show = (event) => showPhotoPreview(event, place, day, sequence, images);
  const move = (event) => movePhotoPreview(event);

  marker.on('mouseover', (event) => show(event.originalEvent));
  marker.on('mousemove', (event) => move(event.originalEvent));
  marker.on('mouseout', hidePhotoPreview);

  marker.once('add', () => {
    const el = marker.getElement();
    if (!el) return;
    el.addEventListener('mouseenter', show);
    el.addEventListener('mousemove', move);
    el.addEventListener('mouseleave', hidePhotoPreview);
  });

  window.setTimeout(() => {
    const el = marker.getElement();
    if (!el || el.dataset.photoPreviewBound === 'true') return;
    el.dataset.photoPreviewBound = 'true';
    el.addEventListener('mouseenter', show);
    el.addEventListener('mousemove', move);
    el.addEventListener('mouseleave', hidePhotoPreview);
  }, 0);
}

function attachMapPhotoHover(map, items) {
  if (!items.length) return;

  const container = map.getContainer();
  container.addEventListener('mousemove', (event) => {
    const nearest = findNearestPreviewItem(map, event, items);
    if (!nearest) {
      hidePhotoPreview();
      return;
    }
    showPhotoPreview(event, nearest.place, nearest.day, nearest.sequence, nearest.images);
  });
  container.addEventListener('mouseleave', hidePhotoPreview);
}

function findNearestPreviewItem(map, event, items) {
  const mousePoint = map.mouseEventToContainerPoint(event);
  let best = null;
  let bestDistance = Infinity;

  items.forEach((item) => {
    const point = map.latLngToContainerPoint([item.place.lat, item.place.lng]);
    const distance = point.distanceTo(mousePoint);
    if (distance < bestDistance) {
      best = item;
      bestDistance = distance;
    }
  });

  return bestDistance <= 18 ? best : null;
}

function showPhotoPreview(event, place, day, sequence, images) {
  if (!event) return;
  const preview = getPhotoPreviewEl();
  preview.innerHTML = renderPlacePhotoTooltip(place, day, sequence, images);
  preview.classList.add('is-visible');
  movePhotoPreview(event);
}

function movePhotoPreview(event) {
  const preview = state.photoPreviewEl;
  if (!preview || !event) return;

  const offset = 18;
  const margin = 12;
  const rect = preview.getBoundingClientRect();
  let x = event.clientX + offset;
  let y = event.clientY - rect.height - offset;

  if (x + rect.width > window.innerWidth - margin) {
    x = event.clientX - rect.width - offset;
  }
  if (y < margin) {
    y = event.clientY + offset;
  }

  preview.style.left = `${Math.max(margin, x)}px`;
  preview.style.top = `${Math.max(margin, y)}px`;
}

function hidePhotoPreview() {
  if (!state.photoPreviewEl) return;
  state.photoPreviewEl.classList.remove('is-visible');
}

function getPhotoPreviewEl() {
  if (state.photoPreviewEl) return state.photoPreviewEl;
  const el = document.createElement('div');
  el.className = 'photo-hover-preview';
  document.body.appendChild(el);
  state.photoPreviewEl = el;
  return el;
}

/* ---- Nav Scroll Highlight ---- */

function setupNavObserver() {
  const nav = document.querySelector('#supplement-nav') || document.querySelector('#journal-nav');
  if (!nav || !window.IntersectionObserver) return;

  const buttons = nav.querySelectorAll('button');

  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (entry.isIntersecting) {
          buttons.forEach((b) => b.classList.remove('active'));
          const targetId = entry.target.id;
          const btn = nav.querySelector(`[data-target="${targetId}"]`);
          if (btn) btn.classList.add('active');
          break;
        }
      }
    },
    { rootMargin: '-20% 0px -60% 0px', threshold: 0 }
  );

  document.querySelectorAll('.day-card').forEach((card) => observer.observe(card));
}

/* ---- Utilities ---- */

function haversineKm(a, b) {
  const R = 6371;
  const dLat = ((b[0] - a[0]) * Math.PI) / 180;
  const dLng = ((b[1] - a[1]) * Math.PI) / 180;
  const sinDLat = Math.sin(dLat / 2);
  const sinDLng = Math.sin(dLng / 2);
  const h =
    sinDLat * sinDLat +
    Math.cos((a[0] * Math.PI) / 180) * Math.cos((b[0] * Math.PI) / 180) * sinDLng * sinDLng;
  return R * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function breakLongSegments(latLngs, maxKm) {
  const segments = [];
  let current = [latLngs[0]];
  for (let i = 1; i < latLngs.length; i++) {
    const dist = haversineKm(latLngs[i - 1], latLngs[i]);
    if (dist > maxKm) {
      if (current.length > 1) segments.push(current);
      current = [latLngs[i]];
    } else {
      current.push(latLngs[i]);
    }
  }
  if (current.length > 1) segments.push(current);
  return segments.length ? segments : [latLngs];
}

function formatDate(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    weekday: 'short'
  }).format(new Date(value));
}

function formatShortDate(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric'
  }).format(new Date(value));
}

function formatDayLabel(day) {
  if (!day.dateRange) return formatShortDate(day.date);
  return day.dateRange.map((date) => formatShortDate(date)).join('-');
}

function formatLongDayLabel(day) {
  if (!day.dateRange) return formatDate(day.date);
  return day.dateRange.map((date) => formatDate(date)).join(' - ');
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  }).format(new Date(value));
}

function emptyState(title, body) {
  return `
    <div class="empty-state">
      <h3>${escapeHtml(title)}</h3>
      <p>${escapeHtml(body)}</p>
    </div>
  `;
}

function escapeHtml(value) {
  if (value == null) return '';
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
    .replaceAll('`', '&#096;');
}

// Start the app after all declarations are processed
init();
