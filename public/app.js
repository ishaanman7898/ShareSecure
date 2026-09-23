import * as ZK from '/zk-client.js';

// ── html escaping for user-supplied strings (filenames, usernames) ──────────
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── landing rosette: guilloché bands like the ones printed on banknotes ───────
function drawRosette() {
  const svg = document.getElementById('rosette');
  if (!svg || svg.childElementCount) return;
  const NS = 'http://www.w3.org/2000/svg';
  const C = 200, STEPS = 480;
  // each band is a set of phase-shifted sine rings woven around a base radius
  const bands = [
    { base: 172, amp: 12, k: 24, n: 9,  cls: 'band-1' },
    { base: 132, amp: 18, k: 16, n: 10, cls: 'band-2' },
    { base: 88,  amp: 20, k: 12, n: 9,  cls: 'band-3' },
    { base: 44,  amp: 16, k: 8,  n: 7,  cls: 'band-4' },
  ];
  bands.forEach((b, bi) => {
    for (let i = 0; i < b.n; i++) {
      const phase = (i / b.n) * Math.PI * 2;
      let d = '';
      for (let s = 0; s <= STEPS; s++) {
        const t = (s / STEPS) * Math.PI * 2;
        const r = b.base + b.amp * Math.sin(b.k * t + phase) * Math.cos(t * 2 + phase / 3);
        d += (s ? 'L' : 'M') + (C + r * Math.cos(t)).toFixed(2) + ' ' + (C + r * Math.sin(t)).toFixed(2);
      }
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d + 'Z');
      path.setAttribute('pathLength', '1');
      path.setAttribute('class', b.cls);
      path.style.setProperty('--d', (bi * 0.18 + i * 0.05).toFixed(2) + 's');
      svg.appendChild(path);
    }
  });
}

// ── toast notification system ─────────────────────────────────────────────────
function showToast(message, type = 'info', durationMs = 4000) {
  let container = document.getElementById('toast-container');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toast-container';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }

  const icons = {
    success: `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>`,
    error:   `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>`,
    warn:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
    info:    `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="8"/><line x1="12" y1="12" x2="12" y2="16"/></svg>`,
  };

  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.innerHTML = `${icons[type] || icons.info}<span>${escapeHtml(message)}</span>`;
  container.appendChild(toast);

  const remove = () => {
    toast.classList.add('fade-out');
    setTimeout(() => { if (toast.parentNode) toast.parentNode.removeChild(toast); }, 280);
  };

  const timer = setTimeout(remove, durationMs);
  toast.addEventListener('click', () => { clearTimeout(timer); remove(); });
}

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
const expiresSelect = document.getElementById('expires-select');
const customExpiryWrap = document.getElementById('custom-expiry-wrap');
const customExpiryInput = document.getElementById('custom-expiry-input');
const customExpiryErr = document.getElementById('custom-expiry-err');
const qrCanvasEl = document.getElementById('qr-canvas');
const saveQrBtn = document.getElementById('save-qr-btn');

// --- auth & dashboard elements ---
const authStatus = document.getElementById('auth-status');
const dashboardCard = document.getElementById('dashboard-card');
const fileList = document.getElementById('file-list');
const uploadCount = document.getElementById('upload-count');

const landingPage = document.getElementById('landing-page');

let qrInstance = null;
let currentShortId = null;
let currentDeleteToken = null;
let currentHistoryRecord = null;
let userToken = sessionStorage.getItem('user_token');
let customExpiryHours = null;
let selfHostMode = false;

// ── localStorage upload history (client-side dashboard) ───────────────────────
const HISTORY_KEY = 'ss_upload_history';

const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function loadUploadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    if (!raw) return [];
    const items = JSON.parse(raw);
    if (!Array.isArray(items)) return [];
    const now = Date.now();
    const live = items.filter(f => {
      // Remove if the link has expired
      if (f.expires_at && new Date(f.expires_at).getTime() <= now) return false;
      // Remove if the entry is older than 30 days regardless of expiry
      // This limits the permanent paper trail on the uploader's device
      if (f.uploaded_at && now - new Date(f.uploaded_at).getTime() > HISTORY_MAX_AGE_MS) return false;
      return true;
    });
    // write the pruned list back so expired entries don't linger in storage
    if (live.length !== items.length) localStorage.setItem(HISTORY_KEY, JSON.stringify(live));
    return live;
  } catch { return []; }
}

