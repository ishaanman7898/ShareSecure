// Inside the desktop app, hide links to download or self-host ShareSecure.
if (/ShareSecureDesktop\//.test(navigator.userAgent)) document.documentElement.classList.add('is-desktop');

// The zero-knowledge prover and the QR code library are only needed when you
// upload, so they load on first use instead of slowing down every page.
let zkModule = null;
const loadZK = () => (zkModule ??= import('/zk-client.js'));
const hasZKCredentials = () => {
  try { return Boolean(localStorage.getItem('zk_secret') && localStorage.getItem('zk_commitment')); } catch { return false; }
};

let qrScript = null;
function loadQRCode() {
  return (qrScript ??= new Promise((resolve, reject) => {
    const el = document.createElement('script');
    el.src = '/qrcode.min.js';
    el.onload = resolve;
    el.onerror = reject;
    document.head.appendChild(el);
  }));
}

// ── html escaping for user-supplied strings (filenames, usernames) ──────────
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── landing rosette: guilloché bands like the ones printed on banknotes ───────
// Each band is its own layer, so turning it is a cheap GPU rotation instead
// of redrawing thousands of path points every frame.
const SVG_NS = 'http://www.w3.org/2000/svg';

function drawRosette() {
  const host = document.getElementById('rosette');
  if (!host || host.childElementCount) return;
  const C = 200, STEPS = 480;
  // each band is a set of phase-shifted sine rings woven around a base radius
  const bands = [
    { base: 172, amp: 12, k: 24, n: 9,  cls: 'band-1' },
    { base: 132, amp: 18, k: 16, n: 10, cls: 'band-2' },
    { base: 88,  amp: 20, k: 12, n: 9,  cls: 'band-3' },
    { base: 44,  amp: 16, k: 8,  n: 7,  cls: 'band-4' },
  ];
  const rings = bands.map((b, bi) => {
    // the outer div follows the cursor; the svg inside turns slowly on its own
    const ring = document.createElement('div');
    ring.className = 'ring';
    ring.style.setProperty('--bloom-delay', `${(3 - bi) * 0.12}s`);
    ring.style.setProperty('--breathe-delay', `${bi * -2}s`);
    const bloom = document.createElement('div');
    bloom.className = 'ring-bloom';
    const drift = document.createElement('div');
    drift.className = 'ring-drift';
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 400 400');
    svg.setAttribute('class', `ring-spin ring-spin-${bi + 1}`);
    for (let i = 0; i < b.n; i++) {
      const phase = (i / b.n) * Math.PI * 2;
      let d = '';
      for (let s = 0; s <= STEPS; s++) {
        const t = (s / STEPS) * Math.PI * 2;
        const r = b.base + b.amp * Math.sin(b.k * t + phase) * Math.cos(t * 2 + phase / 3);
        d += (s ? 'L' : 'M') + (C + r * Math.cos(t)).toFixed(2) + ' ' + (C + r * Math.sin(t)).toFixed(2);
      }
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', d + 'Z');
      path.setAttribute('pathLength', '1');
      path.setAttribute('class', b.cls);
      path.style.setProperty('--d', ((3 - bi) * 0.12 + i * 0.025).toFixed(2) + 's');
      svg.appendChild(path);
    }
    drift.appendChild(svg);
    bloom.appendChild(drift);
    ring.appendChild(bloom);
    host.appendChild(ring);
    return ring;
  });
  followPointer(host, rings);
}

// Ease each band toward the pointer with a little depth. Time-based damping
// keeps the response consistent across refresh rates; stop once it settles.
function followPointer(host, rings) {
  const motion = matchMedia('(prefers-reduced-motion: no-preference)');
  const pointer = matchMedia('(hover: hover) and (pointer: fine)');
  const art = host.closest('.landing-art');
  const RATIO = [-0.15, 0.25, -0.4, 0.6];
  const rot = rings.map(() => 0);
  let dial = 0, last = null, frame = 0, previousTime = 0;
  let targetX = 0, targetY = 0, x = 0, y = 0, visible = true;

  function step(time) {
    const dt = previousTime ? Math.min(time - previousTime, 50) : 16.67;
    previousTime = time;
    const ease = 1 - Math.exp(-dt / 150);
    x += (targetX - x) * ease;
    y += (targetY - y) * ease;
    let moving = false;
    rings.forEach((ring, i) => {
      const diff = dial * RATIO[i] - rot[i];
      if (Math.abs(diff) > 0.02) { rot[i] += diff * ease; moving = true; }
      else rot[i] += diff;
      const depth = 3 + i * 2;
      ring.style.transform = `translate3d(${(x * depth).toFixed(3)}px, ${(y * depth).toFixed(3)}px, 0) rotate(${rot[i].toFixed(3)}deg)`;
    });
    moving ||= Math.abs(targetX - x) + Math.abs(targetY - y) > 0.001;
    frame = moving ? requestAnimationFrame(step) : 0;
    if (!moving) previousTime = 0;
  }

  function start() {
    if (!frame && motion.matches && pointer.matches && visible && !document.hidden) {
      frame = requestAnimationFrame(step);
    }
  }

  function resetPointer() {
    last = null;
    targetX = targetY = 0;
    start();
  }

  function syncMotion() {
    const paused = !visible || document.hidden || !motion.matches;
    host.classList.toggle('is-paused', paused);
    if (paused || !pointer.matches) {
      cancelAnimationFrame(frame);
      frame = previousTime = 0;
      last = null;
      targetX = targetY = x = y = dial = 0;
      rot.fill(0);
      rings.forEach(ring => { ring.style.transform = ''; });
    }
  }

  art.addEventListener('pointermove', e => {
    if (!motion.matches || !pointer.matches || !visible || document.hidden || e.pointerType === 'touch') return;
    const r = host.getBoundingClientRect();
    if (!r.width) return;
    const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
    targetX = Math.max(-1, Math.min(1, dx / (r.width / 2)));
    targetY = Math.max(-1, Math.min(1, dy / (r.height / 2)));
    start();
    // near the middle the angle swings wildly, so ignore it there
    if (Math.hypot(dx, dy) < r.width * 0.15) { last = null; return; }
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    if (last !== null) {
      let delta = angle - last;
      if (delta > 180) delta -= 360; else if (delta < -180) delta += 360;
      dial += Math.max(-20, Math.min(20, delta));
    }
    last = angle;
  });
  art.addEventListener('pointerleave', resetPointer);
  art.addEventListener('pointercancel', resetPointer);
  motion.addEventListener('change', syncMotion);
  pointer.addEventListener('change', syncMotion);
  document.addEventListener('visibilitychange', syncMotion);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      syncMotion();
    }).observe(host);
  }
  syncMotion();
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
const sendToInput = document.getElementById('send-to-input');
const resultTitle = document.getElementById('result-title');
const resultSent = document.getElementById('result-sent');
const resultSendForm = document.getElementById('result-send-form');
const resultSendInput = document.getElementById('result-send-input');

