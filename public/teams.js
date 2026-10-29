// The Teams page (/teams). See functions/_teams.js for how a team's keys work.
//
// Each team's keys arrive sealed to your own key, and are opened here: a list
// of private keys, newest last. The team's public key is worked out from the
// newest one rather than taken from the server, so request links always carry
// the key the team really holds, and a server that swapped in its own key is
// caught (the "doesn't match" warning).
import {
  makeKeyPair, sealText, openText, openKey, sealKey, unlockMeta, unlockText, lockText, lockFile, lockMeta, newFileKey, linkWithKey,
  importPrivateKey, toB64url, fromB64url, fingerprint,
} from './sealed.js';
import { detectType, nameFor, NOT_UTF8, TYPES_ERROR, ENCODING_ERROR } from './filetypes.js';
import { myKeys, publicKeyFor } from './keys.js';
import { confirmAction } from './confirm.js';

const $ = id => document.getElementById(id);
const token = (() => { try { return sessionStorage.getItem('user_token'); } catch { return null; } })();
if (!token) location.replace('/signin?next=/teams');
const auth = { Authorization: `Bearer ${token}` };

const escapeHtml = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const show = (el, on = true) => (typeof el === 'string' ? $(el) : el).classList.toggle('hidden', !on);

function toast(message, type = 'info') {
  const t = document.createElement('div');
  t.className = `toast toast-${type}`;
  t.setAttribute('role', type === 'error' ? 'alert' : 'status');
  t.textContent = message;
  $('toast-container').appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

// body: an object (sent as JSON) or a FormData (sent as it is)
async function api(path, { method = 'GET', body } = {}) {
  const isForm = body instanceof FormData;
  const res = await fetch(path, {
    method,
    headers: { ...auth, ...(body && !isForm ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? (isForm ? body : JSON.stringify(body)) : undefined,
  });
  if (res.status === 401) { location.replace('/signin?next=/teams'); throw new Error('Sign in again.'); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Something went wrong. Try again.'), { status: res.status });
  return data;
}

// ── a team's keys ────────────────────────────────────────────────────────────
// A key ring is { keys: [pkcs8 base64url, …] }, sealed to one person.
const sealRing = (publicKey, ring) => sealText(publicKey, JSON.stringify(ring), 'team');

// The public key that goes with a private one, from its JWK form
async function publicOf(pkcs8) {
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const jwk = await crypto.subtle.exportKey('jwk', key);
  return toB64url(new Uint8Array([4, ...fromB64url(jwk.x), ...fromB64url(jwk.y)]));
}

async function newTeamKey() {
  const pair = await makeKeyPair();
  return { publicKey: pair.publicKey, pkcs8: toB64url(new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey))) };
}

// → { ring, privateKeys (newest last), publicKey, matches }
async function openRing(team, me) {
  const ring = JSON.parse(await openText(me.privateKey, team.key_box, 'team'));
  const privateKeys = await Promise.all(ring.keys.map(k => importPrivateKey(fromB64url(k))));
  const publicKey = await publicOf(fromB64url(ring.keys[ring.keys.length - 1]));
  return { ring, privateKeys, publicKey, matches: publicKey === team.public_key };
}

// The file key in a box sealed to the team, trying each of its keys
async function openTeamBox(privateKeys, box) {
  for (const key of [...privateKeys].reverse()) {
    try { return await openKey(key, box); } catch {}
  }
  return null;
}

// ── state ────────────────────────────────────────────────────────────────────
let me = null;
let teams = [];
let current = null;   // { team, keys }

const colorOf = t => (/^#[0-9a-f]{6}$/i.test(t.color || '') ? t.color : '');
const roleText = t => `${t.members} ${t.members === 1 ? 'person' : 'people'} · you’re ${t.role === 'admin' ? 'an admin' : 'a member'}`;
const initialOf = t => (t.name || '?').trim().charAt(0).toUpperCase();
// the team's logo, or its first letter on its colour
const badge = t => (t.logo
  ? `<img src="${escapeHtml(t.logo)}" alt="" width="44" height="44" />`
  : `<span class="team-initial" aria-hidden="true">${escapeHtml(initialOf(t))}</span>`);

async function loadTeams() {
  ({ teams } = await api('/api/teams'));
  $('team-list').innerHTML = teams.map(t => `
    <button type="button" class="team-card" data-open="${escapeHtml(t.id)}" style="--team:${colorOf(t) || 'var(--ink)'}">
      ${badge(t)}
      <span class="team-card-info">
        <span class="team-card-name">${escapeHtml(t.name)}</span>
        <span class="file-item-meta">${roleText(t)}</span>
      </span>
    </button>`).join('');
  show('teams-intro', !teams.length);
}

$('team-list').addEventListener('click', e => {
  const btn = e.target.closest('[data-open]');
  if (btn) openTeam(btn.dataset.open);
});

function showCreate(on) {
  show('create-form', on);
  show('new-team-btn', !on);
  if (on) $('create-name').focus();
}
$('new-team-btn').addEventListener('click', () => showCreate(true));
$('create-cancel').addEventListener('click', () => { $('create-error').textContent = ''; showCreate(false); });

$('create-form').addEventListener('submit', async e => {
  e.preventDefault();
  const name = $('create-name').value.trim();
  if (!name) { $('create-error').textContent = 'Give the team a name.'; return; }
  $('create-btn').disabled = true;
  $('create-error').textContent = '';
  try {
    const key = await newTeamKey();
    const { id } = await api('/api/teams', {
      method: 'POST',
      body: { name, color: $('create-color').value, public_key: key.publicKey, key_box: await sealRing(me.publicKey, { keys: [key.pkcs8] }) },
    });
    $('create-name').value = '';
    showCreate(false);
    await loadTeams();
    openTeam(id);
  } catch (err) {
    $('create-error').textContent = err.message;
  }
  $('create-btn').disabled = false;
});

// ── one team ─────────────────────────────────────────────────────────────────
async function openTeam(id) {
  const team = teams.find(t => t.id === id);
  if (!team) return;
  let keys;
  try { keys = await openRing(team, me); } catch {
    toast('Couldn’t open this team’s key. Sign out and in again.', 'error');
    return;
  }
  current = { team, keys };
  history.replaceState(null, '', `/teams#${id}`);
  show('teams-home', false);
  show('team-view');
  $('team-name').textContent = team.name;
  $('team-meta').textContent = roleText(team);
  $('team-logo').src = team.logo || '';
  show('team-logo', Boolean(team.logo));
  $('team-initial').textContent = initialOf(team);
  show('team-initial', !team.logo);
  $('team-banner').style.setProperty('--team', colorOf(team) || 'var(--ink)');
  $('count-inbox').textContent = '';
  $('count-requests').textContent = '';
  $('count-members').textContent = String(team.members);
  $('inbox-search').value = '';
  resetAdd();
  window.scrollTo(0, 0);
  // the key the server lists isn't the one the team holds: don't use it
  $('team-warning').textContent = keys.matches ? '' : 'The team key the server lists doesn’t match the one your team holds. New request links use your team’s own key; an admin should make a new team key.';
  document.querySelectorAll('.admin-only').forEach(el => show(el, team.role === 'admin'));
  $('team-code').textContent = await fingerprint(keys.publicKey);
  $('settings-name').value = team.name;
  $('settings-color').value = team.color || '#1e3fd8';
  $('settings-requests').value = team.requests_by;
  pickTab('inbox');
  // the request links' count, without opening the tab
  loadRequests().catch(() => {});
}

$('team-back').addEventListener('click', () => {
  current = null;
  resetAdd();
  history.replaceState(null, '', '/teams');
  show('team-view', false);
  show('teams-home');
  loadTeams().catch(err => toast(err.message, 'error'));
});

function pickTab(name) {
  document.querySelectorAll('.team-tab').forEach(t => t.setAttribute('aria-selected', String(t.dataset.tab === name)));
  document.querySelectorAll('.team-pane').forEach(p => show(p, p.dataset.pane === name));
  ({ inbox: loadInbox, requests: loadRequests, members: loadMembers }[name] || (() => {}))().catch(err => toast(err.message, 'error'));
}
document.querySelectorAll('.team-tab').forEach(t => t.addEventListener('click', () => pickTab(t.dataset.tab)));

// ── inbox ────────────────────────────────────────────────────────────────────
const formatSize = b => (b < 1024 * 1024 ? `${Math.max(1, Math.round(b / 1024))} KB` : `${(b / 1024 / 1024).toFixed(1)} MB`);

async function loadInbox() {
  const { files } = await api(`/api/teams/${current.team.id}/inbox`);
  const rows = [];
  for (const f of files) {
    const key = await openTeamBox(current.keys.privateKeys, f.inbox_key);
    let name = 'Encrypted file', note = null, url = null;
    if (key) {
      try {
        name = (await unlockMeta(key, f.original_filename)).name;
        if (f.note) note = await unlockText(key, f.note, 'note');
        url = linkWithKey(`${location.origin}/r/${f.short_id}`, key, 'f');
      } catch {}
    }
    rows.push({ ...f, name, note, url });
  }
  inboxRows = rows;
  $('count-inbox').textContent = rows.length ? String(rows.length) : '';
  show('inbox-search', rows.length > 5);
  renderInbox();
}

let inboxRows = [];

function renderInbox() {
  const q = $('inbox-search').value.trim().toLowerCase();
  const rows = q ? inboxRows.filter(f => `${f.name} ${f.note || ''}`.toLowerCase().includes(q)) : inboxRows;
  $('team-inbox').innerHTML = rows.length ? rows.map(f => `
    <div class="file-item">
      <div class="file-item-info">
        <span class="file-item-name">${escapeHtml(f.name)}</span>
        <span class="file-item-meta">${formatSize(f.size_bytes || 0)} · ${f.via_request ? 'through a request link' : 'added by a member'} · ${new Date(f.uploaded_at).toLocaleString()}</span>
        ${f.note ? `<span class="file-item-meta team-file-from">${escapeHtml(f.note)}</span>` : ''}
      </div>
      <div class="file-item-actions">
        ${f.url ? `<a class="btn btn-ghost btn-small" href="${escapeHtml(f.url)}" target="_blank" rel="noopener noreferrer">Open</a>` : ''}
        <button class="btn btn-ghost btn-small" data-delete-file="${escapeHtml(f.short_id)}">Delete</button>
      </div>
    </div>`).join('')
    : `<p class="teams-empty">${q ? 'No files match.' : 'No files yet. Add one above, or send out a request link.'}</p>`;
}
$('inbox-search').addEventListener('input', renderInbox);

// ── adding a file for the team ───────────────────────────────────────────────
// Locked here with a fresh key, and that key sealed to the team's own public
// key (worked out from the key ring, never taken from the server), with a
// sealed note saying who added it: the same as a file through a team request link.
let addFile = null;

function resetAdd() {
  addFile = null;
  $('add-file').value = '';
  $('add-note').value = '';
  $('add-error').textContent = '';
  $('add-drop-text').innerHTML = '<strong>Add a file for the team</strong> or drop it here · up to 10 MB';
  show('add-details', false);
  show('add-actions', false);
}

function pickAddFile(file) {
  if (!file) return;
  $('add-error').textContent = '';
  if (file.size > 10 * 1024 * 1024) { $('add-error').textContent = 'That file is over 10 MB.'; return; }
  addFile = file;
  $('add-drop-text').innerHTML = `<strong>${escapeHtml(file.name)}</strong> · ${formatSize(file.size)} · choose another`;
  show('add-details');
  show('add-actions');
}

$('add-file').addEventListener('change', () => pickAddFile($('add-file').files[0]));
$('add-drop').addEventListener('keydown', e => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('add-file').click(); }
});
$('add-drop').addEventListener('dragover', e => { e.preventDefault(); $('add-drop').classList.add('dragover'); });
$('add-drop').addEventListener('dragleave', () => $('add-drop').classList.remove('dragover'));
$('add-drop').addEventListener('drop', e => {
  e.preventDefault();
  $('add-drop').classList.remove('dragover');
  pickAddFile(e.dataTransfer.files[0]);
});
$('add-cancel').addEventListener('click', resetAdd);

$('add-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!addFile || !current) return;
  $('add-btn').disabled = true;
  $('add-error').textContent = '';
  try {
    const bytes = new Uint8Array(await addFile.arrayBuffer());
    const type = detectType(bytes, addFile.name, addFile.type);
    if (!type || type === NOT_UTF8) throw new Error(type ? ENCODING_ERROR : TYPES_ERROR);
    const key = newFileKey();
    const message = $('add-note').value.trim();
    const form = new FormData();
    form.append('file', new Blob([await lockFile(key, bytes)]), 'sealed.bin');
    form.append('meta', await lockMeta(key, { name: nameFor('', addFile.name, type), type }));
    form.append('inbox_key', await sealKey(current.keys.publicKey, key));
    form.append('note', await lockText(key, `From @${me.username}${message ? `: ${message}` : ''}`, 'note'));
    form.append('hours', $('add-hours').value);
    await api(`/api/teams/${current.team.id}/inbox`, { method: 'POST', body: form });
    toast('Added for the team.', 'success');
    resetAdd();
    loadInbox().catch(err => toast(err.message, 'error'));
  } catch (err) {
    $('add-error').textContent = err.message;
  }
  $('add-btn').disabled = false;
});

