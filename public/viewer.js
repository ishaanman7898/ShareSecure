import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';
pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';

// ── Block all download vectors ────────────────────────────────────────────────
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && ['s','p','u'].includes(e.key.toLowerCase())) e.preventDefault();
});
window.addEventListener('beforeprint', () => { document.body.innerHTML = '<p style="padding:40px;font-size:1.2rem">Printing is disabled.</p>'; });

// ── Extract delete token from hash BEFORE any URL rewrite ─────────────────────
// The hash is never sent to the server — safe, untrackable
const _hashParams = new URLSearchParams(location.hash.slice(1));
const myDeleteToken = _hashParams.get('del') || null;
if (myDeleteToken) history.replaceState(null, '', location.pathname + location.search);

// ── Helpers ───────────────────────────────────────────────────────────────────
const rawShortId = location.pathname.split('/r/')[1]?.split('?')[0];
const $ = id => document.getElementById(id);
function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }
function formatSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b/1024).toFixed(1) + ' KB';
  return (b/1048576).toFixed(1) + ' MB';
}

// ── Auto-assign a fresh personal ID on every view ────────────────────────────
// This updates the URL bar silently so each viewer has a unique link
let myShortId = rawShortId;

async function assignFreshId() {
  try {
    const res = await fetch(`/api/reshare/${rawShortId}`, { method: 'POST' });
    const data = await res.json();
    if (data.shortId) {
      myShortId = data.shortId;
      history.replaceState(null, '', `/r/${myShortId}`);
    }
  } catch (_) { /* fall back to original id */ }
}

// ── Countdown ─────────────────────────────────────────────────────────────────
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
      ? `${h}h ${String(m).padStart(2,'0')}m ${String(sec).padStart(2,'0')}s`
      : m > 0 ? `${m}m ${String(sec).padStart(2,'0')}s` : `${sec}s`;
    wrap.className = 'countdown-wrap' + (rem < 60000 ? ' critical' : rem < 300000 ? ' warn' : '');
    setTimeout(tick, 1000);
  }
  tick();
}

// ── Load metadata ─────────────────────────────────────────────────────────────
let fileInfo = null;
async function loadMeta() {
  const res = await fetch(`/api/info/${rawShortId}`);
  if (!res.ok) { $('doc-title').textContent = 'File not found'; hide('loader'); return null; }
  return res.json();
}

// ── Drawing tools ─────────────────────────────────────────────────────────────
let currentTool = 'pen';
let currentColor = '#e74c3c';
const annotCanvases = [];

function setupDrawing(canvas) {
  let drawing = false, lx = 0, ly = 0;
  const ctx = canvas.getContext('2d');

  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    const sx = canvas.width / rect.width, sy = canvas.height / rect.height;
    const src = e.touches ? e.touches[0] : e;
    return [(src.clientX - rect.left) * sx, (src.clientY - rect.top) * sy];
  }

  function startDraw(e) {
    e.preventDefault();
    drawing = true;
    [lx, ly] = getPos(e);
  }

  function moveDraw(e) {
    e.preventDefault();
    if (!drawing) return;
    const [x, y] = getPos(e);
    ctx.save();
    if (currentTool === 'pen') {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = currentColor;
      ctx.lineWidth = 2.5;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
    } else if (currentTool === 'highlight') {
      ctx.globalAlpha = 0.35;
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = '#FFD600';
      ctx.lineWidth = 22;
      ctx.lineCap = 'square';
    } else if (currentTool === 'eraser') {
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = 'destination-out';
      ctx.lineWidth = 24;
      ctx.lineCap = 'round';
      ctx.strokeStyle = 'rgba(0,0,0,1)';
    }
    ctx.beginPath();
    ctx.moveTo(lx, ly); ctx.lineTo(x, y);
    ctx.stroke();
    ctx.restore();
    lx = x; ly = y;
  }

  function endDraw() { drawing = false; }

  canvas.addEventListener('mousedown', startDraw);
  canvas.addEventListener('mousemove', moveDraw);
  canvas.addEventListener('mouseup', endDraw);
  canvas.addEventListener('mouseleave', endDraw);
  canvas.addEventListener('touchstart', startDraw, { passive: false });
  canvas.addEventListener('touchmove', moveDraw, { passive: false });
  canvas.addEventListener('touchend', endDraw);
}

// ── PDF Viewer (scroll mode, all pages) ───────────────────────────────────────
let pdfDoc = null;
let zoomScale = 1.4;

