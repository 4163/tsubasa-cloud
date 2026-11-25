import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function readCliOption(flag) {
  const args = process.argv.slice(2);
  const idx = args.indexOf(flag);
  return idx !== -1 && idx + 1 < args.length ? args[idx + 1] : undefined;
}

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const AUDIT_ROOT = path.resolve(readCliOption('--dir') || process.env.AUDIT_ROOT || SCRIPT_DIR);
const NOTES_FILE = path.join(AUDIT_ROOT, 'audit-notes.json');
const rawPort = readCliOption('--port') || process.env.PORT || '28302';
const PORT = Number.parseInt(rawPort, 10);
if (!Number.isInteger(PORT) || PORT <= 0 || PORT > 65535) {
  throw new Error(`Invalid port: ${rawPort}`);
}

function listScreenshots() {
  const byState = new Map();
  if (!fs.existsSync(AUDIT_ROOT)) return [];
  const folders = fs.readdirSync(AUDIT_ROOT, { withFileTypes: true }).filter((d) => d.isDirectory());
  for (const dir of folders) {
    const dirPath = path.join(AUDIT_ROOT, dir.name);
    const files = fs.readdirSync(dirPath).filter((f) => f.endsWith('.png') && !f.endsWith('--dark.png')).sort();
    for (const file of files) {
      const m = file.match(/^(.*)--(desktop-16x9|mobile)\.png$/);
      if (!m) continue;
      const state = m[1];
      const bp = m[2];
      const id = `${dir.name}/${state}`;
      if (!byState.has(id)) {
        byState.set(id, { id, group: dir.name, state, urls: {} });
      }
      const darkFile = file.replace(/\.png$/, '--dark.png');
      byState.get(id).urls[bp] = {
        light: `/images/${encodeURIComponent(dir.name)}/${encodeURIComponent(file)}`,
        dark: fs.existsSync(path.join(dirPath, darkFile))
          ? `/images/${encodeURIComponent(dir.name)}/${encodeURIComponent(darkFile)}`
          : null,
      };
    }
  }
  return Array.from(byState.values());
}

function readNotes() {
  let raw = { byImage: {}, globalNotes: '' };
  try {
    if (fs.existsSync(NOTES_FILE)) {
      raw = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
    }
  } catch {}
  const merged = {};
  for (const [key, val] of Object.entries(raw.byImage || {})) {
    const stripped = key.replace(/\.png$/, '');
    const cleanKey = /--(desktop-16x9|mobile)$/.test(stripped)
      ? stripped
      : `${stripped}--desktop-16x9`;
    if (!merged[cleanKey]) {
      merged[cleanKey] = { general: '', regions: [] };
    }
    const g = (val?.general || '').trim();
    if (g) {
      if (!merged[cleanKey].general) {
        merged[cleanKey].general = g;
      } else if (merged[cleanKey].general.toLowerCase() !== g.toLowerCase() && !merged[cleanKey].general.includes(g)) {
        merged[cleanKey].general += '\n' + g;
      }
    }
    if (Array.isArray(val?.regions) && val.regions.length > 0) {
      for (const r of val.regions) {
        if (!merged[cleanKey].regions.some((x) => x.id === r.id)) {
          merged[cleanKey].regions.push(r);
        }
      }
    }
  }
  return { byImage: merged, globalNotes: raw.globalNotes || '' };
}

