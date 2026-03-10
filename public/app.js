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
const qrCanvasEl = document.getElementById('qr-canvas');
const saveQrBtn = document.getElementById('save-qr-btn');

// --- Auth & Dashboard Elements ---
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

  // Show the owner's direct URL — same link they'll view the file at
  const ownerUrl = data.shortUrl;
  shortLink.textContent = ownerUrl;
  document.getElementById('view-btn').href = ownerUrl;
  // Store delete token so the viewer tab recognizes this browser as the owner
  if (data.deleteToken) {
    localStorage.setItem('owner_' + data.shortId, data.deleteToken);
  }
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

// Delete file
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
      deleteBtn.textContent = 'Deleted';
      deleteBtn.classList.add('deleted');
      shortLink.textContent = '(deleted)';
      document.getElementById('view-btn').removeAttribute('href');
      if (countdownInterval) clearInterval(countdownInterval);
      resultExpires.textContent = 'File deleted';
      resultExpires.style.color = '#ef4444';
      if (userToken) updateDashboard();
    } else {
      deleteBtn.textContent = 'Failed';
      deleteBtn.disabled = false;
    }
  } catch {
    deleteBtn.textContent = 'Error';
    deleteBtn.disabled = false;
  }
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

// --- Auth & Dashboard Logic ---

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

    // Auth-only view
    landingPage.classList.add('hidden');
    dashboardCard.classList.remove('hidden');
    uploadCard.classList.remove('hidden');
    updateDashboard();
  } else {
    authStatus.innerHTML = `<button class="btn btn-ghost" id="show-login">Sign In</button>`;
    document.getElementById('show-login').addEventListener('click', () => authModal.classList.remove('hidden'));

    // Public/Landing view
    landingPage.classList.remove('hidden');
    dashboardCard.classList.add('hidden');
    uploadCard.classList.add('hidden');
  }
}

landingStartBtn.addEventListener('click', () => {
  authModal.classList.remove('hidden');
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
      uploadCount.textContent = `Used ${data.files.length}/5 today`;
    } else {
      renderFileList([]);
      uploadCount.textContent = `Used 0/5 today`;
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
        <a href="/r/${f.short_id}" target="_blank" class="btn-icon" title="View">👁️</a>
        <button class="btn-icon delete-file-btn" data-id="${f.short_id}" title="Delete">🗑️</button>
      </div>
    </div>
  `).join('');

  fileList.querySelectorAll('.delete-file-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('Permanently delete this file?')) return;
      const shortId = btn.dataset.id;
      btn.textContent = '⏳';
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
          uploadCount.textContent = `Used ${remaining}/5 today`;
        } else {
          btn.textContent = '🗑️';
          btn.disabled = false;
        }
      } catch {
        btn.textContent = '🗑️';
        btn.disabled = false;
      }
    });
  });

  // Start small timers for each item
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

showLoginBtn.addEventListener('click', () => authModal.classList.remove('hidden'));
closeModal.addEventListener('click', () => authModal.classList.add('hidden'));

toggleAuth.addEventListener('click', (e) => {
  e.preventDefault();
  isLoginMode = !isLoginMode;
  modalTitle.textContent = isLoginMode ? 'Sign In' : 'Sign Up';
  authSubmit.textContent = isLoginMode ? 'Sign In' : 'Sign Up';
  toggleAuth.textContent = isLoginMode ? 'Sign Up' : 'Sign In';
  document.getElementById('auth-prompt-text').textContent = isLoginMode ? "Don't have an account? " : "Already have an account? ";
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
        // Clear potential stale sessions on new account
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
