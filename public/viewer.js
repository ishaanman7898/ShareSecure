import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';

// ── block all download vectors ────────────────────────────────────────────────
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && ['s', 'p', 'u'].includes(e.key.toLowerCase())) e.preventDefault();
});
window.addEventListener('beforeprint', () => { document.body.innerHTML = '<p style="padding:40px;font-size:1.2rem">Printing is disabled.</p>'; });

// ── helpers ───────────────────────────────────────────────────────────────────
const rawShortId = location.pathname.split('/r/')[1]?.split('?')[0];

// ── current short id management ──────────────────────────────────────────────
let myShortId = rawShortId;

// ── ownership detection ───────────────────────────────────────────────────────
function checkOwnership() {
  try {
    const key = 'owner_' + myShortId;
    const token = localStorage.getItem(key);
    return token || null;
  } catch { return null; }
}

let myDeleteToken = checkOwnership();
let isOwner = !!myDeleteToken;

const $ = id => document.getElementById(id);
const show = id => $(id)?.classList.remove('hidden');
const hide = id => $(id)?.classList.add('hidden');

function formatSize(b) {
  if (b < 1024) return b + ' B';
  const units = ['KB', 'MB', 'GB'];
  let i = -1;
  do { b /= 1024; i++; } while (b >= 1024 && i < units.length - 1);
  return b.toFixed(1) + ' ' + units[i];
}

function updateOwnershipDisplay() {
  myDeleteToken = checkOwnership();
  isOwner = !!myDeleteToken;
  if (isOwner) show('delete-file-btn'); else hide('delete-file-btn');
}

// ── theme management ────────────────────────────────────────────────────────
function initTheme() {
  const saved = localStorage.getItem('theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  setTheme(saved);
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  const isDark = theme === 'dark';
  $('theme-btn').querySelector('.theme-sun').classList.toggle('hidden', isDark);
  $('theme-btn').querySelector('.theme-moon').classList.toggle('hidden', !isDark);
  $('theme-meta').content = isDark ? '#141417' : '#ffffff';
}

$('theme-btn').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  setTheme(current === 'dark' ? 'light' : 'dark');
});

initTheme();

async function assignFreshId() {
  try {
    const res = await fetch(`/api/reshare/${rawShortId}`, { method: 'POST' });
    const data = await res.json();
    if (data.shortId) {
      myShortId = data.shortId;
      history.replaceState(null, '', `/r/${myShortId}`);
      // If we got a delete token (as a sub-owner), store it so we can delete later
      if (data.deleteToken) {
        localStorage.setItem('owner_' + myShortId, data.deleteToken);
      }
      updateOwnershipDisplay();
    }
  } catch (_) { /* fall back to original id */ }
}

