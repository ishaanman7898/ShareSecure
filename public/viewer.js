import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';

// ── keyboard toast notification ───────────────────────────────────────────────
let kbToastTimer = null;
function showKbToast(msg) {
  let el = document.getElementById('kb-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'kb-toast';
    el.className = 'kb-toast';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.classList.remove('fade-out');
  if (kbToastTimer) clearTimeout(kbToastTimer);
  kbToastTimer = setTimeout(() => { el.classList.add('fade-out'); }, 1200);
}

// ── block all download vectors ────────────────────────────────────────────────
document.addEventListener('contextmenu', e => e.preventDefault());

// ── screenshot shield ─────────────────────────────────────────────────────────
let shieldBlankTimeout = null;

function showShield(message, autohideMs) {
  const shield = document.getElementById('screenshot-shield');
  if (!shield) return;
  if (message) {
    shield.innerHTML = `
      <div style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;color:rgba(255,255,255,0.35);user-select:none;pointer-events:none;">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
        </svg>
        <p style="margin-top:12px;font-size:0.85rem;letter-spacing:0.03em;">${message}</p>
      </div>`;
  } else {
    shield.innerHTML = '';
  }
  shield.classList.remove('hidden');
  if (shieldBlankTimeout) { clearTimeout(shieldBlankTimeout); shieldBlankTimeout = null; }
  if (autohideMs) {
    shieldBlankTimeout = setTimeout(hideShield, autohideMs);
  }
}

function hideShield() {
  const shield = document.getElementById('screenshot-shield');
  if (shield) shield.classList.add('hidden');
  if (shieldBlankTimeout) { clearTimeout(shieldBlankTimeout); shieldBlankTimeout = null; }
}

// Legacy alias used by keyboard handler below
function flashScreenshotShield() {
  showShield('Screenshot blocked', 2000);
}

// ── keyboard shortcuts & screenshot/copy/print blocking ──────────────────────
document.addEventListener('keydown', e => {
  const key = e.key.toLowerCase();
  const tag = document.activeElement?.tagName?.toLowerCase();
  const inInput = tag === 'input' || tag === 'textarea' || tag === 'select';

  // Block save, print, view-source
  if ((e.ctrlKey || e.metaKey) && ['s', 'p', 'u'].includes(key)) {
    e.preventDefault();
    return;
  }

  // Block select-all and copy (prevent clipboard exfil)
  if ((e.ctrlKey || e.metaKey) && ['a', 'c'].includes(key)) {
    e.preventDefault();
    return;
  }

  // PrintScreen / F13 (some keyboards)
  if (e.key === 'PrintScreen' || e.key === 'F13') {
    e.preventDefault();
    flashScreenshotShield();
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText('');
    return;
  }

  // macOS screenshot shortcuts: Cmd+Shift+3, 4, 5, 6
  if (e.metaKey && e.shiftKey && ['3', '4', '5', '6'].includes(e.key)) {
    e.preventDefault();
    flashScreenshotShield();
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText('');
    return;
  }

  // Windows Snipping Tool shortcut: Win+Shift+S is caught as Meta+Shift+s on some browsers
  if (e.metaKey && e.shiftKey && key === 's') {
    e.preventDefault();
    flashScreenshotShield();
    return;
  }

  // F12 / DevTools
  if (e.key === 'F12') {
    e.preventDefault();
    return;
  }

  // ── viewer keyboard shortcuts (skip when typing in inputs) ────────────────
  if (inInput) return;

  // Undo / Redo annotations
  if ((e.ctrlKey || e.metaKey) && key === 'z') {
    e.preventDefault();
    if (e.shiftKey) {
      doRedo();
    } else {
      doUndo();
    }
    return;
  }
  if ((e.ctrlKey || e.metaKey) && key === 'y') {
    e.preventDefault();
    doRedo();
    return;
  }

  // Open search
  if ((e.ctrlKey || e.metaKey) && key === 'f') {
    e.preventDefault();
    openSearch();
    return;
  }

  // Fullscreen
  if (e.key === 'F11') {
    e.preventDefault();
    toggleFullscreen();
    return;
  }

  // Escape: close search, share panel, or exit fullscreen
  if (e.key === 'Escape') {
    if (!document.getElementById('search-bar')?.classList.contains('hidden')) {
      closeSearch();
      return;
    }
    if (!document.getElementById('share-panel')?.classList.contains('hidden')) {
      closeSharePanel();
      return;
    }
    if (document.fullscreenElement) {
      document.exitFullscreen();
      return;
    }
    return;
  }

  // PDF navigation — arrow keys
  if (pdfDoc) {
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
      e.preventDefault();
      const target = Math.min(pdfDoc.numPages, parseInt($('page-num').value) + 1);
      $('page-wrapper-' + target)?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
      e.preventDefault();
      const target = Math.max(1, parseInt($('page-num').value) - 1);
      $('page-wrapper-' + target)?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (e.key === 'Home') {
      e.preventDefault();
      $('page-wrapper-1')?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if (e.key === 'End') {
      e.preventDefault();
      $('page-wrapper-' + pdfDoc.numPages)?.scrollIntoView({ behavior: 'smooth' });
      return;
    }
    // Zoom with + / -
    if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      adjustZoom(+0.25);
      return;
    }
    if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      adjustZoom(-0.25);
      return;
    }
    // Reset zoom
    if (e.key === '0') {
      e.preventDefault();
      zoomScale = 1.3;
      fitMode = null;
      $('fit-btn')?.classList.remove('active');
      updateZoomLabel();
      renderAllPages();
      showKbToast('Zoom reset to 100%');
      return;
    }
    // Fit to width
    if (key === 'f') {
      e.preventDefault();
      toggleFitToWidth();
      return;
    }
    // Rotate
    if (key === 'r') {
      e.preventDefault();
      currentRotation = (currentRotation + 90) % 360;
      renderAllPages();
      showKbToast(`Rotated ${currentRotation}°`);
      return;
    }
    // Invert
    if (key === 'i') {
      e.preventDefault();
      pdfInverted = !pdfInverted;
      $('pdf-container')?.classList.toggle('pdf-inverted', pdfInverted);
      $('invert-pdf-btn')?.classList.toggle('active', pdfInverted);
      showKbToast(pdfInverted ? 'Colors inverted' : 'Colors restored');
      return;
    }
  }
});

