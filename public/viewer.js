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

  // Annotation shortcuts (when annotations are enabled)
  if (annEnabled && !e.ctrlKey && !e.metaKey && !e.altKey) {
    const keyMap = { c: 'cursor', p: 'pen', h: 'highlight', e: 'eraser' };
    const colorKeys = { '1': 0, '2': 1, '3': 2, '4': 3, '5': 4 };
    const colors = [...document.querySelectorAll('.ann-color')].map(b => b.dataset.color);
    if (keyMap[key]) { setAnnTool(keyMap[key]); showKbToast(keyMap[key][0].toUpperCase() + keyMap[key].slice(1)); return; }
    if (key in colorKeys) {
      const idx = colorKeys[key];
      annColor = colors[idx];
      const btns = document.querySelectorAll('.ann-color');
      btns.forEach((b, i) => b.classList.toggle('active', i === idx));
      if (annTool === 'cursor' || annTool === 'eraser') setAnnTool('pen');
      showKbToast('Color ' + (idx + 1));
      return;
    }
    if (key === 'z') { annUndoOne(); showKbToast('Undo'); return; }
    if (key === 'x') { clearPageAnnotations(); showKbToast('Cleared'); return; }
  }

  // Escape: close share panel or exit fullscreen
  if (e.key === 'Escape') {
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

// Links can be limited to people signed in to ShareSecure. Requests go out
// without your sign-in unless the link asks for it, so the server only learns
// who's looking when it has to.
const sessionToken = (() => { try { return sessionStorage.getItem('user_token'); } catch { return null; } })();
let sendSignIn = false;

function withSignIn(init = {}) {
  const headers = new Headers(init.headers || {});
  if (sessionToken && !headers.has('Authorization')) headers.set('Authorization', `Bearer ${sessionToken}`);
  return { ...init, headers };
}

async function apiFetch(url, init = {}) {
  let res = await fetch(url, sendSignIn ? withSignIn(init) : init);
  if (res.status === 401 && !sendSignIn && sessionToken) {
    const body = await res.clone().json().catch(() => ({}));
    if (body.code === 'sign_in_required') {
      sendSignIn = true;
      res = await fetch(url, withSignIn(init));
    }
  }
  return res;
}

// The file itself. One retry covers a brief hiccup on the server, which used to
// show "couldn't be displayed" until the page was reloaded.
async function fetchFileBytes(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await apiFetch(url);
      if (res.ok) return res.arrayBuffer();
      if (attempt >= 1 || res.status < 500) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      if (attempt >= 1) throw err;
    }
    await new Promise(r => setTimeout(r, 800));
  }
}

function showSignInNeeded() {
  hide('loader');
  hide('zoom-group');
  const next = encodeURIComponent(location.pathname);
  $('signin-needed-link').href = `/signin?next=${next}`;
  $('signup-needed-link').href = `/signin?new=1&next=${next}`;
  $('doc-title').textContent = 'Sign in to open this file';
  show('signin-needed');
}
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