$('team-inbox').addEventListener('click', async e => {
  const btn = e.target.closest('[data-delete-file]');
  if (!btn) return;
  if (!(await confirmAction({ title: 'Delete this file?', text: 'It’s erased for everyone in the team.', confirm: 'Delete', danger: true }))) return;
  try {
    await api(`/api/teams/${current.team.id}/inbox/${btn.dataset.deleteFile}`, { method: 'DELETE' });
    loadInbox();
  } catch (err) { toast(err.message, 'error'); }
});

// ── request links ────────────────────────────────────────────────────────────
// The same links as your own (/q/<id>#r=…&pk=…), with the team's public key,
// so whatever's sent is sealed to the team.
const requestLink = (id, key) => `${location.origin}/q/${id}#r=${toB64url(key)}&pk=${current.keys.publicKey}`;

async function loadRequests() {
  const { requests } = await api(`/api/requests?team=${current.team.id}`);
  const rows = [];
  for (const r of requests) {
    const key = await openTeamBox(current.keys.privateKeys, r.owner_box);
    if (!key) continue;
    try { rows.push({ ...r, label: await unlockText(key, r.label, 'request'), link: requestLink(r.id, key) }); } catch {}
  }
  $('team-requests').innerHTML = rows.length ? rows.map(r => `
    <div class="file-item">
      <div class="file-item-info">
        <span class="file-item-name">${escapeHtml(r.label)}</span>
        <span class="file-item-meta">${r.received} of ${r.max_files} received · by @${escapeHtml(r.made_by || 'someone')} · closes ${new Date(r.expires_at).toLocaleDateString()}</span>
      </div>
      <div class="file-item-actions">
        <button class="btn btn-ghost btn-small" data-copy="${escapeHtml(r.link)}">Copy link</button>
        ${current.team.role === 'admin' || r.made_by === me.username ? `<button class="btn btn-ghost btn-small" data-close="${escapeHtml(r.id)}">Close</button>` : ''}
      </div>
    </div>`).join('') : '<p class="teams-empty">No open request links.</p>';
  const mayMake = current.team.requests_by !== 'admins' || current.team.role === 'admin';
  show('request-form', mayMake);
  show('request-admins-only', !mayMake);
  $('count-requests').textContent = rows.length ? String(rows.length) : '';
}

