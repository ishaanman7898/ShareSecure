'use strict';
// Draws the ShareSecure app icon: a vault dial made of the same guilloché
// bands as the landing page, a timer arc for links that expire, and a keyhole.
//   node desktop/logo.js <size-of-tile> <margin>  → SVG on stdout
// The build renders it to PNG with desktop/render-icons.js.

// simple: the small-size version (favicons, the header), with the fine lines left out
function logo({ canvas = 1024, margin = 100, simple = false } = {}) {
  const S = canvas - margin * 2;          // tile size
  const C = canvas / 2;
  const u = S / 824;                      // 1 unit at the macOS reference size
  const f = n => n.toFixed(2);

  // guilloché bands, same formula as the landing rosette
  const bands = [
    { base: 262, amp: 16, k: 26, n: 7, w: 2.1, o: 0.55 },
    { base: 196, amp: 22, k: 18, n: 7, w: 2.1, o: 0.4 },
    { base: 140, amp: 18, k: 12, n: 6, w: 2.1, o: 0.5 },
  ];
  let rings = '';
  for (const b of simple ? [] : bands) {
    for (let i = 0; i < b.n; i++) {
      const phase = (i / b.n) * Math.PI * 2;
      let d = '';
      for (let s = 0; s <= 720; s++) {
        const t = (s / 720) * Math.PI * 2;
        const r = (b.base + b.amp * Math.sin(b.k * t + phase) * Math.cos(t * 2 + phase / 3)) * u;
        d += (s ? 'L' : 'M') + f(C + r * Math.cos(t)) + ' ' + f(C + r * Math.sin(t));
      }
      rings += `<path d="${d}Z" fill="none" stroke="#fff" stroke-opacity="${b.o}" stroke-width="${f(b.w * u)}"/>`;
    }
  }

  // tick ring
  let ticks = '';
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2 - Math.PI / 2, major = i % 5 === 0;
    if (simple) continue;
    const r1 = (major ? 300 : 308) * u, r2 = 318 * u;
    ticks += `<line x1="${f(C + r1 * Math.cos(a))}" y1="${f(C + r1 * Math.sin(a))}" x2="${f(C + r2 * Math.cos(a))}" y2="${f(C + r2 * Math.sin(a))}" stroke="#fff" stroke-opacity="${major ? 0.9 : 0.35}" stroke-width="${f((major ? 6 : 3) * u)}" stroke-linecap="round"/>`;
  }

  // timer arc: two-thirds of the way round, starting at 12 o'clock
  const R = (simple ? 300 : 348) * u, sweep = 0.68, arcW = (simple ? 52 : 14) * u;
  const a0 = -Math.PI / 2, a1 = a0 + sweep * Math.PI * 2;
  const arc = `M${f(C + R * Math.cos(a0))} ${f(C + R * Math.sin(a0))} A${f(R)} ${f(R)} 0 1 1 ${f(C + R * Math.cos(a1))} ${f(C + R * Math.sin(a1))}`;
  const knobX = C + R * Math.cos(a1), knobY = C + R * Math.sin(a1);

  // keyhole, on a disc that grows in the simple version so it still reads at 16px
  const k = simple ? 1.7 : 1;
  const hole = `M${f(C)} ${f(C - 58 * u)} a${f(34 * u)} ${f(34 * u)} 0 0 1 ${f(20 * u)} ${f(61.5 * u)} L${f(C + 30 * u)} ${f(C + 66 * u)} H${f(C - 30 * u)} L${f(C - 20 * u)} ${f(C + 3.5 * u)} A${f(34 * u)} ${f(34 * u)} 0 0 1 ${f(C)} ${f(C - 58 * u)}Z`;

  const x = margin, rx = 185 * u;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${canvas}" height="${canvas}" viewBox="0 0 ${canvas} ${canvas}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#262626"/>
      <stop offset="1" stop-color="#030303"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.45" r="0.55">
      <stop offset="0" stop-color="#fff" stop-opacity="0.16"/>
      <stop offset="1" stop-color="#fff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="disc" cx="0.4" cy="0.32" r="0.8">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#cfcfcf"/>
    </radialGradient>
    <clipPath id="tile"><rect x="${x}" y="${x}" width="${S}" height="${S}" rx="${f(rx)}"/></clipPath>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%">
      <feDropShadow dx="0" dy="${f(10 * u)}" stdDeviation="${f(14 * u)}" flood-color="#000" flood-opacity="${margin ? 0.35 : 0}"/>
    </filter>
  </defs>
  <g filter="url(#shadow)">
    <rect x="${x}" y="${x}" width="${S}" height="${S}" rx="${f(rx)}" fill="url(#bg)"/>
  </g>
  <g clip-path="url(#tile)">
    <rect x="${x}" y="${x}" width="${S}" height="${S}" fill="url(#glow)"/>
    ${rings}
    ${ticks}
    <circle cx="${C}" cy="${C}" r="${f(R)}" fill="none" stroke="#fff" stroke-opacity="0.16" stroke-width="${f(arcW)}"/>
    <path d="${arc}" fill="none" stroke="#fff" stroke-width="${f(arcW)}" stroke-linecap="round"/>
    <circle cx="${f(knobX)}" cy="${f(knobY)}" r="${f((simple ? 0 : 15) * u)}" fill="#fff"/>
    <circle cx="${C}" cy="${C}" r="${f(112 * u * k)}" fill="#000" fill-opacity="0.55"/>
    <circle cx="${C}" cy="${C}" r="${f(100 * u * k)}" fill="url(#disc)"/>
    <path d="${hole}" fill="#0a0a0a" transform="translate(${C} ${C}) scale(${k}) translate(-${C} -${C})"/>
  </g>
  <rect x="${f(x + 1.5 * u)}" y="${f(x + 1.5 * u)}" width="${f(S - 3 * u)}" height="${f(S - 3 * u)}" rx="${f(rx - 1.5 * u)}" fill="none" stroke="#fff" stroke-opacity="0.14" stroke-width="${f(3 * u)}"/>
</svg>`;
}

module.exports = { logo };

if (require.main === module) {
  const [canvas, margin] = process.argv.slice(2).map(Number);
  process.stdout.write(logo({ canvas: canvas || 1024, margin: Number.isFinite(margin) ? margin : 100 }));
}
