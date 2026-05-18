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

  // Block select-all and copy
  if ((e.ctrlKey || e.metaKey) && ['a', 'c'].includes(key)) {
    e.preventDefault();
    return;
  }

  // PrintScreen / F13
  if (e.key === 'PrintScreen' || e.key === 'F13') {
    e.preventDefault();
    flashScreenshotShield();
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText('');
    return;
  }

  // macOS screenshot shortcuts
  if (e.metaKey && e.shiftKey && ['3', '4', '5', '6'].includes(e.key)) {
    e.preventDefault();
    flashScreenshotShield();
    if (navigator.clipboard?.writeText) navigator.clipboard.writeText('');
    return;
  }

  // Windows Snipping Tool
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

  if (inInput) return;

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
  }
});

// ── Snapchat-style: black screen when page becomes hidden ─────────────────────
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    showShield('');
  } else {
    setTimeout(hideShield, 300);
  }
});

// ── Blur-based protection ──────────────────────────────────────────────────────
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

let myShortId = rawShortId;

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
    const availWidth = container.clientWidth - 48;
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
  if (!query || !pdfDoc) {
    if ($('search-count')) $('search-count').textContent = '';
    return;
  }
  if ($('search-count')) $('search-count').textContent = '…';

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

    const charMap = [];
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

// ── theme management ────────────────────────────────────────────────────────
function initTheme() {
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
      if (data.deleteToken) {
        localStorage.setItem('owner_' + myShortId, data.deleteToken);
      }
      updateOwnershipDisplay();
    }
  } catch (_) {}
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

// ── status polling ─────────────────────────────────────────────────────────────
function startStatusPolling() {
  setInterval(async () => {
    try {
      const res = await fetch(`/api/info/${myShortId}`);
      if (res.status === 404 || res.status === 410) {
        document.body.innerHTML = '';
        location.replace('/expired.html');
      }
    } catch (err) {}
  }, 5000);
}

// ── pdf viewer logic ───────────────────────────────────────────────────────
let pdfDoc = null;
let zoomScale = 1.3;
let currentRotation = 0;
let isRendering = false;

async function loadPDF(url) {
  try {
    // Fit to width by default on mobile
    if (window.innerWidth <= 800) {
      fitMode = 'width';
    }

    pdfDoc = await pdfjsLib.getDocument(url).promise;
    $('page-count').textContent = pdfDoc.numPages;
    if ($('m-total-pages')) $('m-total-pages').textContent = pdfDoc.numPages;
    show('page-nav');

    await renderAllPages();
    setupPageTracking();
    setupMobileToolbar();
    setupPinchToZoom();
    setupScrollAutoHide();
  } catch (err) {
    showUnsupported();
  }
}

async function renderAllPages() {
  if (isRendering) return;
  isRendering = true;
  hide('pdf-container');
  show('loader');

  if (fitMode === 'width') await applyFitToWidth();

  const container = $('pdf-container');
  container.innerHTML = '';

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

    wrapper.appendChild(pdfCanvas);
    container.appendChild(wrapper);

    await page.render({ canvasContext: pdfCanvas.getContext('2d'), viewport: vp }).promise;
  }

  hide('loader');
  show('pdf-container');
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
    if ($('page-num')) $('page-num').value = current;
    if ($('m-current-page')) $('m-current-page').textContent = current;
  }, { passive: true });
}

function setupMobileToolbar() {
  const toolbar = $('mobile-toolbar');
  if (!toolbar) return;
  toolbar.classList.add('pdf-mode');
  toolbar.classList.remove('hidden');

  $('m-prev-page')?.addEventListener('click', () => {
    const cur = parseInt($('m-current-page')?.textContent || '1');
    const target = Math.max(1, cur - 1);
    $('page-wrapper-' + target)?.scrollIntoView({ behavior: 'smooth' });
  });

  $('m-next-page')?.addEventListener('click', () => {
    const cur = parseInt($('m-current-page')?.textContent || '1');
    const target = Math.min(pdfDoc?.numPages || 1, cur + 1);
    $('page-wrapper-' + target)?.scrollIntoView({ behavior: 'smooth' });
  });

  $('m-zoom-in')?.addEventListener('click', () => adjustZoom(+0.2));
  $('m-zoom-out')?.addEventListener('click', () => adjustZoom(-0.2));
  $('m-search-btn')?.addEventListener('click', openSearch);
  $('m-share-btn')?.addEventListener('click', openSharePanel);
}

function setupPinchToZoom() {
  let lastDist = null;
  let pinchStartScale = null;

  const container = $('viewer-shell');
  if (!container) return;

  container.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      lastDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      pinchStartScale = zoomScale;
    }
  }, { passive: true });

  container.addEventListener('touchmove', e => {
    if (e.touches.length !== 2 || lastDist === null) return;
    const dist = Math.hypot(
      e.touches[0].clientX - e.touches[1].clientX,
      e.touches[0].clientY - e.touches[1].clientY
    );
    const ratio = dist / lastDist;
    const newScale = Math.min(4, Math.max(0.4, pinchStartScale * ratio));
    if (Math.abs(newScale - zoomScale) > 0.03) {
      zoomScale = newScale;
      fitMode = null;
      $('fit-btn')?.classList.remove('active');
      updateZoomLabel();
    }
  }, { passive: true });

  container.addEventListener('touchend', () => {
    if (lastDist !== null) {
      lastDist = null;
      renderAllPages();
    }
  }, { passive: true });
}

