// WebGL port of React Bits' GradientASCII for ShareSecure's static site.
// The site has no React runtime, so this mounts the same effect directly.
const DEFAULT_COLORS = ['#1e3fd8', '#f6f8ff', '#a5d8ff', '#38bdf8'];
const DEFAULT_CHARACTERS = ' =+xX0S8#@';

const VERTEX = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform vec2 uSize;
uniform vec2 uMouse;
uniform vec2 uClick;
uniform float uTime;
uniform float uClickAge;
uniform float uCell;
uniform float uDensity;
uniform float uGlyphOpacity;
uniform float uGradientOpacity;
uniform float uGlow;
uniform float uFlow;
uniform float uSoftness;
uniform float uScale;
uniform float uFlicker;
uniform float uIntro;
uniform float uGrain;
uniform float uVariation;
uniform float uScrambleRadius;
uniform int uShape;
uniform int uColorCount;
uniform int uCharCount;
uniform int uLightMode;
uniform int uMouseInteraction;
uniform int uClickEffect;
uniform vec3 uColors[8];
uniform sampler2D uAtlas;
out vec4 outColor;
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
vec3 ramp(float t) {
  float x = clamp(t, 0.0, 0.9999) * float(uColorCount - 1);
  int i = int(floor(x));
  return mix(uColors[i], uColors[min(i + 1, uColorCount - 1)], fract(x));
}
void main() {
  vec2 px = gl_FragCoord.xy;
  vec2 uv = px / uSize;
  float aspect = uSize.x / max(uSize.y, 1.0);
  vec2 p = (uv - 0.5) * vec2(aspect, 1.0) / uScale;
  float sway = sin(p.x * 3.0 + uTime * 0.55 + uVariation) * 0.035 * uFlow;
  float edge = p.y - (-0.17 - 0.20 * p.x * p.x + sway);
  float soft = mix(0.045, 0.24, uSoftness);
  float intensity;
  float order;
  if (uShape == 1) {
    float width = 0.10 + 0.22 * p.x * p.x;
    intensity = exp(-pow(abs(p.y - sway) / width, 2.0));
    order = clamp(abs(p.y - sway) * 2.4 + abs(p.x) * 0.3, 0.0, 1.0);
  } else if (uShape == 2) {
    float d = length(vec2(p.x * 0.8, p.y + 0.18));
    intensity = clamp((0.72 - d) * 1.8, 0.0, 1.0);
    order = clamp(d, 0.0, 1.0);
  } else if (uShape == 3) {
    float d = length(p) - 0.23;
    intensity = d > 0.0 ? exp(-d * 7.0) : 0.0;
    order = clamp(d * 2.0, 0.0, 1.0);
  } else {
    intensity = smoothstep(-soft, 0.42, edge) * 0.78;
    intensity *= 0.45 + 0.55 * exp(-p.x * p.x * 0.65);
    order = clamp(edge * 1.3, 0.0, 1.0);
  }
  float reveal = 1.0 - smoothstep(order - 0.15, order + 0.15, 1.0 - uIntro);
  intensity *= reveal;
  float cell = max(uCell, 6.0);
  vec2 grid = floor(px / cell);
  vec2 local = fract(px / cell);
  float cellNoise = hash(grid + uVariation * 11.7);
  if (uMouseInteraction == 1) {
    float nearMouse = 1.0 - smoothstep(uScrambleRadius * uSize.y * 0.35, uScrambleRadius * uSize.y, distance(px, uMouse));
    cellNoise = mix(cellNoise, hash(grid + floor(uTime * 17.0)), nearMouse);
  }
  float clickDistance = distance(px, uClick);
  if (uClickEffect != 0 && uClickAge >= 0.0 && uClickAge < 1.2) {
    float waveRadius = uClickAge * uSize.y * 0.42;
    float wave = 1.0 - smoothstep(cell * 1.2, cell * 2.4, abs(clickDistance - waveRadius));
    if (uClickEffect == 2) wave = (1.0 - smoothstep(uSize.y * 0.05, uSize.y * 0.22, clickDistance)) * (1.0 - uClickAge / 1.2);
    cellNoise = mix(cellNoise, hash(grid + floor(uTime * 30.0) + 81.0), wave);
  }
  float wobble = (hash(grid + floor(uTime * 9.0)) - 0.5) * uFlicker * 0.35;
  float tone = clamp(intensity + wobble, 0.0, 1.0);
  float index = floor(tone * float(uCharCount - 1) + cellNoise * uVariation);
  index = clamp(index, 0.0, float(uCharCount - 1));
  float mask = texture(uAtlas, vec2((index + local.x) / float(uCharCount), local.y)).a;
  float present = step(cellNoise, uDensity * (0.35 + tone * 0.65));
  vec3 color = ramp(tone);
  float wash = intensity * uGradientOpacity * (uShape == 0 ? 0.32 : 0.2);
  float glyph = mask * present * uGlyphOpacity * smoothstep(0.04, 0.3, intensity);
  if (uLightMode == 1) {
    vec3 ink = mix(vec3(0.02), color * 0.55, intensity);
    float alpha = max(wash * 0.38, glyph);
    outColor = vec4(ink * alpha, alpha);
  } else {
    vec3 light = color * (0.7 + uGlow * 0.25);
    float alpha = max(wash, glyph * (0.75 + uGlow * 0.25));
    outColor = vec4(light * alpha, alpha);
  }
  float grain = (hash(px + floor(uTime * 24.0)) - 0.5) * uGrain * 0.12;
  outColor.rgb = clamp(outColor.rgb + grain * outColor.a, 0.0, outColor.a);
}`;

function shader(gl, type, source) {
  const item = gl.createShader(type);
  gl.shaderSource(item, source);
  gl.compileShader(item);
  if (!gl.getShaderParameter(item, gl.COMPILE_STATUS)) {
    gl.deleteShader(item);
    return null;
  }
  return item;
}

function buildAtlas(gl, characters, fontFamily) {
  const atlas = document.createElement('canvas');
  atlas.width = 64 * characters.length;
  atlas.height = 100;
  const ctx = atlas.getContext('2d');
  ctx.font = `300 78px ${fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  [...characters].forEach((char, i) => ctx.fillText(char, i * 64 + 32, 52));
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlas);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

