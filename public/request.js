// A file request's upload page (/q/<id>#r=<request key>&pk=<their public key>).
// The file, its name and the note are sealed here with a fresh key, and that
// key is sealed to the public key in the link, never one the server hands out.
// So only the person who asked can open what's sent, and the server can't
// swap itself in. No account is needed.
import { newFileKey, lockFile, lockMeta, lockText, unlockText, sealKey, fromB64url, isPublicKey, fingerprint } from './sealed.js';
import { detectType, nameFor, NOT_UTF8, TYPES_ERROR, ENCODING_ERROR } from './filetypes.js';

const $ = id => document.getElementById(id);
const id = location.pathname.split('/q/')[1] || '';
const hash = new URLSearchParams(location.hash.slice(1));
const requestKey = /^[A-Za-z0-9_-]{43}$/.test(hash.get('r') || '') ? fromB64url(hash.get('r')) : null;
const ownerKey = hash.get('pk') || '';
let file = null;
let remaining = 0, asker = '', until = '';

const stop = text => { $('req-sub').textContent = text; $('req-form').classList.add('hidden'); };

async function load() {
  if (!requestKey || !isPublicKey(ownerKey)) { stop('This link is incomplete. Ask for the whole link, including the part after #.'); return; }
  const res = await fetch(`/api/requests/${encodeURIComponent(id)}`).catch(() => null);
  const info = res?.ok ? await res.json() : null;
  if (!info) { stop('This file request doesn’t exist, or was closed.'); return; }
  if (!info.open) { stop('This file request is closed: it has expired, or already has all its files.'); return; }

  let label = '';
  try { label = await unlockText(requestKey, info.label, 'request'); } catch { stop('This link doesn’t match its request. Ask for the link again.'); return; }
  remaining = info.remaining;
  asker = info.username;
  until = new Date(info.expires_at).toLocaleString();
  showRemaining();
  $('req-label').textContent = label;
  $('req-label').classList.toggle('hidden', !label);
  $('req-who').textContent = `@${info.username}`;
  $('req-code').textContent = await fingerprint(ownerKey);
  $('req-form').classList.remove('hidden');
}

function showRemaining() {
  $('req-sub').textContent = remaining > 0
    ? `@${asker} asked for a file. ${remaining === 1 ? 'One file' : `Up to ${remaining} files`} can be sent, until ${until}.`
    : `@${asker} asked for a file.`;
}

function pick(f) {
  $('req-error').textContent = '';
  if (!f) return;
  if (f.size > 10 * 1024 * 1024) { $('req-error').textContent = 'That file is over 10 MB.'; return; }
  file = f;
  $('req-file-label').textContent = f.name;
  $('req-submit').disabled = false;
}

const zone = $('req-zone'), input = $('req-input');
zone.addEventListener('click', () => input.click());
zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('dragover'); pick(e.dataTransfer.files[0]); });
input.addEventListener('change', () => pick(input.files[0]));

$('req-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!file) return;
  const submit = $('req-submit');
  submit.disabled = true;
  submit.textContent = 'Encrypting…';
  $('req-error').textContent = '';
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const type = detectType(bytes, file.name, file.type);
    if (!type || type === NOT_UTF8) throw new Error(type ? ENCODING_ERROR : TYPES_ERROR);
    const key = newFileKey();
    const form = new FormData();
    form.append('file', new Blob([await lockFile(key, bytes)]), 'sealed.bin');
    form.append('meta', await lockMeta(key, { name: nameFor('', file.name, type), type }));
    form.append('inbox_key', await sealKey(ownerKey, key));
    const note = $('req-note').value.trim();
    if (note) form.append('note', await lockText(key, note, 'note'));

    submit.textContent = 'Sending…';
    const res = await fetch(`/api/requests/${encodeURIComponent(id)}/upload`, { method: 'POST', body: form });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Couldn’t send the file. Try again.');
    remaining = Math.max(0, remaining - 1);
    showRemaining();
    $('req-another').classList.toggle('hidden', remaining === 0);
    $('req-form').classList.add('hidden');
    $('req-done').classList.remove('hidden');
  } catch (err) {
    $('req-error').textContent = err.message;
    submit.disabled = false;
  }
  submit.textContent = 'Send it';
});

$('req-another').addEventListener('click', () => {
  file = null;
  input.value = '';
  $('req-note').value = '';
  $('req-file-label').textContent = 'Choose a file';
  $('req-submit').disabled = true;
  $('req-done').classList.add('hidden');
  load();
});

load();