$('request-form').addEventListener('submit', async e => {
  e.preventDefault();
  const label = $('request-label').value.trim();
  if (!label) { $('request-error').textContent = 'Say what you need, so they know what to send.'; return; }
  $('request-btn').disabled = true;
  $('request-error').textContent = '';
  try {
    const key = newFileKey();
    const { id } = await api('/api/requests', {
      method: 'POST',
      body: {
        team_id: current.team.id,
        label: await lockText(key, label, 'request'),
        owner_box: await sealKey(current.keys.publicKey, key),
        hours: Number($('request-hours').value),
        max_files: Number($('request-max').value),
        file_hours: 240,
      },
    });
    await navigator.clipboard.writeText(requestLink(id, key)).then(() => toast('Link made and copied.', 'success'), () => toast('Link made.', 'success'));
    $('request-label').value = '';
    loadRequests();
  } catch (err) {
    $('request-error').textContent = err.message;
  }
  $('request-btn').disabled = false;
});

$('team-requests').addEventListener('click', async e => {
  const copy = e.target.closest('[data-copy]');
  if (copy) { navigator.clipboard.writeText(copy.dataset.copy).then(() => toast('Link copied.', 'success')); return; }
  const close = e.target.closest('[data-close]');
  if (!close) return;
  const res = await fetch(`/api/requests/${encodeURIComponent(close.dataset.close)}`, { method: 'DELETE', headers: auth }).catch(() => null);
  toast(res?.ok ? 'Closed. Files already sent stay in the inbox.' : 'Couldn’t close it. Try again.', res?.ok ? 'success' : 'error');
  loadRequests();
});

