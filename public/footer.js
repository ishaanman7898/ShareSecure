// Fills in the version wherever a page shows it ([data-version]) and keeps the
// site footer to the website: a self-hosted install drops it, and the desktop
// app hides it through its .web-only class.
(function () {
  fetch('/api/mode', { cache: 'no-store' })
    .then(r => r.json())
    .then(mode => {
      if (mode.selfHostMode) document.querySelectorAll('.app-footer').forEach(f => f.remove());
      if (!mode.version) return;
      document.querySelectorAll('[data-version]').forEach(el => {
        el.textContent = (el.dataset.version || '') + 'v' + mode.version;
        el.hidden = false;
      });
    })
    .catch(() => {});
})();
