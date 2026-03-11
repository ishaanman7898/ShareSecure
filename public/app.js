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
let userToken = localStorage.getItem('user_token');
let isLoginMode = true;
let customExpiryHours = null;

function toLocalDatetimeString(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

expiresSelect.addEventListener('change', () => {
  if (expiresSelect.value === 'custom') {
    customExpiryWrap.classList.remove('hidden');
    const now = new Date();
    const max = new Date(now.getTime() + 24 * 60 * 60 * 1000 - 60 * 1000);
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
  } else if (diffMs >= 24 * 60 * 60 * 1000) {
    customExpiryErr.textContent = 'Must be less than 24 hours from now.';
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

function setFile(file) {
  if (file.size > MAX_BYTES) {
    alert(`File is too large (${formatSize(file.size)}). Max allowed is 10 MB.`);
    return;
  }
  selectedFile = file;
  fileName.textContent = file.name;
  fileSize.textContent = formatSize(file.size);
  document.getElementById('file-icon').innerHTML = getFileIcon(file.type);
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
      alert('Please select a valid custom expiry time (within the next 24 hours).');
      return;
    }
  }

  const formData = new FormData();
  formData.append('file', selectedFile);
  formData.append('expires_hours', expiresSelect.value === 'custom' ? customExpiryHours : expiresSelect.value);
  formData.append('allow_annotations', document.getElementById('allow-annotations').checked ? '1' : '0');
  formData.append('allow_download', document.getElementById('allow-download').checked ? '1' : '0');

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

    xhr.onload = () => {
      if (xhr.status === 200) {
        const data = JSON.parse(xhr.responseText);
        showResult(data, selectedFile);
        if (userToken) updateDashboard();
      } else if (xhr.status === 429) {
        alert('Upload limit reached (5 files per 24h).');
        uploadBtn.disabled = false;
        progressWrap.classList.add('hidden');
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
  currentShortId = data.shortId;
  currentDeleteToken = data.deleteToken || null;
  deleteBtn.disabled = false;
  deleteBtn.textContent = 'Delete File';
  deleteBtn.classList.remove('deleted');

  // show the owner's direct url — same link they'll view the file at
  const ownerUrl = data.shortUrl;
  shortLink.textContent = ownerUrl;
  document.getElementById('view-btn').href = ownerUrl;
  // store delete token so the viewer tab recognizes this browser as the owner
  if (data.deleteToken) {
    localStorage.setItem('owner_' + data.shortId, data.deleteToken);
  }
  resultFilename.textContent = file.name;
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
    setTimeout(() => {
      copyBtn.textContent = 'Copy';
      copyBtn.classList.remove('copied');
    }, 2000);
  });
});

// delete file
deleteBtn.addEventListener('click', async () => {
  if (!currentShortId) return;
  if (!confirm('Permanently delete this file for everyone? This cannot be undone.')) return;

  deleteBtn.disabled = true;
  deleteBtn.textContent = 'Deleting...';

  try {
    const headers = { 'Content-Type': 'application/json' };
    if (userToken) headers['Authorization'] = `Bearer ${userToken}`;

    const res = await fetch(`/api/delete/${currentShortId}`, { method: 'POST', headers });
    const data = await res.json();
    if (data.deleted) {
      if (countdownInterval) clearInterval(countdownInterval);
      if (userToken) updateDashboard();
      resultCard.innerHTML = `
        <div class="result-icon" style="background:rgba(239,68,68,0.1);color:#ef4444;">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
          </svg>
        </div>
        <p class="result-label">File deleted</p>
        <p style="font-size:0.85rem;color:var(--text-muted);">This file has been permanently removed.</p>
        <button class="btn btn-primary btn-full" id="post-delete-upload-btn">Upload a New File</button>
      `;
      document.getElementById('post-delete-upload-btn').addEventListener('click', () => {
        clearSelection();
        progressWrap.classList.add('hidden');
        progressBar.style.width = '0%';
        expiresSelect.value = '1';
        customExpiryWrap.classList.add('hidden');
        customExpiryHours = null;
        resultCard.classList.add('hidden');
        uploadCard.classList.remove('hidden');
      });
    } else {
      deleteBtn.textContent = 'Failed';
      deleteBtn.disabled = false;
    }
  } catch {
    deleteBtn.textContent = 'Error';
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
    let username = 'User';
    try {
      username = atob(userToken).split(':')[0];
    } catch (e) {
      logout();
      return;
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
  } else {
    authStatus.innerHTML = `<button class="btn btn-ghost" id="show-login">Sign In</button>`;

    // public/landing view
    landingPage.classList.remove('hidden');
    dashboardCard.classList.add('hidden');
    uploadCard.classList.add('hidden');
  }
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
  try {
    const res = await fetch('/api/auth/user/files', {
      headers: { 'Authorization': `Bearer ${userToken}` }
    });

    if (res.status === 401) {
      logout();
      return;
    }

    if (!res.ok) {
      console.error('Failed to load dashboard:', res.status);
      renderFileList([]);
      return;
    }

    const data = await res.json();

    if (data.files && Array.isArray(data.files)) {
      renderFileList(data.files);
      uploadCount.textContent = `Used ${data.dailyUploadCount ?? data.files.length}/5 today`;
    } else {
      renderFileList([]);
      uploadCount.textContent = `Used ${data.dailyUploadCount ?? 0}/5 today`;
    }
  } catch (err) {
    console.error('Failed to fetch user files', err);
    renderFileList([]);
  }
}

function renderFileList(files) {
  if (!files || files.length === 0) {
    fileList.innerHTML = `<p class="empty-msg">You haven't uploaded any files today.</p>`;
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
      btn.innerHTML = `<svg class="spin" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="2" x2="12" y2="6"/><line x1="12" y1="18" x2="12" y2="22"/><line x1="4.93" y1="4.93" x2="7.76" y2="7.76"/><line x1="16.24" y1="16.24" x2="19.07" y2="19.07"/><line x1="2" y1="12" x2="6" y2="12"/><line x1="18" y1="12" x2="22" y2="12"/><line x1="4.93" y1="19.07" x2="7.76" y2="16.24"/><line x1="16.24" y1="7.76" x2="19.07" y2="4.93"/></svg>`;
      btn.disabled = true;
      try {
        const res = await fetch(`/api/delete/${shortId}`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${userToken}` }
        });
        const data = await res.json();
        if (data.deleted) {
          btn.closest('.file-item').remove();
          const remaining = fileList.querySelectorAll('.file-item').length;
          if (remaining === 0) fileList.innerHTML = `<p class="empty-msg">You haven't uploaded any files today.</p>`;
          updateDashboard();
        } else {
          btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
          btn.disabled = false;
        }
      } catch {
        btn.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
        btn.disabled = false;
      }
    });
  });

  // start small timers for each item
  files.forEach(f => {
    const expiry = new Date(f.expires_at).getTime();
    const el = fileList.querySelector(`[data-expires="${f.expires_at}"]`);

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
        authModal.classList.add('hidden');
        initAuth();
      } else {
        // clear potential stale sessions on new account
        localStorage.removeItem('user_token');
        userToken = null;
        alert('Account created! You can now sign in.');
        isLoginMode = true;
        modalTitle.textContent = 'Sign In';
        authSubmit.textContent = 'Sign In';
        toggleAuth.textContent = 'Sign Up';
      }
    } else {
      alert(data.error || 'Operation failed');
    }
  } catch (err) {
    alert('An error occurred');
  } finally {
    authSubmit.disabled = false;
    authSubmit.textContent = isLoginMode ? 'Sign In' : 'Sign Up';
  }
});

initAuth();
