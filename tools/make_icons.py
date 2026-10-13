"""Generate the DeepSeek Video Notes icon set.

A "page + play" mark: a rounded blue tile, a white note sheet with a folded
corner, a play triangle, and a small amber accent dot. Drawn at 1024px and
downsampled for clean edges at 16/32/48/128.
"""
import os
from PIL import Image, ImageDraw

OUT = os.path.join(os.path.dirname(__file__), "..", "assets", "icons")
os.makedirs(OUT, exist_ok=True)

S = 1024
TOP = (109, 140, 255)     # #6D8CFF
BOT = (53, 80, 230)       # #3550E6
ACCENT = (255, 176, 32)   # #FFB020
WHITE = (255, 255, 255, 255)
BLUE = (53, 80, 230, 255)
LINECOL = (198, 210, 250, 255)

# --- Rounded tile with a vertical gradient ---
tile = Image.new("RGBA", (S, S), (0, 0, 0, 0))
td = ImageDraw.Draw(tile)
for y in range(S):
    t = y / (S - 1)
    row = tuple(int(TOP[i] + (BOT[i] - TOP[i]) * t) for i in range(3)) + (255,)
    td.line([(0, y), (S, y)], fill=row)

tile_mask = Image.new("L", (S, S), 0)
ImageDraw.Draw(tile_mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=236, fill=255)

bg = Image.new("RGBA", (S, S), (0, 0, 0, 0))
bg.paste(tile, (0, 0), tile_mask)

# --- Note sheet with a folded top-right corner (own layer so the cut is clean) ---
nx0, ny0, nx1, ny1 = 262, 250, 762, 774
fold = 138
page = Image.new("RGBA", (S, S), (0, 0, 0, 0))
pd = ImageDraw.Draw(page)
pd.rounded_rectangle([nx0, ny0, nx1, ny1], radius=64, fill=WHITE)
pd.polygon([(nx1 - fold, ny0 - 2), (nx1 + 2, ny0 - 2),
            (nx1 + 2, ny0 + fold), (nx1 - fold, ny0 + fold)], fill=(0, 0, 0, 0))

result = bg.copy()
result.alpha_composite(page)

rd = ImageDraw.Draw(result)
# Fold slab tint.
rd.polygon([(nx1 - fold, ny0), (nx1, ny0 + fold), (nx1 - fold, ny0 + fold)],
           fill=(216, 226, 255, 255))
# Play triangle.
px, py, pr = 512, 468, 118
rd.polygon([(px - pr + 20, py - pr), (px - pr + 20, py + pr), (px + pr, py)], fill=BLUE)
# Two text lines.
rd.rounded_rectangle([nx0 + 96, ny1 - 176, nx1 - 96, ny1 - 148], radius=14, fill=LINECOL)
rd.rounded_rectangle([nx0 + 96, ny1 - 116, nx0 + 306, ny1 - 88], radius=14, fill=LINECOL)
# Amber accent dot.
cx, cy, r = nx1 - 70, ny0 - 40, 62
rd.ellipse([cx - r, cy - r, cx + r, cy + r], fill=ACCENT)
rd.ellipse([cx - 26, cy - 26, cx + 26, cy + 26], fill=WHITE)

for size in (128, 48, 32, 16):
    result.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, f"icon{size}.png"))
    print("wrote", f"icon{size}.png")

result.resize((256, 256), Image.LANCZOS).save(os.path.join(OUT, "icon256.png"))
print("wrote icon256.png")