function saveUploadToHistory(record) {
  try {
    const history = loadUploadHistory();
    history.unshift(record);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(0, 50)));
  } catch {}
}

// Purge stale owner_* tokens from localStorage so they don't accumulate forever.
// Runs once on startup; removes tokens whose matching history entry no longer exists.
function purgeStaleOwnerTokens() {
  try {
    const history = loadUploadHistory();
    const activeIds = new Set(history.map(f => f.short_id));
    Object.keys(localStorage)
      .filter(k => k.startsWith('owner_'))
      .forEach(k => {
        const id = k.slice(6);
        if (!activeIds.has(id)) localStorage.removeItem(k);
      });
  } catch {}
}

function removeFromHistory(shortId) {
  try {
    const history = loadUploadHistory().filter(f => f.short_id !== shortId);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(history));
  } catch {}
}

function toLocalDatetimeString(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

expiresSelect.addEventListener('change', () => {
  if (expiresSelect.value === 'custom') {
    customExpiryWrap.classList.remove('hidden');
    const now = new Date();
    const max = new Date(now.getTime() + 10 * 24 * 60 * 60 * 1000 - 60 * 1000);
    customExpiryInput.min = toLocalDatetimeString(now);
    customExpiryInput.max = toLocalDatetimeString(max);
    if (!customExpiryInput.value) {
      customExpiryInput.value = toLocalDatetimeString(new Date(now.getTime() + 60 * 60 * 1000));
    }
    customExpiryErr.textContent = '';
  } else {
    customExpiryWrap.classList.add('hidden');
    customExpiryHours = null;
  }
});

customExpiryInput.addEventListener('change', () => {
  const selected = new Date(customExpiryInput.value);
  const now = new Date();
  const diffMs = selected - now;
  customExpiryErr.textContent = '';
  if (diffMs <= 0) {
    customExpiryErr.textContent = 'Please select a future time.';
    customExpiryHours = null;
  } else if (diffMs >= 10 * 24 * 60 * 60 * 1000) {
    customExpiryErr.textContent = 'Must be less than 10 days from now.';
    customExpiryHours = null;
  } else {
    customExpiryHours = diffMs / (1000 * 3600);
  }
});

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
  const days = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (days > 0) return `${days}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
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
      el.style.color = 'var(--danger)';
      clearInterval(countdownInterval);
      return;
    }
    el.textContent = 'Expires in ' + formatCountdown(remaining);
    el.style.color = remaining < 60000 ? 'var(--danger)' : remaining < 300000 ? 'var(--warn)' : '';
  }

  tick();
  countdownInterval = setInterval(tick, 1000);
}

function getFileIcon(mime) {
  const iconProps = 'width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  if (mime.startsWith('image/')) return `<svg ${iconProps}><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
  if (mime.startsWith('video/')) return `<svg ${iconProps}><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><polyline points="8 21 12 17 16 21"/></svg>`;
  if (mime.startsWith('audio/')) return `<svg ${iconProps}><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
  if (mime.includes('pdf')) return `<svg ${iconProps}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>`;
  if (mime.includes('zip') || mime.includes('archive') || mime.includes('compressed')) return `<svg ${iconProps}><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M10 8V5a2 2 0 0 1 2-2h0a2 2 0 0 1 2 2v3"/><path d="M8 15h8"/></svg>`;
  if (mime.includes('text')) return `<svg ${iconProps}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>`;
  return `<svg ${iconProps}><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>`;
}

const ALLOWED_EXTENSIONS = ['.pdf', '.docx', '.png', '.jpg', '.jpeg'];
const ALLOWED_MIMES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png',
  'image/jpeg',
];