// --- auth & dashboard elements ---
const dashboardCard = document.getElementById('dashboard-card');
const fileList = document.getElementById('file-list');

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

const ALLOWED_EXTENSIONS = ['.pdf', '.docx', '.png', '.jpg', '.jpeg', '.txt', '.md', '.markdown', '.csv'];
const ALLOWED_MIMES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'image/png',
  'image/jpeg',
  'text/plain',
  'text/markdown',
  'text/csv',
];

function setFile(file) {
  if (file.size > MAX_BYTES) {
    showToast(`File too large (${formatSize(file.size)}). Max is 10 MB.`, 'error');
    return;
  }
  const ext = file.name.slice(file.name.lastIndexOf('.')).toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext) && !ALLOWED_MIMES.includes(file.type)) {
    showToast('Only PDF, DOCX, PNG, JPG, TXT, MD and CSV files are accepted.', 'error');
    return;
  }
  selectedFile = file;
  // fetch what "Create link" needs while the person fills in the form
  loadQRCode().catch(() => {});
  if (userToken && hasZKCredentials()) loadZK().catch(() => {});
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
  updateUploadLabel();
}

// The button says what will happen: "Send" once there are names to send to.
function updateUploadLabel() {
  uploadBtn.textContent = sendToInput.value.trim() ? 'Send' : 'Create link';
}
sendToInput.addEventListener('input', updateUploadLabel);


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
function buildUploadForm() {
  const formData = new FormData();
  formData.append('file', selectedFile);
  formData.append('expires_hours', expiresSelect.value === 'custom' ? customExpiryHours : expiresSelect.value);
  formData.append('allow_annotations', document.getElementById('allow-annotations')?.checked ? '1' : '0');
  formData.append('allow_download', document.getElementById('allow-download').checked ? '1' : '0');
  formData.append('require_account', document.getElementById('require-account').checked ? '1' : '0');

  // Send custom display name if the user changed it
  const displayNameInput = document.getElementById('display-name-input');
  if (displayNameInput && displayNameInput.value.trim()) {
    formData.append('display_name', displayNameInput.value.trim());
  }
  return formData;
}

// Sends one upload and resolves with { status, body }. status is 0 if the
// server couldn't be reached.
function sendUpload(formData, withBearer) {
  return new Promise(resolve => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    if (withBearer && userToken) xhr.setRequestHeader('Authorization', `Bearer ${userToken}`);
    xhr.upload.addEventListener('progress', e => {
      if (e.lengthComputable) progressBar.style.width = Math.round((e.loaded / e.total) * 100) + '%';
    });
    xhr.onload = () => {
      let body = {};
      try { body = JSON.parse(xhr.responseText); } catch {}
      resolve({ status: xhr.status, body });
    };
    xhr.onerror = () => resolve({ status: 0, body: {} });
    xhr.send(formData);
  });
}

// Only a real 401 on the session means signed out; ask before logging anyone out.
async function sessionStillValid() {
  if (selfHostMode) return true;
  try {
    const res = await fetch('/api/auth/user/files', { headers: authHeaders() });
    return res.status !== 401;
  } catch {
    return true;
  }
}

function resetUploadButton() {
  uploadBtn.disabled = false;
  progressWrap.classList.add('hidden');
}

uploadBtn.addEventListener('click', async () => {
  if (!selectedFile) return;

  if (expiresSelect.value === 'custom') {
    if (!customExpiryHours) {
      showToast('Pick an expiry time within the next 10 days.', 'warn');
      return;
    }
  }

  // on this computer, sending to usernames needs a linked ShareSecure account
  const sendTo = sendToInput.value.trim();
  if (sendTo && selfHostMode && !cloudState.linked) {
    showToast('Link your ShareSecure account to send to usernames.', 'info', 5000);
    openCloudModal();
    return;
  }

  uploadBtn.disabled = true;
  progressWrap.classList.remove('hidden');
  progressBar.style.width = '0%';

  // Use the signed session. The experimental proof protocol is not a secure
  // authentication or anonymity boundary and has been disabled on the server.
  const result = await sendUpload(buildUploadForm(), true);

  if (result.status === 200) {
    const data = result.body;
    if (sendTo) uploadBtn.textContent = 'Sending…';
    const delivery = sendTo ? await sendToUsers(data.shortId, sendTo, data.deleteToken) : null;
    showResult(data, selectedFile, delivery);
    if (!delivery) showToast('Link created.', 'success');
    else if (delivery.sent.length) showToast('Sent.', 'success');
    // ready for the next file
    sendToInput.value = '';
    clearSelection();
    progressWrap.classList.add('hidden');
    if (userToken) updateDashboard();
    if (selfHostMode) renderFileList(loadUploadHistory());
  } else if (result.status === 401 && !(await sessionStillValid())) {
    showToast('Your session ended. Sign in again to upload.', 'warn', 6000);
    logout();
  } else if (result.status === 429) {
    showToast('Upload limit reached (5 files per 24h). Try again tomorrow.', 'warn', 6000);
    resetUploadButton();
  } else if (result.status === 0) {
    showToast('Couldn’t reach the server. Check your connection and try again.', 'error');
    resetUploadButton();
  } else {
    showToast(result.body.error ? `Upload failed: ${result.body.error}` : 'Upload failed. Try again.', 'error', 6000);
    resetUploadButton();
  }
});

function showResult(data, file, delivery) {
  // Determine the display name (custom name takes precedence over original filename)
  const displayNameInput = document.getElementById('display-name-input');
  const usedName = (displayNameInput && displayNameInput.value.trim())
    ? displayNameInput.value.trim()
    : file.name;

  // store delete token so the viewer tab recognizes this browser as the owner
  if (data.deleteToken) {
    localStorage.setItem('owner_' + data.shortId, data.deleteToken);
  }

  // Save full record to client-side dashboard history (no server-side user→file link)
  const record = {
    short_id:          data.shortId,
    short_url:         data.shortUrl,
    original_filename: usedName,
    mime_type:         file.type || 'application/octet-stream',
    size_bytes:        file.size,
    expires_at:        data.expiresAt,
    uploaded_at:       new Date().toISOString(),
    delete_token:      data.deleteToken || null,
  };
  saveUploadToHistory(record);

  // a new link opens in a new tab; one sent to people doesn't need to
  if (!delivery) window.open(data.shortUrl, '_blank', 'noopener,noreferrer');

  openResult(record, { delivery });
}