// ── Snapchat-style: black screen when page becomes hidden ─────────────────────
// On mobile this fires when the user takes a screenshot (the screen dims/switches briefly),
// opens the app switcher, or presses the home button.
// On desktop it fires when the tab is switched or window minimised.
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    showShield(''); // immediately go black
  } else {
    // Brief pause before restoring content so any screenshot captures the black screen
    setTimeout(hideShield, 300);
  }
});

// ── Blur-based protection: blank when the window loses focus ──────────────────
// Fires when the user switches to another app (e.g., screenshot tool, Snipping Tool).
// Debounced at 150 ms to avoid blanking on quick address-bar clicks.
let blurBlankTimeout = null;

window.addEventListener('blur', () => {
  blurBlankTimeout = setTimeout(() => {
    showShield('');
  }, 150);
});

window.addEventListener('focus', () => {
  if (blurBlankTimeout) { clearTimeout(blurBlankTimeout); blurBlankTimeout = null; }
  hideShield();
});

window.addEventListener('beforeprint', () => {
  document.body.innerHTML = '<div style="padding:40px;font-size:1.2rem;font-family:sans-serif;">Printing is disabled for this document.</div>';
});

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
  // download visibility is set after fileInfo loads (depends on allowDownload flag)
}

// ── zoom helpers ──────────────────────────────────────────────────────────────
function updateZoomLabel() {
  const pct = Math.round((zoomScale / 1.3) * 100);
  if ($('zoom-label')) $('zoom-label').textContent = pct + '%';
}

function adjustZoom(delta) {
  zoomScale = Math.min(4, Math.max(0.4, zoomScale + delta));
  fitMode = null;
  $('fit-btn')?.classList.remove('active');
  updateZoomLabel();
  renderAllPages();
}

// ── mouse wheel zoom (Ctrl + scroll) ──────────────────────────────────────────
document.addEventListener('wheel', e => {
  if (!pdfDoc) return;
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    adjustZoom(e.deltaY < 0 ? 0.15 : -0.15);
  }
}, { passive: false });

// ── fullscreen ─────────────────────────────────────────────────────────────────
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  } else {
    document.exitFullscreen().catch(() => {});
  }
}