async function loadPDF(url) {
  pdfDoc = await pdfjsLib.getDocument(url).promise;
  const container = $('pdf-container');
  container.innerHTML = '';
  annotCanvases.length = 0;

  for (let n = 1; n <= pdfDoc.numPages; n++) {
    const page = await pdfDoc.getPage(n);
    const vp = page.getViewport({ scale: zoomScale });

    const wrapper = document.createElement('div');
    wrapper.className = 'pdf-page-wrapper';
    wrapper.style.width = vp.width + 'px';
    wrapper.style.height = vp.height + 'px';

    const pdfCanvas = document.createElement('canvas');
    pdfCanvas.width = vp.width; pdfCanvas.height = vp.height;
    pdfCanvas.className = 'pdf-page-canvas';

    const annotCanvas = document.createElement('canvas');
    annotCanvas.width = vp.width; annotCanvas.height = vp.height;
    annotCanvas.className = 'pdf-annot-canvas';
    annotCanvases.push(annotCanvas);

    wrapper.appendChild(pdfCanvas);
    wrapper.appendChild(annotCanvas);
    container.appendChild(wrapper);

    await page.render({ canvasContext: pdfCanvas.getContext('2d'), viewport: vp }).promise;
    setupDrawing(annotCanvas);
  }

  hide('loader');
  show('pdf-container');
  show('draw-toolbar');

  // Zoom re-renders all pages
  async function reRender() {
    const pages = container.querySelectorAll('.pdf-page-wrapper');
    for (let n = 1; n <= pdfDoc.numPages; n++) {
      const page = await pdfDoc.getPage(n);
      const vp = page.getViewport({ scale: zoomScale });
      const wrapper = pages[n - 1];
      const pdfCanvas = wrapper.querySelector('.pdf-page-canvas');
      const annotCanvas = wrapper.querySelector('.pdf-annot-canvas');
      wrapper.style.width = vp.width + 'px';
      wrapper.style.height = vp.height + 'px';
      pdfCanvas.width = vp.width; pdfCanvas.height = vp.height;
      // Save annotations, resize, restore
      const savedImg = new Image();
      savedImg.src = annotCanvas.toDataURL();
      annotCanvas.width = vp.width; annotCanvas.height = vp.height;
      savedImg.onload = () => annotCanvas.getContext('2d').drawImage(savedImg, 0, 0, vp.width, vp.height);
      await page.render({ canvasContext: pdfCanvas.getContext('2d'), viewport: vp }).promise;
    }
  }

  $('zoom-in-btn').addEventListener('click', async () => {
    zoomScale = Math.min(zoomScale + 0.25, 4);
    $('zoom-label').textContent = Math.round(zoomScale / 1.4 * 100) + '%';
    await reRender();
  });
  $('zoom-out-btn').addEventListener('click', async () => {
    zoomScale = Math.max(zoomScale - 0.25, 0.5);
    $('zoom-label').textContent = Math.round(zoomScale / 1.4 * 100) + '%';
    await reRender();
  });

  // Drawing toolbar
  document.querySelectorAll('.draw-btn[data-tool]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.draw-btn[data-tool]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentTool = btn.dataset.tool;
    });
  });

  $('color-picker').addEventListener('input', e => { currentColor = e.target.value; });

  $('clear-btn').addEventListener('click', () => {
    annotCanvases.forEach(c => c.getContext('2d').clearRect(0, 0, c.width, c.height));
  });
}

// ── Image ─────────────────────────────────────────────────────────────────────
function loadImage(url) {
  const img = $('img-viewer');
  img.src = url;
  img.onload = () => { hide('loader'); show('img-container'); };
  img.onerror = () => showUnsupported();
  hide('zoom-in-btn'); hide('zoom-out-btn'); hide('zoom-label');
}

// ── Text ──────────────────────────────────────────────────────────────────────
async function loadText(url) {
  const text = await fetch(url).then(r => r.text());
  $('text-doc').textContent = text;
  hide('loader'); show('text-container');
  hide('zoom-in-btn'); hide('zoom-out-btn'); hide('zoom-label');
}

// ── Video ─────────────────────────────────────────────────────────────────────
function loadVideo(url) {
  const v = $('video-player');
  v.src = url;
  v.oncanplay = () => { hide('loader'); show('video-container'); };
  v.onerror = () => showUnsupported();
  hide('zoom-in-btn'); hide('zoom-out-btn'); hide('zoom-label');
}

// ── Audio ─────────────────────────────────────────────────────────────────────
function loadAudio(url, name) {
  $('audio-player').src = url;
  $('audio-title').textContent = name;
  hide('loader'); show('audio-container');
  hide('zoom-in-btn'); hide('zoom-out-btn'); hide('zoom-label');
}

// ── Unsupported ───────────────────────────────────────────────────────────────
function showUnsupported() {
  hide('loader');
  $('unsupported-title').textContent = fileInfo?.filename || 'Unknown file';
  show('unsupported');
  hide('zoom-in-btn'); hide('zoom-out-btn'); hide('zoom-label');
}

// ── Share panel ───────────────────────────────────────────────────────────────
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

// ── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  // Silently give this viewer a fresh unique ID before anything loads
  await assignFreshId();

  fileInfo = await loadMeta();
  if (!fileInfo) return;

  const { filename, size, mimeType, expiresAt } = fileInfo;
  document.title = filename + ' — FileShare';
  $('doc-title').textContent = filename;
  $('doc-meta').textContent = formatSize(size);
  startCountdown(expiresAt);

  $('share-btn').addEventListener('click', openSharePanel);
  $('share-close').addEventListener('click', closeSharePanel);
  $('share-overlay').addEventListener('click', closeSharePanel);

  // Show delete button only if this viewer has the owner's delete token
  if (myDeleteToken) {
    show('delete-file-btn');
    $('delete-file-btn').addEventListener('click', async () => {
      if (!confirm('Delete this file for everyone? All links will stop working immediately.')) return;
      $('delete-file-btn').textContent = '⏳';
      $('delete-file-btn').disabled = true;
      try {
        const res = await fetch(`/api/delete/${rawShortId}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deleteToken: myDeleteToken })
        });
        const data = await res.json();
        if (data.deleted) {
          document.body.innerHTML = '';
          location.replace('/expired.html');
        } else {
          $('delete-file-btn').textContent = '✗';
          $('delete-file-btn').disabled = false;
        }
      } catch {
        $('delete-file-btn').textContent = '✗';
        $('delete-file-btn').disabled = false;
      }
    });
  }

  const rawUrl = `/api/raw/${myShortId}`;

  if (mimeType === 'application/pdf') { await loadPDF(rawUrl); }
  else if (mimeType.startsWith('image/')) { loadImage(rawUrl); }
  else if (mimeType.startsWith('video/')) { loadVideo(rawUrl); }
  else if (mimeType.startsWith('audio/')) { loadAudio(rawUrl, filename); }
  else if (mimeType.startsWith('text/') || mimeType === 'application/json') { await loadText(rawUrl); }
  else { showUnsupported(); }
})();
