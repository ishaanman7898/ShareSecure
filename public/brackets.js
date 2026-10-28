// White corner brackets that frame buttons, links, drop zones and anything
// marked data-crosshair-target as the pointer moves over them (crosshair.js,
// with its lines and coordinates turned off). Only on the public pages: not
// in the file viewer, where nothing should sit over a document, nor anywhere
// you use once signed in (your files, Settings, Teams). Only with a mouse or
// trackpad, still for people who prefer reduced motion, and off in Settings →
// Appearance.
import { mountCrosshair } from './crosshair.js';

const KEY = 'crosshair';
export const bracketsWanted = () => { try { return localStorage.getItem(KEY) !== 'off'; } catch { return true; } };
export function setBracketsWanted(on) { try { localStorage.setItem(KEY, on ? 'on' : 'off'); } catch {} syncBrackets(); }

// your files and Settings: signed in, and not looking at the home page
const inApp = () => document.body.classList.contains('is-logged-in')
  && document.getElementById('landing-page')?.classList.contains('hidden') !== false;

let remove = null;
export function syncBrackets() {
  const on = bracketsWanted()
    && window.matchMedia?.('(pointer: fine)').matches
    && !location.pathname.startsWith('/r/')
    && !inApp();
  if (on && !remove) {
    remove = mountCrosshair({
      lines: false, clickPulse: false, color: '#ffffff', blendMode: 'difference',
      opacity: 0.9, thickness: 1, smoothing: 0.35, targetEffect: 'lock', showCoordinates: false,
      targetSelector: 'a, button, summary, label.switch, [data-crosshair-target]',
    });
  } else if (!on && remove) {
    remove();
    remove = null;
  }
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', syncBrackets, { once: true });
else syncBrackets();
// another tab turned them on or off in Settings
window.addEventListener('storage', e => { if (e.key === KEY) syncBrackets(); });