// ── countdown ─────────────────────────────────────────────────────────────────
function startCountdown(expiresAt) {
  if (!expiresAt) { $('countdown-wrap').style.display = 'none'; return; }
  const expiry = new Date(expiresAt).getTime();
  const wrap = $('countdown-wrap');
  const text = $('countdown-text');

  function tick() {
    const rem = expiry - Date.now();
    if (rem <= 0) {
      document.body.innerHTML = '';
      window.close();
      setTimeout(() => location.replace('/expired.html'), 300);
      return;
    }
    const s = Math.floor(rem / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
    text.textContent = h > 0
      ? `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`
      : m > 0 ? `${m}m ${String(sec).padStart(2, '0')}s` : `${sec}s`;
    wrap.className = 'countdown-wrap' + (rem < 60000 ? ' critical' : rem < 300000 ? ' warn' : '');
    setTimeout(tick, 1000);
  }
  tick();
}

// ── load metadata ─────────────────────────────────────────────────────────────
let fileInfo = null;
async function loadMeta() {
  const res = await fetch(`/api/info/${myShortId}`);
  if (!res.ok) { $('doc-title').textContent = 'File not found'; hide('loader'); return null; }
  return res.json();
}

// ── status polling (kick others out) ─────────────────────────────────────────
function startStatusPolling() {
  setInterval(async () => {
    try {
      const res = await fetch(`/api/info/${myShortId}`);
      if (res.status === 404 || res.status === 410) {
        // file is gone! kill the tab.
        document.body.innerHTML = '';
        location.replace('/expired.html');
      }
    } catch (err) { /* ignore network blips */ }
  }, 5000);
}

// ── drawing tools ─────────────────────────────────────────────────────────────
let currentTool = 'pen';
let currentColor = '#e74c3c';
const annotCanvases = [];
// track all drawing strokes for persistence
let allStrokes = []; // Array of { pageIndex, tool, color, points: [{x,y}] }
let isDrawing = false;
let currentStroke = null;

function setupDrawing(canvas, pageIndex) {
  const ctx = canvas.getContext('2d');

  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
    const src = e.touches ? e.touches[0] : e;
    return [(src.clientX - rect.left) * sx, (src.clientY - rect.top) * sy];
  }

  function startDraw(e) {
    e.preventDefault();
    isDrawing = true;
    const [x, y] = getPos(e);
    currentStroke = {
      pageIndex,
      tool: currentTool,
      color: currentTool === 'highlight' ? '#FFD600' : currentColor,
      points: [{ x, y }]
    };
  }

  function moveDraw(e) {
    e.preventDefault();
    if (!isDrawing || !currentStroke) return;
    const [x, y] = getPos(e);
    currentStroke.points.push({ x, y });

    // Draw the segment
    const pts = currentStroke.points;
    const prev = pts[pts.length - 2];
    const curr = pts[pts.length - 1];

    ctx.save();
    if (currentStroke.tool === 'pen') {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = currentStroke.color;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    } else if (currentStroke.tool === 'highlight') {
      ctx.globalAlpha = 0.35;
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = '#FFD600';
      ctx.lineWidth = 22;
      ctx.lineCap = 'square';
    } else if (currentStroke.tool === 'eraser') {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth = 24;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    }
    ctx.beginPath();
    ctx.moveTo(prev.x, prev.y); ctx.lineTo(curr.x, curr.y);
    ctx.stroke();
    ctx.restore();
  }

  function endDraw() {
    if (isDrawing && currentStroke && currentStroke.points.length > 1) {
      allStrokes.push(currentStroke);
      markAnnotationsDirty();
    }
    isDrawing = false;
    currentStroke = null;
  }

  canvas.addEventListener('mousedown', startDraw);
  canvas.addEventListener('mousemove', moveDraw);
  canvas.addEventListener('mouseup', endDraw);
  canvas.addEventListener('mouseleave', endDraw);
  canvas.addEventListener('touchstart', startDraw, { passive: false });
  canvas.addEventListener('touchmove', moveDraw, { passive: false });
  canvas.addEventListener('touchend', endDraw);
}

// ── redraw all strokes (for loading saved annotations or after zoom) ──────────
function redrawAllStrokes() {
  // clear all annotation canvases
  annotCanvases.forEach(c => c.getContext('2d').clearRect(0, 0, c.width, c.height));

  for (const stroke of allStrokes) {
    if (stroke.pageIndex >= annotCanvases.length) continue;
    const canvas = annotCanvases[stroke.pageIndex];
    const ctx = canvas.getContext('2d');

    ctx.save();
    if (stroke.tool === 'pen') {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    } else if (stroke.tool === 'highlight') {
      ctx.globalAlpha = 0.35;
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = '#FFD600';
      ctx.lineWidth = 22;
      ctx.lineCap = 'square';
    } else if (stroke.tool === 'eraser') {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth = 24;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    }

    ctx.beginPath();
    for (let i = 0; i < stroke.points.length; i++) {
      const pt = stroke.points[i];
      if (i === 0) ctx.moveTo(pt.x, pt.y);
      else ctx.lineTo(pt.x, pt.y);
    }
    ctx.stroke();
    ctx.restore();
  }
}

// ── annotation save state tracking ────────────────────────────────────────────
let annotationsDirty = false;

