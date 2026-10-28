// Your list of shares, kept on the server sealed to your own key, so "Your
// shares" is the same on every device, including anonymous uploads the server
// can't tie to you.
//
// It's saved now and then (when you leave the page, or a minute or two after
// opening it), never right after an upload, so the timing doesn't point back
// at which anonymous upload was yours. The list is padded to a standard size.
import { newFileKey, sealKey, openKey, lockText, unlockText, isSealed } from './sealed.js';
import { myKeys } from './keys.js';

// What's kept of each share: enough to show it, open it and delete it.
const FIELDS = ['short_id', 'short_url', 'original_filename', 'mime_type', 'size_bytes', 'expires_at', 'uploaded_at', 'delete_token'];

// → the list, [] when there's none yet, or null when it can't be opened here
export async function loadVault(authHeaders) {
  const me = await myKeys();
  if (!me) return null;
  try {
    const res = await fetch('/api/vault', { headers: authHeaders });
    if (!res.ok) return null;
    const { vault } = await res.json();
    if (!vault) return [];
    const [sealedKey, box] = vault.split('|');
    const key = await openKey(me.privateKey, sealedKey);
    return JSON.parse(await unlockText(key, box, 'vault')).list || [];
  } catch {
    return null;
  }
}

export async function saveVault(authHeaders, list) {
  const me = await myKeys();
  if (!me?.publicKey) return false;
  const clean = list.map(r => Object.fromEntries(FIELDS.map(f => [f, r[f] ?? null])));
  let text = JSON.stringify({ list: clean });
  // pad to the next 4 KB so the size doesn't count your shares
  text += ' '.repeat((4096 - (text.length % 4096)) % 4096);
  const key = newFileKey();
  const vault = `${await sealKey(me.publicKey, key)}|${await lockText(key, text, 'vault')}`;
  if (!isSealed(vault)) return false;
  const res = await fetch('/api/vault', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify({ vault }),
  }).catch(() => null);
  return Boolean(res?.ok);
}