// ── people ───────────────────────────────────────────────────────────────────
let members = [];

async function loadMembers() {
  ({ members } = await api(`/api/teams/${current.team.id}/members`));
  $('count-members').textContent = String(members.length);
  const admin = current.team.role === 'admin';
  $('team-members').innerHTML = members.map(m => `
    <div class="file-item">
      <div class="file-item-info">
        <span class="file-item-name">@${escapeHtml(m.username)}${m.username === me.username ? ' (you)' : ''}</span>
        <span class="file-item-meta">${m.role === 'admin' ? 'Admin' : 'Member'} · since ${new Date(m.added_at).toLocaleDateString()}</span>
      </div>
      ${admin && m.username !== me.username ? `<div class="file-item-actions">
        <button class="btn btn-ghost btn-small" data-role="${escapeHtml(m.username)}" data-to="${m.role === 'admin' ? 'member' : 'admin'}">${m.role === 'admin' ? 'Make member' : 'Make admin'}</button>
        <button class="btn btn-ghost btn-small" data-remove="${escapeHtml(m.username)}">Remove</button>
      </div>` : ''}
    </div>`).join('');
}

$('member-form').addEventListener('submit', async e => {
  e.preventDefault();
  const username = $('member-name').value.trim().replace(/^@/, '');
  if (!username) return;
  $('member-btn').disabled = true;
  $('member-error').textContent = '';
  try {
    // their key, checked against the public key log and your saved contacts
    const found = await publicKeyFor(username);
    if (found === undefined) throw new Error('There’s no one with that username.');
    if (!found) throw new Error('They need to sign in to ShareSecure once before they can join a team.');
    await api(`/api/teams/${current.team.id}/members`, {
      method: 'POST',
      body: { username, role: $('member-role').value, key_box: await sealRing(found.publicKey, current.keys.ring) },
    });
    $('member-name').value = '';
    toast(`Added @${username}. Their security code is ${found.code}.`, 'success');
    loadMembers();
  } catch (err) {
    $('member-error').textContent = err.message;
  }
  $('member-btn').disabled = false;
});

