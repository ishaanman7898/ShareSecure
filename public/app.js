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
  toast.innerHTML = `${icons[type] || icons.info}<span>${message}</span>`;
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
const newUploadBtn = document.getElementById('new-upload-btn');
const deleteBtn = document.getElementById('delete-btn');
const expiresSelect = document.getElementById('expires-select');
const customExpiryWrap = document.getElementById('custom-expiry-wrap');
const customExpiryInput = document.getElementById('custom-expiry-input');
const customExpiryErr = document.getElementById('custom-expiry-err');
const qrCanvasEl = document.getElementById('qr-canvas');
const saveQrBtn = document.getElementById('save-qr-btn');

// --- auth & dashboard elements ---
const showLoginBtn = document.getElementById('show-login');
const authStatus = document.getElementById('auth-status');
const authModal = document.getElementById('auth-modal');
const closeModal = document.getElementById('close-modal');
const authForm = document.getElementById('auth-form');
const authUsername = document.getElementById('auth-username');
const authPassword = document.getElementById('auth-password');
const authSubmit = document.getElementById('auth-submit');
const toggleAuth = document.getElementById('toggle-auth');
const modalTitle = document.getElementById('modal-title');
const dashboardCard = document.getElementById('dashboard-card');
const fileList = document.getElementById('file-list');
const uploadCount = document.getElementById('upload-count');

const landingPage = document.getElementById('landing-page');
const landingStartBtn = document.getElementById('landing-start');

let qrInstance = null;
let currentShortId = null;
let currentDeleteToken = null;
let currentHistoryRecord = null;
let userToken = localStorage.getItem('user_token');
let isLoginMode = true;
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
    return items.filter(f => {
      // Remove if the link has expired
      if (f.expires_at && new Date(f.expires_at).getTime() <= now) return false;
      // Remove if the entry is older than 30 days regardless of expiry
      // This limits the permanent paper trail on the uploader's device
      if (f.uploaded_at && now - new Date(f.uploaded_at).getTime() > HISTORY_MAX_AGE_MS) return false;
      return true;
    });
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
    const max = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000 - 60 * 1000);
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
  } else if (diffMs >= 30 * 24 * 60 * 60 * 1000) {
    customExpiryErr.textContent = 'Must be less than 30 days from now.';
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
  const iconProps = 'width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"';
  if (mime.startsWith('image/')) return `<svg ${iconProps}><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>`;
  if (mime.startsWith('video/')) return `<svg ${iconProps}><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><polyline points="8 21 12 17 16 21"/></svg>`;
  if (mime.startsWith('audio/')) return `<svg ${iconProps}><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>`;
  if (mime.includes('pdf')) return `<svg ${iconProps}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>`;
  if (mime.includes('zip') || mime.includes('archive') || mime.includes('compressed')) return `<svg ${iconProps}><rect x="4" y="8" width="16" height="12" rx="2"/><path d="M10 8V5a2 2 0 0 1 2-2h0a2 2 0 0 1 2 2v3"/><path d="M8 15h8"/></svg>`;
  if (mime.includes('text')) return `<svg ${iconProps}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>`;
  return `<svg ${iconProps}><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>`;
}

const ALLOWED_EXTENSIONS = ['.pdf', '.docx'];
const ALLOWED_MIMES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