function setFile(file) {
  if (file.size > MAX_BYTES) {
    showToast(`File too large (${formatSize(file.size)}). Max is 10 MB.`, 'error');
    return;
  }
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext) && !ALLOWED_MIMES.includes(file.type)) {
    showToast('Only PDF, DOCX, PNG, and JPG files are accepted.', 'error');
    return;
  }
  selectedFile = file;
  fileName.textContent = file.name;
  fileSize.textContent = formatSize(file.size);
  document.getElementById('file-icon').innerHTML = getFileIcon(file.type);
  filePreview.classList.remove('hidden');
  dropZone.classList.add('hidden');
  uploadBtn.disabled = false;

  // Show rename field and pre-fill with filename minus extension
  const nameWrap = document.getElementById('display-name-wrap');
  const nameInput = document.getElementById('display-name-input');
  if (nameWrap && nameInput) {
    nameWrap.classList.remove('hidden');
    // Pre-fill with filename without extension for easy editing
    nameInput.value = file.name.replace(/\.[^.]+$/, '');
  }
}

function clearSelection() {
  selectedFile = null;
  fileInput.value = '';
  filePreview.classList.add('hidden');
  dropZone.classList.remove('hidden');
  uploadBtn.disabled = true;

  const nameWrap = document.getElementById('display-name-wrap');
  const nameInput = document.getElementById('display-name-input');
  if (nameWrap) nameWrap.classList.add('hidden');
  if (nameInput) nameInput.value = '';
}


// drag & drop
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
dropZone.addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); }
});
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) setFile(fileInput.files[0]);
});
clearFile.addEventListener('click', clearSelection);

// upload
uploadBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  if (expiresSelect.value === 'custom') {
    if (!customExpiryHours) {
      showToast('Pick an expiry time within the next 10 days.', 'warn');
      return;
    }
  }

  const formData = new FormData();
  formData.append('file', selectedFile);
  formData.append('expires_hours', expiresSelect.value === 'custom' ? customExpiryHours : expiresSelect.value);
  formData.append('allow_annotations', document.getElementById('allow-annotations')?.checked ? '1' : '0');
  formData.append('allow_download', document.getElementById('allow-download').checked ? '1' : '0');

  // Send custom display name if the user changed it
  const displayNameInput = document.getElementById('display-name-input');
  if (displayNameInput && displayNameInput.value.trim()) {
    formData.append('display_name', displayNameInput.value.trim());
  }

  uploadBtn.disabled = true;
  progressWrap.classList.remove('hidden');
  progressBar.style.width = '0%';

  // Prepare ZK auth fields if the user has enrolled credentials.
  // When using ZK, we OMIT the Authorization header so the server (and any
  // logging in the request chain) cannot link the upload to a specific user_id.
  // The proof is multi-KB so it goes in the form data, not headers.
  let zkFields = null;
  if (userToken && ZK.hasZKCredentials()) {
    try {
      zkFields = await ZK.prepareUploadFields(userToken);
      formData.append('zk_proof',     zkFields.zk_proof);
      formData.append('zk_nullifier', zkFields.zk_nullifier);
      formData.append('zk_nonce',     zkFields.zk_nonce);
    } catch {
      // ZK prep failed (challenge limit, network, etc.) — fall back to Bearer
      zkFields = null;
    }
  }

  try {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    if (!zkFields && userToken) {
      xhr.setRequestHeader('Authorization', `Bearer ${userToken}`);
    }

    xhr.upload.addEventListener('progress', e => {
      if (e.lengthComputable) {
        progressBar.style.width = Math.round((e.loaded / e.total) * 100) + '%';
      }
    });

    xhr.onload = async () => {
      if (xhr.status === 200) {
        const data = JSON.parse(xhr.responseText);
        showResult(data, selectedFile);
        showToast('Link created.', 'success');
        if (userToken) updateDashboard();
        if (selfHostMode) renderFileList(loadUploadHistory());
      } else if (xhr.status === 401) {
        showToast('Your session ended. Sign in again to upload.', 'warn', 6000);
        logout();
      } else if (xhr.status === 429) {
        showToast('Upload limit reached (5 files per 24h). Try again tomorrow.', 'warn', 6000);
        uploadBtn.disabled = false;
        progressWrap.classList.add('hidden');
      } else {
        showToast('Upload failed. Try again.', 'error');
        uploadBtn.disabled = false;
        progressWrap.classList.add('hidden');
      }
    };

    xhr.onerror = () => {
      showToast('Couldn’t reach the server. Check your connection and try again.', 'error');
      uploadBtn.disabled = false;
      progressWrap.classList.add('hidden');
    };

    xhr.send(formData);
  } catch (err) {
    showToast('Upload failed. Try again.', 'error');
    uploadBtn.disabled = false;
    progressWrap.classList.add('hidden');
  }
});

