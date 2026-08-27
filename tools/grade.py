"""Grade Cali's facade rendering into three scarier looks.

The raw render reads as a lit warehouse: fluorescent ceiling panels, a ceiling
fan, acoustic foam on the walls. Fear needs the room to disappear, so every
look here does three things before it does anything stylistic:
  1. kills the ceiling (the studio giveaway) into black
  2. crushes the floor reflections so the set stops looking like a showroom
  3. keeps only the practicals - lanterns, candles, window glow - as light
"""
import os
import numpy as np
from PIL import Image, ImageFilter

SRC = r"C:\Users\danie\hauntedmansion-bk\img\facade-raw.png"
OUT = r"C:\Users\danie\hauntedmansion-bk\img"

im = Image.open(SRC).convert("RGB")
W, H = im.size
a = np.asarray(im).astype(np.float32) / 255.0

# --- geometry masks -------------------------------------------------------
yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
ny, nx = yy / H, xx / W

# ceiling: everything above the balcony rail, faded in so there is no seam
ceiling = np.clip((0.20 - ny) / 0.20, 0, 1) ** 0.8
# floor: below the porch steps
floor = np.clip((ny - 0.78) / 0.22, 0, 1) ** 0.9
# side walls: acoustic foam sits outside the facade on both flanks
sides = np.clip((0.085 - nx) / 0.085, 0, 1) ** 0.7 + np.clip((nx - 0.905) / 0.095, 0, 1) ** 0.7
sides = np.clip(sides, 0, 1)
# upper corners, where the foam wraps above the balcony
corners = np.clip((0.34 - ny) / 0.34, 0, 1) * np.clip((np.abs(nx - 0.5) - 0.30) / 0.20, 0, 1)

# radial vignette from the doorway, not the frame centre
r = np.sqrt(((nx - 0.5) * 1.15) ** 2 + ((ny - 0.55) * 1.0) ** 2)

lum = a @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32)
# practicals = small bright spots; blur-difference keeps flames, drops walls
soft = np.asarray(Image.fromarray((lum * 255).astype(np.uint8))
                  .filter(ImageFilter.GaussianBlur(W * 0.02))).astype(np.float32) / 255.0
practical = np.clip((lum - soft) * 3.0 + (lum - 0.55) * 2.2, 0, 1)


def glow(img, radius, amount, tint):
    """Halation: bloom the practicals back over the frame, tinted."""
    g = np.clip(img - 0.45, 0, 1) * practical[..., None]
    g = np.asarray(Image.fromarray((np.clip(g, 0, 1) * 255).astype(np.uint8))
                   .filter(ImageFilter.GaussianBlur(radius))).astype(np.float32) / 255.0
    return img + g * amount * np.array(tint, dtype=np.float32)


def scurve(x, amount):
    """Contrast that pivots on the midtone instead of crushing everything."""
    return np.clip(x + amount * np.sin(2 * np.pi * np.clip(x, 0, 1)) * -0.5, 0, 1)


def grade(name, ambient, contrast, black, exposure, fog_tint, fog_amt,
          glow_tint, glow_amt, grain, sat, vig):
    x = a.copy()

    # 1. drown the room, not the house
    x *= (1.0 - 0.95 * ceiling)[..., None]          # ceiling + fluorescents to void
    x *= (1.0 - 0.38 * floor)[..., None]            # dull the showroom reflections
    x *= (1.0 - 0.96 * sides)[..., None]            # flanking foam to void
    x *= (1.0 - 0.92 * corners)[..., None]          # foam wrapping the upper corners

    # 2. split-tone: ambient goes cold/sick, practicals keep their own colour.
    #    Normalised so the tint recolours without stealing a stop.
    amb = np.array(ambient, dtype=np.float32)
    amb = amb / amb.mean()
    keep = practical[..., None]
    x = x * (amb * (1 - keep) + keep)

    # 3. exposure first, then contrast, then a shallow black lift
    x = np.clip(x * exposure, 0, 1)
    x = scurve(x, contrast)
    x = np.clip((x - black) / (1.0 - black), 0, 1)

    # 4. desaturate the field, saturate the flames
    g = (x @ np.array([0.2126, 0.7152, 0.0722], dtype=np.float32))[..., None]
    x = g + (x - g) * (sat * (1 - keep) + 1.40 * keep)

    # 5. fog rolling up from the floor, thickest at the doorway
    fog = (np.clip((ny - 0.45) / 0.55, 0, 1) ** 1.7) * (1.0 - np.abs(nx - 0.5))
    x = x + fog[..., None] * fog_amt * np.array(fog_tint, dtype=np.float32) * (1 - x)

    # 6. halation off the flames
    x = glow(x, W * 0.012, glow_amt, glow_tint)

    # 7. vignette: enough that the walls stop existing, not so much the set does
    x *= np.clip(1.18 - r * vig, 0.10, 1.0)[..., None]

    # 8. grain, heavier in shadow like real pushed film
    n = np.random.default_rng(7).normal(0, grain, x.shape[:2]).astype(np.float32)
    x = x + n[..., None] * (1.0 - np.clip(x, 0, 1)) ** 1.5

    out = Image.fromarray((np.clip(x, 0, 1) * 255).astype(np.uint8))
    p = os.path.join(OUT, f"facade-{name}.jpg")
    out.save(p, quality=92)
    print("wrote", p)
    return out


grade("cold",  ambient=(0.68, 0.82, 1.15), contrast=0.16, black=0.015, exposure=1.55,
      fog_tint=(0.46, 0.58, 0.80), fog_amt=0.26,
      glow_tint=(1.00, 0.70, 0.32), glow_amt=0.75, grain=0.026, sat=0.62, vig=0.85)

grade("blood", ambient=(1.18, 0.62, 0.60), contrast=0.20, black=0.02, exposure=1.45,
      fog_tint=(0.52, 0.14, 0.16), fog_amt=0.24,
      glow_tint=(1.00, 0.34, 0.16), glow_amt=0.95, grain=0.032, sat=0.74, vig=0.95)

grade("rot",   ambient=(0.72, 1.05, 0.80), contrast=0.18, black=0.015, exposure=1.50,
      fog_tint=(0.32, 0.50, 0.38), fog_amt=0.28,
      glow_tint=(1.00, 0.62, 0.20), glow_amt=0.72, grain=0.030, sat=0.55, vig=0.88)


# --- hero crop ------------------------------------------------------------
# 16:9 off the facade for the page hero. The ceiling is already void, so the
# crop starts just above the balcony rail and ends below the porch steps.
for nm in ("cold", "blood", "rot"):
    src = Image.open(os.path.join(OUT, f"facade-{nm}.jpg"))
    w, h = src.size
    top = int(h * 0.13)
    ch = int(w * 9 / 16)
    src.crop((0, top, w, min(h, top + ch))).save(
        os.path.join(OUT, f"hero-{nm}.jpg"), quality=92)
print("wrote hero crops")
