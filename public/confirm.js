// "You're about to do this. Continue?" inside the app, instead of the browser's
// own confirm(). Buttons, Enter and Escape work everywhere; on a touch screen the
// card can also be swiped right to go ahead or left to cancel.
//   await confirmAction({ title, text, confirm: 'Delete', danger: true }) → true | false

const SWIPE_SHARE = 0.32;   // of the card's width, to count as a choice
const FLICK_SPEED = 0.6;    // px per ms: a quick flick counts even if short

let open = null;            // only one at a time

export function confirmAction({ title, text = '', confirm = 'Continue', cancel = 'Cancel', danger = false } = {}) {
  if (open) open.settle(false);
  return new Promise(resolve => {
    const returnFocus = document.activeElement;
    const layer = document.createElement('div');
    layer.className = 'confirm-layer';
    layer.innerHTML = `
      <div class="confirm-card${danger ? ' confirm-danger' : ''}" role="alertdialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-text">
        <span class="confirm-tint confirm-tint-yes" aria-hidden="true"></span>
        <span class="confirm-tint confirm-tint-no" aria-hidden="true"></span>
        <h2 id="confirm-title"></h2>
        <p id="confirm-text"></p>
        <div class="confirm-actions">
          <button type="button" class="btn btn-ghost" data-answer="no"></button>
          <button type="button" class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-answer="yes"></button>
        </div>
        <p class="confirm-hint" aria-hidden="true"><span>← Cancel</span><span></span></p>
      </div>`;
    const card = layer.querySelector('.confirm-card');
    layer.querySelector('h2').textContent = title;
    layer.querySelector('#confirm-text').textContent = text;
    layer.querySelector('[data-answer="no"]').textContent = cancel;
    layer.querySelector('[data-answer="yes"]').textContent = confirm;
    layer.querySelector('.confirm-hint span:last-child').textContent = `${confirm} →`;
    if (!text) layer.querySelector('#confirm-text').remove();
    document.body.appendChild(layer);
    void layer.offsetWidth;   // lay it out closed first, so opening animates
    layer.classList.add('is-open');

    let done = false;
    const settle = (answer, direction = 0) => {
      if (done) return;
      done = true;
      open = null;
      document.removeEventListener('keydown', onKey, true);
      if (direction) card.style.transform = `translateX(${direction * 120}%) rotate(${direction * 8}deg)`;
      layer.classList.remove('is-open');
      layer.classList.add('is-closing');
      setTimeout(() => layer.remove(), matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 260);
      returnFocus?.focus?.();
      resolve(answer);
    };
    open = { settle };

    layer.addEventListener('click', e => {
      if (e.target === layer) settle(false);
      const button = e.target.closest('[data-answer]');
      if (button) settle(button.dataset.answer === 'yes');
    });

    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); settle(false); }
      else if (e.key === 'Enter' && !e.target.closest?.('[data-answer="no"]')) { e.preventDefault(); settle(true); }
      else if (e.key === 'Tab') {
        // keep focus on the two buttons
        const [no, yes] = card.querySelectorAll('[data-answer]');
        if (e.shiftKey && document.activeElement === no) { e.preventDefault(); yes.focus(); }
        else if (!e.shiftKey && document.activeElement === yes) { e.preventDefault(); no.focus(); }
      }
    };
    document.addEventListener('keydown', onKey, true);
    // the safe choice has focus, so a stray Enter on a keyboard can't delete anything
    card.querySelector('[data-answer="no"]').focus();

    // ── swiping ─────────────────────────────────────────────────────────────
    let start = null;
    card.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' || e.target.closest('button')) return;
      start = { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId, dx: 0 };
    });
    card.addEventListener('pointermove', e => {
      if (!start || e.pointerId !== start.id) return;
      const dx = e.clientX - start.x, dy = e.clientY - start.y;
      if (!start.dragging) {
        if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy)) return;   // a scroll, not a swipe
        start.dragging = true;
        try { card.setPointerCapture(e.pointerId); } catch {}
        card.classList.add('is-dragging');
      }
      start.dx = dx;
      const share = Math.min(Math.abs(dx) / (card.offsetWidth * SWIPE_SHARE), 1);
      card.style.transform = `translateX(${dx}px) rotate(${dx / 40}deg)`;
      card.style.setProperty('--yes', dx > 0 ? share : 0);
      card.style.setProperty('--no', dx < 0 ? share : 0);
    });
    const end = e => {
      if (!start || e.pointerId !== start.id) return;
      const { dx, t, dragging } = start;
      start = null;
      if (!dragging) return;
      card.classList.remove('is-dragging');
      const speed = Math.abs(dx) / Math.max(performance.now() - t, 1);
      if (Math.abs(dx) > card.offsetWidth * SWIPE_SHARE || (speed > FLICK_SPEED && Math.abs(dx) > 40)) {
        settle(dx > 0, Math.sign(dx));
      } else {
        card.style.transform = '';
        card.style.setProperty('--yes', 0);
        card.style.setProperty('--no', 0);
      }
    };
    card.addEventListener('pointerup', end);
    card.addEventListener('pointercancel', end);
  });
}
