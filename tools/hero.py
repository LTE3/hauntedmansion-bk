"""Build the page hero from the raw render.

The poster is the poster - it carries Cali's type and cannot be cropped without
fighting it. The page needs the house alone, full bleed, in two aspect ratios,
with the studio gone and the set no longer reading as a party:
  ceiling + flanking foam to void, string lights killed, porch bays voided,
  one cold source upper-left, fog with structure, rotted texture.
"""
import os
import numpy as np
from PIL import Image, ImageFilter

SRC = os.path.join("img", "facade-raw.png")
OUT = "img"

# The source render is only 1448px wide. Grading at 1x and letting the browser
# upscale to a retina viewport is what made the house look soft, so the whole
# pass runs at 2x: the fog, halation and grain are then real pixels at the size
# the page actually displays, instead of a stretched 1x plate.
SUPER = 2
im = Image.open(SRC).convert("RGB")
im = im.resize((im.width * SUPER, im.height * SUPER), Image.LANCZOS)
W, H = im.size
x = np.asarray(im).astype(np.float32) / 255.0

yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
ny, nx = yy / H, xx / W


def blur(arr, r):
    a8 = (np.clip(arr, 0, 1) * 255).astype(np.uint8)
    return np.asarray(Image.fromarray(a8).filter(ImageFilter.GaussianBlur(r))).astype(np.float32) / 255.0


def value_noise(h, w, octaves, seed):
    rng = np.random.default_rng(seed)
    out = np.zeros((h, w), np.float32)
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        s = max(2, int(2 ** (o + 2)))
        base = rng.random((s, s)).astype(np.float32)
        out += np.asarray(Image.fromarray((base * 255).astype(np.uint8))
                          .resize((w, h), Image.BICUBIC), np.float32) / 255.0 * amp
        tot += amp
        amp *= 0.55
    return out / tot


lum = x @ np.array([0.2126, 0.7152, 0.0722], np.float32)
spot = np.clip((lum - blur(lum, W * 0.02)) * 4.0, 0, 1)
practical = np.clip(spot * 2.2 + (lum - 0.55) * 2.0, 0, 1)[..., None]

# 1. the room disappears
ceiling = np.clip((0.265 - ny) / 0.265, 0, 1) ** 0.6   # includes the ceiling fan
sides = np.clip(np.clip((0.135 - nx) / 0.135, 0, 1) ** 0.6 +
                np.clip((nx - 0.870) / 0.130, 0, 1) ** 0.6, 0, 1)
corners = np.clip((0.42 - ny) / 0.42, 0, 1) * np.clip((np.abs(nx - 0.5) - 0.20) / 0.18, 0, 1)
floor = np.clip((ny - 0.78) / 0.22, 0, 1) ** 0.9
x *= (1 - 0.96 * ceiling)[..., None]
x *= (1 - 0.96 * sides)[..., None]
x *= (1 - 0.92 * corners)[..., None]
x *= (1 - 0.60 * floor)[..., None]

# 2. string lights along the balcony rail read festive - kill them
rail = ((ny > 0.10) & (ny < 0.36)).astype(np.float32)
warm = ((x[..., 0] > x[..., 2] + 0.04) & (lum > 0.16)).astype(np.float32)
strings = blur(np.clip(spot * rail * warm * 3.0, 0, 1), W * 0.004)
x *= (1 - 0.92 * strings)[..., None]

# 3. porch bays and doorway go void, so the dark is the only thing to look at
keep = np.clip(spot * 2.5, 0, 1)
bay = (np.clip((ny - 0.50) / 0.06, 0, 1) * np.clip((0.80 - ny) / 0.06, 0, 1)
       * np.clip((nx - 0.09) / 0.05, 0, 1) * np.clip((0.91 - nx) / 0.05, 0, 1))
x *= (1 - 0.45 * bay * (1 - keep))[..., None]
sign = (np.clip((nx - 0.34) / 0.03, 0, 1) * np.clip((0.66 - nx) / 0.03, 0, 1)
        * np.clip((ny - 0.38) / 0.02, 0, 1) * np.clip((0.48 - ny) / 0.02, 0, 1))