// A new team key, plus all the old ones, sealed to everyone still in.
async function rotate() {
  ({ members } = await api(`/api/teams/${current.team.id}/members`));
  const key = await newTeamKey();
  const ring = { keys: [...current.keys.ring.keys, key.pkcs8] };
  const boxes = {};
  for (const m of members) {
    const pub = m.username === me.username ? me.publicKey : (await publicKeyFor(m.username))?.publicKey;
    if (!pub) throw new Error(`Couldn’t find @${m.username}’s key, so the team key wasn’t changed.`);
    boxes[m.username] = await sealRing(pub, ring);
  }
  await api(`/api/teams/${current.team.id}/keys`, { method: 'PUT', body: { public_key: key.publicKey, boxes } });
  const team = { ...current.team, public_key: key.publicKey, key_box: boxes[me.username] };
  teams = teams.map(t => (t.id === team.id ? team : t));
  current = { team, keys: await openRing(team, me) };
  $('team-code').textContent = await fingerprint(current.keys.publicKey);
  $('team-warning').textContent = '';
}

$('team-members').addEventListener('click', async e => {
  const role = e.target.closest('[data-role]');
  const remove = e.target.closest('[data-remove]');
  try {
    if (role) {
      await api(`/api/teams/${current.team.id}/members/${encodeURIComponent(role.dataset.role)}`, { method: 'PATCH', body: { role: role.dataset.to } });
    } else if (remove) {
      const name = remove.dataset.remove;
      if (!(await confirmAction({ title: `Remove @${name}?`, text: 'They lose the team inbox and its request links straight away, and the team gets a new key.', confirm: 'Remove', danger: true }))) return;
      await api(`/api/teams/${current.team.id}/members/${encodeURIComponent(name)}`, { method: 'DELETE' });
      await rotate();
      toast(`Removed @${name}, and made a new team key.`, 'success');
    } else return;
    loadMembers();
  } catch (err) { toast(err.message, 'error'); }
});

