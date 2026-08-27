"""Scarier by subtraction, not by darkening.

The grade passes all read as "same poster, murkier" - proof that tone was never
what made this set feel safe. Four specific things make it feel like a party:
  1. string lights along the balcony - festive, reads Christmas
  2. an evenly lit porch - you can see everything, so nothing can hide
  3. purple window glow - pretty, reads nightclub
  4. even ambient - no single source means no shadow to be afraid of
Each gets removed or inverted here. Type zones stay untouched.
"""
import os
import numpy as np
from PIL import Image, ImageFilter
import colorsys

SRC = os.path.join("img", "cali", "poster-en.png")
OUT = os.path.join("img", "scarier")
os.makedirs(OUT, exist_ok=True)

im = Image.open(SRC).convert("RGB")
W, H = im.size
x = np.asarray(im).astype(np.float32) / 255.0
base = x.copy()

yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
ny, nx = yy / H, xx / W

lum = x @ np.array([0.2126, 0.7152, 0.0722], np.float32)
soft = np.asarray(Image.fromarray((lum * 255).astype(np.uint8))
                  .filter(ImageFilter.GaussianBlur(W * 0.02))).astype(np.float32) / 255.0
spot = np.clip((lum - soft) * 4.0, 0, 1)          # small bright points only

# --- 1. string lights: warm points along the balcony rail band ---------------
rail = ((ny > 0.155) & (ny < 0.235)).astype(np.float32)
warm = ((x[..., 0] > x[..., 2] + 0.05) & (lum > 0.18)).astype(np.float32)
strings = np.clip(spot * rail * warm * 3.0, 0, 1)
strings = np.asarray(Image.fromarray((strings * 255).astype(np.uint8))
                     .filter(ImageFilter.GaussianBlur(W * 0.004))).astype(np.float32) / 255.0
x = x * (1.0 - 0.82 * strings)[..., None]

# --- 2. porch void: the bays go black so the doorway is the only thing left --
bay = (np.clip((ny - 0.40) / 0.06, 0, 1) * np.clip((0.76 - ny) / 0.06, 0, 1)
       * np.clip((nx - 0.05) / 0.05, 0, 1) * np.clip((0.95 - nx) / 0.05, 0, 1))
keep_flame = np.clip(spot * 2.5, 0, 1)
x = x * (1.0 - 0.55 * bay * (1 - keep_flame))[..., None]

# doorway itself: absolute void, no detail, so the eye has nowhere to land
door = np.exp(-(((nx - 0.5) / 0.075) ** 2 + ((ny - 0.575) / 0.085) ** 2))
x = x * (1.0 - 0.72 * door * (1 - keep_flame))[..., None]

# --- 3. window glow: purple (nightclub) becomes toxic green (wrong) ---------
mx = x.max(2); mn = x.min(2)
delta = np.clip(mx - mn, 1e-6, None)
hue = np.zeros_like(mx)
r, g, b = x[..., 0], x[..., 1], x[..., 2]
m = (mx == r); hue[m] = ((g - b)[m] / delta[m]) % 6
m = (mx == g); hue[m] = ((b - r)[m] / delta[m]) + 2
m = (mx == b); hue[m] = ((r - g)[m] / delta[m]) + 4
hue = hue / 6.0
purple = (((hue > 0.68) & (hue < 0.92)) & (delta > 0.04)).astype(np.float32)
purple = np.asarray(Image.fromarray((purple * 255).astype(np.uint8))
                    .filter(ImageFilter.GaussianBlur(W * 0.006))).astype(np.float32) / 255.0
toxic = (lum[..., None] * np.array([0.34, 1.00, 0.52], np.float32)) * 1.35
x = x * (1 - purple[..., None]) + toxic * purple[..., None]

# --- 4. one source: cold moonlight from upper left, everything else falls off -
moon = np.exp(-(((nx - 0.18) / 0.55) ** 2 + ((ny - 0.10) / 0.55) ** 2))
ambient = 0.42 + 0.58 * moon
x = x * ambient[..., None]
x = x + moon[..., None] * 0.06 * np.array([0.40, 0.52, 0.78], np.float32) * (1 - x)

# --- 5. rot the texture: local contrast so the wood reads decayed ------------
blur = np.asarray(Image.fromarray((np.clip(x, 0, 1) * 255).astype(np.uint8))
                  .filter(ImageFilter.GaussianBlur(W * 0.006))).astype(np.float32) / 255.0
x = np.clip(x + (x - blur) * 0.85, 0, 1)

# --- 6. close the frame, then grain -----------------------------------------
rr = np.sqrt(((nx - 0.5) * 1.22) ** 2 + ((ny - 0.56) * 1.02) ** 2)
x *= np.clip(1.14 - rr * 0.92, 0.05, 1.0)[..., None]
gr = np.random.default_rng(5).normal(0, 0.020, (H, W)).astype(np.float32)
x = x + gr[..., None] * (1.0 - np.clip(x, 0, 1)) ** 1.4

# --- 7. give the type back -------------------------------------------------
guard = np.clip((0.30 - ny) / 0.30, 0, 1) + np.clip((ny - 0.82) / 0.18, 0, 1)
guard = np.clip(guard, 0, 1)[..., None] * (lum[..., None] > 0.20)
x = base * guard * 0.80 + x * (1 - guard * 0.80)

p = os.path.join(OUT, "poster-en-v4-surgical.jpg")
Image.fromarray((np.clip(x, 0, 1) * 255).astype(np.uint8)).save(p, quality=93)
print("wrote", p)