// ── delete confirmation modal ───────────────────────────────────────────────────
function showDeleteConfirm() {
  return new Promise(resolve => {
    const backdrop = document.createElement('div');
    backdrop.className = 'delete-modal-backdrop';
    backdrop.innerHTML = `
      <div class="delete-modal-card">
        <p class="delete-modal-title">Delete this file?</p>
        <p class="delete-modal-sub">${fileInfo?.isRoot
          ? 'This is the original, so the file and every link to it are erased for everyone. This can’t be undone.'
          : 'This link stops working, along with any links shared from it. The original and everyone else’s links keep working.'}</p>
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
    const res = await apiFetch(`/api/reshare/${rawShortId}`, { method: 'POST' });
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

// ── leave no trace in this browser once the file is gone ──────────────────────
function forgetFile() {
  try {
    localStorage.removeItem('owner_' + myShortId);
    localStorage.removeItem('owner_' + rawShortId);
  } catch {}
}

function fileGone() {
  forgetFile();
  document.body.innerHTML = '';
  location.replace('/expired.html');
}

// ── countdown ─────────────────────────────────────────────────────────────────
function startCountdown(expiresAt) {
  if (!expiresAt) return;
  const expiry = new Date(expiresAt).getTime();
  const wrap = $('countdown-wrap');
  const text = $('countdown-text');

  function tick() {
    const rem = expiry - Date.now();
    if (rem <= 0) { fileGone(); return; }
    const s = Math.floor(rem / 1000);
    const days = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const left = days > 0 ? `${days}d ${h}h`
      : h > 0 ? `${h}h ${String(m).padStart(2, '0')}m`
      : m > 0 ? `${m}m ${String(sec).padStart(2, '0')}s`
      : `${sec}s`;
    text.textContent = 'Expires in ' + left;
    wrap.classList.toggle('critical', rem < 60000);
    wrap.classList.toggle('warn', rem >= 60000 && rem < 300000);
    setTimeout(tick, 1000);
  }
  tick();
}

// ── load metadata ─────────────────────────────────────────────────────────────
let fileInfo = null;
async function loadMeta() {
  const res = await apiFetch(`/api/info/${myShortId}`);
  if (res.status === 401) { showSignInNeeded(); return null; }
  if (!res.ok) { $('doc-title').textContent = 'File not found'; hide('loader'); return null; }
  return res.json();
}

// ── status polling ─────────────────────────────────────────────────────────────
function startStatusPolling() {
  setInterval(async () => {
    try {
      const res = await apiFetch(`/api/info/${myShortId}`);
      if (res.status === 404 || res.status === 410) fileGone();
    } catch (err) {}
  }, 5000);
}

// ── pdf viewer logic ───────────────────────────────────────────────────────
let pdfDoc = null;
let zoomScale = 1.3;
const currentRotation = 0;
let isRendering = false;

async function loadPDF(url) {
  try {
    // Fit to width by default on mobile
    if (window.innerWidth <= 800) {
      fitMode = 'width';
    }

    pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(await fetchFileBytes(url)) }).promise;
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
    if (annEnabled) attachAnnCanvas(wrapper, n);
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

$('zoom-in-btn')?.addEventListener('click', () => adjustZoom(+0.25));
$('zoom-out-btn')?.addEventListener('click', () => adjustZoom(-0.25));
$('fit-btn')?.addEventListener('click', toggleFitToWidth);

// ── image ─────────────────────────────────────────────────────────────────────
async function loadImage(url) {
  const img = $('img-viewer');
  try {
    img.src = URL.createObjectURL(new Blob([await fetchFileBytes(url)], { type: fileInfo?.mimeType || 'image/*' }));
  } catch {
    showUnsupported();
    return;
  }
  img.onload = () => {
    hide('loader');
    show('img-container');
    if (annEnabled) {
      const container = $('img-container');
      const wrapper = document.createElement('div');
      wrapper.id = 'page-wrapper-1';
      wrapper.style.cssText = 'position:relative;display:inline-block;line-height:0;max-width:100%';
      img.parentNode.insertBefore(wrapper, img);
      wrapper.appendChild(img);
      attachAnnCanvas(wrapper, 1);
    }
  };
  img.onerror = () => showUnsupported();
  hide('zoom-group');
}

// ── docx ──────────────────────────────────────────────────────────────────────
async function loadDocx(url) {
  try {
    const arrayBuffer = await fetchFileBytes(url);
    if (!window.mammoth) throw new Error('mammoth.js not loaded');
    const result = await window.mammoth.convertToHtml({ arrayBuffer });
    const docContent = $('docx-content');
    docContent.innerHTML = result.value;
    hide('loader');
    show('docx-container');
    hide('zoom-group');
  } catch (err) {
    console.error('DOCX Load Error:', err);
    showUnsupported();
  }
}

// ── unsupported ───────────────────────────────────────────────────────────────
function showUnsupported() {
  hide('loader');
  $('unsupported-title').textContent = fileInfo?.filename || 'Unknown file';
  show('unsupported');
  hide('zoom-group');
}


// ── send to user ──────────────────────────────────────────────────────────────
function showSendDialog() {
  const backdrop = document.createElement('div');
  backdrop.className = 'delete-modal-backdrop';
  backdrop.innerHTML = `
    <div class="delete-modal-card">
      <p class="delete-modal-title">Send to a user</p>
      <p class="delete-modal-sub" id="send-dialog-sub">They get a request and choose whether to accept it. They won’t see who sent it unless you say so in the note.</p>
      <input id="send-username-input" type="text" placeholder="Their username" autocomplete="off" spellcheck="false" aria-label="Username" />
      <input id="send-note-input" type="text" placeholder="Note (optional)" maxlength="140" autocomplete="off" aria-label="Note" />
      <div class="delete-modal-actions">
        <button class="delete-modal-cancel" id="send-cancel-btn">Cancel</button>
        <button class="delete-modal-confirm is-primary" id="send-confirm-btn">Send</button>
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

    const token = sessionStorage.getItem('user_token');
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;

    try {
      const res = await apiFetch(`/api/send/${myShortId}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ targetUsername: username, note: backdrop.querySelector('#send-note-input').value.trim() })
      });
      const data = await res.json();
      if (data.sent) {
        close();
        showKbToast('Sent. Waiting for them to accept.');
      } else {
        sub.textContent = data.error || 'Couldn’t send. Check the username and try again.';
        sub.style.color = 'var(--danger)';
        confirmBtn.disabled = false;
        confirmBtn.textContent = 'Send';
      }
    } catch {
      sub.textContent = 'Couldn’t reach the server. Try again.';
      sub.style.color = 'var(--danger)';
      confirmBtn.disabled = false;
      confirmBtn.textContent = 'Send';
    }
  };

  confirmBtn.addEventListener('click', doSend);
  backdrop.querySelector('#send-cancel-btn').addEventListener('click', close);
  backdrop.addEventListener('click', e => { if (e.target === backdrop) close(); });
  backdrop.querySelector('#send-note-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); doSend(); }
    e.stopPropagation();
  });
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

  apiFetch(`/api/reshare/${myShortId}`, { method: 'POST' })
    .then(r => r.json())
    .then(data => {
      const ownerUrl = data.shortUrl;
      $('share-link-text').textContent = ownerUrl;

      if (ownerUrl.includes('localhost') || ownerUrl.includes('127.0.0.1')) {
        let warningText = document.getElementById('viewer-localhost-warn');
        if (!warningText) {
          warningText = document.createElement('div');
          warningText.id = 'viewer-localhost-warn';
          warningText.style.color = 'var(--muted)';
          warningText.style.fontSize = '0.78rem';
          warningText.style.paddingTop = '4px';
          warningText.textContent = 'This link only works on this computer. Set BASE_URL or turn on the tunnel to share it with other devices.';
          $('share-link-text').parentNode.appendChild(warningText);
        }
      }

      makeQR($('share-qr-div'), ownerUrl);
      hide('share-generating'); show('share-ready');

      $('share-copy-btn').onclick = () => {
        navigator.clipboard.writeText(data.shortUrl).then(() => {
          $('share-copy-btn').textContent = 'Copied';
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
      $('share-panel-body').innerHTML = '<p class="share-note">Couldn’t create a link. Close this panel and try again.</p>';
    });
}

function closeSharePanel() { hide('share-overlay'); hide('share-panel'); }

// ── annotations ───────────────────────────────────────────────────────────────
let annEnabled = false;
let annTool = 'cursor';
let annColor = '#111111';
let annStrokes = {};
let annSaveTimer = null;

function isMobile() { return window.innerWidth <= 800; }

async function fetchAnnotations() {
  try {
    const res = await apiFetch(`/api/annotations/${myShortId}`);
    const data = await res.json();
    return data.annotations || [];
  } catch { return []; }
}

function setAnnStatus(msg, isError) {
  const el = $('ann-status');
  if (!el) return;
  el.textContent = msg;
  el.style.color = isError ? 'var(--danger)' : '';
}

function scheduleSave() {
  clearTimeout(annSaveTimer);
  annSaveTimer = setTimeout(saveAnnotations, 1500);
}

async function saveAnnotations() {
  const flat = [];
  Object.entries(annStrokes).forEach(([page, strokes]) => {
    strokes.forEach(s => flat.push({ page: parseInt(page), ...s }));
  });
  try {
    setAnnStatus('Saving…');
    await apiFetch(`/api/annotations/${myShortId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ annotations: flat }),
    });
    setAnnStatus('Saved');
    setTimeout(() => setAnnStatus(''), 2000);
  } catch {
    setAnnStatus('Save failed', true);
  }
}