# The COMING SOON banner is the one prop that reads as a prop. Push it back
# until it looks like something that has been hanging there a long time.
x *= (1 - 0.74 * sign)[..., None]

door = np.exp(-(((nx - 0.5) / 0.055) ** 2 + ((ny - 0.63) / 0.09) ** 2))
x *= (1 - 0.70 * door * (1 - keep))[..., None]

# The one red in the frame, and it comes from inside the house. Amber light on
# a porch is hospitality; red light behind a door is not. A tight core in the
# doorway gap, a wider bleed that catches the columns and the fog above it.
core = np.exp(-(((nx - 0.5) / 0.030) ** 2 + ((ny - 0.655) / 0.055) ** 2))
bleed = np.exp(-(((nx - 0.5) / 0.115) ** 2 + ((ny - 0.640) / 0.155) ** 2))
blood = np.array([1.00, 0.11, 0.07], np.float32)
x = x + (core * 0.58 + bleed * 0.19)[..., None] * blood * (1 - x)

# 4. exposure back up, one cold source upper-left, flames stay amber
x = np.clip(x * 1.18, 0, 1)
cold = np.array([0.70, 0.84, 1.16], np.float32); cold /= cold.mean()
x = x * (cold * (1 - practical) + practical * np.array([1.14, 0.90, 0.64], np.float32))
moon = np.exp(-(((nx - 0.16) / 0.62) ** 2 + ((ny - 0.06) / 0.62) ** 2))
x = x * (0.52 + 0.48 * moon)[..., None]
x = x + moon[..., None] * 0.05 * np.array([0.42, 0.54, 0.80], np.float32) * (1 - x)

# 5. desaturate the field, keep the fire hot
g = (x @ np.array([0.2126, 0.7152, 0.0722], np.float32))[..., None]
x = g + (x - g) * (0.58 * (1 - practical) + 1.45 * practical)

# 6. fog with structure, rising and pooling at the door
n = value_noise(H, W, 5, 11)
rise = np.clip((ny - 0.46) / 0.54, 0, 1) ** 1.5
pool = np.exp(-(((nx - 0.5) / 0.30) ** 2 + ((ny - 0.78) / 0.26) ** 2))
fog = np.clip(n * 1.3 - 0.36, 0, 1) * (rise * 0.85 + pool * 0.55)
x = x + fog[..., None] * 0.30 * np.array([0.50, 0.58, 0.72], np.float32) * (1 - x)

# 7. halation, rotted local contrast, closing frame, grain
e = blur(np.clip(x - 0.42, 0, 1) * practical, W * 0.015)
x = x + e * 0.32 * np.array([1.00, 0.56, 0.20], np.float32)
# red spills further than the lanterns do - a wide, weak glow off the doorway
x = x + blur(core + bleed * 0.5, W * 0.035)[..., None] * 0.15 * blood
# 0.75 was carving halos around every board. Enough to read as texture, no more.
x = np.clip(x + (x - blur(x, W * 0.006)) * 0.42, 0, 1)
r = np.sqrt(((nx - 0.5) * 1.20) ** 2 + ((ny - 0.58) * 1.02) ** 2)
x *= np.clip(1.14 - r * 1.02, 0.03, 1.0)[..., None]
gr = np.random.default_rng(5).normal(0, 0.013, (H, W)).astype(np.float32)
x = x + gr[..., None] * (1 - np.clip(x, 0, 1)) ** 1.4

full = Image.fromarray((np.clip(x, 0, 1) * 255).astype(np.uint8))

# 16:9 for desktop, 3:4 for phones - the phone crop keeps the doorway centred.
# Each ships at 1x and 2x so the page can hand the right plate to each screen
# instead of making one file cover both badly.
w, h = full.size
top = int(h * 0.10)
wide = full.crop((0, top, w, min(h, top + int(w * 9 / 16))))
# start the phone crop below the ceiling line so the fan and the room above it
# never make it into the plate, whatever object-fit does with it later
ttop = int(h * 0.13)
th = h - ttop
cw = int(th * 3 / 4)
tall = full.crop(((w - cw) // 2, ttop, (w - cw) // 2 + cw, h))

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