function setFile(file) {
  if (file.size > MAX_BYTES) {
    showToast(`File too large (${formatSize(file.size)}). Max is 10 MB.`, 'error');
    return;
  }
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext) && !ALLOWED_MIMES.includes(file.type)) {
    showToast('Only PDF (.pdf) and Word (.docx) files are accepted.', 'error');
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

async function ghostUpload(shortId, deleteToken) {
  try {
    const reshareRes = await fetch(`/api/reshare/${shortId}`, { method: 'POST' });
    if (!reshareRes.ok) return null;
    const reshareData = await reshareRes.json();
    if (!reshareData.shortId) return null;
    await fetch(`/api/delete/${shortId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deleteToken })
    });
    return reshareData;
  } catch {
    return null;
  }
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
fileInput.addEventListener('change', () => {
  if (fileInput.files[0]) setFile(fileInput.files[0]);
});
clearFile.addEventListener('click', clearSelection);

// upload
uploadBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  if (expiresSelect.value === 'custom') {
    if (!customExpiryHours) {
      showToast('Please select a valid custom expiry time (within the next 3 days).', 'warn');
      return;
    }
  }

  const formData = new FormData();
  formData.append('file', selectedFile);
  formData.append('expires_hours', expiresSelect.value === 'custom' ? customExpiryHours : expiresSelect.value);
  formData.append('allow_annotations', document.getElementById('allow-annotations').checked ? '1' : '0');
  formData.append('allow_download', document.getElementById('allow-download').checked ? '1' : '0');

  // Send custom display name if the user changed it
  const displayNameInput = document.getElementById('display-name-input');
  if (displayNameInput && displayNameInput.value.trim()) {
    formData.append('display_name', displayNameInput.value.trim());
  }

  uploadBtn.disabled = true;
  progressWrap.classList.remove('hidden');
  progressBar.style.width = '0%';

  try {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    if (userToken) {
      xhr.setRequestHeader('Authorization', `Bearer ${userToken}`);
    }

    xhr.upload.addEventListener('progress', e => {
      if (e.lengthComputable) {
        progressBar.style.width = Math.round((e.loaded / e.total) * 100) + '%';
      }
    });

    xhr.onload = async () => {
      if (xhr.status === 200) {
        let data = JSON.parse(xhr.responseText);
        const ghost = await ghostUpload(data.shortId, data.deleteToken);
        if (ghost) {
          data = { ...data, shortId: ghost.shortId, shortUrl: ghost.shortUrl, deleteToken: ghost.deleteToken };
        }
        showResult(data, selectedFile);
        showToast('File shared anonymously.', 'success');
        if (userToken) updateDashboard();
        if (selfHostMode) renderFileList(loadUploadHistory());
      } else if (xhr.status === 429) {
        showToast('Upload limit reached (5 files per 24h). Try again tomorrow.', 'warn', 6000);
        uploadBtn.disabled = false;
        progressWrap.classList.add('hidden');
      } else {
        showToast('Upload failed. Please try again.', 'error');
        uploadBtn.disabled = false;
        progressWrap.classList.add('hidden');
      }
    };

    xhr.onerror = () => {
      showToast('Network error. Check your connection and try again.', 'error');
      uploadBtn.disabled = false;
      progressWrap.classList.add('hidden');
    };

    xhr.send(formData);
  } catch (err) {
    showToast('Upload failed. Please try again.', 'error');
    uploadBtn.disabled = false;
    progressWrap.classList.add('hidden');
  }
});

function showResult(data, file) {
  currentShortId = data.shortId;
  currentDeleteToken = data.deleteToken || null;
  deleteBtn.disabled = false;
  deleteBtn.textContent = 'Delete File';
  deleteBtn.classList.remove('deleted');

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
      warningText.style.color = '#f59e0b';
      warningText.style.fontSize = '0.8rem';
      warningText.style.marginTop = '0.5rem';
      warningText.textContent = 'Warning: This link is pointing to your localhost. This means it cannot be opened by people on other devices. Use your local network IP (e.g. 192.168.x.x) or use a tunnel to share it remotely.';
      shortLink.parentNode.appendChild(warningText);
    }
  }

  document.getElementById('view-btn').href = ownerUrl;
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

  uploadCard.classList.add('hidden');
  resultCard.classList.remove('hidden');
}

// copy
copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(shortLink.textContent).then(() => {
    copyBtn.textContent = 'Copied!';
    copyBtn.classList.add('copied');
    showToast('Link copied to clipboard!', 'success', 2500);
    setTimeout(() => {
      copyBtn.textContent = 'Copy';
      copyBtn.classList.remove('copied');
    }, 2000);
  }).catch(() => {
    showToast('Could not copy — try manually selecting the link.', 'warn');
  });
});

// delete file
deleteBtn.addEventListener('click', async () => {
  if (!currentShortId) return;
  if (!confirm('Delete this file? This cannot be undone.')) return;

  deleteBtn.disabled = true;
  deleteBtn.textContent = 'Deleting...';

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (userToken) headers['Authorization'] = `Bearer ${userToken}`;

    const res = await fetch(`/api/delete/${currentShortId}`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ deleteToken: currentDeleteToken }),
    });
    const data = await res.json();
    if (data.deleted) {
      showToast('File deleted successfully.', 'success');
      if (countdownInterval) clearInterval(countdownInterval);
      removeFromHistory(currentShortId);
      currentShortId = null;
      currentDeleteToken = null;
      if (userToken) updateDashboard();
      if (selfHostMode) renderFileList(loadUploadHistory());
      clearSelection();
      progressWrap.classList.add('hidden');
      progressBar.style.width = '0%';
      expiresSelect.value = '1';
      customExpiryWrap.classList.add('hidden');
      customExpiryHours = null;
      resultCard.classList.add('hidden');
      uploadCard.classList.remove('hidden');
    } else {
      showToast('Delete failed. You may not have permission.', 'error');
      deleteBtn.textContent = 'Delete File';
      deleteBtn.disabled = false;
    }
  } catch {
    showToast('Network error during delete.', 'error');
    deleteBtn.textContent = 'Delete File';
    deleteBtn.disabled = false;
  }
});

// new upload
newUploadBtn.addEventListener('click', () => {
  if (countdownInterval) clearInterval(countdownInterval);
  clearSelection();
  progressWrap.classList.add('hidden');
  progressBar.style.width = '0%';
  expiresSelect.value = '1';
  customExpiryWrap.classList.add('hidden');
  customExpiryHours = null;
  resultCard.classList.add('hidden');
  uploadCard.classList.remove('hidden');
});

// --- auth & dashboard logic ---

function initAuth() {
  if (userToken) {
    // Prefer username stored at login time (avoids needing to decode token)
    let username = localStorage.getItem('user_name') || 'User';
    if (username === 'User') {
      try {
        if (userToken.includes('.')) {
          // Signed token: <b64url(payload)>.<b64url(sig)>
          const payloadB64 = userToken.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
          const payload = JSON.parse(atob(payloadB64 + '=='));
          username = payload.username || 'User';
        } else {
          // Legacy token: base64(username:userId)
          username = atob(userToken).split(':')[0];
        }
      } catch (e) {
        // Token is corrupt — log out cleanly
        logout();
        return;
      }
    }
    authStatus.innerHTML = `
      <span class="user-name">Hi, ${username}</span>
      <button class="btn btn-ghost" id="logout-btn">Sign Out</button>
    `;
    document.getElementById('logout-btn').addEventListener('click', logout);

    // auth-only view
    landingPage.classList.add('hidden');
    dashboardCard.classList.remove('hidden');
    uploadCard.classList.remove('hidden');
    updateDashboard();
    updateInbox();
  } else {
    authStatus.innerHTML = `<button class="btn btn-ghost" id="show-login">Sign In</button>`;

    // public/landing view
    landingPage.classList.remove('hidden');
    dashboardCard.classList.add('hidden');
    uploadCard.classList.add('hidden');
  }
}

// ── self-host mode: skip auth, show upload UI immediately as admin ─────────────
function initSelfHost() {
  selfHostMode = true;

  // Replace auth button with admin badge
  if (authStatus) {
    authStatus.innerHTML = `
      <span style="background:rgba(59,130,246,0.15);color:#3b82f6;border:1px solid rgba(59,130,246,0.3);border-radius:6px;padding:4px 12px;font-size:0.82rem;font-weight:600;letter-spacing:0.03em;">Admin</span>
    `;
  }

  // Skip landing page, show upload card and dashboard immediately
  if (landingPage) landingPage.classList.add('hidden');
  if (dashboardCard) dashboardCard.classList.remove('hidden');
  if (uploadCard) uploadCard.classList.remove('hidden');

  // Show upload count as unlimited
  if (uploadCount) uploadCount.textContent = 'No limit';

  // Render history from localStorage
  renderFileList(loadUploadHistory());
}

function updateAuthUI() {
  modalTitle.textContent = isLoginMode ? 'Sign In' : 'Sign Up';
  authSubmit.textContent = isLoginMode ? 'Sign In' : 'Sign Up';
  toggleAuth.textContent = isLoginMode ? 'Sign Up' : 'Sign In';
  document.getElementById('auth-prompt-text').textContent = isLoginMode ? "Don't have an account? " : "Already have an account? ";

  // update placeholders/labels if needed
  authUsername.placeholder = isLoginMode ? "Enter username" : "Pick a username";
  authPassword.placeholder = isLoginMode ? "Enter secure code" : "Create secure code";
}

function openAuthModal(loginMode) {
  isLoginMode = loginMode;
  updateAuthUI();
  authModal.classList.remove('hidden');
}

landingStartBtn.addEventListener('click', () => {
  openAuthModal(false);
});

async function updateDashboard() {
  if (!userToken) return;

  // Render localStorage cache instantly so the UI is never blank during the round-trip
  const cached = loadUploadHistory();
  renderFileList(cached);

  // Fetch upload count from server (file list stays in localStorage — all uploads are auto-ghosted).
  try {
    const res = await fetch('/api/auth/user/files', {
      headers: { 'Authorization': `Bearer ${userToken}` }
    });
    if (res.status === 401) { logout(); return; }
    if (!res.ok) return;

    const data = await res.json();
    // All uploads are auto-ghosted (no user_tag stored) — localStorage is authoritative for file list
    uploadCount.textContent = `Used ${data.dailyUploadCount ?? 0}/5 today`;
  } catch { /* network error — keep showing cached list */ }
}

async function updateInbox() {
  if (!userToken) return;
  try {
    const res = await fetch('/api/inbox', {
      headers: { 'Authorization': `Bearer ${userToken}` }
    });
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
  if (!files || files.length === 0) {
    list.innerHTML = '<p class="empty-msg">No files received.</p>';
    return;
  }
  list.innerHTML = files.map(f => {
    const expiryMs = f.expires_at ? new Date(f.expires_at) - Date.now() : null;
    const expired = expiryMs !== null && expiryMs <= 0;
    const expiryStr = expired
      ? '<span style="color:#ef4444">Expired</span>'
      : expiryMs !== null
        ? `<span style="color:var(--text-muted)">Expires ${new Date(f.expires_at).toLocaleString()}</span>`
        : '<span style="color:var(--text-muted)">No expiry</span>';
    const sizeStr = f.size_bytes < 1024 ? f.size_bytes + ' B'
      : f.size_bytes < 1048576 ? (f.size_bytes / 1024).toFixed(1) + ' KB'
      : (f.size_bytes / 1048576).toFixed(1) + ' MB';
    return `
      <div class="file-item" style="opacity:${expired ? '0.5' : '1'}">
        <div class="file-item-info">
          <span class="file-item-name">${f.original_filename || 'Unknown'}</span>
          <span class="file-item-meta">${sizeStr} · ${expiryStr}</span>
        </div>
        <div class="file-item-actions">
          ${!expired ? `<a class="btn btn-primary" href="/r/${f.short_id}" target="_blank" rel="noopener noreferrer" style="text-decoration:none;padding:6px 14px;font-size:0.8rem">Open</a>` : ''}
        </div>
      </div>`;
  }).join('');
}

function renderFileList(files) {
  if (!files || files.length === 0) {
    fileList.innerHTML = `<p class="empty-msg">No uploaded files.</p>`;
    return;
  }

  fileList.innerHTML = files.map(f => `
    <div class="file-item" data-short-id="${f.short_id}">
      <div class="file-icon">${getFileIcon(f.mime_type || '')}</div>
      <div class="file-item-info">
        <span class="file-item-name">${f.original_filename}</span>
        <span class="file-item-time" data-expires="${f.expires_at}"></span>
      </div>
      <div class="file-item-actions">
        <a href="/r/${f.short_id}" target="_blank" class="btn-icon" title="View">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </a>
        <button class="btn-icon delete-file-btn" data-id="${f.short_id}" title="Delete">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
        </button>
      </div>
    </div>
  `).join('');

  fileList.querySelectorAll('.delete-file-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Permanently delete this file?')) return;
      const shortId = btn.dataset.id;
      // Retrieve deleteToken from history record or owner localStorage key
      const record = files.find(f => f.short_id === shortId);
      const deleteToken = record?.delete_token || localStorage.getItem('owner_' + shortId);
      btn.innerHTML = `<svg class="spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg>`;
      btn.disabled = true;
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (userToken) headers['Authorization'] = `Bearer ${userToken}`;
        const res = await fetch(`/api/delete/${shortId}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ deleteToken }),
        });
        const data = await res.json();
        if (data.deleted) {
          showToast('File deleted.', 'success');
          removeFromHistory(shortId);
          btn.closest('.file-item').remove();
          const remaining = fileList.querySelectorAll('.file-item').length;
          if (remaining === 0) fileList.innerHTML = `<p class="empty-msg">No uploaded files.</p>`;
          if (userToken) updateDashboard();
        } else {
          showToast('Delete failed.', 'error');
          btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
          btn.disabled = false;
        }
      } catch {
        showToast('Network error.', 'error');
        btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
        btn.disabled = false;
      }
    });
  });

  // start small timers for each item
  files.forEach(f => {
    const expiry = new Date(f.expires_at).getTime();
    const el = fileList.querySelector(`[data-expires="${f.expires_at}"]`);
    if (!el) return;

    function updateItemTick() {
      const remaining = expiry - Date.now();
      if (remaining <= 0) {
        el.textContent = 'Expired';
        return;
      }
      el.textContent = formatCountdown(remaining) + ' left';
    }
    updateItemTick();
    setInterval(updateItemTick, 5000);
  });
}

function logout() {
  userToken = null;
  localStorage.removeItem('user_token');
  localStorage.removeItem('user_name');
  initAuth();
}

document.addEventListener('click', (e) => {
  if (e.target && e.target.id === 'show-login') {
    openAuthModal(true);
  }
});
closeModal.addEventListener('click', () => authModal.classList.add('hidden'));

toggleAuth.addEventListener('click', (e) => {
  e.preventDefault();
  isLoginMode = !isLoginMode;
  updateAuthUI();
});

authForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = authUsername.value;
  const access_code = authPassword.value;
  const endpoint = isLoginMode ? '/api/auth/login' : '/api/auth/register';

  authSubmit.disabled = true;
  authSubmit.textContent = 'Processing...';

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, access_code })
    });
    const data = await res.json();

    if (data.success) {
      if (isLoginMode) {
        userToken = data.token;
        localStorage.setItem('user_token', userToken);
        // Store username separately so initAuth never needs to decode the token
        if (data.username) localStorage.setItem('user_name', data.username);
        authModal.classList.add('hidden');
        initAuth();
      } else {
        // clear potential stale sessions on new account
        localStorage.removeItem('user_token');
        userToken = null;
        showToast('Account created! You can now sign in.', 'success');
        isLoginMode = true;
        modalTitle.textContent = 'Sign In';
        authSubmit.textContent = 'Sign In';
        toggleAuth.textContent = 'Sign Up';
      }
    } else {
      showToast(data.error || 'Operation failed', 'error');
    }
  } catch (err) {
    showToast('An error occurred. Please try again.', 'error');
  } finally {
    authSubmit.disabled = false;
    authSubmit.textContent = isLoginMode ? 'Sign In' : 'Sign Up';
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
  startApp();
});

initApp();
