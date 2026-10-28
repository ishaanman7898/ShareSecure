// Screenshot resistance for the viewer: screenshot-resistant and traceable,
// never screenshot-proof. A browser can't stop every screenshot, screen
// recorder or phone camera. What these do is make casual copying harder, and
// the watermark is what makes a leak traceable back to one opening of a link.
//
// Both are off unless the sender turns them on for a share:
//   watermark   a faint repeating mark over the file: who opened it (their
//               username if signed in, otherwise "Guest"), when, and the
//               link's short id. Drawn here, after decrypting, over the page;
//               the file itself is never changed.
//   discourage  for view-only shares: no printing, PrintScreen clears the
//               clipboard and blurs the file for a moment, no right-click,
//               selecting or dragging. In the desktop app the window is also
//               hidden from screenshots and recordings (Windows and macOS).
//
// The settings travel in the share's sealed name (sealed.js lockMeta), so the
// server can't see or change them, and nothing here talks to the server: who
// opened what stays in this browser.

// What a share gets → { watermark, deterrents }. Deterrents only make sense
// when people can't simply download the file.
export function protectionsFor({ allowDownload = false, watermark = false, discourage = false } = {}) {
  return { watermark: Boolean(watermark), deterrents: Boolean(discourage) && !allowDownload };
}

// The username in a ShareSecure sign-in token, read here and never sent anywhere.
export function usernameFromSession(token) {
  try {
    const body = String(token || '').split('.')[0];
    const json = atob(body.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(body.length / 4) * 4, '='));
    const name = JSON.parse(decodeURIComponent(escape(json))).username;
    return typeof name === 'string' && name ? name : null;
  } catch { return null; }
}

const two = n => String(n).padStart(2, '0');

// "@alice · 2026-10-27 14:05 · k3Tq9a"
export function watermarkText({ username = null, openedAt = new Date(), linkId = '' } = {}) {
  const d = openedAt;
  const when = `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
  return [username ? `@${username}` : 'Guest', when, String(linkId).slice(0, 6)].filter(Boolean).join(' · ');
}

// ── the watermark ────────────────────────────────────────────────────────────
// A fixed layer over the whole viewer, so it stays over every page while
// scrolling and zooming. It's put back if it's removed, hidden or restyled.
export function mountWatermark(doc, text) {
  const tile = doc.createElement('canvas');
  const ctx = tile.getContext('2d');
  const font = '600 15px ui-sans-serif, system-ui, sans-serif';
  ctx.font = font;
  const width = Math.ceil(ctx.measureText(text).width) + 120;
  tile.width = width;
  tile.height = 170;
  ctx.font = font;
  ctx.translate(width / 2, 85);
  ctx.rotate(-Math.PI / 7);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  // dark and light together, so it shows on white pages and dark images alike
  ctx.fillStyle = 'rgba(0, 0, 0, 0.13)';
  ctx.fillText(text, 0, 0);
  ctx.fillStyle = 'rgba(255, 255, 255, 0.13)';
  ctx.fillText(text, 1, 1);
  const image = `url("${tile.toDataURL('image/png')}")`;

  const STYLE = [
    'position:fixed', 'inset:0', 'z-index:2147483000', 'pointer-events:none', 'display:block', 'opacity:1',
    'visibility:visible', `background-image:${image}`, 'background-repeat:repeat', 'mix-blend-mode:normal',
  ].join(';');

  let layer = null;
  const place = () => {
    if (!layer || !layer.isConnected) {
      layer = doc.createElement('div');
      layer.setAttribute('aria-hidden', 'true');
      layer.dataset.watermark = '';
      doc.body.appendChild(layer);
    }
    if (layer.getAttribute('style') !== STYLE) layer.setAttribute('style', STYLE);
    if (layer.hidden) layer.hidden = false;
  };
  place();

  const watch = new MutationObserver(place);
  watch.observe(doc.body, { childList: true, subtree: false, attributes: true });
  const own = new MutationObserver(place);
  const follow = () => own.observe(layer, { attributes: true });
  follow();
  // a new layer needs watching too
  const timer = setInterval(() => { const before = layer; place(); if (layer !== before) follow(); }, 1500);
  return () => { watch.disconnect(); own.disconnect(); clearInterval(timer); layer?.remove(); };
}

// ── deterrents ───────────────────────────────────────────────────────────────
// win and doc are the page's window and document; blur(ms) hides the file for
// a moment. → a function that takes them all off again
export function installDeterrents(win, doc, { blur = () => {}, area = null } = {}) {
  const style = doc.createElement('style');
  style.textContent = '@media print { body { display: none !important; } } .no-copy, .no-copy * { -webkit-user-select: none !important; user-select: none !important; -webkit-touch-callout: none !important; }';
  doc.head.appendChild(style);
  const target = area || doc.body;
  target.classList.add('no-copy');

  const onKeyDown = e => {
    const key = String(e.key || '').toLowerCase();
    if ((e.ctrlKey || e.metaKey) && (key === 'p' || key === 's')) e.preventDefault();
  };
  const onKeyUp = e => {
    if (e.key !== 'PrintScreen') return;
    // what the screenshot put on the clipboard is replaced, where the browser allows it
    try { win.navigator?.clipboard?.writeText?.('')?.catch?.(() => {}); } catch {}
    blur(1500);
  };
  const stop = e => e.preventDefault();

  win.addEventListener('keydown', onKeyDown, true);
  win.addEventListener('keyup', onKeyUp, true);
  target.addEventListener('contextmenu', stop);
  target.addEventListener('selectstart', stop);
  target.addEventListener('dragstart', stop);

  return () => {
    style.remove();
    target.classList.remove('no-copy');
    win.removeEventListener('keydown', onKeyDown, true);
    win.removeEventListener('keyup', onKeyUp, true);
    target.removeEventListener('contextmenu', stop);
    target.removeEventListener('selectstart', stop);
    target.removeEventListener('dragstart', stop);
  };
}

// What the share options and viewer say, in one place
export const HONEST_NOTE = 'Screenshot-resistant and traceable, not screenshot-proof. No browser can fully block screenshots, screen recorders or a phone camera; the watermark is what makes a leak traceable.';