function writeNotes(data) {
  fs.mkdirSync(AUDIT_ROOT, { recursive: true });
  fs.writeFileSync(NOTES_FILE, JSON.stringify(data, null, 2), 'utf8');
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Tsubasa~ Frontend Audit Annotator</title>
<style>
  :root {
    --bg: #eef2ec;
    --surface: #f7faf5;
    --surface-elevated: #ffffff;
    --text: #111d18;
    --text-muted: #2d453b;
    --border: #8ea194;
    --border-subtle: #c2d1c7;
    --accent: #116329;
    --gold: #deb76c;
    --danger: #82071e;
    --hover: #e4ede7;
  }
  [data-theme="dark"] {
    --bg: #0b1412;
    --surface: #12211d;
    --surface-elevated: #1b3b32;
    --text: #e5f2eb;
    --text-muted: #9bb8ab;
    --border: #2d453b;
    --border-subtle: #1e302a;
    --accent: #7ee787;
    --gold: #d4a13c;
    --danger: #ff9492;
    --hover: #162d26;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: var(--bg);
    color: var(--text);
    height: 100vh;
    display: grid;
    grid-template-columns: 280px 1fr 340px;
    grid-template-rows: 48px 1fr;
    overflow: hidden;
  }
  header {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 16px;
    background: var(--surface);
    border-bottom: 1px solid var(--border);
  }
  header h1 { font-size: 14px; font-weight: 700; margin: 0; }
  .header-actions { display: flex; gap: 8px; align-items: center; }
  button {
    font: inherit;
    font-size: 12px;
    font-weight: 600;
    padding: 6px 10px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--surface-elevated);
    color: var(--text);
    cursor: pointer;
  }
  button:hover { background: var(--hover); }
  button.primary {
    background: var(--text);
    color: var(--surface);
    border-color: var(--text);
  }
  button.danger { color: var(--danger); border-color: var(--danger); }
  aside.sidebar {
    background: var(--surface);
    border-right: 1px solid var(--border);
    overflow-y: auto;
    padding: 8px 0;
  }
  .group-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
    padding: 10px 12px 4px;
  }
  .nav-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 12px;
    font-size: 12px;
    cursor: pointer;
    border-left: 3px solid transparent;
    gap: 6px;
  }
  .nav-item:hover { background: var(--hover); }
  .nav-item.active {
    background: var(--hover);
    border-left-color: var(--gold);
    font-weight: 600;
  }
  .badge {
    font-size: 10px;
    padding: 1px 5px;
    border-radius: 4px;
    border: 1px solid var(--border-subtle);
    color: var(--text-muted);
    flex-shrink: 0;
  }
  .badge.has-notes {
    background: var(--gold);
    color: #111d18;
    border-color: var(--gold);
    font-weight: 700;
  }
  main.canvas-area {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    padding: 16px;
    overflow: auto;
    position: relative;
  }
  .stage-toolbar {
    display: flex;
    gap: 8px;
    align-items: center;
    margin-bottom: 10px;
    font-size: 12px;
    color: var(--text-muted);
  }
  .image-stage {
    position: relative;
    display: inline-block;
    user-select: none;
    border: 1px solid var(--border);
    background: #000;
    max-width: 100%;
    max-height: calc(100vh - 120px);
    cursor: crosshair;
  }
  .image-stage img {
    display: block;
    max-width: 100%;
    max-height: calc(100vh - 122px);
    width: auto;
    height: auto;
    pointer-events: none;
  }
  .marquee-box {
    position: absolute;
    border: 2px solid var(--gold);
    background: rgba(222, 183, 108, 0.22);
    pointer-events: none;
  }
  .region-box {
    position: absolute;
    border: 2px solid var(--accent);
    background: rgba(17, 99, 41, 0.12);
    cursor: pointer;
  }
  .region-box.selected {
    border-color: var(--gold);
    background: rgba(222, 183, 108, 0.22);
    z-index: 5;
  }
  .region-tag {
    position: absolute;
    top: -1px;
    left: -1px;
    background: var(--accent);
    color: #fff;
    font-size: 10px;
    font-weight: 700;
    padding: 1px 5px;
    line-height: 1.2;
  }
  [data-theme="dark"] .region-tag { color: #0b1412; }
  .region-box.selected .region-tag {
    background: var(--gold);
    color: #111d18;
  }
  aside.inspector {
    background: var(--surface);
    border-left: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .inspector-section {
    padding: 12px;
    border-bottom: 1px solid var(--border-subtle);
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .inspector-section h2 {
    margin: 0;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
  textarea {
    width: 100%;
    min-height: 76px;
    resize: vertical;
    font: inherit;
    font-size: 12px;
    padding: 8px;
    border-radius: 6px;
    border: 1px solid var(--border);
    background: var(--surface-elevated);
    color: var(--text);
  }
  .regions-list {
    flex: 1;
    overflow-y: auto;
    padding: 12px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }
  .region-card {
    border: 1px solid var(--border);
    border-radius: 6px;
    padding: 8px;
    background: var(--surface-elevated);
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .region-card.selected {
    border-color: var(--gold);
    outline: 1px solid var(--gold);
  }
  .region-card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 11px;
    font-weight: 700;
  }
  .status-pill { font-size: 11px; color: var(--text-muted); }
</style>
</head>
<body>
  <header>
    <h1>Tsubasa~ Frontend Audit Annotator</h1>
    <div class="header-actions">
      <span class="status-pill" id="saveStatus">Loaded</span>
      <button id="bpToggle">Breakpoint: desktop-16x9 (1366x768)</button>
      <button id="themeToggle">Theme: Light</button>
      <button class="primary" id="copyMdBtn">Copy Markdown Summary</button>
    </div>
  </header>

  <aside class="sidebar" id="sidebar"></aside>

  <main class="canvas-area">
    <div class="stage-toolbar" id="stageToolbar">Drag on the screenshot to draw a marquee box and attach a note.</div>
    <div class="image-stage" id="imageStage">
      <img id="previewImg" alt="Frontend screenshot" draggable="false" />
      <div id="regionsOverlay"></div>
      <div id="marqueePreview" class="marquee-box" style="display:none;"></div>
    </div>
  </main>

  <aside class="inspector">
    <div class="inspector-section">
      <h2>General Notes (This Screenshot)</h2>
      <textarea id="imageGeneralNotes" placeholder="Overall layout, spacing, contrast, or alignment notes for this screen or state..."></textarea>
    </div>
    <div class="inspector-section">
      <h2>Global Audit Notes (All Screens)</h2>
      <textarea id="globalNotes" placeholder="Cross-cutting feedback across all screens..."></textarea>
    </div>
    <div class="regions-list" id="regionsList"></div>
  </aside>

<script>
const BREAKPOINTS = {
  'desktop-16x9': { label: 'desktop-16x9 (1366x768)' },
  mobile: { label: 'mobile (390x844)' },
};
let screenshots = [];
let notes = { byImage: {}, globalNotes: '' };
let currentBreakpoint = 'desktop-16x9';
let currentTheme = 'light';
let currentId = null;
let selectedRegionId = null;
let dragStart = null;
let saveTimer = null;

function noteKey(id, bp = currentBreakpoint) {
  return id + '--' + bp;
}

function ensureImageEntry(id, bp = currentBreakpoint) {
  const key = noteKey(id, bp);
  if (!notes.byImage[key]) {
    notes.byImage[key] = { general: '', regions: [] };
  }
  return notes.byImage[key];
}

function scheduleSave() {
  document.getElementById('saveStatus').textContent = 'Saving...';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await fetch('/api/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(notes),
    });
    document.getElementById('saveStatus').textContent = 'Saved to audit-notes.json';
  }, 250);
}

function visibleScreenshots() {
  return screenshots.filter((s) => Boolean(s.urls?.[currentBreakpoint]));
}

function renderSidebar() {
  const sb = document.getElementById('sidebar');
  sb.innerHTML = '';
  const list = visibleScreenshots();
  const byGroup = new Map();
  for (const item of list) {
    if (!byGroup.has(item.group)) byGroup.set(item.group, []);
    byGroup.get(item.group).push(item);
  }
  for (const [group, items] of byGroup.entries()) {
    const title = document.createElement('div');
    title.className = 'group-title';
    title.textContent = group;
    sb.appendChild(title);
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'nav-item' + (item.id === currentId ? ' active' : '');
      const entry = notes.byImage[noteKey(item.id)];
      const count = (entry?.regions?.length || 0) + (entry?.general?.trim() ? 1 : 0);
      row.innerHTML = '<span>' + item.state + '</span>' +
        (count > 0 ? '<span class="badge has-notes">' + count + '</span>' : '');
      row.onclick = () => selectScreenshot(item.id);
      sb.appendChild(row);
    }
  }
}

