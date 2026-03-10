const dropZone = document.getElementById('drop-zone');
const fileInput = document.getElementById('file-input');
const filePreview = document.getElementById('file-preview');
const fileName = document.getElementById('file-name');
const fileSize = document.getElementById('file-size');
const clearFile = document.getElementById('clear-file');
const uploadBtn = document.getElementById('upload-btn');
const progressWrap = document.getElementById('progress-wrap');
const progressBar = document.getElementById('progress-bar');
const uploadCard = document.getElementById('upload-card');
const resultCard = document.getElementById('result-card');
const shortLink = document.getElementById('short-link');
const copyBtn = document.getElementById('copy-btn');
const resultFilename = document.getElementById('result-filename');
const resultSize = document.getElementById('result-size');
const resultExpires = document.getElementById('result-expires');
const newUploadBtn = document.getElementById('new-upload-btn');
const expiresSelect = document.getElementById('expires-select');
const qrCanvasEl = document.getElementById('qr-canvas');
const saveQrBtn = document.getElementById('save-qr-btn');
let qrInstance = null;

const MAX_BYTES = 10 * 1024 * 1024;
let selectedFile = null;
let countdownInterval = null;

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatCountdown(ms) {
  if (ms <= 0) return 'Expired';
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function startResultCountdown(expiresAt) {
  const el = resultExpires;
  if (!expiresAt) { el.textContent = 'No expiry set'; return; }

  const expiry = new Date(expiresAt).getTime();

  function tick() {
    const remaining = expiry - Date.now();
    if (remaining <= 0) {
      el.textContent = 'Expired';
      el.style.color = '#ef4444';
      clearInterval(countdownInterval);
      return;
    }
    el.textContent = 'Expires in ' + formatCountdown(remaining);
    el.style.color = remaining < 60000 ? '#ef4444' : remaining < 300000 ? '#f59e0b' : '';
  }

  tick();
  countdownInterval = setInterval(tick, 1000);
}

function getFileIcon(mime) {
  if (mime.startsWith('image/')) return '🖼️';
  if (mime.startsWith('video/')) return '🎬';
  if (mime.startsWith('audio/')) return '🎵';
  if (mime.includes('pdf')) return '📄';
  if (mime.includes('zip') || mime.includes('archive') || mime.includes('compressed')) return '🗜️';
  if (mime.includes('text')) return '📝';
  return '📁';
}

function setFile(file) {
  if (file.size > MAX_BYTES) {
    alert(`File is too large (${formatSize(file.size)}). Max allowed is 10 MB.`);
    return;
  }
  selectedFile = file;
  fileName.textContent = file.name;
  fileSize.textContent = formatSize(file.size);
  document.getElementById('file-icon').textContent = getFileIcon(file.type);
  filePreview.classList.remove('hidden');
  dropZone.classList.add('hidden');
  uploadBtn.disabled = false;
}

function clearSelection() {
  selectedFile = null;
  fileInput.value = '';
  filePreview.classList.add('hidden');
  dropZone.classList.remove('hidden');
  uploadBtn.disabled = true;
}

// Drag & drop
dropZone.addEventListener('dragover', e => {
  e.preventDefault();
  dropZone.classList.add('dragover');
});
dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
dropZone.addEventListener('drop', e => {
  e.preventDefault();
  dropZone.classList.remove('dragover');
  const file = e.dataTransfer.files[0];
  if (file) setFile(file);
});
dropZone.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) setFile(fileInput.files[0]);
});
clearFile.addEventListener('click', clearSelection);

// Upload
uploadBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  const formData = new FormData();
  formData.append('file', selectedFile);
  // Always send expiry — no "never" option
  formData.append('expires_hours', expiresSelect.value);

  uploadBtn.disabled = true;
  progressWrap.classList.remove('hidden');
  progressBar.style.width = '0%';

  try {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');

    xhr.upload.addEventListener('progress', e => {
      if (e.lengthComputable) {
        progressBar.style.width = Math.round((e.loaded / e.total) * 100) + '%';
      }
    });

    xhr.onload = () => {
      if (xhr.status === 200) {
        const data = JSON.parse(xhr.responseText);
        showResult(data, selectedFile);
      } else {
        alert('Upload failed. Please try again.');
        uploadBtn.disabled = false;
        progressWrap.classList.add('hidden');
      }
    };

    xhr.onerror = () => {
      alert('Network error. Please try again.');
      uploadBtn.disabled = false;
      progressWrap.classList.add('hidden');
    };

    xhr.send(formData);
  } catch (err) {
    alert('Upload failed.');
    uploadBtn.disabled = false;
    progressWrap.classList.add('hidden');
  }
});

function showResult(data, file) {
  shortLink.textContent = data.shortUrl;
  document.getElementById('view-btn').href = data.shortUrl;
  resultFilename.textContent = file.name;
  resultSize.textContent = formatSize(file.size);

  // Live countdown
  if (countdownInterval) clearInterval(countdownInterval);
  startResultCountdown(data.expiresAt);

  // Generate QR entirely client-side — no third party ever sees the URL
  qrCanvasEl.innerHTML = '';
  qrInstance = new QRCode(qrCanvasEl, {
    text: data.shortUrl, width: 200, height: 200,
    colorDark: '#000000', colorLight: '#ffffff',
    correctLevel: QRCode.CorrectLevel.M
  });

  saveQrBtn.onclick = () => {
    const img = qrCanvasEl.querySelector('img') || qrCanvasEl.querySelector('canvas');
    const url = img.tagName === 'CANVAS' ? img.toDataURL('image/png') : img.src;
    const a = document.createElement('a');
    a.href = url; a.download = 'fileshare-qr.png'; a.click();
  };

  uploadCard.classList.add('hidden');
  resultCard.classList.remove('hidden');
}

// Copy
copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(shortLink.textContent).then(() => {
    copyBtn.textContent = 'Copied!';
    copyBtn.classList.add('copied');
    setTimeout(() => {
      copyBtn.textContent = 'Copy';
      copyBtn.classList.remove('copied');
    }, 2000);
  });
});

// New upload
newUploadBtn.addEventListener('click', () => {
  if (countdownInterval) clearInterval(countdownInterval);
  clearSelection();
  progressWrap.classList.add('hidden');
  progressBar.style.width = '0%';
  expiresSelect.value = '1';
  resultCard.classList.add('hidden');
  uploadCard.classList.remove('hidden');
});
