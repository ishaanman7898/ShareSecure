// The upload page an assistant hands out (/drop/<ticket>). The ticket already
// carries the assistant's choices (expiry, who to send it to), works once, and
// expires after 30 minutes.
(function () {
  const $ = id => document.getElementById(id);
  const ticket = location.pathname.split('/drop/')[1] || '';
  const input = $('drop-input');
  const zone = $('drop-zone');
  const submit = $('drop-submit');
  const error = $('drop-error');
  let file = null;

  function pick(f) {
    error.textContent = '';
    if (!f) return;
    if (!/\.(pdf|docx|png|jpe?g|txt|md|markdown|csv)$/i.test(f.name)) { error.textContent = 'Choose a PDF, DOCX, PNG, JPG or text (.txt, .md, .csv) file.'; return; }
    if (f.size > 10 * 1024 * 1024) { error.textContent = 'That file is over 10 MB.'; return; }
    file = f;
    $('drop-label').textContent = f.name;
    submit.disabled = false;
  }

  zone.addEventListener('click', () => input.click());
  zone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('dragover'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('dragover'));
  zone.addEventListener('drop', e => { e.preventDefault(); zone.classList.remove('dragover'); pick(e.dataTransfer.files[0]); });
  input.addEventListener('change', () => pick(input.files[0]));

  $('drop-form').addEventListener('submit', async e => {
    e.preventDefault();
    if (!file) return;
    submit.disabled = true;
    submit.textContent = 'Uploading…';
    error.textContent = '';
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(`/api/mcp/upload/${encodeURIComponent(ticket)}`, { method: 'POST', body: form });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.url) throw new Error(data.error || 'Couldn’t share the file. Try again.');

      $('drop-form').classList.add('hidden');
      $('drop-link').textContent = data.url;
      $('drop-link').href = data.url;
      $('drop-open').href = data.url;
      if (data.sent_to?.length) $('drop-note').textContent = `Sent to ${data.sent_to.join(', ')}. Your assistant gets the link too.`;
      $('drop-done').classList.remove('hidden');
    } catch (err) {
      error.textContent = err.message;
      submit.disabled = false;
      submit.textContent = 'Share it';
    }
  });

  $('drop-copy').addEventListener('click', () => {
    navigator.clipboard.writeText($('drop-link').textContent).then(() => {
      $('drop-copy').textContent = 'Copied';
      setTimeout(() => { $('drop-copy').textContent = 'Copy link'; }, 1800);
    }).catch(() => {});
  });
})();