function showResult(data, file) {
  currentShortId = data.shortId;
  currentDeleteToken = data.deleteToken || null;

  // Determine the display name (custom name takes precedence over original filename)
  const displayNameInput = document.getElementById('display-name-input');
  const usedName = (displayNameInput && displayNameInput.value.trim())
    ? displayNameInput.value.trim()
    : file.name;

  // show the owner's direct url — same link they'll view the file at
  const ownerUrl = data.shortUrl;
  shortLink.textContent = ownerUrl;

  if (ownerUrl.includes('localhost') || ownerUrl.includes('127.0.0.1')) {
    let warningText = document.getElementById('localhost-warn');
    if (!warningText) {
      warningText = document.createElement('div');
      warningText.id = 'localhost-warn';
      warningText.style.color = 'var(--warn)';
      warningText.style.fontSize = '0.82rem';
      warningText.style.padding = '4px 0 2px';
      warningText.textContent = 'This link points to localhost, so other devices can’t open it. Use your local network IP (e.g. 192.168.x.x) or a tunnel to share it.';
      shortLink.parentNode.appendChild(warningText);
    }
  }

  // auto-open the file in a new tab
  window.open(ownerUrl, '_blank', 'noopener,noreferrer');

  // store delete token so the viewer tab recognizes this browser as the owner
  if (data.deleteToken) {
    localStorage.setItem('owner_' + data.shortId, data.deleteToken);
  }

  // Save full record to client-side dashboard history (no server-side user→file link)
  currentHistoryRecord = {
    short_id:          data.shortId,
    original_filename: usedName,
    mime_type:         file.type || 'application/octet-stream',
    size_bytes:        file.size,
    expires_at:        data.expiresAt,
    uploaded_at:       new Date().toISOString(),
    delete_token:      data.deleteToken || null,
  };
  saveUploadToHistory(currentHistoryRecord);

  resultFilename.textContent = usedName;
  resultSize.textContent = formatSize(file.size);

  // live countdown
  if (countdownInterval) clearInterval(countdownInterval);
  startResultCountdown(data.expiresAt);

  // generate qr entirely client-side — no third party ever sees the url
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
    a.href = url; a.download = 'sharesecure-qr.png'; a.click();
  };

  resultCard.classList.remove('hidden');
}

// copy
copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(shortLink.textContent).then(() => {
    copyBtn.textContent = 'Copied';
    copyBtn.classList.add('copied');
    showToast('Link copied.', 'success', 2500);
    setTimeout(() => {
      copyBtn.textContent = 'Copy';
      copyBtn.classList.remove('copied');
    }, 2000);
  }).catch(() => {
    showToast('Couldn’t copy. Select the link and copy it manually.', 'warn');
  });
});


document.getElementById('result-close-btn')?.addEventListener('click', () => {
  if (countdownInterval) clearInterval(countdownInterval);
  resultCard.classList.add('hidden');
});

document.getElementById('result-modal-backdrop')?.addEventListener('click', () => {
  if (countdownInterval) clearInterval(countdownInterval);
  resultCard.classList.add('hidden');
});

// --- auth & dashboard logic ---

function authHeaders() {
  return userToken ? { 'Authorization': `Bearer ${userToken}` } : {};
}

function tokenUsername() {
  const stored = sessionStorage.getItem('user_name');
  if (stored) return stored;
  try {
    const payloadB64 = userToken.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(payloadB64 + '==')).username || null;
  } catch {
    return null;
  }
}