// The link for a share. On this computer, always the current public address
// (the tunnel's can change, and this page itself is on localhost); otherwise
// the one the server gave, or this site's own.
let publicBase = null;
function shareUrl(record) {
  const path = `/r/${encodeURIComponent(record.short_id)}`;
  if (selfHostMode && publicBase) return publicBase + path;
  return record.short_url || location.origin + path;
}

// A share's dialog: send it to people, copy the link, or show its QR code. It
// opens after an upload and from "Send" in Your shares.
let resultSentTo = [];
let resultDefaultTitle = 'Link created';
let resultSendSeq = 0;   // which opening of the dialog a send belongs to

function openResult(record, { delivery = null, title = 'Link created' } = {}) {
  currentShortId = record.short_id;
  currentHistoryRecord = record;
  currentDeleteToken = record.delete_token || null;
  if (!currentDeleteToken) {
    try { currentDeleteToken = localStorage.getItem('owner_' + record.short_id); } catch {}
  }

  const url = shareUrl(record);
  shortLink.textContent = url;
  shortLink.href = url;
  document.getElementById('open-link-btn').href = url;
  document.getElementById('localhost-warn').classList.toggle('hidden', !/\/\/(localhost|127\.0\.0\.1)[:/]/.test(url));

  resultFilename.textContent = record.original_filename || 'Untitled';
  resultSize.textContent = formatSize(record.size_bytes || 0);

  // live countdown
  if (countdownInterval) clearInterval(countdownInterval);
  startResultCountdown(record.expires_at);

  // generate qr entirely client-side — no third party ever sees the url
  qrCanvasEl.innerHTML = '';
  loadQRCode().then(() => {
    qrInstance = new QRCode(qrCanvasEl, {
      text: url, width: 200, height: 200,
      colorDark: '#000000', colorLight: '#ffffff',
      correctLevel: QRCode.CorrectLevel.M
    });
  }).catch(() => {});

  saveQrBtn.onclick = () => {
    const img = qrCanvasEl.querySelector('img') || qrCanvasEl.querySelector('canvas');
    const url = img.tagName === 'CANVAS' ? img.toDataURL('image/png') : img.src;
    const a = document.createElement('a');
    a.href = url; a.download = 'sharesecure-qr.png'; a.click();
  };

  resultSentTo = [];
  resultDefaultTitle = title;
  resultSent.innerHTML = '';
  resultSent.classList.add('hidden');
  resultSendInput.value = '';
  // a send still running for the share shown before doesn't belong to this one
  resultSendSeq++;
  const sendBtn = document.getElementById('result-send-btn');
  sendBtn.disabled = false;
  sendBtn.textContent = 'Send';
  if (delivery) showDelivery(delivery);
  updateResultTitle();

  resultCard.classList.remove('hidden');
}

function closeResult() {
  if (countdownInterval) clearInterval(countdownInterval);
  resultCard.classList.add('hidden');
}

// "@alice, @bob", or "@alice, @bob and 3 more"
function namesText(names) {
  const at = names.map(n => '@' + n);
  return at.length <= 3 ? at.join(', ') : `${at.slice(0, 2).join(', ')} and ${at.length - 2} more`;
}

function updateResultTitle() {
  resultTitle.textContent = resultSentTo.length ? `Sent to ${namesText(resultSentTo)}` : resultDefaultTitle;
}

// Adds who got it, and who didn't, to the dialog.
function showDelivery(d) {
  const lines = [];
  if (d.sent.length) lines.push(['is-ok', `Sent to ${namesText(d.sent)}. They’ll accept or decline it.`]);
  if (d.missing.length) lines.push(['is-bad', `There’s no user called ${namesText(d.missing)}.`]);
  for (const f of d.failed) lines.push(['is-bad', `Couldn’t send it to @${f.username}. ${f.reason}`]);
  for (const [cls, text] of lines) {
    const li = document.createElement('li');
    li.className = cls;
    li.textContent = text;
    resultSent.appendChild(li);
  }
  if (d.notLinked.length) {
    const li = document.createElement('li');
    li.className = 'is-bad';
    li.textContent = `Not sent to ${namesText(d.notLinked)}. Link your ShareSecure account to send to usernames. `;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'link-btn';
    btn.textContent = 'Link account';
    btn.addEventListener('click', () => openCloudModal({ resume: d.notLinked.map(n => '@' + n).join(', ') }));
    li.appendChild(btn);
    resultSent.appendChild(li);
  }
  resultSent.classList.toggle('hidden', !resultSent.childElementCount);
  resultSentTo.push(...d.sent.filter(n => !resultSentTo.includes(n)));
  updateResultTitle();
  // keep the names that didn't go through, so they can be fixed and sent again
  resultSendInput.value = [...d.missing, ...d.failed.map(f => f.username), ...d.notLinked].map(n => '@' + n).join(', ');
}

resultSendForm.addEventListener('submit', async e => {
  e.preventDefault();
  const input = resultSendInput.value.trim();
  if (!input || !currentShortId) return;
  if (selfHostMode && !cloudState.linked) { openCloudModal({ resume: input }); return; }
  const btn = document.getElementById('result-send-btn');
  btn.disabled = true;
  btn.textContent = 'Sending…';
  const seq = resultSendSeq;
  const d = await sendToUsers(currentShortId, input, currentDeleteToken);
  // the dialog was closed, or now shows another share: just say how it went
  if (seq !== resultSendSeq || resultCard.classList.contains('hidden')) {
    if (seq === resultSendSeq) { btn.disabled = false; btn.textContent = 'Send'; }
    const missed = [...d.missing, ...d.failed.map(f => f.username), ...d.notLinked];
    if (d.sent.length) showToast(`Sent to ${namesText(d.sent)}.`, 'success');
    if (missed.length) showToast(`Not sent to ${namesText(missed)}. Open the share and send again.`, 'warn', 6000);
    return;
  }
  showDelivery(d);
  btn.disabled = false;
  btn.textContent = 'Send';
});

