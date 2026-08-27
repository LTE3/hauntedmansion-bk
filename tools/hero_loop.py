"""Turn the hero plate into a seamless ambient loop.

The page was a photograph. Everything premium in this category moves, so the
lanterns flicker, something behind the door breathes, and fog crosses the
porch - but the camera does not move at all. Two reasons for that: the CSS
already drifts the layer, and a locked-off frame lets h264 spend its whole
budget on the light, which is the only thing changing. The 12s wide loop
comes out under a megabyte.

Everything here is periodic with the loop length by construction - sums of
integer harmonics for the light, FFT-filtered noise rolled by an exact
fraction of its own width for the fog. There is no crossfade hiding a seam
because there is no seam.

    python tools/hero_loop.py
"""

import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
IMG = ROOT / "img"

T = 12.0          # loop length, seconds
FPS = 24
NF = int(round(T * FPS))

# Deliberately a fraction of the reel's amplitudes. The reel is a thing you
# watch; this sits underneath a headline and repeats forever, and anything you
# can consciously see it doing is too much.
WARM_GAIN = 15.0  # lanterns
RED_GAIN = 20.0   # whatever is behind the door
FOG_GAIN = 11.0


def masks(plate):
    """The two things in this photograph that can be made to move: the warm
    highlights (lanterns, and the light lying on the floor) and the red spill
    coming through the doorway. Derived from the plate, so replacing the render
    does not mean re-masking by hand."""
    a = np.asarray(plate).astype(np.float32) / 255.0
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    lum = a @ np.array([0.2126, 0.7152, 0.0722], np.float32)

    warm = np.clip(R - B - 0.03, 0, 1) * np.clip((lum - 0.10) / 0.45, 0, 1)
    red = np.clip((R - np.maximum(G, B)) * 2.4, 0, 1) * np.clip(lum / 0.35, 0, 1)

    def norm(m):
        return np.clip(m / max(m.max(), 1e-6), 0, 1)

    return norm(warm), norm(red)


def fog_field(rng, h, w, cutoff=0.012):
    """Low-passed white noise. Done through the FFT specifically because the
    transform treats the array as periodic, so the field wraps exactly on both
    axes - a coarse grid upscaled with BICUBIC does not, and leaves a seam that
    walks across the frame once per loop."""
    F = np.fft.rfft2(rng.normal(0, 1, (h, w)))
    ky = np.fft.fftfreq(h)[:, None]
    kx = np.fft.rfftfreq(w)[None, :]
    F *= np.exp(-((np.sqrt(ky ** 2 + kx ** 2) / cutoff) ** 2))
    f = np.fft.irfft2(F, s=(h, w))
    f -= f.min()
    return f / max(f.max(), 1e-6)


def harmonics(u, terms):
    """u is the phase through the loop, 0..1.

    Raised cosines rather than sines. Integer frequencies alone make the value
    match at both ends, which is all a seam needs mathematically - but the first
    build phased them so the steepest part of the light curve landed exactly on
    the wrap, and the difference map showed the door and both lanterns lighting
    up right where the loop repeats. Continuous, and still the worst possible
    place to put the fastest change.

    (1 - cos)/2 is zero AND stationary at u=0 and u=1, so every harmonic comes
    to rest together at the wrap. The loop restarts from its own calmest,
    dimmest moment and the motion lives in the middle, where nobody is looking
    for a repeat."""
    return sum(a * (1.0 - np.cos(2 * np.pi * k * u)) * 0.5 for a, k in terms)


def render(plate_path, out_stem, size):
    plate = Image.open(plate_path).convert("RGB").resize(size, Image.LANCZOS)
    W, H = size
    base = np.asarray(plate).astype(np.float32)
    warm, red = masks(plate)

    rng = np.random.default_rng(7)
    fog_a = fog_field(rng, H, W, 0.010)
    fog_b = fog_field(rng, H, W, 0.016)

    # Fog only crosses the porch. Full-height fog reads as a dirty lens.
    yy = np.linspace(0, 1, H, dtype=np.float32)[:, None]
    band = np.clip((yy - 0.34) / 0.22, 0, 1) * np.clip((1.02 - yy) / 0.30, 0, 1)

    warm_rgb = warm[..., None] * np.array([1.0, .72, .38], np.float32)
    red_rgb = red[..., None] * np.array([1.0, .22, .16], np.float32)
    fog_rgb = np.array([.82, .86, 1.0], np.float32)

    proc = subprocess.Popen(
        ["ffmpeg", "-y", "-loglevel", "error",
         "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", "%dx%d" % (W, H),
         "-r", str(FPS), "-i", "-",
         # This is a near-black frame whose entire content is a slow
         # gradient. At crf 27 the codec threw the animation away: the
         # motion measures 0.26 mean absolute difference and the coding
         # noise measured 1.5, so the light was six times quieter than the
         # artefacts on top of it. aq-mode=3 biases the quantiser toward
         # dark regions, which is the whole picture here.
         "-an", "-c:v", "libx264", "-preset", "veryslow", "-crf", "19",
         "-x264-params", "aq-mode=3:aq-strength=1.2",
         "-pix_fmt", "yuv420p", "-profile:v", "high",
         # every frame is a valid loop point, so the GOP only needs to be
         # short enough that a browser seeking to 0 does not stall
         "-g", str(FPS * 2), "-movflags", "+faststart",
         str(out_stem) + ".mp4"],
        stdin=subprocess.PIPE)

    for i in range(NF):
        u = i / NF

        # irregular to the eye, exactly periodic to the maths
        fl = 0.80 + harmonics(u, [(.34, 3), (.22, 7), (.13, 11)])
        glow = 0.72 + harmonics(u, [(.62, 1), (.22, 2), (.10, 5)])

        x = base + warm_rgb * (WARM_GAIN * fl) + red_rgb * (RED_GAIN * glow)

        # rolled by an exact fraction of the field's own width: at i == NF the
        # shift is a whole width, which is the field it started as
        sa = int(round(u * W))
        sb = int(round(2 * u * W))
        f = np.roll(fog_a, -sa, axis=1) * .62 + np.roll(fog_b, sb, axis=1) * .38
        x += (np.clip(f - 0.46, 0, 1) * band)[..., None] * FOG_GAIN * fog_rgb

        # Truncating to 8 bits leaves visible contour rings in a gradient
        # this dark. A sub-LSB dither costs nothing and breaks them up;
        # it does not need to be periodic because uncorrelated noise has
        # no seam to see.
        x += rng.uniform(-0.5, 0.5, x.shape)
        proc.stdin.write(np.clip(x, 0, 255).astype(np.uint8).tobytes())

    proc.stdin.close()
    if proc.wait() != 0:
        sys.exit("ffmpeg failed for %s" % out_stem)

    subprocess.run(
        ["ffmpeg", "-y", "-loglevel", "error", "-i", str(out_stem) + ".mp4",
         "-an", "-c:v", "libvpx-vp9", "-crf", "30", "-b:v", "0",
         "-row-mt", "1", "-deadline", "good", "-cpu-used", "2",
         str(out_stem) + ".webm"], check=True)

    for ext in ("mp4", "webm"):
        p = Path(str(out_stem) + "." + ext)
        print("  %-28s %6.0f KB" % (p.name, p.stat().st_size / 1024))


if __name__ == "__main__":
    print("wide")
    render(IMG / "hero-wide@2x.jpg", IMG / "hero-loop-wide", (1280, 720))
    print("tall")
    render(IMG / "hero-tall@2x.jpg", IMG / "hero-loop-tall", (720, 960))
