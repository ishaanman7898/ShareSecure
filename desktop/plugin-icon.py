# Draws the small rosette icon ChatGPT's "Create new plugin" form asks for:
# a PNG of at least 256 x 256 pixels and at most 10 KB.
#   python desktop/plugin-icon.py   → public/plugin-icon.png
# Same rosette as desktop/rosette.js (fewer rings, so it compresses small),
# drawn large and scaled down so the lines are smooth.
import io, math, os
from PIL import Image, ImageDraw

SIZE, SCALE = 256, 4
BIG = SIZE * SCALE
C = BIG / 2
u = BIG / 100  # the rosette is drawn on a 100 x 100 grid

BANDS = [  # base radius, wave height, waves, rings, brightness
    (36, 3.2, 24, 3, 235),
    (27.5, 4.0, 16, 3, 160),
    (18.5, 4.2, 12, 3, 220),
    (9.5, 3.4, 8, 2, 150),
]

img = Image.new('L', (BIG, BIG), 0)
draw = ImageDraw.Draw(img)
draw.rounded_rectangle([0, 0, BIG - 1, BIG - 1], radius=23 * u, fill=12)
for base, amp, k, n, shade in BANDS:
    for i in range(n):
        phase = i / n * math.pi * 2
        pts = []
        for s in range(721):
            t = s / 720 * math.pi * 2
            r = (base + amp * math.sin(k * t + phase) * math.cos(t * 2 + phase / 3)) * u
            pts.append((C + r * math.cos(t), C + r * math.sin(t)))
        draw.line(pts, fill=shade, width=int(1.1 * u), joint='curve')

small = img.resize((SIZE, SIZE), Image.LANCZOS)
# corners outside the tile are see-through
mask = Image.new('L', (BIG, BIG), 0)
ImageDraw.Draw(mask).rounded_rectangle([0, 0, BIG - 1, BIG - 1], radius=23 * u, fill=255)
alpha = mask.resize((SIZE, SIZE), Image.LANCZOS)

# Fewer grey levels until it fits under 10 KB.
out = os.path.join(os.path.dirname(__file__), '..', 'public', 'plugin-icon.png')
for colors in (32, 24, 16, 12, 8):
    rgba = Image.merge('RGBA', (small, small, small, alpha))
    q = rgba.quantize(colors=colors, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.NONE)
    buf = io.BytesIO()
    q.save(buf, 'PNG', optimize=True)
    if buf.tell() <= 9500:  # under 10 KB however it is counted
        break
with open(out, 'wb') as f:
    f.write(buf.getvalue())
print(f'{os.path.normpath(out)}: {buf.tell()} bytes, {colors} colours')