// copy
copyBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(shortLink.textContent).then(() => {
    copyBtn.textContent = 'Copied';
    copyBtn.classList.add('copied');
    showToast('Link copied.', 'success', 2500);
    setTimeout(() => {
      copyBtn.textContent = 'Copy link';
      copyBtn.classList.remove('copied');
    }, 2000);
  }).catch(() => {
    showToast('Couldn’t copy. Select the link and copy it manually.', 'warn');
  });
});


document.getElementById('result-close-btn')?.addEventListener('click', closeResult);
document.getElementById('result-modal-backdrop')?.addEventListener('click', closeResult);

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

// ── profile menu: everything account-related lives behind the avatar ─────────
const profile = document.getElementById('profile');
const profileBtn = document.getElementById('profile-btn');
const profileMenu = document.getElementById('profile-menu');

function menuItems() {
  return [...profileMenu.querySelectorAll('.menu-item:not(.hidden):not(:disabled)')];
}

function openMenu(focusFirst) {
  profileMenu.classList.remove('hidden');
  profileBtn.setAttribute('aria-expanded', 'true');
  if (focusFirst) menuItems()[0]?.focus();
}

function closeMenu(returnFocus) {
  if (profileMenu.classList.contains('hidden')) return;
  profileMenu.classList.add('hidden');
  profileBtn.setAttribute('aria-expanded', 'false');
  if (returnFocus) profileBtn.focus();
}

profileBtn.addEventListener('click', () => {
  if (profileMenu.classList.contains('hidden')) openMenu(false);
  else closeMenu(false);
});

profileBtn.addEventListener('keydown', e => {
  if (e.key === 'ArrowDown') { e.preventDefault(); openMenu(true); }
});

profileMenu.addEventListener('keydown', e => {
  const items = menuItems();
  const i = items.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
  else if (e.key === 'Home') { e.preventDefault(); items[0]?.focus(); }
  else if (e.key === 'End') { e.preventDefault(); items[items.length - 1]?.focus(); }
  else if (e.key === 'Tab') closeMenu(false);
});

document.addEventListener('click', e => {
  if (!profile.contains(e.target)) closeMenu(false);
});

document.getElementById('menu-inbox').addEventListener('click', () => {
  closeMenu(false);
  const title = document.getElementById('inbox-title');
  title?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  title?.focus({ preventScroll: true });
});

document.getElementById('logout-btn').addEventListener('click', logout);
// Privacy and Terms open in a new window, so close the menu behind them
profileMenu.querySelectorAll('a.menu-item').forEach(a => a.addEventListener('click', () => closeMenu(false)));

// ── account dialogs ───────────────────────────────────────────────────────────
let modalReturnFocus = null;

function openModal(modal) {
  closeMenu(false);
  modalReturnFocus = profileBtn;
  modal.classList.remove('hidden');
  (modal.querySelector('input') || modal.querySelector('button:not([data-close])'))?.focus();
}

function closeModal(modal) {
  if (modal.classList.contains('hidden')) return;
  modal.classList.add('hidden');
  modalReturnFocus?.focus();
  // linked or not, go back to the share the link dialog was opened from
  if (modal === cloudModal) resumeResult();
}

for (const modal of document.querySelectorAll('[data-dialog]')) {
  modal.addEventListener('click', e => {
    if (e.target === modal || e.target.closest('[data-close]')) closeModal(modal);
  });
}

// copy buttons point at the element whose text they copy
document.addEventListener('click', e => {
  const btn = e.target.closest('[data-copy]');
  if (!btn) return;
  navigator.clipboard.writeText(document.getElementById(btn.dataset.copy).textContent)
    .then(() => {
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = 'Copy'; }, 1800);
    })
    .catch(() => showToast('Couldn’t copy. Select the text and copy it manually.', 'warn'));
});

// ── connect an AI assistant (MCP) ─────────────────────────────────────────────
// desktop / self-hosted settings that live in the account menu
document.getElementById('menu-cloud').addEventListener('click', () => openCloudModal());
document.getElementById('menu-updates').addEventListener('click', () => openModal(document.getElementById('updates-modal')));

const mcpModal = document.getElementById('mcp-modal');

function renderMcp(state, token) {
  document.getElementById('mcp-off').classList.toggle('hidden', state.hasToken || Boolean(token));
  document.getElementById('mcp-on').classList.toggle('hidden', !(state.hasToken || token));
  document.getElementById('mcp-status').textContent = token
    ? 'Your assistant can now share files for you once it’s set up below.'
    : `Connected${state.createdAt ? ` since ${new Date(state.createdAt).toLocaleDateString()}` : ''}. Replace the token if you’ve lost it, or turn this off to disconnect every assistant.`;
  document.getElementById('mcp-setup').classList.toggle('hidden', !token);
  if (!token) return;
  document.getElementById('mcp-token').textContent = token;
  document.getElementById('mcp-claude').textContent =
    `claude mcp add --transport http sharesecure ${state.mcpUrl} --header "Authorization: Bearer ${token}"`;
  document.getElementById('mcp-codex').textContent =
    `[mcp_servers.sharesecure]\nurl = "${state.mcpUrl}"\nbearer_token_env_var = "SHARESECURE_TOKEN"`;

  // Claude's and ChatGPT's apps connect over the internet, and their connector
  // form only takes a URL, so the token rides in the connector URL
  const connector = document.getElementById('mcp-connector');
  connector.textContent = state.publicUrl ? `${state.publicUrl}/connect/${token}` : '';
  connector.closest('.code-box').classList.toggle('hidden', !state.publicUrl);
  document.querySelector('.mcp-no-public').classList.toggle('hidden', Boolean(state.publicUrl));
  document.querySelector('.mcp-tunnel-warn').classList.toggle('hidden', !/\.loca\.lt$/i.test(state.publicUrl ? new URL(state.publicUrl).hostname : ''));
  document.querySelector('.mcp-gpt').classList.toggle('hidden', !state.gptActions);
  if (state.gptActions) {
    document.getElementById('mcp-openapi').textContent = `${state.publicUrl}/openapi.json`;
    document.getElementById('mcp-privacy').textContent = `${state.publicUrl}/privacy`;
  }
}