function setupScrollAutoHide() {
  const shell = $('viewer-shell');
  const topbar = document.querySelector('.topbar');
  if (!shell || !topbar || window.innerWidth > 800) return;

  let lastScrollY = shell.scrollTop;
  shell.addEventListener('scroll', () => {
    const scrollY = shell.scrollTop;
    if (scrollY > lastScrollY + 5 && scrollY > 60) {
      topbar.classList.add('scrolled-down');
    } else if (scrollY < lastScrollY - 5 || scrollY < 10) {
      topbar.classList.remove('scrolled-down');
    }
    lastScrollY = scrollY;
  }, { passive: true });
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


// ── send to user ──────────────────────────────────────────────────────────────
function showSendDialog() {
  const backdrop = document.createElement('div');
  backdrop.className = 'delete-modal-backdrop';
  backdrop.innerHTML = `
    <div class="delete-modal-card">
      <div class="delete-modal-icon" style="background:rgba(16,185,129,0.12);border-color:rgba(16,185,129,0.25);color:#10b981">
        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/>
        </svg>
      </div>
      <p class="delete-modal-title">Send to user</p>
      <p class="delete-modal-sub" id="send-dialog-sub">They won't know who sent it. Enter their exact username.</p>
      <input id="send-username-input" type="text" placeholder="Username" autocomplete="off" spellcheck="false"
        style="width:100%;padding:10px 12px;border:1px solid rgba(255,255,255,0.1);border-radius:10px;background:rgba(0,0,0,0.4);color:var(--text,#f0f0ff);font-size:0.9rem;font-family:inherit;outline:none;margin:4px 0;" />
      <div class="delete-modal-actions">
        <button class="delete-modal-cancel" id="send-cancel-btn">Cancel</button>
        <button class="delete-modal-confirm" id="send-confirm-btn" style="background:rgba(16,185,129,0.85);border-color:rgba(16,185,129,0.5)">Send</button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);

  const input = backdrop.querySelector('#send-username-input');
  const sub = backdrop.querySelector('#send-dialog-sub');
  const confirmBtn = backdrop.querySelector('#send-confirm-btn');
  input.focus();

  const close = () => {
    backdrop.style.animation = 'backdropIn 0.15s ease reverse';
    setTimeout(() => { if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop); }, 150);
  };

  const doSend = async () => {
    const username = input.value.trim();
    if (!username) return;
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Sending…';
    sub.style.color = '';

    const token = localStorage.getItem('user_token');
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    try {
      const res = await fetch(`/api/send/${myShortId}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ targetUsername: username })
      });
      const data = await res.json();
      if (data.sent) {
        close();
        showKbToast('Sent!');
      } else {
        sub.textContent = data.error || 'Failed to send.';
        sub.style.color = 'var(--danger,#ef4444)';
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Send';
      }
    } catch {
      sub.textContent = 'Network error. Try again.';
      sub.style.color = 'var(--danger,#ef4444)';
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Send';
    }
  };

  confirmBtn.addEventListener('click', doSend);
  backdrop.querySelector('#send-cancel-btn').addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); doSend(); }
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    e.stopPropagation();
  });
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

  if (!isOwner) {
    await assignFreshId();
  }

  updateOwnershipDisplay();
  startStatusPolling();

  fileInfo = await loadMeta();
  if (!fileInfo) return;

  const { filename, size, mimeType, expiresAt, integrityHash, allowDownload } = fileInfo;
  document.title = filename + ' — ShareSecure';

  if (isOwner && allowDownload) show('download-btn'); else hide('download-btn');
  $('doc-title').textContent = filename;
  $('doc-meta').textContent = formatSize(size);
  startCountdown(expiresAt);

  if (integrityHash && isOwner) {
    const badge = $('integrity-badge');
    if (badge) {
      badge.textContent = '🔒 SHA-256: ' + integrityHash.substring(0, 12) + '…';
      badge.title = 'Full hash: ' + integrityHash;
      badge.classList.remove('hidden');
    }
  }

  $('send-to-user-btn').addEventListener('click', showSendDialog);
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

  const rawUrl = `/api/raw/${myShortId}`;

  if (mimeType === 'application/pdf') {
    await loadPDF(rawUrl);
  } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') { await loadDocx(rawUrl); }
  else if (mimeType.startsWith('image/')) { loadImage(rawUrl); }
  else if (mimeType.startsWith('video/')) { loadVideo(rawUrl); }
  else if (mimeType.startsWith('audio/')) { loadAudio(rawUrl, filename); }
  else if (mimeType.startsWith('text/') || mimeType === 'application/json') { await loadText(rawUrl); }
  else { showUnsupported(); }
})();
