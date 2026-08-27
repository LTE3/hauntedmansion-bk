"""Build the page hero from the raw render.

v2. The first pass was rescuing a 1448px set photo: it had to void the studio
ceiling, kill string lights, and paint a red doorway in by hand, all at 2x
because the source was smaller than the screen. The v2 render is 5504x3072 and
already photographic, already lit, already fogged - so this pass does almost
nothing. It talks the red down from a primary to blood, closes the frame, adds
grain, and cuts the two aspect ratios. Anything more would be undoing work the
render already did.
"""
import os
import numpy as np
from PIL import Image, ImageFilter

SRC = os.path.join("img", "facade-raw-v2.png")
OUT = "img"

im = Image.open(SRC).convert("RGB")
W, H = im.size
x = np.asarray(im).astype(np.float32) / 255.0

yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
ny, nx = yy / H, xx / W


def blur(arr, r):
    a8 = (np.clip(arr, 0, 1) * 255).astype(np.uint8)
    return np.asarray(Image.fromarray(a8).filter(ImageFilter.GaussianBlur(r))
                      ).astype(np.float32) / 255.0


# 1. the red is the whole point, but the render delivered it as a pure primary,
#    which reads as a nightclub sign rather than something burning behind a door.
#    Only 0.08% of the red channel is actually clipped, so the grain is still in
#    there - it is buried under saturation. Retint the hot red to the page's own
#    blood and pull the intensity down until the door's wood grain comes back.
BLOOD = np.array([0.86, 0.19, 0.14], np.float32)
R, G, B = x[..., 0], x[..., 1], x[..., 2]
redness = np.clip((R - np.maximum(G, B)) * 2.4, 0, 1)
hot = (redness * np.clip((R - 0.30) / 0.70, 0, 1))[..., None]
x = x * (1 - hot) + hot * (R[..., None] * 0.88) * BLOOD

# 2. close the frame. The corners of an establishing shot are information the
#    page does not need; the eye should arrive at the doorway and stay there.
r = np.sqrt(((nx - 0.5) * 1.16) ** 2 + ((ny - 0.56) * 1.00) ** 2)
x *= np.clip(1.12 - r * 0.98, 0.04, 1.0)[..., None]

# 3. halation. Real glass and real air bloom; a render's lights stop at their
#    own edge. Warm off the lanterns, red off the doorway, both weak.
lum = x @ np.array([0.2126, 0.7152, 0.0722], np.float32)
warm = np.clip(x[..., 0] - x[..., 2] - 0.06, 0, 1) * np.clip((lum - 0.30) / 0.70, 0, 1)
x = x + blur(warm, W * 0.008)[..., None] * 0.30 * np.array([1.00, 0.62, 0.26], np.float32)
x = x + blur(redness * np.clip((R - 0.35) / 0.65, 0, 1), W * 0.030)[..., None] * 0.20 * BLOOD

# 4. grain, weighted into the shadows where film actually shows it. Finer than
#    v2's predecessor because this plate is downscaled 2x on the way out, and
#    grain that survives a 2x downscale was too coarse to begin with.
gr = np.random.default_rng(5).normal(0, 0.016, (H, W)).astype(np.float32)
x = np.clip(x + gr[..., None] * (1 - np.clip(x, 0, 1)) ** 1.4, 0, 1)

full = Image.fromarray((x * 255).astype(np.uint8))

# 16:9 for desktop, 3:4 for phones. The phone crop centres on the doorway rather
# than on the frame, because the frame's centre and the subject's are not the
# same place. Each ships 1x and 2x so the page hands the right plate to each
# screen instead of making one file cover both badly.
# Measured on the door band only (y 0.38-0.62). The whole-frame red centroid
# reads 0.530 because the light pooling on the floor spreads sideways, and
# centring the phone crop on the spill leaves the door a tenth of a frame off.
DOOR_X = 0.491
wh = int(H * 16 / 9)
if wh <= W:
    wide = full.crop(((W - wh) // 2, 0, (W - wh) // 2 + wh, H))
else:
    hh = int(W * 9 / 16)
    wide = full.crop((0, (H - hh) // 2, W, (H - hh) // 2 + hh))

cw = int(H * 3 / 4)
left = min(max(int(DOOR_X * W) - cw // 2, 0), W - cw)
tall = full.crop((left, 0, left + cw, H))

for name, src, size2x in (("hero-wide", wide, (2560, 1440)),
                          ("hero-tall", tall, (1440, 1920))):
    big = src.resize(size2x, Image.LANCZOS)
    small = src.resize((size2x[0] // 2, size2x[1] // 2), Image.LANCZOS)
    big.save(os.path.join(OUT, name + "@2x.jpg"), quality=88, optimize=True,
             progressive=True, subsampling=0)
    small.save(os.path.join(OUT, name + ".jpg"), quality=90, optimize=True,
               progressive=True, subsampling=0)
    print(name, small.size, "+", big.size)
print("wrote hero-wide / hero-tall at 1x and 2x")