document.addEventListener('fullscreenchange', () => {
  const isFs = !!document.fullscreenElement;
  const btn = $('fullscreen-btn');
  if (btn) {
    btn.classList.toggle('active', isFs);
    btn.querySelector('.fs-expand')?.classList.toggle('hidden', isFs);
    btn.querySelector('.fs-shrink')?.classList.toggle('hidden', !isFs);
  }
});

// ── fit to width ───────────────────────────────────────────────────────────────
let fitMode = null;

function toggleFitToWidth() {
  if (fitMode === 'width') {
    fitMode = null;
    $('fit-btn')?.classList.remove('active');
    zoomScale = 1.3;
    updateZoomLabel();
    renderAllPages();
    showKbToast('Fit off');
  } else {
    fitMode = 'width';
    $('fit-btn')?.classList.add('active');
    applyFitToWidth();
    renderAllPages();
    showKbToast('Fit to width');
  }
}

async function applyFitToWidth() {
  if (!pdfDoc) return;
  try {
    const page = await pdfDoc.getPage(1);
    const vp = page.getViewport({ scale: 1 });
    const container = $('viewer-shell');
    const availWidth = container.clientWidth - 48; // 24px each side padding
    zoomScale = Math.max(0.4, availWidth / vp.width);
    updateZoomLabel();
  } catch (_) {}
}

// ── PDF text search ────────────────────────────────────────────────────────────
let searchMatches = [];
let searchCurrentIdx = -1;
let searchActive = false;

function openSearch() {
  if (!pdfDoc) return;
  const bar = $('search-bar');
  if (bar) bar.classList.remove('hidden');
  const inp = $('search-input');
  if (inp) { inp.focus(); inp.select(); }
  searchActive = true;
}

function closeSearch() {
  const bar = $('search-bar');
  if (bar) bar.classList.add('hidden');
  clearSearchHighlights();
  searchMatches = [];
  searchCurrentIdx = -1;
  searchActive = false;
  if ($('search-count')) $('search-count').textContent = '';
}

function clearSearchHighlights() {
  document.querySelectorAll('.search-highlight').forEach(el => el.remove());
}

async function runSearch(query) {
  clearSearchHighlights();
  searchMatches = [];
  searchCurrentIdx = -1;
  if ($('search-count')) $('search-count').textContent = '';
  if (!query || !pdfDoc) return;

  for (let n = 1; n <= pdfDoc.numPages; n++) {
    const page = await pdfDoc.getPage(n);
    const textContent = await page.getTextContent();
    const vp = page.getViewport({ scale: zoomScale, rotation: currentRotation });
    const wrapper = $('page-wrapper-' + n);
    if (!wrapper) continue;

    const fullText = textContent.items.map(i => i.str).join('');
    const queryLower = query.toLowerCase();
    let searchStr = fullText.toLowerCase();
    let offset = 0;
    let charCount = 0;

    // Build char-to-item mapping for position lookup
    const charMap = []; // [{item, charOffset}]
    for (const item of textContent.items) {
      for (let ci = 0; ci < item.str.length; ci++) {
        charMap.push({ item, charOffset: ci });
      }
    }

    while ((offset = searchStr.indexOf(queryLower, charCount)) !== -1) {
      const matchChar = charMap[offset];
      if (matchChar) {
        const item = matchChar.item;
        const tx = pdfjsLib.Util.transform(vp.transform, item.transform);
        const x = tx[4];
        const y = tx[5];
        const charWidth = item.width ? (item.width * zoomScale / Math.max(1, item.str.length)) : 8;
        const charHeight = Math.abs(item.transform[3]) * zoomScale || 14;

        const highlight = document.createElement('div');
        highlight.className = 'search-highlight';
        highlight.style.left = (x) + 'px';
        highlight.style.top = (y - charHeight) + 'px';
        highlight.style.width = (charWidth * query.length) + 'px';
        highlight.style.height = charHeight + 'px';
        wrapper.appendChild(highlight);
        searchMatches.push({ el: highlight, pageNum: n });
      }
      charCount = offset + 1;
      if (charCount >= searchStr.length) break;
    }
  }

  if ($('search-count')) {
    $('search-count').textContent = searchMatches.length > 0
      ? `1 / ${searchMatches.length}`
      : 'No results';
  }

  if (searchMatches.length > 0) {
    searchCurrentIdx = 0;
    highlightSearchCurrent();
  }
}