document.querySelector('.mcp-tabs').addEventListener('click', e => {
  const tab = e.target.closest('.mcp-tab');
  if (!tab) return;
  for (const t of document.querySelectorAll('.mcp-tab')) t.setAttribute('aria-selected', String(t === tab));
  for (const p of document.querySelectorAll('.mcp-panel')) p.classList.toggle('hidden', p.dataset.panel !== tab.dataset.tab);
});

async function mcpCall(method) {
  const res = await fetch('/api/auth/mcp-token', { method, headers: authHeaders() });
  if (res.status === 401 && !(await sessionStillValid())) { logout(); throw new Error('signed out'); }
  if (!res.ok) throw new Error('failed');
  return res.json();
}

document.getElementById('menu-mcp').addEventListener('click', async () => {
  openModal(mcpModal);
  try { renderMcp(await mcpCall('GET')); } catch { showToast('Couldn’t load your assistant settings.', 'error'); }
});

async function createMcpToken() {
  try {
    const data = await mcpCall('POST');
    renderMcp({ ...data, hasToken: true }, data.token);
  } catch { showToast('Couldn’t create a token. Try again.', 'error'); }
}

document.getElementById('mcp-create').addEventListener('click', createMcpToken);
document.getElementById('mcp-rotate').addEventListener('click', createMcpToken);
document.getElementById('mcp-revoke').addEventListener('click', async () => {
  try {
    renderMcp(await mcpCall('DELETE'));
    showToast('Assistants can no longer share files for you.', 'success', 3000);
  } catch { showToast('Couldn’t turn it off. Try again.', 'error'); }
});

// ── delete account ────────────────────────────────────────────────────────────
const deleteModal = document.getElementById('delete-modal');
const deleteForm = document.getElementById('delete-form');
const deleteError = document.getElementById('delete-error');

document.getElementById('menu-delete').addEventListener('click', () => {
  document.getElementById('delete-text').textContent = selfHostMode
    ? 'This erases the owner account and every file on this ShareSecure, right away, and takes you back to setup. It can’t be undone.'
    : 'This erases your account and every file you’ve shared from it, right away. Your links stop working. It can’t be undone.';
  deleteForm.reset();
  deleteError.textContent = '';
  openModal(deleteModal);
});

