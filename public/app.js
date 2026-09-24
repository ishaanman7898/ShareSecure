import * as ZK from '/zk-client.js';

// ── html escaping for user-supplied strings (filenames, usernames) ──────────
function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ── landing rosette: guilloché bands like the ones printed on banknotes ───────
// It doubles as a vault dial: circle the cursor around it to turn the dial,
// and one full turn unlocks it. Tapping (or clicking) opens it too.
const SVG_NS = 'http://www.w3.org/2000/svg';

function drawRosette() {
  const svg = document.getElementById('rosette');
  if (!svg || svg.childElementCount) return;
  const C = 200, STEPS = 480;
  // each band is a set of phase-shifted sine rings woven around a base radius
  const bands = [
    { base: 172, amp: 12, k: 24, n: 9,  cls: 'band-1' },
    { base: 132, amp: 18, k: 16, n: 10, cls: 'band-2' },
    { base: 88,  amp: 20, k: 12, n: 9,  cls: 'band-3' },
    { base: 44,  amp: 16, k: 8,  n: 7,  cls: 'band-4' },
  ];
  const groups = bands.map((b, bi) => {
    // the group carries the turning, the paths carry the engraving
    const group = document.createElementNS(SVG_NS, 'g');
    svg.appendChild(group);
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
      path.style.setProperty('--d', (bi * 0.18 + i * 0.05).toFixed(2) + 's');
      group.appendChild(path);
    }
    return group;
  });

  // dial: safe-style ticks around the edge, and an arc that fills as you turn
  const dial = document.createElementNS(SVG_NS, 'g');
  dial.setAttribute('class', 'dial');
  let ticks = '';
  for (let i = 0; i < 72; i++) {
    const a = (i / 72) * Math.PI * 2, major = i % 6 === 0;
    const r1 = major ? 184 : 188, r2 = 193;
    ticks += `<line class="${major ? 'major' : ''}" x1="${(C + r1 * Math.cos(a)).toFixed(2)}" y1="${(C + r1 * Math.sin(a)).toFixed(2)}" x2="${(C + r2 * Math.cos(a)).toFixed(2)}" y2="${(C + r2 * Math.sin(a)).toFixed(2)}"/>`;
  }
  dial.innerHTML = `<g class="ticks">${ticks}</g>`
    + `<circle class="track" cx="${C}" cy="${C}" r="198"/>`
    + `<circle class="progress" cx="${C}" cy="${C}" r="198" pathLength="1" stroke-dasharray="0 1" transform="rotate(-90 ${C} ${C})"/>`;
  svg.appendChild(dial);

  const lock = document.createElementNS(SVG_NS, 'g');
  lock.setAttribute('class', 'lock');
  lock.innerHTML = `<circle class="pulse" cx="${C}" cy="${C}" r="24"/>`
    + `<circle class="lock-face" cx="${C}" cy="${C}" r="24"/>`
    + `<path class="shackle" d="M193 199 V191 a7 7 0 0 1 14 0 V199"/>`
    + `<rect class="lock-body" x="186" y="197" width="28" height="19" rx="3"/>`
    + `<circle class="lock-hole" cx="${C}" cy="205" r="2.4"/>`
    + `<rect class="lock-hole" x="199" y="205" width="2" height="6" rx="1"/>`;
  svg.appendChild(lock);

  initVault(svg, groups, dial.querySelector('.ticks'), dial.querySelector('.progress'));
}