function highlightSearchCurrent() {
  searchMatches.forEach((m, i) => m.el.classList.toggle('current', i === searchCurrentIdx));
  const cur = searchMatches[searchCurrentIdx];
  if (cur) {
    cur.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if ($('search-count')) {
      $('search-count').textContent = `${searchCurrentIdx + 1} / ${searchMatches.length}`;
    }
  }
}

function searchNext() {
  if (!searchMatches.length) return;
  searchCurrentIdx = (searchCurrentIdx + 1) % searchMatches.length;
  highlightSearchCurrent();
}

function searchPrev() {
  if (!searchMatches.length) return;
  searchCurrentIdx = (searchCurrentIdx - 1 + searchMatches.length) % searchMatches.length;
  highlightSearchCurrent();
}

// ── redo stack ─────────────────────────────────────────────────────────────────
let redoStack = [];

function doUndo() {
  if (allStrokes.length === 0) return;
  const stroke = allStrokes.pop();
  redoStack.push(stroke);
  redrawAllStrokes();
  if (allStrokes.length === 0) {
    annotationsDirty = false;
  } else {
    markAnnotationsDirty();
  }
  showKbToast('Undo');
}

function doRedo() {
  if (redoStack.length === 0) return;
  const stroke = redoStack.pop();
  allStrokes.push(stroke);
  redrawAllStrokes();
  markAnnotationsDirty();
  showKbToast('Redo');
}

// ── theme management ────────────────────────────────────────────────────────
function initTheme() {
  // Default to dark to match the main ShareSecure site
  const saved = localStorage.getItem('viewer_theme') || 'dark';
  setTheme(saved);
}

function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('viewer_theme', theme);
  const isDark = theme === 'dark';
  $('theme-btn').querySelector('.theme-sun').classList.toggle('hidden', isDark);
  $('theme-btn').querySelector('.theme-moon').classList.toggle('hidden', !isDark);
  $('theme-meta').content = isDark ? '#0d0d12' : '#ffffff';
}

$('theme-btn').addEventListener('click', () => {
  const current = document.documentElement.getAttribute('data-theme');
  setTheme(current === 'dark' ? 'light' : 'dark');
});

initTheme();

// ── delete confirmation modal ───────────────────────────────────────────────────
function showDeleteConfirm() {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'delete-modal-backdrop';
    backdrop.innerHTML = `
      <div class="delete-modal-card">
        <div class="delete-modal-icon">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </div>
        <p class="delete-modal-title">Delete this file?</p>
        <p class="delete-modal-sub">This permanently removes the file and all share links. This action cannot be undone.</p>
        <div class="delete-modal-actions">
          <button class="delete-modal-cancel" id="del-cancel">Cancel</button>
          <button class="delete-modal-confirm" id="del-confirm">Delete</button>
        </div>
      </div>
    `;
    document.body.appendChild(backdrop);

    const cleanup = (result) => {
      backdrop.style.animation = 'backdropIn 0.15s ease reverse';
      setTimeout(() => { if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop); }, 150);
      resolve(result);
    };

    backdrop.querySelector('#del-confirm').addEventListener('click', () => cleanup(true));
    backdrop.querySelector('#del-cancel').addEventListener('click', () => cleanup(false));
    backdrop.addEventListener('click', (e) => { if (e.target === backdrop) cleanup(false); });
  });
}

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
let currentTool = 'pointer';
let currentColor = '#e74c3c';
let currentPenSize = 2.5;
const annotCanvases = [];
// track all drawing strokes for persistence
let allStrokes = []; // Array of { pageIndex, tool, color, points: [{x,y}] }
let isDrawing = false;
let currentStroke = null;

function updateAnnotCursors() {
  annotCanvases.forEach(c => {
    c.classList.toggle('text-mode', currentTool === 'text');
    if (currentTool === 'pointer') c.style.cursor = 'default';
    else if (currentTool === 'text') c.style.cursor = '';
    else c.style.cursor = 'crosshair';
  });
}

