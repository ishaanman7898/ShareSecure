const $ = id => document.getElementById(id);
const form = $('send-form');
const errorEl = $('send-error');
const submit = $('send-submit');

const MAX_BYTES = 10 * 1024 * 1024;

function showState(state) {
  $('send-closed').classList.toggle('hidden', state !== 'closed');
  form.classList.toggle('hidden', state !== 'form');
  $('send-done').classList.toggle('hidden', state !== 'done');
}

form.addEventListener('submit', async e => {
  e.preventDefault();
  errorEl.textContent = '';
  const username = $('send-username').value.trim();
  const file = $('send-file').files[0];

  if (!username) { errorEl.textContent = 'Enter their username.'; $('send-username').focus(); return; }
  if (!file) { errorEl.textContent = 'Choose a file to send.'; return; }
  if (file.size > MAX_BYTES) { errorEl.textContent = 'That file is over 10 MB.'; return; }

  const data = new FormData();
  data.append('username', username);
  data.append('file', file);
  data.append('note', $('send-note').value.trim());
  data.append('expires_hours', $('send-expiry').value);

  submit.disabled = true;
  submit.textContent = 'Sending…';
  try {
    const res = await fetch('/api/incoming', { method: 'POST', body: data });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || 'Couldn’t send the file. Try again.');
    form.reset();
    showState('done');
  } catch (err) {
    errorEl.textContent = err.message;
  } finally {
    submit.disabled = false;
    submit.textContent = 'Send file';
  }
});

$('send-another').addEventListener('click', () => {
  showState('form');
  $('send-file').focus();
});

(async () => {
  try {
    const mode = await fetch('/api/mode').then(r => r.json());
    // on the hosted version, sending happens inside the app
    if (!mode.selfHostMode) { location.replace('/'); return; }
    const status = await fetch('/api/incoming/status').then(r => r.json());
    showState(status.enabled ? 'form' : 'closed');
    if (status.enabled) $('send-username').focus();
  } catch {
    showState('closed');
  }
})();
