# -*- coding: utf-8 -*-
"""Build the two alternate plate sets, from art that is already on this disk.

Nothing here generates an image. Every pixel comes out of the raw facade
paintings that were made for this project, or out of the photographic plates
that already ship. The point of the file is that the choice between "drawn" and
"photographed" stops being a question about credits and becomes a question you
can look at.

  ill-*   the illustrated set   - painted storefront, painted door, painted window
  re-*    the photographic set  - the same renders that ship today, regraded

The regrade is the interesting half. The renders have one fault and it is the
same fault three times: a single red light source has been allowed to paint the
entire frame, so a hallway that should read as a dark hallway with a red door at
the end reads instead as a red photograph. The fix is a mask, not a slider -
find the pixels that ARE the light, leave those alone, and white-balance
everything else back toward neutral-cool. Then the red means something again,
because it is somewhere instead of everywhere.
"""
import os
import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "img")


def _f(im):
    return np.asarray(im.convert("RGB"), dtype=np.float32) / 255.0


def _im(a):
    return Image.fromarray((np.clip(a, 0, 1) * 255.0 + .5).astype(np.uint8), "RGB")


def luma(a):
    return a[..., 0] * .2126 + a[..., 1] * .7152 + a[..., 2] * .0722


def blur(m, r):
    return _f(_im(np.dstack([m] * 3)).filter(ImageFilter.GaussianBlur(r)))[..., 0]


def light_mask(a, thresh=.30, chroma=.10, radius=26):
    """Where the picture is actually emitting light, not merely tinted by it.

    Bright AND strongly red-dominant. Blurred wide, so the mask has the shape
    of a glow rather than the shape of the bright pixels - which is what keeps
    the boundary invisible once it is used to blend two grades together.
    """
    L = luma(a)
    hot = np.clip((L - thresh) / (1.0 - thresh), 0, 1)
    red = np.clip((a[..., 0] - np.maximum(a[..., 1], a[..., 2]) - chroma) / .30, 0, 1)
    return np.clip(blur(hot * red, radius) * 2.2, 0, 1)


def white_balance(a, target=(.97, 1.0, 1.06), lo=.04, hi=.75):
    """Gray-world, but measured only over the midtones.

    Averaging the whole frame lets a large black area decide the correction,
    and these frames are mostly black. Sampling between lo and hi means the
    walls vote and the shadows do not.
    """
    L = luma(a)
    sel = (L > lo) & (L < hi)
    if sel.sum() < 400:
        return a
    means = np.array([a[..., c][sel].mean() for c in range(3)], dtype=np.float32)
    gain = (means.mean() * np.asarray(target, np.float32)) / np.maximum(means, 1e-4)
    gain = np.clip(gain, .55, 1.9)
    return a * gain


def curve(a, contrast=1.0, lift=0.0, gamma=1.0, pivot=.34):
    a = np.clip(a, 0, 1) ** gamma
    a = (a - pivot) * contrast + pivot + lift
    return np.clip(a, 0, 1)


def cool_shadows(a, amount=.05, warm_high=.02):
    """Split-tone. Blue into the shadows, a little amber into the highs.

    This is the whole reason a night photograph reads as night rather than as
    an underexposed day: the darkness is a colour, and it is not the same
    colour as the lamp.
    """
    L = luma(a)[..., None]
    sh = (1.0 - L) ** 2
    hi = L ** 2
    t = np.dstack([-amount * .55 * sh[..., 0] + warm_high * hi[..., 0],
                   -amount * .12 * sh[..., 0] + warm_high * .55 * hi[..., 0],
                   amount * sh[..., 0] - warm_high * .70 * hi[..., 0]])
    return np.clip(a + t, 0, 1)


def vignette(a, strength=.34, radius=.86):
    h, w = a.shape[:2]
    y, x = np.mgrid[0:h, 0:w].astype(np.float32)
    d = np.sqrt(((x / w - .5) / .5) ** 2 + ((y / h - .5) / .5) ** 2) / 1.4142
    v = 1.0 - strength * np.clip((d - radius * .55) / (1.0 - radius * .55), 0, 1) ** 1.6
    return a * v[..., None]


def local_contrast(im, radius=22, percent=42, threshold=2):
    return im.filter(ImageFilter.UnsharpMask(radius=radius, percent=percent, threshold=threshold))


def grain(a, amount=.012, seed=7):
    """Interpolation mush and banding both read as cheap; grain reads as film.

    Deterministic seed, so a rebuild produces a byte-identical plate and git
    does not churn.
    """
    rng = np.random.default_rng(seed)
    n = rng.normal(0, 1, a.shape[:2]).astype(np.float32)
    n = blur(n * .5 + .5, .6) * 2 - 1
    L = luma(a)
    return np.clip(a + (n * amount * (1.0 - np.abs(L - .5) * 1.2))[..., None], 0, 1)


# ---------------------------------------------------------------- the grades