function startTextInput(e, canvas, pageIndex) {
  const rect = canvas.getBoundingClientRect();
  const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
  const src = e.touches ? e.touches[0] : e;
  const screenX = src.clientX - rect.left;
  const screenY = src.clientY - rect.top;
  const canvasX = screenX * sx;
  const canvasY = screenY * sy;
  const fontSize = Math.max(12, currentPenSize * 7);

  const wrapper = canvas.parentElement;

  const ta = document.createElement('textarea');
  ta.className = 'text-annot-input';
  ta.style.left = screenX + 'px';
  ta.style.top = (screenY - fontSize) + 'px';
  ta.style.color = currentColor;
  ta.style.fontSize = fontSize + 'px';
  ta.style.borderColor = currentColor;
  wrapper.appendChild(ta);
  ta.focus();

  let committed = false;
  function commit() {
    if (committed) return;
    committed = true;
    const text = ta.value.trim();
    if (wrapper.contains(ta)) wrapper.removeChild(ta);
    if (text) {
      allStrokes.push({ pageIndex, tool: 'text', text, x: canvasX, y: canvasY, color: currentColor, size: currentPenSize });
      redoStack = [];
      redrawAllStrokes();
      markAnnotationsDirty();
    }
  }

  ta.addEventListener('keydown', ev => {
    if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); commit(); }
    if (ev.key === 'Escape') { committed = true; if (wrapper.contains(ta)) wrapper.removeChild(ta); }
  });
  ta.addEventListener('blur', commit);
}

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
    if (currentTool === 'pointer') return;
    if (currentTool === 'text') { startTextInput(e, canvas, pageIndex); return; }
    isDrawing = true;
    const [x, y] = getPos(e);
    currentStroke = {
      pageIndex,
      tool: currentTool,
      color: currentColor,
      size: currentPenSize,
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
      ctx.lineWidth = currentStroke.size || 2.5;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    } else if (currentStroke.tool === 'highlight') {
      ctx.globalAlpha = 0.35;
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = currentStroke.color;
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
      redoStack = []; // new stroke clears redo history
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
    if (stroke.tool === 'text') {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = stroke.color;
      const fontSize = Math.max(12, (stroke.size || 2.5) * 7);
      ctx.font = `bold ${fontSize}px sans-serif`;
      const lines = stroke.text.split('\n');
      lines.forEach((line, i) => ctx.fillText(line, stroke.x, stroke.y + i * fontSize * 1.3));
    } else if (stroke.tool === 'pen') {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = stroke.size || 2.5;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath();
      stroke.points.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y));
      ctx.stroke();
    } else if (stroke.tool === 'highlight') {
      ctx.globalAlpha = 0.35;
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = stroke.color;
      ctx.lineWidth = 22;
      ctx.lineCap = 'square';
      ctx.beginPath();
      stroke.points.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y));
      ctx.stroke();
    } else if (stroke.tool === 'eraser') {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth = 24;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
      ctx.beginPath();
      stroke.points.forEach((pt, i) => i === 0 ? ctx.moveTo(pt.x, pt.y) : ctx.lineTo(pt.x, pt.y));
      ctx.stroke();
    }
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

  // Apply fit-to-width before rendering
  if (fitMode === 'width') await applyFitToWidth();

  const container = $('pdf-container');
  container.innerHTML = '';
  annotCanvases.length = 0;

  // Show page progress
  const loader = $('loader');
  let progressEl = loader?.querySelector('.loader-progress');
  if (!progressEl && loader) {
    progressEl = document.createElement('span');
    progressEl.className = 'loader-progress';
    loader.appendChild(progressEl);
  }

  for (let n = 1; n <= pdfDoc.numPages; n++) {
    if (progressEl) progressEl.textContent = `Page ${n} of ${pdfDoc.numPages}`;
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
  if (fileInfo?.allowAnnotations !== 0) show('draw-toolbar');
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
  showKbToast(`Rotated ${currentRotation}°`);
  await renderAllPages();
});

$('zoom-in-btn')?.addEventListener('click', () => adjustZoom(+0.25));
$('zoom-out-btn')?.addEventListener('click', () => adjustZoom(-0.25));
$('fit-btn')?.addEventListener('click', toggleFitToWidth);
$('fullscreen-btn')?.addEventListener('click', toggleFullscreen);

// Search bar events
$('search-btn')?.addEventListener('click', openSearch);
$('search-close')?.addEventListener('click', closeSearch);
$('search-next')?.addEventListener('click', searchNext);
$('search-prev')?.addEventListener('click', searchPrev);

let searchDebounce = null;
$('search-input')?.addEventListener('input', e => {
  clearTimeout(searchDebounce);
  searchDebounce = setTimeout(() => runSearch(e.target.value.trim()), 350);
});