function markAnnotationsDirty() {
  annotationsDirty = true;
  const saveBtn = $('save-annotations-btn');
  if (saveBtn) {
    saveBtn.classList.add('unsaved');
    saveBtn.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v13a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
      Save*
    `;
  }
}

async function saveAnnotations() {
  const saveBtn = $('save-annotations-btn');
  if (saveBtn) {
    saveBtn.innerHTML = `
      <svg class="spin" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg>
      Saving...
    `;
    saveBtn.disabled = true;
  }

  try {
    const res = await fetch(`/api/annotations/${myShortId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ annotations: allStrokes })
    });
    const data = await res.json();
    if (data.saved) {
      annotationsDirty = false;
      if (saveBtn) {
        saveBtn.classList.remove('unsaved');
        saveBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          Saved!
        `;
        saveBtn.classList.add('saved');
        setTimeout(() => {
          saveBtn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v13a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
            Save
          `;
          saveBtn.classList.remove('saved');
        }, 2000);
      }
    }
  } catch (err) {
    if (saveBtn) {
      saveBtn.innerHTML = `
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
        Error
      `;
      setTimeout(() => {
        saveBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v13a2 2 0 0 1-2 2z"/><polyline points="17 21 17 13 7 13 7 21"/><polyline points="7 3 7 8 15 8"/></svg>
          Save
        `;
      }, 2000);
    }
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

async function loadAnnotations() {
  try {
    const res = await fetch(`/api/annotations/${myShortId}`);
    if (res.ok) {
      const data = await res.json();
      if (data.annotations && data.annotations.length > 0) {
        allStrokes = data.annotations;
        redrawAllStrokes();
      }
    }
  } catch (_) { /* ignore — annotations are optional */ }
}

// ── pdf viewer logic ───────────────────────────────────────────────────────
let pdfDoc = null;
let zoomScale = 1.3;
let currentRotation = 0;
let isRendering = false;

async function loadPDF(url) {
  try {
    pdfDoc = await pdfjsLib.getDocument(url).promise;
    $('page-count').textContent = pdfDoc.numPages;
    show('page-nav');

    await renderAllPages();
    await loadAnnotations();
    setupPageTracking();
  } catch (err) {
    console.error('PDF Load Error:', err);
    showUnsupported();
  }
}

async function renderAllPages() {
  if (isRendering) return;
  isRendering = true;
  hide('pdf-container');
  show('loader');

  const container = $('pdf-container');
  container.innerHTML = '';
  annotCanvases.length = 0;

  for (let n = 1; n <= pdfDoc.numPages; n++) {
    const page = await pdfDoc.getPage(n);
    const vp = page.getViewport({ scale: zoomScale, rotation: currentRotation });

    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page-wrapper';
    wrapper.id = `page-wrapper-${n}`;
    wrapper.style.width = `${vp.width}px`;
    wrapper.style.height = `${vp.height}px`;

    const pdfCanvas = document.createElement('canvas');
    pdfCanvas.width = vp.width; pdfCanvas.height = vp.height;
    pdfCanvas.className = 'pdf-page-canvas';

    const annotCanvas = document.createElement('canvas');
    annotCanvas.width = vp.width; annotCanvas.height = vp.height;
    annotCanvas.className = 'pdf-annot-canvas';
    annotCanvases.push(annotCanvas);

    wrapper.append(pdfCanvas, annotCanvas);
    container.appendChild(wrapper);

    await page.render({ canvasContext: pdfCanvas.getContext('2d'), viewport: vp }).promise;
    setupDrawing(annotCanvas, n - 1);
  }

  hide('loader');
  show('pdf-container');
  show('draw-toolbar');
  redrawAllStrokes();
  isRendering = false;
}

function setupPageTracking() {
  const container = $('viewer-shell');
  container.addEventListener('scroll', () => {
    const pages = document.querySelectorAll('.pdf-page-wrapper');
    let current = 1;
    let minDiff = Infinity;
    pages.forEach((p, i) => {
      const diff = Math.abs(p.getBoundingClientRect().top - 60);
      if (diff < minDiff) { minDiff = diff; current = i + 1; }
    });
    $('page-num').value = current;
  });
}

// UI Event Listeners
$('prev-page')?.addEventListener('click', () => {
  const target = Math.max(1, parseInt($('page-num').value) - 1);
  $('page-wrapper-' + target)?.scrollIntoView({ behavior: 'smooth' });
});

$('next-page')?.addEventListener('click', () => {
  const target = Math.min(pdfDoc?.numPages || 1, parseInt($('page-num').value) + 1);
  $('page-wrapper-' + target)?.scrollIntoView({ behavior: 'smooth' });
});

$('page-num')?.addEventListener('change', (e) => {
  const target = Math.min(pdfDoc?.numPages || 1, Math.max(1, parseInt(e.target.value)));
  $('page-wrapper-' + target)?.scrollIntoView({ behavior: 'smooth' });
});

$('rotate-btn')?.addEventListener('click', async () => {
  currentRotation = (currentRotation + 90) % 360;
  await renderAllPages();
});

$('zoom-in-btn')?.addEventListener('click', async () => {
  zoomScale = Math.min(zoomScale + 0.2, 4);
  if ($('zoom-label')) $('zoom-label').textContent = Math.round(zoomScale / 1.3 * 100) + '%';
  await renderAllPages();
});

$('zoom-out-btn')?.addEventListener('click', async () => {
  zoomScale = Math.max(zoomScale - 0.2, 0.5);
  if ($('zoom-label')) $('zoom-label').textContent = Math.round(zoomScale / 1.3 * 100) + '%';
  await renderAllPages();
});

// drawing toolbar
document.querySelectorAll('.draw-btn[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.draw-btn[data-tool]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentTool = btn.dataset.tool;
  });
});

$('color-picker')?.addEventListener('input', e => { currentColor = e.target.value; });

$('clear-btn')?.addEventListener('click', () => {
  if (!confirm('Clear all drawings on this document?')) return;
  annotCanvases.forEach(c => c.getContext('2d').clearRect(0, 0, c.width, c.height));
  allStrokes = [];
  markAnnotationsDirty();
});

$('save-annotations-btn')?.addEventListener('click', saveAnnotations);

// ── image ─────────────────────────────────────────────────────────────────────
function loadImage(url) {
  const img = $('img-viewer');
  img.src = url;
  img.onload = () => { hide('loader'); show('img-container'); };
  img.onerror = () => showUnsupported();
  hide('zoom-in-btn'); hide('zoom-out-btn'); hide('zoom-label');
}

// ── text ──────────────────────────────────────────────────────────────────────
async function loadText(url) {
  const text = await fetch(url).then(r => r.text());
  $('text-doc').textContent = text;
  hide('loader'); show('text-container');
  hide('zoom-in-btn'); hide('zoom-out-btn'); hide('zoom-label');
}

// ── video ─────────────────────────────────────────────────────────────────────
function loadVideo(url) {
  const v = $('video-player');
  v.src = url;
  v.oncanplay = () => { hide('loader'); show('video-container'); };
  v.onerror = () => showUnsupported();
  hide('zoom-in-btn'); hide('zoom-out-btn'); hide('zoom-label');
}

// ── audio ─────────────────────────────────────────────────────────────────────
function loadAudio(url, name) {
  $('audio-player').src = url;
  $('audio-title').textContent = name;
  hide('loader'); show('audio-container');
  hide('zoom-in-btn'); hide('zoom-out-btn'); hide('zoom-label');
}

// ── unsupported ───────────────────────────────────────────────────────────────
function showUnsupported() {
  hide('loader');
  $('unsupported-title').textContent = fileInfo?.filename || 'Unknown file';
  show('unsupported');
  hide('zoom-in-btn'); hide('zoom-out-btn'); hide('zoom-label');
}

// ── share panel ───────────────────────────────────────────────────────────────
function makeQR(divEl, url) {
  divEl.innerHTML = '';
  new QRCode(divEl, {
    text: url, width: 180, height: 180,
    colorDark: '#000', colorLight: '#fff',
    correctLevel: QRCode.CorrectLevel.M
  });
}

function openSharePanel() {
  show('share-overlay'); show('share-panel');
  show('share-generating'); hide('share-ready');

  fetch(`/api/reshare/${myShortId}`, { method: 'POST' })
    .then(r => r.json())
    .then(data => {
      $('share-link-text').textContent = data.shortUrl;
      makeQR($('share-qr-div'), data.shortUrl);
      hide('share-generating'); show('share-ready');

      $('share-copy-btn').onclick = () => {
        navigator.clipboard.writeText(data.shortUrl).then(() => {
          $('share-copy-btn').textContent = 'Copied!';
          $('share-copy-btn').classList.add('copied');
          setTimeout(() => { $('share-copy-btn').textContent = 'Copy'; $('share-copy-btn').classList.remove('copied'); }, 2000);
        });
      };

      $('share-save-qr').onclick = () => {
        const img = $('share-qr-div').querySelector('canvas') || $('share-qr-div').querySelector('img');
        const a = document.createElement('a');
        a.href = img.tagName === 'CANVAS' ? img.toDataURL('image/png') : img.src;
        a.download = 'share-qr.png'; a.click();
      };
    })
    .catch(() => {
      $('share-panel-body').innerHTML = '<p style="color:red;padding:20px;font-size:.85rem">Failed to generate link.</p>';
    });
}

function closeSharePanel() { hide('share-overlay'); hide('share-panel'); }

// ── main ──────────────────────────────────────────────────────────────────────
(async () => {
  // owner keeps their original link — no redirect, no reshare.
  // non-owner (no delete token) gets a fresh unique id so their link is untraceable.
  if (!isOwner) {
    await assignFreshId();
  }

  // ownership and polling initialization
  updateOwnershipDisplay();
  startStatusPolling();

  fileInfo = await loadMeta();
  if (!fileInfo) return;

  const { filename, size, mimeType, expiresAt, integrityHash } = fileInfo;
  document.title = filename + ' — FileShare';
  $('doc-title').textContent = filename;
  $('doc-meta').textContent = formatSize(size);
  startCountdown(expiresAt);

  // show integrity hash badge
  if (integrityHash) {
    const badge = $('integrity-badge');
    if (badge) {
      badge.textContent = '🔒 SHA-256: ' + integrityHash.substring(0, 12) + '…';
      badge.title = 'Full hash: ' + integrityHash;
      badge.classList.remove('hidden');
    }
  }

  $('share-btn').addEventListener('click', openSharePanel);
  $('share-close').addEventListener('click', closeSharePanel);
  $('share-overlay').addEventListener('click', closeSharePanel);

  // use the refined delete handler
  $('delete-file-btn').addEventListener('click', async () => {
    const isRoot = fileInfo?.isRoot;
    const msg = isRoot
      ? 'CAUTION: This will delete the file for EVERYONE on all links. Continue?'
      : 'Delete your link and all links reshared from it?';

    if (!confirm(msg)) return;

    $('delete-file-btn').textContent = '⏳';
    $('delete-file-btn').disabled = true;
    try {
      const res = await fetch(`/api/delete/${myShortId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteToken: myDeleteToken })
      });
      const data = await res.json();
      if (data.deleted) {
        localStorage.removeItem('owner_' + myShortId);
        document.body.innerHTML = '';
        location.replace('/expired.html');
      } else {
        $('delete-file-btn').innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
        $('delete-file-btn').disabled = false;
      }
    } catch {
      $('delete-file-btn').innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
      $('delete-file-btn').disabled = false;
    }
  });

  // use the owner's short id for raw access (not the reshared one)
  const rawUrl = `/api/raw/${myShortId}`;

  if (mimeType === 'application/pdf') { await loadPDF(rawUrl); }
  else if (mimeType.startsWith('image/')) { loadImage(rawUrl); }
  else if (mimeType.startsWith('video/')) { loadVideo(rawUrl); }
  else if (mimeType.startsWith('audio/')) { loadAudio(rawUrl, filename); }
  else if (mimeType.startsWith('text/') || mimeType === 'application/json') { await loadText(rawUrl); }
  else { showUnsupported(); }

  // warn before leaving with unsaved annotations
  window.addEventListener('beforeunload', (e) => {
    if (annotationsDirty) {
      e.preventDefault();
      e.returnValue = '';
    }
  });
})();