function updateSelectionStyles() {
  document.querySelectorAll('.region-box').forEach((el) => {
    el.classList.toggle('selected', el.dataset.regionId === selectedRegionId);
  });
  document.querySelectorAll('.region-card').forEach((el) => {
    el.classList.toggle('selected', el.dataset.regionId === selectedRegionId);
  });
}

function renderRegions() {
  const overlay = document.getElementById('regionsOverlay');
  const list = document.getElementById('regionsList');
  overlay.innerHTML = '';
  list.innerHTML = '';
  if (!currentId) return;

  const entry = ensureImageEntry(currentId);
  entry.regions.forEach((reg, idx) => {
    const box = document.createElement('div');
    box.className = 'region-box' + (reg.id === selectedRegionId ? ' selected' : '');
    box.dataset.regionId = reg.id;
    box.style.left = reg.x + '%';
    box.style.top = reg.y + '%';
    box.style.width = reg.w + '%';
    box.style.height = reg.h + '%';
    box.innerHTML = '<span class="region-tag">#' + (idx + 1) + '</span>';
    box.onclick = (e) => {
      e.stopPropagation();
      selectedRegionId = reg.id;
      updateSelectionStyles();
      const ta = document.querySelector('textarea[data-region-id="' + reg.id + '"]');
      if (ta) ta.focus();
    };
    overlay.appendChild(box);

    const card = document.createElement('div');
    card.className = 'region-card' + (reg.id === selectedRegionId ? ' selected' : '');
    card.dataset.regionId = reg.id;
    card.onclick = () => {
      if (selectedRegionId !== reg.id) {
        selectedRegionId = reg.id;
        updateSelectionStyles();
      }
    };

    const head = document.createElement('div');
    head.className = 'region-card-head';
    head.innerHTML = '<span>Area #' + (idx + 1) + ' (' + Math.round(reg.w) + '% × ' + Math.round(reg.h) + '%)</span>';
    const delBtn = document.createElement('button');
    delBtn.className = 'danger';
    delBtn.textContent = 'Delete';
    delBtn.onclick = (e) => {
      e.stopPropagation();
      entry.regions = entry.regions.filter((r) => r.id !== reg.id);
      if (selectedRegionId === reg.id) selectedRegionId = null;
      scheduleSave();
      renderSidebar();
      renderRegions();
    };
    head.appendChild(delBtn);

    const ta = document.createElement('textarea');
    ta.placeholder = 'Note for Area #' + (idx + 1) + '...';
    ta.value = reg.note || '';
    ta.dataset.regionId = reg.id;
    ta.oninput = () => {
      reg.note = ta.value;
      scheduleSave();
      renderSidebar();
    };

    card.appendChild(head);
    card.appendChild(ta);
    list.appendChild(card);
  });
}

