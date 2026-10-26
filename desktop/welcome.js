// The same moving gradient as the sign-in page, behind the first-launch choice.
import { mountGradientASCII } from '../public/gradient-ascii.js';

mountGradientASCII(document.getElementById('gradient'), {
  shape: 'rise',
  cellSize: 18,
  density: 0.8,
  speed: 0.7,
  lightMode: !matchMedia('(prefers-color-scheme: dark)').matches,
});
