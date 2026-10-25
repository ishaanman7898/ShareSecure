// Lightweight, dependency-free adaptation of React Bits' GradientASCII for
// ShareSecure's static JavaScript app. The animation is mounted in Electron only.
const COLORS = ['#1e3fd8', '#f6f8ff', '#a5d8ff', '#38bdf8'];
const CHARACTERS = ' =+xX0S8#@';

export function mountGradientASCII(container, {
  colors = COLORS,
  shape = 'horizon',
  characters = CHARACTERS,
  cellSize = 16,
  density = 0.8,
  glyphOpacity = 0.85,
  gradientOpacity = 0.9,
  glow = 0.2,
  flow = 0.5,
  speed = 1,
  softness = 0.5,
  mouseInteraction = true,
} = {}) {
  if (!container || container.dataset.gradientMounted) return;
  container.dataset.gradientMounted = 'true';
  const canvas = container.querySelector('canvas');
  const ctx = canvas?.getContext('2d', { alpha: true });
  if (!canvas || !ctx) return;

  const palette = colors.slice(0, 8);
  const chars = [...new Set([...characters].filter(char => char !== '\n' && char !== '\r'))];
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let width = 1, height = 1, dpr = 1, frame = 0, last = 0, elapsed = 0;
  let pointer = null, click = null, visible = true;
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  function resize() {
    const bounds = container.getBoundingClientRect();
    width = Math.max(1, bounds.width);
    height = Math.max(1, bounds.height);
    dpr = Math.min(devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    wake();
  }

  function draw(now = 0) {
    frame = 0;
    if (document.hidden || !visible) return;
    const dt = last ? Math.min((now - last) / 1000, 0.05) : 1 / 60;
    last = now;
    if (!reducedMotion) elapsed += dt * Math.max(0, speed);
    const t = elapsed;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    // Soft horizon wash, colored from the same React Bits ramp.
    const wash = ctx.createLinearGradient(0, 0, width, height);
    palette.forEach((color, i) => wash.addColorStop(i / Math.max(1, palette.length - 1), color));
    const washAlpha = gradientOpacity * 0.18;
    ctx.globalAlpha = washAlpha;
    ctx.fillStyle = wash;
    ctx.fillRect(0, 0, width, height);
    ctx.globalAlpha = 1;

    const cell = Math.max(7, cellSize);
    const cols = Math.ceil(width / cell);
    const rows = Math.ceil(height / cell);
    const aspect = width / Math.max(1, height);
    const softnessBand = 0.15 + softness * 0.42;
    ctx.font = `300 ${cell * 0.72}px "IBM Plex Mono", ui-monospace, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';

    for (let row = 0; row < rows; row++) {
      const y = (row + 0.5) * cell;
      const ny = y / height - 0.5;
      for (let col = 0; col < cols; col++) {
        const x = (col + 0.5) * cell;
        const nx = (x / width - 0.5) * aspect;
        const sway = Math.sin(nx * 2.8 + t * 0.38) * 0.035 * flow;
        const arch = -0.12 - 0.2 * nx * nx + sway;
        let intensity;
        if (shape === 'rise') intensity = clamp((0.58 - Math.hypot(nx * 0.8, ny + 0.18)) * 2.2, 0, 1);
        else if (shape === 'pinch') intensity = Math.exp(-Math.pow(Math.abs(ny - sway) / (0.08 + 0.2 * nx * nx), 2));
        else if (shape === 'eclipse') {
          const radius = Math.hypot(nx, ny);
          intensity = radius > 0.22 ? Math.exp(-(radius - 0.22) * 6) : 0;
        } else {
          const edge = ny - arch;
          intensity = clamp((0.48 - edge) / softnessBand, 0, 1) * (0.4 + 0.6 * Math.exp(-nx * nx * 0.65));
        }
        const shimmer = (Math.sin(nx * 13 + ny * 9 + t * 1.4) + Math.cos(nx * 6 - t * 0.8)) * 0.035;
        intensity = clamp(intensity + shimmer, 0, 1);
        if (pointer && mouseInteraction) {
          const distance = Math.hypot(x - pointer.x, y - pointer.y);
          intensity = clamp(intensity + Math.max(0, 1 - distance / Math.max(height * 0.14, 1)) * 0.2, 0, 1);
        }
        if (click) {
          const distance = Math.hypot(x - click.x, y - click.y);
          const radius = (now - click.time) * 0.18;
          intensity = clamp(intensity + Math.max(0, 1 - Math.abs(distance - radius) / (cell * 2.5)) * 0.65, 0, 1);
        }
        const level = Math.floor(intensity * (chars.length - 1));
        const seeded = Math.abs(Math.sin(col * 127.1 + row * 311.7));
        if (!intensity || seeded > density * (0.45 + intensity * 0.55)) continue;
        const colorAt = Math.min(palette.length - 1, Math.floor(intensity * palette.length));
        ctx.fillStyle = palette[colorAt] || COLORS[0];
        ctx.globalAlpha = glyphOpacity * clamp(intensity * 1.6, 0, 1);
        ctx.shadowColor = ctx.fillStyle;
        ctx.shadowBlur = glow * cell * 0.8;
        ctx.fillText(chars[level] || '@', x, y);
      }
    }
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    if (click && now - click.time > 1300) click = null;
    if (!reducedMotion || click) wake();
    else last = 0;
  }

  function wake() {
    if (!frame && !document.hidden && visible) frame = requestAnimationFrame(draw);
  }
  function onPointer(event) {
    const rect = container.getBoundingClientRect();
    pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    if (mouseInteraction) wake();
  }
  function onClick(event) {
    const rect = container.getBoundingClientRect();
    click = { x: event.clientX - rect.left, y: event.clientY - rect.top, time: performance.now() };
    wake();
  }
  const observer = new ResizeObserver(resize);
  observer.observe(container);
  const visibility = new IntersectionObserver(entries => {
    visible = entries.some(entry => entry.isIntersecting);
    if (visible) wake();
    else { cancelAnimationFrame(frame); frame = 0; }
  });
  visibility.observe(container);
  container.addEventListener('pointermove', onPointer, { passive: true });
  container.addEventListener('pointerleave', () => { pointer = null; });
  container.addEventListener('pointerdown', onClick, { passive: true });
  document.addEventListener('visibilitychange', wake);
  resize();
}