$('leave-btn').addEventListener('click', async () => {
  if (!(await confirmAction({ title: `Leave ${current.team.name}?`, text: 'You lose its inbox and request links. An admin can add you back.', confirm: 'Leave', danger: true }))) return;
  try {
    await api(`/api/teams/${current.team.id}/members/${encodeURIComponent(me.username)}`, { method: 'DELETE' });
    toast('You left the team.', 'success');
    $('team-back').click();
  } catch (err) { toast(err.message, 'error'); }
});

// ── settings (admins) ────────────────────────────────────────────────────────
let logoChange;   // undefined: unchanged, null: removed, string: new
$('settings-logo').addEventListener('change', () => {
  const file = $('settings-logo').files[0];
  if (!file) return;
  if (file.size > 60 * 1024) { $('settings-error').textContent = 'The logo has to be under 60 KB.'; return; }
  const reader = new FileReader();
  reader.onload = () => { logoChange = reader.result; $('team-logo').src = logoChange; show('team-logo'); };
  reader.readAsDataURL(file);
});
$('settings-logo-clear').addEventListener('click', () => { logoChange = null; show('team-logo', false); });

$('settings-form').addEventListener('submit', async e => {
  e.preventDefault();
  $('settings-error').textContent = '';
  try {
    const body = { name: $('settings-name').value, color: $('settings-color').value, requests_by: $('settings-requests').value };
    if (logoChange !== undefined) body.logo = logoChange;
    await api(`/api/teams/${current.team.id}`, { method: 'PATCH', body });
    logoChange = undefined;
    await loadTeams();
    openTeam(current.team.id);
    toast('Saved.', 'success');
  } catch (err) { $('settings-error').textContent = err.message; }
});

$('rotate-btn').addEventListener('click', async () => {
  try { await rotate(); toast('New team key made.', 'success'); } catch (err) { toast(err.message, 'error'); }
});

$('delete-team-btn').addEventListener('click', async () => {
  if (!(await confirmAction({ title: `Delete ${current.team.name}?`, text: 'Its request links stop working and every file in its inbox is erased, for everyone. This can’t be undone.', confirm: 'Delete team', danger: true }))) return;
  try {
    await api(`/api/teams/${current.team.id}`, { method: 'DELETE' });
    toast('Team deleted.', 'success');
    $('team-back').click();
  } catch (err) { toast(err.message, 'error'); }
});

// ── start ────────────────────────────────────────────────────────────────────
(async () => {
  me = await myKeys();
  if (!me?.publicKey) { location.replace('/signin?next=/teams'); return; }
  try {
    await loadTeams();
    const wanted = location.hash.slice(1);
    if (wanted) openTeam(wanted);
  } catch (err) { toast(err.message, 'error'); }
})();
