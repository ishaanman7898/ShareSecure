import * as pdfjsLib from 'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.min.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc =
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@4.10.38/build/pdf.worker.min.mjs';

// ── Helpers ──────────────────────────────────────────────────────────────────

const shortId = location.pathname.split('/r/')[1];

const $ = id => document.getElementById(id);

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function show(id) { $(id).classList.remove('hidden'); }
function hide(id) { $(id).classList.add('hidden'); }

// ── Load metadata ─────────────────────────────────────────────────────────────

let fileInfo = null;

async function loadMeta() {
  const res = await fetch(`/api/info/${shortId}`);
  if (!res.ok) {
    $('doc-title').textContent = 'File not found';
    hide('loader');
    return null;
  }
  return res.json();
}

// ── PDF Viewer ────────────────────────────────────────────────────────────────

let pdfDoc = null;
let currentPage = 1;
let currentScale = 1.4;

async function renderPage(num) {
  const page = await pdfDoc.getPage(num);
  const viewport = page.getViewport({ scale: currentScale });
  const canvas = $('pdf-canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
  $('page-info').textContent = `Page ${num} of ${pdfDoc.numPages}`;
}

async function loadPDF(url) {
  show('pdf-container');
  show('page-nav');

  pdfDoc = await pdfjsLib.getDocument(url).promise;
  await renderPage(1);
  hide('loader');

  $('prev-page').addEventListener('click', async () => {
    if (currentPage > 1) { currentPage--; await renderPage(currentPage); }
  });
  $('next-page').addEventListener('click', async () => {
    if (currentPage < pdfDoc.numPages) { currentPage++; await renderPage(currentPage); }
  });
  $('zoom-in-btn').addEventListener('click', async () => {
    currentScale = Math.min(currentScale + 0.2, 4);
    $('zoom-label').textContent = Math.round(currentScale / 1.4 * 100) + '%';
    await renderPage(currentPage);
  });
  $('zoom-out-btn').addEventListener('click', async () => {
    currentScale = Math.max(currentScale - 0.2, 0.4);
    $('zoom-label').textContent = Math.round(currentScale / 1.4 * 100) + '%';
    await renderPage(currentPage);
  });
}

// ── Image Viewer ──────────────────────────────────────────────────────────────

function loadImage(url) {
  const img = $('img-viewer');
  img.src = url;
  img.onload = () => { hide('loader'); show('img-container'); };
  img.onerror = () => showUnsupported();

  // Zoom for images
  let scale = 1;
  $('zoom-in-btn').addEventListener('click', () => {
    scale = Math.min(scale + 0.15, 4);
    img.style.transform = `scale(${scale})`;
    img.style.transformOrigin = 'top center';
    $('zoom-label').textContent = Math.round(scale * 100) + '%';
  });
  $('zoom-out-btn').addEventListener('click', () => {
    scale = Math.max(scale - 0.15, 0.2);
    img.style.transform = `scale(${scale})`;
    img.style.transformOrigin = 'top center';
    $('zoom-label').textContent = Math.round(scale * 100) + '%';
  });
}

// ── Text Viewer ───────────────────────────────────────────────────────────────

async function loadText(url) {
  const res = await fetch(url);
  const text = await res.text();
  $('text-doc').textContent = text;
  hide('loader');
  show('text-container');

  let size = 11;
  $('zoom-in-btn').addEventListener('click', () => {
    size = Math.min(size + 1, 28);
    $('text-doc').style.fontSize = size + 'pt';
    $('zoom-label').textContent = Math.round(size / 11 * 100) + '%';
  });
  $('zoom-out-btn').addEventListener('click', () => {
    size = Math.max(size - 1, 6);
    $('text-doc').style.fontSize = size + 'pt';
    $('zoom-label').textContent = Math.round(size / 11 * 100) + '%';
  });
}

// ── Video ─────────────────────────────────────────────────────────────────────

function loadVideo(url) {
  const v = $('video-player');
  v.src = url;
  v.oncanplay = () => { hide('loader'); show('video-container'); };
  v.onerror = () => showUnsupported();
  hide('zoom-out-btn'); hide('zoom-in-btn'); hide('zoom-label');
}

// ── Audio ─────────────────────────────────────────────────────────────────────

function loadAudio(url, name) {
  $('audio-player').src = url;
  $('audio-title').textContent = name;
  hide('loader');
  show('audio-container');
  hide('zoom-out-btn'); hide('zoom-in-btn'); hide('zoom-label');
}

// ── Unsupported ───────────────────────────────────────────────────────────────

function showUnsupported() {
  hide('loader');
  $('unsupported-title').textContent = fileInfo?.filename || 'Unknown file';
  $('unsupported-download').onclick = () => {
    location.href = `/api/download/${shortId}`;
  };
  show('unsupported');
  hide('zoom-out-btn'); hide('zoom-in-btn'); hide('zoom-label');
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  fileInfo = await loadMeta();
  if (!fileInfo) return;

  const { filename, size, mimeType } = fileInfo;
  document.title = filename + ' — FileShare';
  $('doc-title').textContent = filename;
  $('doc-meta').textContent = formatSize(size);

  const rawUrl = `/api/raw/${shortId}`;

  $('download-btn').addEventListener('click', () => {
    location.href = `/api/download/${shortId}`;
  });

  if (mimeType === 'application/pdf') {
    await loadPDF(rawUrl);

  } else if (mimeType.startsWith('image/')) {
    loadImage(rawUrl);

  } else if (mimeType.startsWith('video/')) {
    loadVideo(rawUrl);

  } else if (mimeType.startsWith('audio/')) {
    loadAudio(rawUrl, filename);

  } else if (mimeType.startsWith('text/') || mimeType === 'application/json') {
    await loadText(rawUrl);

  } else {
    showUnsupported();
  }
})();
