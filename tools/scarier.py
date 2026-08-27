"""Push Cali's poster further into dread without touching her layout.

Cali's grade already works: dark, fogged, cobwebbed, warm practicals. What it
does not yet do is make the viewer uneasy. Three things do that, and none of
them is "make it darker":
  1. the light stops agreeing with itself - cold moonlight against sick amber
  2. something moves in the depth - fog that has structure, not a flat wash
  3. the frame closes in - the edges rot away so the house is the only exit

Type zones are protected so the headline and CTA stay legible.
"""
import os
import numpy as np
from PIL import Image, ImageFilter

SRC = os.path.join("img", "cali")
OUT = os.path.join("img", "scarier")
os.makedirs(OUT, exist_ok=True)


def value_noise(h, w, octaves, seed):
    """Cheap fBm - fog needs structure or it reads as haze on a lens."""
    rng = np.random.default_rng(seed)
    out = np.zeros((h, w), np.float32)
    amp, tot = 1.0, 0.0
    for o in range(octaves):
        s = max(2, int(2 ** (o + 2)))
        base = rng.random((s, s)).astype(np.float32)
        layer = np.asarray(
            Image.fromarray((base * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC),
            dtype=np.float32) / 255.0
        out += layer * amp
        tot += amp
        amp *= 0.55
    return out / tot


def scarier(name, src, cold=(0.72, 0.86, 1.18), sick=0.55, fog_amt=0.30,
            ember=0.85, vig=1.10, grain=0.022, rot=0.55, protect_top=0.30,
            protect_bot=0.18):
    im = Image.open(os.path.join(SRC, src)).convert("RGB")
    W, H = im.size
    x = np.asarray(im).astype(np.float32) / 255.0

    yy, xx = np.mgrid[0:H, 0:W].astype(np.float32)
    ny, nx = yy / H, xx / W

    lum = x @ np.array([0.2126, 0.7152, 0.0722], np.float32)
    soft = np.asarray(Image.fromarray((lum * 255).astype(np.uint8))
                      .filter(ImageFilter.GaussianBlur(W * 0.02))).astype(np.float32) / 255.0
    practical = np.clip((lum - soft) * 3.2 + (lum - 0.48) * 2.4, 0, 1)[..., None]

    # type zones keep most of their contrast - a poster nobody can read is not scary
    guard = np.clip((protect_top - ny) / protect_top, 0, 1) + \
            np.clip((ny - (1 - protect_bot)) / protect_bot, 0, 1)
    guard = np.clip(guard, 0, 1)[..., None] * (lum[..., None] > 0.22)
    strength = 1.0 - 0.75 * guard

    base = x.copy()

    # 1. the light disagrees: ambient goes cold, flames stay amber and get hotter
    amb = np.array(cold, np.float32)
    amb = amb / amb.mean()
    x = x * (amb * (1 - practical) + practical * np.array([1.12, 0.92, 0.68], np.float32))

    # 2. sickness in the midtones - desaturate the field, push flames warmer
    g = (x @ np.array([0.2126, 0.7152, 0.0722], np.float32))[..., None]
    x = g + (x - g) * (sick * (1 - practical) + 1.45 * practical)

    # 3. fog with structure, crawling up from the floor and pooling in the doorway
    n = value_noise(H, W, 5, 11)
    rise = np.clip((ny - 0.42) / 0.58, 0, 1) ** 1.5
    door = np.exp(-(((nx - 0.5) / 0.28) ** 2 + ((ny - 0.72) / 0.30) ** 2))
    fog = np.clip(n * 1.25 - 0.35, 0, 1) * (rise * 0.8 + door * 0.6)
    x = x + fog[..., None] * fog_amt * np.array([0.52, 0.60, 0.72], np.float32) * (1 - x)

    # 4. embers: halation off every flame, so the practicals bleed into the fog
    e = np.clip(x - 0.42, 0, 1) * practical
    e = np.asarray(Image.fromarray((np.clip(e, 0, 1) * 255).astype(np.uint8))
                   .filter(ImageFilter.GaussianBlur(W * 0.016))).astype(np.float32) / 255.0
    x = x + e * ember * np.array([1.00, 0.58, 0.22], np.float32)

    # 5. the frame rots: edges lose detail into black, so the house is the only exit
    r = np.sqrt(((nx - 0.5) * 1.25) ** 2 + ((ny - 0.58) * 1.05) ** 2)
    x *= np.clip(1.16 - r * vig, 0.04, 1.0)[..., None]
    edge = np.clip((r - 0.42) / 0.45, 0, 1)
    dark = np.asarray(Image.fromarray((np.clip(x, 0, 1) * 255).astype(np.uint8))
                      .filter(ImageFilter.GaussianBlur(W * 0.01))).astype(np.float32) / 255.0
    x = x * (1 - edge[..., None] * rot) + dark * (edge[..., None] * rot) * 0.55

    # 6. pushed-film grain, heavier where there is least light
    gr = np.random.default_rng(3).normal(0, grain, (H, W)).astype(np.float32)
    x = x + gr[..., None] * (1.0 - np.clip(x, 0, 1)) ** 1.4

    # 7. hand the type back most of what it lost
    x = base * (1 - strength) + x * strength

    p = os.path.join(OUT, f"{name}.jpg")
    Image.fromarray((np.clip(x, 0, 1) * 255).astype(np.uint8)).save(p, quality=93)
    print("wrote", p)


# three intensities off the same English poster
scarier("poster-en-v1", "poster-en.png", fog_amt=0.26, ember=0.70, vig=0.95,
        rot=0.42, sick=0.62, grain=0.018)
scarier("poster-en-v2", "poster-en.png", fog_amt=0.34, ember=0.90, vig=1.12,
        rot=0.58, sick=0.50, grain=0.024)
scarier("poster-en-v3", "poster-en.png", cold=(0.66, 0.94, 0.86), fog_amt=0.42,
        ember=1.05, vig=1.28, rot=0.70, sick=0.40, grain=0.030)
