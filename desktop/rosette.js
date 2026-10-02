'use strict';
// Draws ShareSecure's logo: the guilloché rosette from the landing page, light
// lines on a dark tile (so it shows on any background), as a small SVG that
// animates on its own: the bands engrave in, then keep turning slowly against
// each other. The loading version turns about ten times faster.
//   node desktop/rosette.js   → public/rosette.svg and public/rosette-loading.svg
// It's the same formula as drawRosette() in public/app.js, with fewer rings
// so it still reads at 28 pixels.
const fs = require('fs');
const path = require('path');

const C = 50;          // the drawing is 100 × 100
const STEPS = 200;
const bands = [
  { base: 36, amp: 3.2, k: 24, n: 5, cls: 'b1', spin: 120, reverse: false },
  { base: 27.5, amp: 4, k: 16, n: 5, cls: 'b2', spin: 90, reverse: true },
  { base: 18.5, amp: 4.2, k: 12, n: 5, cls: 'b3', spin: 72, reverse: false },
  { base: 9.5, amp: 3.4, k: 8, n: 4, cls: 'b4', spin: 54, reverse: true },
];

const f = n => n.toFixed(2).replace(/\.?0+$/, '');
let groups = '';
bands.forEach((b, bi) => {
  let paths = '';
  for (let i = 0; i < b.n; i++) {
    const phase = (i / b.n) * Math.PI * 2;
    let d = '';
    for (let s = 0; s <= STEPS; s++) {
      const t = (s / STEPS) * Math.PI * 2;
      const r = b.base + b.amp * Math.sin(b.k * t + phase) * Math.cos(t * 2 + phase / 3);
      d += (s ? 'L' : 'M') + f(C + r * Math.cos(t)) + ' ' + f(C + r * Math.sin(t));
    }
    const delay = ((3 - bi) * 0.12 + i * 0.03).toFixed(2);
    paths += `<path d="${d}Z" pathLength="1" style="animation-delay:${delay}s"/>`;
  }
  groups += `<g class="${b.cls}">${paths}</g>`;
});

// speed: how many times faster than the landing page the bands turn
function svgFor(speed) {
  const spins = bands.map(b => `.${b.cls}{animation:turn ${f(b.spin / speed)}s linear infinite${b.reverse ? ' reverse' : ''}}`).join('');
  const css = [
    'path{fill:none;stroke:#f2f2f2;stroke-width:0.8;stroke-linejoin:round}',
    '.b1{opacity:.85}.b2{opacity:.55}.b3{opacity:.8}.b4{opacity:.5}',
    'g{transform-origin:50px 50px}',
    '@media (prefers-reduced-motion:no-preference){',
    'path{stroke-dasharray:1;stroke-dashoffset:1;animation:engrave 1.4s cubic-bezier(.45,0,.2,1) forwards}',
    spins,
    '}',
    '@keyframes engrave{to{stroke-dashoffset:0}}',
    '@keyframes turn{to{transform:rotate(360deg)}}',
  ].join('\n');
  return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" role="img" aria-label="ShareSecure">' +
    `<style>${css}</style><rect width="100" height="100" rx="23" fill="#0b0b0b"/>${groups}</svg>\n`;
}

for (const [name, speed] of [['rosette.svg', 1], ['rosette-loading.svg', 10]]) {
  const svg = svgFor(speed);
  const out = path.join(__dirname, '..', 'public', name);
  fs.writeFileSync(out, svg);
  console.log(`${out}: ${(svg.length / 1024).toFixed(1)} KB`);
}