function showSignedIn(username) {
  authStatus.innerHTML = `
    <span class="user-name">Signed in as <strong>${escapeHtml(username)}</strong></span>
    <button class="btn btn-ghost" id="logout-btn">Sign out</button>
  `;
  document.getElementById('logout-btn').addEventListener('click', logout);
  document.body.classList.add('is-logged-in');
  landingPage.classList.add('hidden');
  document.getElementById('app-grid')?.classList.remove('hidden');
}

function initAuth() {
  const username = userToken && tokenUsername();
  if (username) {
    showSignedIn(username);
    updateDashboard();
    updateInbox();
  } else {
    if (userToken) logout();
    authStatus.innerHTML = `<a class="btn btn-ghost" href="/signin">Sign in</a>`;
    document.body.classList.remove('is-logged-in');
    landingPage.classList.remove('hidden');
    drawRosette();
    document.getElementById('app-grid')?.classList.add('hidden');
  }
}

// ── self-hosted: the owner signs in; nobody else can upload ──────────────────
function initSelfHost() {
  selfHostMode = true;
  const username = userToken && tokenUsername();
  if (!username) { location.replace('/signin'); return; }

  showSignedIn(username);
  // no other accounts exist on a self-hosted instance, so nobody can send you files
  document.getElementById('inbox-section')?.classList.add('hidden');
  if (uploadCount) uploadCount.textContent = 'No limit';
  renderFileList(loadUploadHistory());
  initUpdates();
}

async function updateDashboard() {
  if (!userToken) return;

  // Render localStorage cache instantly so the UI is never blank during the round-trip
  renderFileList(loadUploadHistory());

  // Fetch upload count from server (file list stays in localStorage — no server-side user→file link).
  try {
    const res = await fetch('/api/auth/user/files', { headers: authHeaders() });
    if (res.status === 401) { logout(); return; }
    if (!res.ok) return;
    const data = await res.json();
    uploadCount.textContent = data.unlimited ? 'No limit' : `${data.dailyUploadCount ?? 0}/5 today`;
  } catch { /* network error — keep showing cached list */ }
}

async function updateInbox() {
  if (!userToken) return;
  try {
    const res = await fetch('/api/inbox', { headers: authHeaders() });
    if (!res.ok) return;
    const data = await res.json();
    renderInbox(data.files || []);
    const count = (data.files || []).length;
    const inboxCount = document.getElementById('inbox-count');
    if (inboxCount) inboxCount.textContent = count > 0 ? `${count} received` : '';
  } catch {}
}

function renderInbox(files) {
  const list = document.getElementById('inbox-list');
  if (!list) return;
  const live = (files || []).filter(f => !f.expires_at || new Date(f.expires_at) > Date.now());
  if (live.length === 0) {
    list.innerHTML = '<p class="empty-msg">No files received.</p>';
    return;
  }
  list.innerHTML = live.map(f => {
    const expiryStr = f.expires_at ? `${formatCountdown(new Date(f.expires_at) - Date.now())} left` : 'No expiry';
    return `
      <div class="file-item">
        <div class="file-icon">${getFileIcon(f.mime_type || '')}</div>
        <div class="file-item-info">
          <span class="file-item-name">${escapeHtml(f.original_filename || 'Untitled')}</span>
          <span class="file-item-meta">${formatSize(f.size_bytes || 0)}, ${expiryStr}</span>
        </div>
        <div class="file-item-actions">
          <a class="btn btn-ghost btn-open" href="/r/${encodeURIComponent(f.short_id)}" target="_blank" rel="noopener noreferrer">Open</a>
        </div>
      </div>`;
  }).join('');
}

const EMPTY_LIST = `<p class="empty-msg">Nothing shared yet. Your links will show up here.</p>`;
const TRASH_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
let listTimer = null;

// Drop a share from this browser entirely: list entry, owner key, and row.
function forgetShare(shortId) {
  removeFromHistory(shortId);
  try { localStorage.removeItem('owner_' + shortId); } catch {}
  fileList.querySelector(`[data-short-id="${CSS.escape(shortId)}"]`)?.remove();
  if (!fileList.querySelector('.file-item')) fileList.innerHTML = EMPTY_LIST;
}