function setAnnTool(tool) {
  annTool = tool;
  ['ann-cursor', 'ann-pen', 'ann-highlight', 'ann-eraser'].forEach(id => {
    $(`${id}`)?.classList.toggle('active', id === `ann-${tool}`);
  });
  document.querySelectorAll('.ann-canvas').forEach(c => {
    c.style.pointerEvents = tool === 'cursor' ? 'none' : 'auto';
    c.className = 'ann-canvas ' + (tool === 'cursor' ? 'cursor-mode' : tool === 'pen' ? 'drawing-mode' : tool === 'highlight' ? 'highlight-mode' : 'eraser-mode');
  });
}

function redrawPage(n) {
  const canvas = document.getElementById(`ann-canvas-${n}`);
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const strokes = annStrokes[n] || [];
  strokes.forEach(stroke => {
    if (!stroke.points || stroke.points.length < 2) return;
    ctx.beginPath();
    ctx.strokeStyle = stroke.color;
    ctx.lineWidth = stroke.width;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.globalAlpha = stroke.highlight ? 0.35 : 1;
    ctx.globalCompositeOperation = stroke.eraser ? 'destination-out' : 'source-over';
    ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
    for (let i = 1; i < stroke.points.length; i++) {
      ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  });
}

function getCanvasPos(canvas, e) {
  const rect = canvas.getBoundingClientRect();
  const scaleX = canvas.width / rect.width;
  const scaleY = canvas.height / rect.height;
  const src = e.touches ? e.touches[0] : e;
  return { x: (src.clientX - rect.left) * scaleX, y: (src.clientY - rect.top) * scaleY };
}

function attachAnnCanvas(wrapper, n) {
  const existing = document.getElementById(`ann-canvas-${n}`);
  if (existing) existing.remove();

  const canvas = document.createElement('canvas');
  canvas.id = `ann-canvas-${n}`;
  canvas.className = 'ann-canvas ' + (annTool === 'cursor' ? 'cursor-mode' : annTool === 'pen' ? 'drawing-mode' : annTool === 'highlight' ? 'highlight-mode' : 'eraser-mode');
  if (annTool === 'cursor') canvas.style.pointerEvents = 'none';

  const pdfCanvas = wrapper.querySelector('.pdf-page-canvas');
  const imgEl = wrapper.querySelector('img');
  if (pdfCanvas) {
    canvas.width = pdfCanvas.width;
    canvas.height = pdfCanvas.height;
  } else if (imgEl) {
    canvas.width = imgEl.naturalWidth || imgEl.offsetWidth;
    canvas.height = imgEl.naturalHeight || imgEl.offsetHeight;
  }
  wrapper.appendChild(canvas);
  redrawPage(n);

  let drawing = false;
  let currentStroke = null;

  const startDraw = e => {
    e.preventDefault();
    drawing = true;
    const pos = getCanvasPos(canvas, e);
    if (annTool === 'cursor') { drawing = false; return; }
    currentStroke = {
      color: annTool === 'eraser' ? 'rgba(0,0,0,1)' : annColor,
      width: annTool === 'eraser' ? 24 : annTool === 'highlight' ? 18 : 3,
      eraser: annTool === 'eraser',
      highlight: annTool === 'highlight',
      points: [pos],
    };
    if (!annStrokes[n]) annStrokes[n] = [];
    annStrokes[n].push(currentStroke);
    redrawPage(n);
  };

  const moveDraw = e => {
    if (!drawing || !currentStroke) return;
    e.preventDefault();
    currentStroke.points.push(getCanvasPos(canvas, e));
    redrawPage(n);
  };

  const endDraw = () => {
    if (drawing) { drawing = false; scheduleSave(); }
  };

  canvas.addEventListener('mousedown', startDraw);
  canvas.addEventListener('mousemove', moveDraw);
  canvas.addEventListener('mouseup', endDraw);
  canvas.addEventListener('mouseleave', endDraw);
  canvas.addEventListener('touchstart', startDraw, { passive: false });
  canvas.addEventListener('touchmove', moveDraw, { passive: false });
  canvas.addEventListener('touchend', endDraw, { passive: false });
}

function annUndoOne() {
  const n = parseInt($('page-num')?.value || '1');
  if (annStrokes[n]?.length > 0) {
    annStrokes[n].pop();
    redrawPage(n);
    scheduleSave();
  }
}

function clearPageAnnotations() {
  const n = parseInt($('page-num')?.value || '1');
  annStrokes[n] = [];
  redrawPage(n);
  scheduleSave();
}

function initAnnToolbar() {
  $('ann-cursor')?.addEventListener('click', () => setAnnTool('cursor'));
  $('ann-pen')?.addEventListener('click', () => setAnnTool('pen'));
  $('ann-highlight')?.addEventListener('click', () => setAnnTool('highlight'));
  $('ann-eraser')?.addEventListener('click', () => setAnnTool('eraser'));
  $('ann-undo')?.addEventListener('click', annUndoOne);
  $('ann-clear')?.addEventListener('click', clearPageAnnotations);

  document.querySelectorAll('.ann-color').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.ann-color').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      annColor = btn.dataset.color;
      if (annTool === 'cursor' || annTool === 'eraser') setAnnTool('pen');
    });
  });
}