function initVault(svg, bands, ticks, progress) {
  const art = svg.closest('.landing-art');
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const RATIO = [-0.3, 0.5, -0.8, 1.2];     // how far each band turns with the dial
  const DRIFT = [0.3, -0.5, 0.7, -1];       // idle turning when nobody's touching it
  const SPREAD = [1.03, 1.08, 1.16, 1.34];  // how far each band opens when unlocked
  const rot = bands.map(() => 0), scale = bands.map(() => 1), base = bands.map(() => 0);
  let dial = 0, drift = 0, turned = 0, last = null, open = false, inside = false, lastMove = 0, relockTimer = 0;

  const place = (el, r, s = 1) => el.setAttribute('transform',
    `translate(200 200) rotate(${r.toFixed(2)}) scale(${s.toFixed(3)}) translate(-200 -200)`);

  function setOpen(value) {
    clearTimeout(relockTimer);
    if (value && !open) {
      // spin every band home to where it was engraved, then carry on from there
      bands.forEach((_, i) => {
        base[i] += Math.round(rot[i] / 360) * 360 - (dial * RATIO[i] + drift * DRIFT[i] + base[i]);
      });
      turned = 1;
    }
    if (!value) turned = 0;
    open = value;
    svg.classList.toggle('unlocked', value);
    art.classList.toggle('is-open', value);
    if (still) bands.forEach((g, i) => place(g, 0, value ? SPREAD[i] : 1));
  }

  function relockIn(ms) {
    clearTimeout(relockTimer);
    relockTimer = setTimeout(() => setOpen(false), ms);
  }

  art.addEventListener('click', () => {
    setOpen(!open);
    if (open && !inside) relockIn(3500);  // a tap on a phone springs shut again
  });

  if (still) return;

  art.addEventListener('pointermove', e => {
    if (e.pointerType === 'touch') return;
    inside = true;
    if (open) { clearTimeout(relockTimer); return; }
    const r = svg.getBoundingClientRect();
    const x = e.clientX - (r.left + r.width / 2), y = e.clientY - (r.top + r.height / 2);
    const dist = Math.hypot(x, y) / (r.width / 2);
    // too close to the middle to read an angle reliably
    if (dist < 0.15) { last = null; return; }
    const angle = Math.atan2(y, x) * 180 / Math.PI;
    if (last !== null) {
      let delta = angle - last;
      if (delta > 180) delta -= 360; else if (delta < -180) delta += 360;
      dial += delta;
      turned = Math.min(1, turned + Math.abs(delta) / 360);
      lastMove = performance.now();
      if (turned >= 1) setOpen(true);
    }
    last = angle;
  });

  art.addEventListener('pointerleave', () => {
    inside = false;
    last = null;
    if (open) relockIn(1600);
  });

  function frame(now) {
    if (!open) {
      if (!inside) drift += 0.04;
      // the dial slowly unwinds if you stop turning it
      if (now - lastMove > 700) turned = Math.max(0, turned - 0.004);
    }
    bands.forEach((g, i) => {
      const target = dial * RATIO[i] + drift * DRIFT[i] + base[i];
      rot[i] += (target - rot[i]) * (open ? 0.08 : 0.12);
      scale[i] += ((open ? SPREAD[i] : 1) - scale[i]) * 0.08;
      place(g, rot[i], scale[i]);
    });
    place(ticks, open ? 0 : dial * 0.6 + drift * 0.2);
    progress.setAttribute('stroke-dasharray', `${turned.toFixed(4)} 1`);
    progress.style.opacity = turned < 0.01 ? '0' : '';
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
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
        const sendTo = selfHostMode ? '' : (document.getElementById('send-to-input')?.value.trim() || '');
        showResult(data, selectedFile);
        if (sendTo) {
          sendToUser(data.shortId, sendTo);
          document.getElementById('send-to-input').value = '';
        }
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
    document.getElementById('send-to-wrap')?.classList.remove('hidden');
    updateDashboard();
    startInboxPolling();
  } else {
    if (userToken) logout();
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
  if (uploadCount) uploadCount.textContent = 'No limit';
  renderFileList(loadUploadHistory());
  startInboxPolling();
  initReceive();
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
    list.innerHTML = pendingCount ? '' : EMPTY_INBOX;
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

// ── web version: send a new upload straight to someone ───────────────────────
async function sendToUser(shortId, username) {
  try {
    const res = await fetch(`/api/send/${encodeURIComponent(shortId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ targetUsername: username }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.sent) showToast(`Sent to ${username}. They’ll accept or decline it.`, 'success', 5000);
    else showToast(data.error === 'User not found' ? `There’s no user called ${username}.` : (data.error || 'Couldn’t send the file.'), 'error', 6000);
  } catch {
    showToast('Couldn’t send the file. Try again from the file’s Share panel.', 'error', 6000);
  }
}

// ── desktop version: let people send the owner files ─────────────────────────
const receiveSection = document.getElementById('receive-section');
const receiveToggle = document.getElementById('receive-toggle');

function renderReceive(s) {
  receiveToggle.checked = !!s.enabled;
  document.getElementById('receive-info').classList.toggle('hidden', !s.enabled);
  document.getElementById('receive-username').textContent = s.username || '';
  document.getElementById('receive-url').textContent = s.sendUrl || `${location.origin}/send`;
}

async function initReceive() {
  if (!receiveSection) return;
  try {
    const res = await fetch('/api/settings/incoming', { headers: authHeaders() });
    if (!res.ok) return;
    receiveSection.classList.remove('hidden');
    renderReceive(await res.json());
  } catch {}
}

receiveToggle?.addEventListener('change', async () => {
  try {
    const res = await fetch('/api/settings/incoming', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ enabled: receiveToggle.checked }),
    });
    if (!res.ok) throw new Error();
    renderReceive(await res.json());
    showToast(receiveToggle.checked ? 'People can now send you files for approval.' : 'Nobody can send you files now.', 'success', 3000);
  } catch {
    receiveToggle.checked = !receiveToggle.checked;
    showToast('Couldn’t change the setting. Try again.', 'error');
  }
});

document.getElementById('receive-copy')?.addEventListener('click', () => {
  navigator.clipboard.writeText(document.getElementById('receive-url').textContent)
    .then(() => showToast('Link copied.', 'success', 2500))
    .catch(() => showToast('Couldn’t copy. Select the link and copy it manually.', 'warn'));
});

const EMPTY_LIST = `<div class="empty-msg">
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
  <p>Nothing shared yet.</p><span>Your links show up here until they expire.</span>
</div>`;
const EMPTY_INBOX = `<div class="empty-msg">
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>
  <p>No files received.</p><span>Files people send you wait here for you to accept.</span>
</div>`;
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
  if (!profileMenu.classList.contains('hidden')) { closeMenu(true); return; }
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