function renderFileList(files) {
  if (listTimer) { clearInterval(listTimer); listTimer = null; }
  if (!files || files.length === 0) {
    fileList.innerHTML = EMPTY_LIST;
    return;
  }

  fileList.innerHTML = files.map(f => `
    <div class="file-item" data-short-id="${escapeHtml(f.short_id)}">
      <div class="file-icon">${getFileIcon(f.mime_type || '')}</div>
      <div class="file-item-info">
        <span class="file-item-name">${escapeHtml(f.original_filename)}</span>
        <span class="file-item-time" data-expires="${escapeHtml(f.expires_at)}"></span>
      </div>
      <div class="file-item-actions">
        <a href="/r/${encodeURIComponent(f.short_id)}" target="_blank" class="btn-icon" title="Open" aria-label="Open ${escapeHtml(f.original_filename)}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </a>
        <button class="btn-icon delete-file-btn" data-id="${escapeHtml(f.short_id)}" title="Delete" aria-label="Delete ${escapeHtml(f.original_filename)}">${TRASH_ICON}</button>
      </div>
    </div>
  `).join('');

  fileList.querySelectorAll('.delete-file-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Delete this file for everyone? This can’t be undone.')) return;
      const shortId = btn.dataset.id;
      const record = files.find(f => f.short_id === shortId);
      const deleteToken = record?.delete_token || localStorage.getItem('owner_' + shortId);
      btn.innerHTML = `<svg class="spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3a9 9 0 1 0 9 9"/></svg>`;
      btn.disabled = true;
      try {
        const res = await fetch(`/api/delete/${encodeURIComponent(shortId)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ deleteToken }),
        });
        const data = await res.json().catch(() => ({}));
        if (data.deleted || res.status === 404) {
          showToast('File deleted.', 'success');
          forgetShare(shortId);
        } else {
          showToast('Couldn’t delete the file. Try again.', 'error');
          btn.innerHTML = TRASH_ICON;
          btn.disabled = false;
        }
      } catch {
        showToast('Couldn’t reach the server. Try again.', 'error');
        btn.innerHTML = TRASH_ICON;
        btn.disabled = false;
      }
    });
  });

  // countdowns; an expired share disappears from this browser on its own
  const tick = () => {
    files.forEach(f => {
      const el = fileList.querySelector(`[data-short-id="${CSS.escape(f.short_id)}"] .file-item-time`);
      if (!el) return;
      const remaining = new Date(f.expires_at).getTime() - Date.now();
      if (remaining <= 0) forgetShare(f.short_id);
      else el.textContent = formatCountdown(remaining) + ' left';
    });
  };
  tick();
  listTimer = setInterval(tick, 5000);
}

function logout() {
  userToken = null;
  sessionStorage.removeItem('user_token');
  sessionStorage.removeItem('user_name');
  location.replace(selfHostMode ? '/signin' : '/');
}

// ── updates (self-hosted) ─────────────────────────────────────────────────────
const updatesSection = document.getElementById('updates-section');
const updateVersion = document.getElementById('update-version');
const updateStatus = document.getElementById('update-status');
const updateBtn = document.getElementById('update-btn');
const updateCheckBtn = document.getElementById('update-check-btn');
const autoUpdateInput = document.getElementById('auto-update');

async function updateCall(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) { logout(); throw new Error('signed out'); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Update failed');
  return data;
}

function renderUpdates(s) {
  updateVersion.textContent = `Version ${s.current}`;
  autoUpdateInput.checked = !!s.autoUpdate;
  autoUpdateInput.disabled = !s.canUpdate;
  updateBtn.classList.add('hidden');
  updateBtn.disabled = false;

  if (s.blockedReason === 'docker') {
    updateStatus.textContent = s.updateAvailable
      ? `Version ${s.latest} is out. Rebuild the container to update.`
      : 'Docker installs update by rebuilding the container.';
    return;
  }
  if (s.status === 'updating') { updateStatus.textContent = `Installing version ${s.latest}…`; return; }
  if (s.status === 'restarting') { updateStatus.textContent = 'Restarting with the new version…'; return; }
  if (s.status === 'restart-required') { updateStatus.textContent = `Version ${s.latest} is installed. Restart ShareSecure to finish.`; return; }
  if (s.status === 'failed') {
    updateStatus.textContent = `The update didn’t install: ${s.error}`;
  } else if (s.checkError) {
    updateStatus.textContent = s.checkError;
  } else if (s.updateAvailable) {
    updateStatus.textContent = `Version ${s.latest} is available.`;
  } else if (s.latest) {
    updateStatus.textContent = 'You’re up to date.';
  } else {
    updateStatus.textContent = 'Checking for updates…';
  }
  if (s.updateAvailable && s.canUpdate) {
    updateBtn.textContent = `Update to ${s.latest}`;
    updateBtn.classList.remove('hidden');
  }
}

// After an update the server restarts; wait for the new version, then reload.
async function waitForRestart(fromVersion) {
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 2000));
    try {
      const res = await fetch('/api/mode', { cache: 'no-store' });
      const info = await res.json();
      if (info.version && info.version !== fromVersion) { location.reload(); return; }
    } catch { /* still restarting */ }
  }
  updateStatus.textContent = 'ShareSecure is taking a while to restart. Reload the page in a minute.';
}

async function initUpdates() {
  if (!updatesSection) return;
  updatesSection.classList.remove('hidden');
  try {
    let s = await updateCall('/api/update/status');
    renderUpdates(s);
    if (!s.checkedAt) renderUpdates(s = await updateCall('/api/update/check', {}));
  } catch {
    updatesSection.classList.add('hidden');
  }
}

updateCheckBtn?.addEventListener('click', async () => {
  updateCheckBtn.disabled = true;
  updateStatus.textContent = 'Checking for updates…';
  try { renderUpdates(await updateCall('/api/update/check', {})); } catch {}
  updateCheckBtn.disabled = false;
});

updateBtn?.addEventListener('click', async () => {
  updateBtn.disabled = true;
  updateStatus.textContent = 'Downloading and installing the update…';
  try {
    const before = updateVersion.textContent.replace('Version ', '');
    const s = await updateCall('/api/update/apply', {});
    renderUpdates(s);
    if (s.status === 'restarting') waitForRestart(before);
  } catch (err) {
    updateStatus.textContent = `The update didn’t install: ${err.message}`;
    updateBtn.disabled = false;
  }
});

autoUpdateInput?.addEventListener('change', async () => {
  try {
    renderUpdates(await updateCall('/api/update/settings', { autoUpdate: autoUpdateInput.checked }));
    showToast(autoUpdateInput.checked ? 'Updates will install automatically.' : 'Automatic updates turned off.', 'success', 2500);
  } catch {
    autoUpdateInput.checked = !autoUpdateInput.checked;
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!resultCard.classList.contains('hidden')) {
    if (countdownInterval) clearInterval(countdownInterval);
    resultCard.classList.add('hidden');
  }
});

// ── mode detection + app initialisation ──────────────────────────────────────
const tcModal = document.getElementById('tc-modal');
const acceptTcBtn = document.getElementById('accept-tc-btn');

async function detectSelfHostMode() {
  try {
    const res = await fetch('/api/mode', { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data = await res.json();
      return data.selfHostMode === true;
    }
  } catch {}
  return false;
}

async function startApp() {
  const isSelfHost = await detectSelfHostMode();
  if (isSelfHost) {
    initSelfHost();
  } else {
    initAuth();
  }
}

function initApp() {
  purgeStaleOwnerTokens();
  if (localStorage.getItem('tc_accepted') !== 'true') {
    tcModal.classList.remove('hidden');
    landingPage.classList.add('hidden');
    dashboardCard.classList.add('hidden');
    uploadCard.classList.add('hidden');
  } else {
    startApp();
  }
}

acceptTcBtn?.addEventListener('click', () => {
  localStorage.setItem('tc_accepted', 'true');
  tcModal.classList.add('hidden');
  dashboardCard.classList.remove('hidden');
  uploadCard.classList.remove('hidden');
  startApp();
});

initApp();