function getScreenshotUrl(item) {
  const bpUrls = item.urls?.[currentBreakpoint] || item.urls?.['desktop-16x9'] || item.urls?.mobile;
  if (!bpUrls) return '';
  if (currentTheme === 'dark' && bpUrls.dark) return bpUrls.dark;
  return bpUrls.light;
}

function updateStagePreview(item) {
  document.getElementById('previewImg').src = getScreenshotUrl(item) + '?t=' + Date.now();
  const bpLabel = BREAKPOINTS[currentBreakpoint]?.label || currentBreakpoint;
  document.getElementById('stageToolbar').textContent =
    item.group + ' / ' + item.state + ' (' + bpLabel + ', ' + currentTheme + ') · Drag on image to select area';
}

function selectScreenshot(id) {
  currentId = id;
  selectedRegionId = null;
  const item = screenshots.find((s) => s.id === id);
  if (!item) return;
  updateStagePreview(item);
  const entry = ensureImageEntry(id);
  document.getElementById('imageGeneralNotes').value = entry.general || '';
  renderSidebar();
  renderRegions();
}

const stage = document.getElementById('imageStage');
const marquee = document.getElementById('marqueePreview');

stage.addEventListener('mousedown', (e) => {
  if (e.button !== 0 || !currentId) return;
  const rect = stage.getBoundingClientRect();
  dragStart = {
    xPct: Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100)),
    yPct: Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100)),
  };
  marquee.style.display = 'block';
  marquee.style.left = dragStart.xPct + '%';
  marquee.style.top = dragStart.yPct + '%';
  marquee.style.width = '0%';
  marquee.style.height = '0%';
});

window.addEventListener('mousemove', (e) => {
  if (!dragStart) return;
  const rect = stage.getBoundingClientRect();
  const curX = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
  const curY = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
  const x = Math.min(dragStart.xPct, curX);
  const y = Math.min(dragStart.yPct, curY);
  const w = Math.abs(curX - dragStart.xPct);
  const h = Math.abs(curY - dragStart.yPct);
  marquee.style.left = x + '%';
  marquee.style.top = y + '%';
  marquee.style.width = w + '%';
  marquee.style.height = h + '%';
});