def regrade_photo(src, keep=.9, contrast=1.16, lift=.004, gamma=.98,
                  cool=.075, vig=.30, sharp=44, seed=7):
    """Take the red out of everywhere and leave it where the light is."""
    a = _f(Image.open(src))
    m = light_mask(a)[..., None] * keep
    n = cool_shadows(white_balance(a), amount=cool)
    n = curve(n, contrast=contrast, lift=lift, gamma=gamma)
    out = n * (1 - m) + curve(a, contrast=contrast * .96, lift=lift) * m
    out = vignette(out, strength=vig)
    out = _f(local_contrast(_im(out), percent=sharp))
    return _im(grain(out, seed=seed))


def grade_ill(src, box=None, contrast=1.12, lift=-.004, gamma=1.03,
              cool=.045, vig=.34, sharp=26, sat=.94, seed=11):
    """The paintings need less. Deepen, cool slightly, do not fight the hand."""
    im = Image.open(src)
    if box:
        w, h = im.size
        im = im.crop((int(box[0] * w), int(box[1] * h), int(box[2] * w), int(box[3] * h)))
    a = _f(im)
    g = luma(a)[..., None]
    a = g + (a - g) * sat
    a = cool_shadows(a, amount=cool, warm_high=.03)
    a = curve(a, contrast=contrast, lift=lift, gamma=gamma)
    a = vignette(a, strength=vig)
    a = _f(local_contrast(_im(a), radius=16, percent=sharp))
    return _im(grain(a, amount=.010, seed=seed))


# ------------------------------------------------------------------- output

# Exactly the dimensions the shipped plates use, so swapping a set is a
# filename substitution in the HTML and nothing else has to move.
SIZES = {
    "hero":  [("tall", 720, 960), ("tall@2x", 1440, 1920), ("wide", 1280, 720), ("wide@2x", 2560, 1440)],
    "hall":  [("tall", 576, 720), ("tall@2x", 1152, 1440), ("wide", 1600, 900), ("wide@2x", 2560, 1440)],
    "stair": [("tall", 540, 720), ("tall@2x", 1080, 1440), ("wide", 1400, 788), ("wide@2x", 2100, 1181)],
}


def cover(im, w, h, anchor=.5):
    """Fill w x h without distorting. anchor is where the crop sits vertically."""
    sw, sh = im.size
    s = max(float(w) / sw, float(h) / sh)
    r = im.resize((max(w, int(sw * s + .5)), max(h, int(sh * s + .5))), Image.LANCZOS)
    rw, rh = r.size
    x = (rw - w) // 2
    y = int((rh - h) * anchor)
    return r.crop((x, y, x + w, y + h))


def emit(base, prefix, plate, anchor=.5, q=82):
    made = []
    for suf, w, h in SIZES[plate]:
        p = os.path.join(OUT, "%s%s-%s.jpg" % (prefix, plate, suf))
        cover(base, w, h, anchor).save(p, "JPEG", quality=q, optimize=True, progressive=True)
        made.append((os.path.basename(p), os.path.getsize(p) // 1024))
    return made


def build():
    log = []

    # -- illustrated: the storefront, then the open door, then the window ----
    # A sequence rather than three pictures: you are outside, then you are at
    # the threshold, then you are looking at glass that is already broken.
    ill = [
        ("hero",  "img/facade-raw.png",    None,                 .42, dict()),
        ("hall",  "img/facade-raw-v2.png", (.34, .18, .66, .97), .46, dict(contrast=1.10, vig=.30, sat=.86)),
        ("stair", "img/facade-raw-v2.png", (.03, .13, .43, .92), .40, dict(contrast=1.08, vig=.40, sat=.88)),
    ]
    for plate, src, box, anchor, kw in ill:
        b = grade_ill(os.path.join(ROOT, src), box=box, **kw)
        log += emit(b, "ill-", plate, anchor)

    # -- photographic: the shipped renders, with the red put back in its place
    for plate in ("hero", "hall", "stair"):
        if plate == "hall":
            kw = dict(keep=.82, contrast=1.22, cool=.072, sharp=52)    # worst offender
        elif plate == "stair":
            kw = dict(keep=.86, contrast=1.14, cool=.062, lift=.010)   # crushed, needs air
        else:
            kw = dict(keep=.94, contrast=1.20, cool=.070, sharp=50)    # flat, not red
        w = regrade_photo(os.path.join(OUT, "%s-wide@2x.jpg" % plate), **kw)
        t = regrade_photo(os.path.join(OUT, "%s-tall@2x.jpg" % plate), **kw)
        for suf, ww, hh in SIZES[plate]:
            p = os.path.join(OUT, "re-%s-%s.jpg" % (plate, suf))
            base = t if suf.startswith("tall") else w
            cover(base, ww, hh, .5).save(p, "JPEG", quality=82, optimize=True, progressive=True)
            log.append((os.path.basename(p), os.path.getsize(p) // 1024))

    total = sum(k for _, k in log)
    for name, k in log:
        print("%-26s %5d KB" % (name, k))
    print("-- %d files, %d KB" % (len(log), total))


if __name__ == "__main__":
    build()