deleteForm.addEventListener('submit', async e => {
  e.preventDefault();
  const password = document.getElementById('delete-password').value;
  if (!password) { deleteError.textContent = 'Enter your password.'; return; }
  const btn = document.getElementById('delete-confirm');
  btn.disabled = true;
  btn.textContent = 'Deleting…';
  deleteError.textContent = '';
  try {
    const res = await fetch('/api/auth/delete-account', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ access_code: password }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.deleted) throw new Error(res.status === 403 ? 'That password isn’t right.' : (data.error || 'Couldn’t delete the account. Try again.'));

    // Private uploads have no account link on the server, so erase them with
    // the delete keys this browser kept.
    if (!selfHostMode) {
      await Promise.allSettled(loadUploadHistory().map(f => fetch(`/api/delete/${encodeURIComponent(f.short_id)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deleteToken: f.delete_token || localStorage.getItem('owner_' + f.short_id) }),
      })));
      try { localStorage.removeItem('zk_secret'); localStorage.removeItem('zk_commitment'); } catch {}
    }
    try {
      localStorage.removeItem(HISTORY_KEY);
      localStorage.removeItem(NOTIFY_KEY);
      Object.keys(localStorage).filter(k => k.startsWith('owner_')).forEach(k => localStorage.removeItem(k));
    } catch {}
    userToken = null;
    sessionStorage.clear();
    sessionStorage.setItem('account_deleted', '1');
    location.replace(selfHostMode ? '/signin' : '/');
  } catch (err) {
    deleteError.textContent = err.message;
    btn.disabled = false;
    btn.textContent = 'Delete account';
  }
});

function showSignedIn(username) {
  document.getElementById('signin-link').classList.add('hidden');
  document.getElementById('profile-name').textContent = username;
  document.getElementById('profile-menu-name').textContent = username;
  document.getElementById('profile-avatar').textContent = username.charAt(0).toUpperCase();
  profileBtn.setAttribute('aria-label', `Account menu for ${username}`);
  profile.classList.remove('hidden');
  document.body.classList.add('is-logged-in');
  landingPage.classList.add('hidden');
  document.getElementById('app-grid')?.classList.remove('hidden');
}

function initAuth() {
  const username = userToken && tokenUsername();
  if (username) {
    showSignedIn(username);
    // a self-hosted install has one account, so this only makes sense on the website
    document.getElementById('require-account-wrap')?.classList.remove('hidden');
    updateDashboard();
    startInboxPolling();
    repairZkEnrollment();
  } else {
    if (userToken) logout();
    document.body.classList.remove('is-logged-in');
    landingPage.classList.remove('hidden');
    if (sessionStorage.getItem('account_deleted')) {
      sessionStorage.removeItem('account_deleted');
      showToast('Your account and files were deleted.', 'success', 5000);
    }
    drawRosette();
    document.getElementById('app-grid')?.classList.add('hidden');
  }
}

// Accounts created before the sign-up fix never had their private-upload
// commitment saved. Save this browser's now; the server ignores it if one exists.
function repairZkEnrollment() {
  if (!hasZKCredentials()) return;
  fetch('/api/auth/zk-enroll', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ commitment: localStorage.getItem('zk_commitment') }),
  }).catch(() => {});
}

// ── self-hosted: the owner signs in; nobody else can upload ──────────────────
function initSelfHost() {
  selfHostMode = true;
  const username = userToken && tokenUsername();
  if (!username) { location.replace('/signin'); return; }

  showSignedIn(username);
  updateDashboard();
  startInboxPolling();
  initCloudLink();
  initUpdates();
}

async function updateDashboard() {
  if (!userToken) return;

  // Render localStorage cache instantly so the UI is never blank during the round-trip
  renderFileList(loadUploadHistory());

  // The upload count, plus any shares the server can tie to this account (ones
  // made by an assistant, or from another browser) that this browser hasn't seen.
  // Private uploads have no server-side link, so those only live in this list.
  try {
    const res = await fetch('/api/auth/user/files', { headers: authHeaders() });
    if (res.status === 401) { logout(); return; }
    if (!res.ok) return;
    const data = await res.json();
    if (selfHostMode && 'publicUrl' in data) publicBase = data.publicUrl || null;
    if (mergeServerShares(data.files || [])) renderFileList(loadUploadHistory());
  } catch { /* network error — keep showing cached list */ }
}

// SQLite timestamps ("2026-09-23 14:00:00") are UTC but carry no zone.
function parseServerTime(value) {
  if (!value) return new Date();
  const s = String(value);
  return new Date(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z');
}

// Adds server-listed shares missing from this browser's list. True if any were added.
function mergeServerShares(files) {
  const history = loadUploadHistory();
  const known = new Set(history.map(f => f.short_id));
  const fresh = files.filter(f => f.short_id && !known.has(f.short_id)).map(f => ({
    short_id: f.short_id,
    short_url: f.short_url || null,
    original_filename: f.original_filename || 'Untitled',
    mime_type: f.mime_type || 'application/octet-stream',
    size_bytes: f.size_bytes || 0,
    expires_at: f.expires_at,
    uploaded_at: parseServerTime(f.uploaded_at).toISOString(),
    delete_token: f.delete_token || null,
  }));
  if (!fresh.length) return false;
  try {
    const merged = [...history, ...fresh].sort((a, b) => new Date(b.uploaded_at) - new Date(a.uploaded_at));
    localStorage.setItem(HISTORY_KEY, JSON.stringify(merged.slice(0, 50)));
  } catch {}
  return true;
}

// ── inbox: files other people send you ────────────────────────────────────────
// Files arrive as requests. Nothing opens until you accept it; declining erases it.
const inboxRequests = document.getElementById('inbox-requests');
const notifyToggle = document.getElementById('notify-toggle');
const NOTIFY_KEY = 'ss_notify';
const SEEN_KEY = 'ss_seen_requests';
const BASE_TITLE = document.title;
let inboxTimer = null;
let pendingCount = 0;

function seenRequests() {
  try { return new Set(JSON.parse(sessionStorage.getItem(SEEN_KEY) || '[]')); } catch { return new Set(); }
}

function rememberSeen(ids) {
  try { sessionStorage.setItem(SEEN_KEY, JSON.stringify([...ids])); } catch {}
}

function notificationsOn() {
  return 'Notification' in window && Notification.permission === 'granted' && localStorage.getItem(NOTIFY_KEY) === 'on';
}

function renderNotifyToggle() {
  if (!notifyToggle) return;
  if (!('Notification' in window)) { notifyToggle.classList.add('hidden'); return; }
  notifyToggle.classList.remove('hidden');
  notifyToggle.disabled = Notification.permission === 'denied';
  notifyToggle.setAttribute('aria-checked', String(notificationsOn()));
  document.getElementById('notify-label').textContent = Notification.permission === 'denied'
    ? 'Notifications blocked'
    : notificationsOn() ? 'Notifications on' : 'Turn on notifications';
  notifyToggle.title = Notification.permission === 'denied'
    ? 'Allow notifications for this site in your browser settings to turn them on.'
    : '';
}

notifyToggle?.addEventListener('click', async () => {
  if (notificationsOn()) {
    localStorage.setItem(NOTIFY_KEY, 'off');
    showToast('Notifications turned off.', 'info', 2500);
  } else {
    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      localStorage.setItem(NOTIFY_KEY, 'on');
      showToast('You’ll be notified when someone sends you a file.', 'success', 3000);
    }
  }
  renderNotifyToggle();
});

function setPendingBadge(count) {
  pendingCount = count;
  const menuCount = document.getElementById('menu-inbox-count');
  menuCount.textContent = count > 9 ? '9+' : String(count);
  menuCount.classList.toggle('hidden', count === 0);
  document.getElementById('profile-dot').classList.toggle('hidden', count === 0);
  const name = document.getElementById('profile-name').textContent;
  profileBtn.setAttribute('aria-label', count
    ? `Account menu for ${name}, ${count} file ${count === 1 ? 'request' : 'requests'} waiting`
    : `Account menu for ${name}`);
  document.title = count ? `(${count}) ${BASE_TITLE}` : BASE_TITLE;
}

function announce(newCount) {
  const text = newCount === 1 ? 'Someone sent you a file.' : `${newCount} new files were sent to you.`;
  showToast(`${text} Accept or decline it in Sent to you.`, 'info', 6000);
  // a system notification only when the tab isn't in front of you; no file names on the lock screen
  if (notificationsOn() && document.hidden) {
    try {
      const n = new Notification('ShareSecure', {
        body: `${text} Open ShareSecure to accept or decline.`,
        tag: 'sharesecure-inbox',
        icon: '/app-icon.png',
      });
      n.onclick = () => { window.focus(); document.getElementById('inbox-title')?.focus(); n.close(); };
    } catch {}
  }
}

async function updateInbox() {
  if (!userToken) return;
  try {
    const res = await fetch('/api/inbox', { headers: authHeaders() });
    if (res.status === 401) { logout(); return; }
    if (!res.ok) return;
    const data = await res.json();
    const files = (data.files || []).filter(f => !f.expires_at || new Date(f.expires_at) > Date.now());
    const pending = files.filter(f => f.status === 'pending');

    const seen = seenRequests();
    const fresh = pending.filter(f => !seen.has(f.short_id));
    if (fresh.length && inboxTimer) announce(fresh.length);   // not on the very first load
    pending.forEach(f => seen.add(f.short_id));
    rememberSeen(seen);

    setPendingBadge(pending.length);
    renderRequests(pending);
    renderInbox(files.filter(f => f.status !== 'pending'));
  } catch {}
}

function startInboxPolling() {
  renderNotifyToggle();
  updateInbox().finally(() => {
    if (!inboxTimer) inboxTimer = setInterval(updateInbox, 30 * 1000);
  });
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && inboxTimer) updateInbox();
  // picks up shares an assistant made while you were away
  if (!document.hidden && userToken) updateDashboard();
});

function renderRequests(pending) {
  if (!inboxRequests) return;
  if (!pending.length) { inboxRequests.innerHTML = ''; return; }
  inboxRequests.innerHTML = pending.map(f => `
    <div class="request" data-id="${escapeHtml(f.short_id)}">
      <div class="request-top">
        <div class="file-icon">${getFileIcon(f.mime_type || '')}</div>
        <div class="file-item-info">
          <span class="file-item-name">${escapeHtml(f.original_filename || 'Untitled')}</span>
          <span class="file-item-meta">${formatSize(f.size_bytes || 0)}, expires in ${formatCountdown(new Date(f.expires_at) - Date.now())}</span>
        </div>
      </div>
      ${f.note ? `<p class="request-note">“${escapeHtml(f.note)}”</p>` : ''}
      <div class="request-actions">
        <button class="btn btn-ghost" data-action="decline">Decline</button>
        <button class="btn btn-primary" data-action="accept">Accept</button>
      </div>
    </div>`).join('');
}

inboxRequests?.addEventListener('click', async e => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const card = btn.closest('.request');
  const action = btn.dataset.action;
  card.querySelectorAll('button').forEach(b => { b.disabled = true; });
  try {
    const res = await fetch(`/api/inbox/${encodeURIComponent(card.dataset.id)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ action }),
    });
    if (!res.ok) throw new Error();
    showToast(action === 'accept' ? 'Accepted. You can open it now.' : 'Declined. The file was erased.', 'success', 3000);
    updateInbox();
  } catch {
    showToast('Couldn’t update the request. Try again.', 'error');
    card.querySelectorAll('button').forEach(b => { b.disabled = false; });
  }
});