function showAnnToolbar(allowAnnotations) {
  annEnabled = !!allowAnnotations;
  if (annEnabled) {
    show('ann-toolbar');
    initAnnToolbar();
    setAnnTool('cursor');
  } else {
    hide('ann-toolbar');
  }
}

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

  const { filename, size, mimeType, expiresAt, allowDownload, allowAnnotations } = fileInfo;
  document.title = filename + ' — ShareSecure';

  if (isOwner && allowDownload) show('download-btn'); else hide('download-btn');

  showAnnToolbar(allowAnnotations);
  if (allowAnnotations) {
    const saved = await fetchAnnotations();
    annStrokes = {};
    saved.forEach(a => {
      if (!annStrokes[a.page]) annStrokes[a.page] = [];
      annStrokes[a.page].push(a);
    });
  }
  $('doc-title').textContent = filename;
  $('doc-meta').textContent = formatSize(size);
  startCountdown(expiresAt);

  // sending to another user needs an account on the hosted version; self-hosted has one owner only
  if (sessionStorage.getItem('user_token')) {
    fetch('/api/mode').then(r => r.json()).then(m => { if (!m.selfHostMode) show('send-to-user-btn'); }).catch(() => {});
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
      const res = await apiFetch(`/api/download/${myShortId}`);
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
      showKbToast('Download failed. Try again.');
    } finally {
      btn.disabled = false;
      btn.querySelector('span') && (btn.querySelector('span').textContent = 'Download');
    }
  });

  const deleteIcon = $('delete-file-btn').innerHTML;
  $('delete-file-btn').addEventListener('click', async () => {
    const confirmed = await showDeleteConfirm();
    if (!confirmed) return;

    $('delete-file-btn').disabled = true;
    try {
      const res = await apiFetch(`/api/delete/${myShortId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteToken: myDeleteToken })
      });
      const data = await res.json();
      if (data.deleted) fileGone(); else {
        $('delete-file-btn').innerHTML = deleteIcon;
        showKbToast('Couldn’t delete. Try again.');
        $('delete-file-btn').disabled = false;
      }
    } catch {
      $('delete-file-btn').innerHTML = deleteIcon;
      showKbToast('Couldn’t delete. Try again.');
      $('delete-file-btn').disabled = false;
    }
  });

  const rawUrl = `/api/raw/${myShortId}`;

  if (mimeType === 'application/pdf') {
    await loadPDF(rawUrl);
  } else if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') { await loadDocx(rawUrl); }
  else if (mimeType.startsWith('image/')) { await loadImage(rawUrl); }
  else { showUnsupported(); }
})();