$('search-input')?.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (e.shiftKey) searchPrev(); else searchNext();
  }
  if (e.key === 'Escape') { e.preventDefault(); closeSearch(); }
});

// drawing toolbar
document.querySelectorAll('.draw-btn[data-tool]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.draw-btn[data-tool]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentTool = btn.dataset.tool;
    updateAnnotCursors();
  });
});

$('color-picker')?.addEventListener('input', e => { currentColor = e.target.value; });

// pen size buttons
document.querySelectorAll('.pen-size-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.pen-size-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentPenSize = parseFloat(btn.dataset.size);
  });
});

// undo / redo
$('undo-btn')?.addEventListener('click', doUndo);
$('redo-btn')?.addEventListener('click', doRedo);

// invert PDF colors toggle
let pdfInverted = false;
$('invert-pdf-btn')?.addEventListener('click', () => {
  pdfInverted = !pdfInverted;
  $('pdf-container').classList.toggle('pdf-inverted', pdfInverted);
  $('invert-pdf-btn').classList.toggle('active', pdfInverted);
});

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

// ── docx ──────────────────────────────────────────────────────────────────────
async function loadDocx(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error('Failed to fetch DOCX');
    const arrayBuffer = await res.arrayBuffer();
    if (!window.mammoth) throw new Error('mammoth.js not loaded');
    const result = await window.mammoth.convertToHtml({ arrayBuffer });
    const docContent = $('docx-content');
    docContent.innerHTML = result.value;
    hide('loader');
    show('docx-container');
    hide('zoom-in-btn'); hide('zoom-out-btn'); hide('zoom-label');
  } catch (err) {
    console.error('DOCX Load Error:', err);
    showUnsupported();
  }
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
      const ownerUrl = data.shortUrl;
      $('share-link-text').textContent = ownerUrl;

      if (ownerUrl.includes('localhost') || ownerUrl.includes('127.0.0.1')) {
        let warningText = document.getElementById('viewer-localhost-warn');
        if (!warningText) {
          warningText = document.createElement('div');
          warningText.id = 'viewer-localhost-warn';
          warningText.style.color = '#f59e0b';
          warningText.style.fontSize = '0.75rem';
          warningText.style.marginTop = '0.5rem';
          warningText.textContent = 'Warning: This link is pointing to your localhost and can only be accessed on this specific computer. Use your local network IP to share across devices on the same network.';
          $('share-link-text').parentNode.appendChild(warningText);
        }
      }

      makeQR($('share-qr-div'), ownerUrl);
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
  // Check terms
  if (localStorage.getItem('tc_accepted') !== 'true') {
    const tcModal = $('tc-modal');
    if (tcModal) {
      tcModal.classList.remove('hidden');
      await new Promise(resolve => {
        $('accept-tc-btn')?.addEventListener('click', () => {
          localStorage.setItem('tc_accepted', 'true');
          tcModal.classList.add('hidden');
          resolve();
        });
      });
    }
  }

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

  const { filename, size, mimeType, expiresAt, integrityHash, allowAnnotations, allowDownload } = fileInfo;
  document.title = filename + ' — ShareSecure';

  // show download button only for owner AND if uploader allowed it
  if (isOwner && allowDownload) show('download-btn'); else hide('download-btn');
  $('doc-title').textContent = filename;
  $('doc-meta').textContent = formatSize(size);
  startCountdown(expiresAt);

  // show integrity hash badge (only meaningful on the original uploader's link)
  if (integrityHash && isOwner) {
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

  $('download-btn')?.addEventListener('click', async () => {
    const btn = $('download-btn');
    btn.disabled = true;
    btn.querySelector('span') && (btn.querySelector('span').textContent = 'Downloading...');
    try {
      const res = await fetch(`/api/download/${myShortId}`);
      if (!res.ok) throw new Error('Download failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileInfo?.filename || 'file';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch {
      alert('Download failed. Try again.');
    } finally {
      btn.disabled = false;
      btn.querySelector('span') && (btn.querySelector('span').textContent = 'Download');
    }
  });

  // use the refined delete handler
  $('delete-file-btn').addEventListener('click', async () => {
    const confirmed = await showDeleteConfirm();
    if (!confirmed) return;

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
  else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') { await loadDocx(rawUrl); }
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
