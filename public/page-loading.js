// Show real startup activity, then give the mark a short, calm exit.
// Loaded before app.js so even a cached or first-visit startup is covered.
(() => {
  const loader = document.getElementById('page-loader');
  if (!loader) return;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const started = performance.now();
  let finished = false;
  let ready = false;
  let exitTimer;

  loader.hidden = false;
  document.body.classList.add('page-loading');

  function finish() {
    if (finished) return;
    finished = true;
    clearTimeout(exitTimer);
    clearTimeout(fallback);
    document.removeEventListener('sharesecure:ready', onReady);
    motion.removeEventListener('change', onMotionChange);
    document.body.classList.remove('page-loading');
    loader.classList.add('is-complete');
    setTimeout(() => loader.remove(), motion.matches ? 0 : 400);
  }

  function onReady() {
    ready = true;
    // Avoid a flash on fast connections without slowing app initialization.
    exitTimer = setTimeout(finish, motion.matches ? 0 : Math.max(0, 650 - (performance.now() - started)));
  }

  function onMotionChange() {
    if (ready && motion.matches) finish();
  }

  document.addEventListener('sharesecure:ready', onReady, { once: true });
  motion.addEventListener('change', onMotionChange);
  // A failed app script must never leave an overlay blocking the page.
  const fallback = setTimeout(finish, 5000);
})();