function renderInbox(files) {
  const list = document.getElementById('inbox-list');
  if (!list) return;
  if (!files.length) {
    list.innerHTML = pendingCount ? '' : emptyInbox();
    return;
  }
  list.innerHTML = files.map(f => `
    <div class="file-item">
      <div class="file-icon">${getFileIcon(f.mime_type || '')}</div>
      <div class="file-item-info">
        <span class="file-item-name">${escapeHtml(f.original_filename || 'Untitled')}</span>
        <span class="file-item-meta">${formatSize(f.size_bytes || 0)}, ${f.expires_at ? `${formatCountdown(new Date(f.expires_at) - Date.now())} left` : 'No expiry'}</span>
      </div>
      <div class="file-item-actions">
        <a class="btn btn-ghost btn-open" href="/r/${encodeURIComponent(f.short_id)}" target="_blank" rel="noopener noreferrer">Open</a>
      </div>
    </div>`).join('');
}

// ── send a share to people (both editions) ───────────────────────────────────
// "alice, bob" or "@alice bob"; each person gets their own copy to accept. On
// this computer the local server passes it on through the linked account.
// The delete key proves to the website that the share is yours.
async function sendToUsers(shortId, input, deleteToken) {
  const names = [...new Set(input.split(/[\s,;]+/).map(u => u.replace(/^@/, '')).filter(Boolean))].slice(0, 20);
  let key = deleteToken || null;
  if (!key) {
    try { key = localStorage.getItem('owner_' + shortId) || loadUploadHistory().find(f => f.short_id === shortId)?.delete_token || null; } catch {}
  }
  const result = { sent: [], missing: [], failed: [], notLinked: [] };
  for (let i = 0; i < names.length; i++) {
    const username = names[i];
    try {
      const res = await fetch(`/api/send/${encodeURIComponent(shortId)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ targetUsername: username, deleteToken: key }),
      });
      const data = await res.json().catch(() => ({}));
      if (data.sent) result.sent.push(username);
      else if (data.error === 'User not found') result.missing.push(username);
      else if (data.error === 'link_account' || data.error === 'link_expired') {
        // on this computer, with no linked account (or its sign-in ran out)
        result.notLinked.push(...names.slice(i));
        if (cloudState.linked) { cloudState.linked = false; renderCloud(); }
        break;
      } else result.failed.push({ username, reason: data.error || 'Try again.' });
    } catch {
      result.failed.push({ username, reason: 'Couldn’t reach the server.' });
    }
  }
  return result;
}

// ── desktop version: link a ShareSecure account to send to usernames ─────────
// Usernames live on the ShareSecure website, so sending from this computer goes
// through your account there.
const cloudModal = document.getElementById('cloud-modal');
const cloudForm = document.getElementById('cloud-form');
const cloudError = document.getElementById('cloud-error');
let cloudState = { linked: false, username: null, cloudUrl: null };

function renderSendHint() {
  if (!selfHostMode) return;
  const hint = document.getElementById('send-to-hint');
  if (cloudState.linked) {
    hint.textContent = `Sent through your ShareSecure account, @${cloudState.username}. They get an encrypted copy that works even while this computer is off.`;
    return;
  }
  hint.textContent = 'Sending to usernames needs your ShareSecure account. Leave it empty to just get a link. ';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'link-btn';
  btn.textContent = 'Link account';
  btn.addEventListener('click', openCloudModal);
  hint.appendChild(btn);
}

function renderCloud() {
  const { linked, username } = cloudState;
  document.getElementById('cloud-status').textContent = linked
    ? `Linked to @${username}. Files you send to usernames go through this account.`
    : username ? `Sign in again to keep sending as @${username}.` : 'No account linked yet.';
  cloudForm.classList.toggle('hidden', linked);
  document.getElementById('cloud-linked').classList.toggle('hidden', !linked);
  if (cloudState.cloudUrl) document.getElementById('cloud-signup').href = `${cloudState.cloudUrl}/signin?new=1`;
  renderSendHint();
}

async function initCloudLink() {
  renderSendHint();
  try {
    const res = await fetch('/api/cloud', { headers: authHeaders() });
    if (!res.ok) return;
    cloudState = await res.json();
    document.getElementById('menu-cloud').classList.remove('hidden');
    renderCloud();
  } catch {}
}

// resume: names to send to once the account is linked. The share's dialog then
// opens again with them filled in, so nothing has to be typed twice. It also
// opens again when this dialog is closed without linking.
let cloudResume = null;

function resumeResult() {
  if (!cloudResume) return;
  const { record, title, names } = cloudResume;
  cloudResume = null;
  openResult(record, { title });
  resultSendInput.value = names;
  resultSendInput.focus();
}

function openCloudModal({ resume = null } = {}) {
  const fromResult = !resultCard.classList.contains('hidden') && currentHistoryRecord;
  cloudResume = resume && fromResult ? { record: currentHistoryRecord, title: resultDefaultTitle, names: resume } : null;
  closeResult();
  cloudForm.reset();
  cloudError.textContent = '';
  renderCloud();
  openModal(cloudModal);
  // after a sign-in runs out, only the password is needed
  if (!cloudState.linked && cloudState.username) {
    document.getElementById('cloud-username').value = cloudState.username;
    document.getElementById('cloud-password').focus();
  } else if (cloudState.linked) {
    document.getElementById('cloud-unlink').focus();
  }
}

cloudForm.addEventListener('submit', async e => {
  e.preventDefault();
  const username = document.getElementById('cloud-username').value.trim();
  const password = document.getElementById('cloud-password').value;
  if (!username || !password) { cloudError.textContent = 'Enter your username and password.'; return; }
  const btn = document.getElementById('cloud-link-btn');
  btn.disabled = true;
  btn.textContent = 'Linking…';
  cloudError.textContent = '';
  try {
    const res = await fetch('/api/cloud/link', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ username, access_code: password }),
    });
    if (res.status === 401) { logout(); return; }
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.linked) throw new Error(data.error || 'Couldn’t link the account. Try again.');
    cloudState = data;
    renderCloud();
    showToast(`Linked to @${data.username}. You can send to usernames now.`, 'success', 4000);
    closeModal(cloudModal);   // reopens the share it was opened from, if any
  } catch (err) {
    cloudError.textContent = err.message;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Link account';
  }
});

document.getElementById('cloud-unlink').addEventListener('click', async () => {
  if (!confirm('Unlink this account? Files you sent to usernames from here will be taken back from the people who got them.')) return;
  try {
    const res = await fetch('/api/cloud', { method: 'DELETE', headers: authHeaders() });
    if (!res.ok) throw new Error();
    cloudState = await res.json();
    renderCloud();
    document.getElementById('cloud-username').focus();
    showToast('Account unlinked. Anything you sent to usernames from here was taken back.', 'success', 4000);
  } catch {
    showToast('Couldn’t unlink the account. Try again.', 'error');
  }
});

const EMPTY_LIST = `<div class="empty-msg">
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
  <p>Nothing shared yet.</p><span>Your links show up here until they expire.</span>
</div>`;
const INBOX_ICON = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>`;
const EMPTY_INBOX = `<div class="empty-msg">
  ${INBOX_ICON}
  <p>No files received.</p><span>Files people send you wait here for you to accept.</span>
</div>`;

// On this computer nothing new arrives here: files sent to your username wait
// in your inbox on the ShareSecure website.
function emptyInbox() {
  if (!selfHostMode) return EMPTY_INBOX;
  const site = escapeHtml(cloudState.cloudUrl || 'https://sharesecure-du8.pages.dev');
  return `<div class="empty-msg">
  ${INBOX_ICON}
  <p>No files received here.</p><span>Files sent to your username arrive in your inbox on <a href="${site}/" target="_blank" rel="noopener noreferrer">the ShareSecure website</a>.</span>
</div>`;
}
const SEND_ICON = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>`;
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
        <span class="expiry-bar" aria-hidden="true"><span></span></span>
      </div>
      <div class="file-item-actions">
        <a href="/r/${encodeURIComponent(f.short_id)}" target="_blank" class="btn-icon" title="Open" aria-label="Open ${escapeHtml(f.original_filename)}">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
        </a>
        <button class="btn-icon send-file-btn" data-id="${escapeHtml(f.short_id)}" title="Send, copy the link or show the QR code" aria-label="Send ${escapeHtml(f.original_filename)}">${SEND_ICON}</button>
        <button class="btn-icon delete-file-btn" data-id="${escapeHtml(f.short_id)}" title="Delete" aria-label="Delete ${escapeHtml(f.original_filename)}">${TRASH_ICON}</button>
      </div>
    </div>
  `).join('');

  // opens the share's dialog, ready to send it to someone
  fileList.querySelectorAll('.send-file-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const record = files.find(f => f.short_id === btn.dataset.id);
      if (!record) return;
      openResult(record, { title: 'Send or share' });
      resultSendInput.focus();
    });
  });

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
      const row = fileList.querySelector(`[data-short-id="${CSS.escape(f.short_id)}"]`);
      if (!row) return;
      const end = new Date(f.expires_at).getTime();
      const remaining = end - Date.now();
      if (remaining <= 0) { forgetShare(f.short_id); return; }
      row.querySelector('.file-item-time').textContent = formatCountdown(remaining) + ' left';
      // the bar shows how much of the link's life is left
      const start = new Date(f.uploaded_at).getTime();
      const left = end > start ? Math.min(1, remaining / (end - start)) : 1;
      const bar = row.querySelector('.expiry-bar');
      bar.style.setProperty('--left', left.toFixed(4));
      bar.classList.toggle('is-low', left < 0.1);
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
const updatesMenu = document.getElementById('menu-updates');
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
  document.getElementById('menu-update-badge').classList.toggle('hidden', !s.updateAvailable);
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
  if (s.blockedReason === 'development') {
    updateStatus.textContent = s.updateAvailable
      ? `Version ${s.latest} is out. This is a development copy, so update it with git.`
      : 'This is a development copy, so it doesn’t update itself. Update it with git.';
    autoUpdateInput.closest('.switch').classList.add('hidden');
    return;
  }
  if (s.blockedReason === 'desktop') {
    updateStatus.textContent = s.updateAvailable
      ? `Version ${s.latest} is out. The app downloads it and installs it the next time you quit.`
      : `${s.latest ? 'You’re up to date. ' : ''}The app installs new versions by itself.`;
    autoUpdateInput.closest('.switch').classList.add('hidden');
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
  if (!updatesMenu) return;
  updatesMenu.classList.remove('hidden');
  try {
    let s = await updateCall('/api/update/status');
    renderUpdates(s);
    if (!s.checkedAt) renderUpdates(s = await updateCall('/api/update/check', {}));
  } catch {
    updatesMenu.classList.add('hidden');
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
  if (!profileMenu.classList.contains('hidden')) { closeMenu(true); return; }
  const openDialog = document.querySelector('[data-dialog]:not(.hidden)');
  if (openDialog) { closeModal(openDialog); return; }
  if (!resultCard.classList.contains('hidden')) closeResult();
});

// ── mode detection + app initialisation ──────────────────────────────────────
const tcModal = document.getElementById('tc-modal');
const acceptTcBtn = document.getElementById('accept-tc-btn');

async function detectSelfHostMode() {
  try {
    const res = await fetch('/api/mode', { signal: AbortSignal.timeout(2000) });
    if (res.ok) {
      const data = await res.json();
      publicBase = data.publicUrl || null;
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
  document.dispatchEvent(new Event('sharesecure:ready'));
}

function initApp() {
  purgeStaleOwnerTokens();
  if (localStorage.getItem('tc_accepted') !== 'true') {
    tcModal.classList.remove('hidden');
    landingPage.classList.add('hidden');
    dashboardCard.classList.add('hidden');
    uploadCard.classList.add('hidden');
    document.dispatchEvent(new Event('sharesecure:ready'));
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