const clamp = (n, min, max) => Math.max(min, Math.min(max, n));

export function mountGradientASCII(container, options = {}) {
  if (!container || container.dataset.gradientMounted) return;
  container.dataset.gradientMounted = 'true';
  const canvas = container.querySelector('canvas');
  const gl = canvas?.getContext('webgl2', { alpha: true, premultipliedAlpha: true, antialias: false });
  if (!canvas || !gl) return;

  const colors = (options.colors || DEFAULT_COLORS).slice(0, 8);
  if (colors.length === 1) colors.push(colors[0]);
  const chars = [...new Set([...(options.characters || DEFAULT_CHARACTERS)].filter(c => c !== '\n' && c !== '\r'))].slice(0, 32).join('') || DEFAULT_CHARACTERS;
  const vertex = shader(gl, gl.VERTEX_SHADER, VERTEX);
  const fragment = shader(gl, gl.FRAGMENT_SHADER, FRAGMENT);
  const program = gl.createProgram();
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return;
  const loc = name => gl.getUniformLocation(program, name);
  const uniforms = Object.fromEntries(['uSize', 'uMouse', 'uClick', 'uTime', 'uClickAge', 'uCell', 'uDensity', 'uGlyphOpacity', 'uGradientOpacity', 'uGlow', 'uFlow', 'uSoftness', 'uScale', 'uFlicker', 'uIntro', 'uGrain', 'uVariation', 'uScrambleRadius', 'uShape', 'uColorCount', 'uCharCount', 'uLightMode', 'uMouseInteraction', 'uClickEffect', 'uColors', 'uAtlas'].map(name => [name, loc(name)]));
  const atlas = buildAtlas(gl, chars, options.fontFamily || '"IBM Plex Mono", ui-monospace, monospace');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let width = 1, height = 1, ratio = 1, raf = 0, started = 0, last = 0, time = 0, clickAt = -Infinity;
  let mouse = [-10000, -10000], click = [-10000, -10000], visible = true;
  const shape = { horizon: 0, pinch: 1, rise: 2, eclipse: 3 }[options.shape || 'horizon'] || 0;
  const colorValues = new Float32Array(24);
  const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  colors.forEach((value, i) => {
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = value;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
    colorValues.set([r / 255, g / 255, b / 255], i * 3);
  });

  function draw(now = performance.now()) {
    raf = 0;
    if (!visible || document.hidden) return;
    if (!started) started = now;
    const dt = last ? clamp((now - last) / 1000, 0, 0.05) : 1 / 60;
    last = now;
    if (!reduced) time += dt * Math.max(0, options.speed ?? 1);
    const intro = reduced || options.intro === false ? 1 : clamp((now - started) / 2400, 0, 1);
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlas);
    gl.uniform1i(uniforms.uAtlas, 0);
    gl.uniform2f(uniforms.uSize, canvas.width, canvas.height);
    gl.uniform2f(uniforms.uMouse, mouse[0] * ratio, canvas.height - mouse[1] * ratio);
    gl.uniform2f(uniforms.uClick, click[0] * ratio, canvas.height - click[1] * ratio);
    gl.uniform1f(uniforms.uTime, time);
    gl.uniform1f(uniforms.uClickAge, (now - clickAt) / 1000);
    gl.uniform1f(uniforms.uCell, (options.cellSize || 18) * ratio);
    gl.uniform1f(uniforms.uDensity, clamp(options.density ?? 0.8, 0, 1));
    gl.uniform1f(uniforms.uGlyphOpacity, clamp(options.glyphOpacity ?? 0.85, 0, 1));
    gl.uniform1f(uniforms.uGradientOpacity, clamp(options.gradientOpacity ?? 0.9, 0, 1));
    gl.uniform1f(uniforms.uGlow, clamp(options.glow ?? 0.2, 0, 1.5));
    gl.uniform1f(uniforms.uFlow, clamp(options.flow ?? 0.5, 0, 2));
    gl.uniform1f(uniforms.uSoftness, clamp(options.softness ?? 0.5, 0, 1));
    gl.uniform1f(uniforms.uScale, clamp(options.scale ?? 1, 0.4, 2.5));
    gl.uniform1f(uniforms.uFlicker, reduced ? 0 : clamp(options.flicker ?? 0.2, 0, 1));
    gl.uniform1f(uniforms.uIntro, intro);
    gl.uniform1f(uniforms.uGrain, clamp(options.grain ?? 0.08, 0, 0.4));
    gl.uniform1f(uniforms.uVariation, Math.max(0, options.variation || 0));
    gl.uniform1f(uniforms.uScrambleRadius, clamp(options.scrambleRadius ?? 0.1, 0.02, 0.4));
    gl.uniform1i(uniforms.uShape, shape);
    gl.uniform1i(uniforms.uColorCount, colors.length);
    gl.uniform1i(uniforms.uCharCount, chars.length);
    gl.uniform1i(uniforms.uLightMode, options.lightMode ? 1 : 0);
    gl.uniform1i(uniforms.uMouseInteraction, options.mouseInteraction === false ? 0 : 1);
    gl.uniform1i(uniforms.uClickEffect, options.clickEffect === 'burst' ? 2 : options.clickEffect === 'none' ? 0 : 1);
    gl.uniform3fv(uniforms.uColors, colorValues);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!reduced || intro < 1 || (now - clickAt) / 1000 < 1.2) raf = requestAnimationFrame(draw);
  }
  function wake() { if (!raf && visible && !document.hidden) raf = requestAnimationFrame(draw); }
  function resize() {
    const bounds = container.getBoundingClientRect();
    width = Math.max(1, bounds.width);
    height = Math.max(1, bounds.height);
    ratio = Math.min(options.dpr || devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);
    wake();
  }
  const move = event => { const r = container.getBoundingClientRect(); mouse = [event.clientX - r.left, event.clientY - r.top]; wake(); };
  const down = event => { const r = container.getBoundingClientRect(); click = [event.clientX - r.left, event.clientY - r.top]; clickAt = performance.now(); wake(); };
  const resizeObserver = new ResizeObserver(resize);
  resizeObserver.observe(container);
  const intersection = new IntersectionObserver(entries => { visible = entries.some(entry => entry.isIntersecting); wake(); });
  intersection.observe(container);
  container.addEventListener('pointermove', move, { passive: true });
  container.addEventListener('pointerdown', down, { passive: true });
  document.addEventListener('visibilitychange', wake);
  resize();
}
