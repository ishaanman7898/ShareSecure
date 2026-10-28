// The page shown while the app updates itself, after "Restart to update" or
// "Update to …" (see showUpdatePage in main.js): the download, then the
// install, which closes the app and opens the new version by itself.
import { mountGradientASCII } from '../public/gradient-ascii.js';

mountGradientASCII(document.getElementById('gradient'), {
  shape: 'rise',
  cellSize: 18,
  density: 0.8,
  speed: 0.7,
  lightMode: !matchMedia('(prefers-color-scheme: dark)').matches,
});

const $ = id => document.getElementById(id);
const params = new URLSearchParams(location.search);
const from = params.get('from');
const local = params.get('local') === '1';

$('note').textContent = local
  ? 'Links on this computer pause while it installs, and come back when ShareSecure reopens.'
  : 'Your links keep working while it updates.';

function render(s) {
  if (!s) return;
  const to = s.latest || params.get('to');
  $('versions').textContent = from && to ? `${from}  →  ${to}` : '';
  const installing = s.status === 'downloaded' || s.status === 'installing';
  const failed = s.status === 'error';
  $('title').textContent = failed ? 'The update didn’t finish' : installing ? 'Installing the update' : `Updating to ${to}`;
  $('lede').textContent = failed
    ? 'Nothing changed: you’re still on the version you had.'
    : installing
      ? 'ShareSecure closes and opens again by itself in a few seconds.'
      : 'Downloading the new version. Keep the app open.';
  $('bar').hidden = failed;
  $('bar').classList.toggle('sweep', installing);
  const progress = installing ? 100 : Math.max(0, Math.min(100, s.progress || 0));
  $('fill').style.width = installing ? '' : `${progress}%`;
  $('bar').setAttribute('aria-valuenow', String(progress));
  $('step').parentElement.hidden = failed;
  $('step').textContent = installing ? 'Installing' : 'Downloading';
  $('percent').textContent = installing ? '' : `${progress}%`;
  $('error').hidden = !failed;
  $('error').textContent = failed ? s.error || 'Something went wrong.' : '';
  $('actions').hidden = !failed;
}

render({ status: params.get('status'), latest: params.get('to'), progress: 0 });
window.shareSecureDesktop?.updates.onChange(render);