window.addEventListener('mouseup', (e) => {
  if (!dragStart) return;
  const rect = stage.getBoundingClientRect();
  const curX = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
  const curY = Math.max(0, Math.min(100, ((e.clientY - rect.top) / rect.height) * 100));
  const x = Math.min(dragStart.xPct, curX);
  const y = Math.min(dragStart.yPct, curY);
  const w = Math.abs(curX - dragStart.xPct);
  const h = Math.abs(curY - dragStart.yPct);
  dragStart = null;
  marquee.style.display = 'none';

  if (w < 1.5 || h < 1.5) return;
  const entry = ensureImageEntry(currentId);
  const newRegion = {
    id: 'r-' + Date.now(),
    x: Number(x.toFixed(2)),
    y: Number(y.toFixed(2)),
    w: Number(w.toFixed(2)),
    h: Number(h.toFixed(2)),
    note: '',
  };
  entry.regions.push(newRegion);
  selectedRegionId = newRegion.id;
  scheduleSave();
  renderSidebar();
  renderRegions();
  const ta = document.querySelector('textarea[data-region-id="' + newRegion.id + '"]');
  if (ta) ta.focus();
});

document.getElementById('imageGeneralNotes').addEventListener('input', (e) => {
  if (!currentId) return;
  ensureImageEntry(currentId).general = e.target.value;
  scheduleSave();
  renderSidebar();
});

document.getElementById('globalNotes').addEventListener('input', (e) => {
  notes.globalNotes = e.target.value;
  scheduleSave();
});

document.getElementById('bpToggle').addEventListener('click', () => {
  currentBreakpoint = currentBreakpoint === 'desktop-16x9' ? 'mobile' : 'desktop-16x9';
  document.getElementById('bpToggle').textContent = 'Breakpoint: ' + BREAKPOINTS[currentBreakpoint].label;
  const visible = visibleScreenshots();
  const item = visible.find((s) => s.id === currentId) || visible[0];
  if (item) {
    selectScreenshot(item.id);
  } else {
    currentId = null;
    selectedRegionId = null;
    document.getElementById('imageGeneralNotes').value = '';
    renderSidebar();
    renderRegions();
  }
});

document.getElementById('themeToggle').addEventListener('click', () => {
  currentTheme = currentTheme === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', currentTheme);
  document.getElementById('themeToggle').textContent = 'Theme: ' + (currentTheme === 'dark' ? 'Dark' : 'Light');
  const item = screenshots.find((s) => s.id === currentId);
  if (item) updateStagePreview(item);
});

document.getElementById('copyMdBtn').addEventListener('click', async () => {
  const lines = ['# Frontend Audit Notes', ''];
  if (notes.globalNotes?.trim()) {
    lines.push('## Global Notes', notes.globalNotes.trim(), '');
  }
  for (const [id, entry] of Object.entries(notes.byImage)) {
    const hasGeneral = entry.general && entry.general.trim();
    const hasRegions = entry.regions && entry.regions.length > 0;
    if (!hasGeneral && !hasRegions) continue;
    lines.push('## ' + id);
    if (hasGeneral) lines.push('- **General:** ' + entry.general.trim());
    (entry.regions || []).forEach((r, idx) => {
      lines.push('- **Area #' + (idx + 1) + '** (' + r.x + '%, ' + r.y + '%, ' + r.w + '%x' + r.h + '%): ' + (r.note || '(no note)'));
    });
    lines.push('');
  }
  await navigator.clipboard.writeText(lines.join('\\n'));
  document.getElementById('saveStatus').textContent = 'Copied Markdown to clipboard!';
});

async function init() {
  const [listRes, notesRes] = await Promise.all([fetch('/api/screenshots'), fetch('/api/notes')]);
  screenshots = await listRes.json();
  notes = await notesRes.json();
  document.getElementById('globalNotes').value = notes.globalNotes || '';
  const first = visibleScreenshots()[0] || screenshots[0];
  if (first) {
    selectScreenshot(first.id);
  } else {
    renderSidebar();
    document.getElementById('stageToolbar').textContent = 'No screenshots found. Place *--desktop-16x9.png (1366x768) or *--mobile.png (390x844) captures in subdirectories and reload.';
  }
}

init();
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', `http://localhost:${PORT}`);

  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HTML);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/screenshots') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(listScreenshots()));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/notes') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(readNotes()));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/notes') {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        const parsed = JSON.parse(body);
        writeNotes(parsed);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: String(err) }));
      }
    });
    return;
  }

  if (req.method === 'GET' && url.pathname.startsWith('/images/')) {
    const rel = url.pathname.slice('/images/'.length).split('/').map(decodeURIComponent).join(path.sep);
    const full = path.resolve(AUDIT_ROOT, rel);
    if (!full.startsWith(path.resolve(AUDIT_ROOT)) || !fs.existsSync(full)) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'image/png' });
    fs.createReadStream(full).pipe(res);
    return;
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Frontend audit annotator listening on http://localhost:${PORT}`);
});
