"""Build a countdown reel for Instagram. One number in, one 9:16 film out.

The shape is taken from the reel that works: a long hold where the number has
not arrived yet, then it lands on a single frame, then the picture dissolves and
the sound stops dead. The waiting is the content.

The first cut took that too literally - seven seconds of a still photograph with
a 7.5% zoom on it, which on a phone is a JPEG with extra steps. The waiting only
works if the waiting is doing something. So the push is three times bigger now,
fog moves through the lower half, the lanterns actually flicker, and twice
before the number lands something happens: the light behind the door surges, and
then the house blinks out and comes back brighter than it left.

    python tools/reel.py                  # days to opening, worked out from today
    python tools/reel.py --days 14
    python tools/reel.py --days 1 --out reels/one.mp4

Needs ffmpeg on PATH and img/hero-reel.jpg (written by tools/hero.py).
"""
import argparse
import datetime
import os
import shutil
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
PLATE = os.path.join(ROOT, "img", "hero-reel.jpg")
FONT_R = os.path.join(HERE, "fonts", "Cinzel-Regular.ttf")
FONT_B = os.path.join(HERE, "fonts", "Cinzel-SemiBold.ttf")

W, H, FPS = 1080, 1920, 30
OPENS = datetime.date(2026, 9, 25)

# The page's red, and the page's bone. If these two ever drift from index.html
# the reel stops looking like it came from the same house.
RED = (216, 74, 60)
BONE = (207, 196, 180)

# beats, in seconds
T_UP = 0.7            # up from black
T_SURGE = 3.3         # something behind the door leans on the light
T_BLINK = 5.0         # the house goes out
T_TEXT = 6.1          # the number
T_DATE = T_TEXT + 0.45
T_OUT = 8.1           # dissolve starts
T_END = 9.2


def ease_out(t):
    return 1 - (1 - t) ** 3


def span(t, start, dur):
    """0 before `start`, 1 after `start + dur`, eased in between."""
    if dur <= 0:
        return 1.0 if t >= start else 0.0
    return ease_out(min(max((t - start) / dur, 0.0), 1.0))


def decay(t, start, rate):
    """A spike at `start` falling off exponentially. 0 before it."""
    return 0.0 if t < start else float(np.exp(-rate * (t - start)))


def tracked(draw, text, font, tracking, cx, y, fill):
    """PIL has no letter-spacing, and this typography is mostly letter-spacing."""
    widths = [draw.textlength(c, font=font) for c in text]
    total = sum(widths) + tracking * (len(text) - 1)
    x = cx - total / 2
    for c, w in zip(text, widths):
        draw.text((x, y), c, font=font, fill=fill)
        x += w + tracking
    return total


def glow_text(base, text, font, tracking, cx, y, colour, alpha, radius, strength):
    """Type on a photograph needs to sit in the air, not on the glass."""
    layer = Image.new("L", base.size, 0)
    tracked(ImageDraw.Draw(layer), text, font, tracking, cx, y, 255)
    if strength > 0:
        halo = layer.filter(ImageFilter.GaussianBlur(radius))
        base.paste(Image.new("RGB", base.size, colour), (0, 0),
                   halo.point(lambda v: int(v * strength * alpha)))
    base.paste(Image.new("RGB", base.size, colour), (0, 0),
               layer.point(lambda v: int(v * alpha)))


def masks(plate):
    """Pull the two things in this photograph that can be made to move: the warm
    highlights (lanterns, and the light lying on the floor) and the red spill
    coming through the doorway. Derived from the plate rather than hand-painted,
    so replacing the render does not mean re-masking by hand."""
    a = np.asarray(plate).astype(np.float32) / 255.0
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    lum = a @ np.array([0.2126, 0.7152, 0.0722], np.float32)

    warm = np.clip(R - B - 0.03, 0, 1) * np.clip((lum - 0.10) / 0.45, 0, 1)
    red = np.clip((R - np.maximum(G, B)) * 2.4, 0, 1) * np.clip(lum / 0.35, 0, 1)

    def to_img(m):
        m = m / max(m.max(), 1e-6)
        return Image.fromarray((np.clip(m, 0, 1) * 255).astype(np.uint8), "L")

    return to_img(warm), to_img(red)


def fog_texture(rng, cells, w, h):
    """Low-frequency noise, upsampled until it is cloud rather than static. Twice
    as wide as the frame so a full pass can scroll through without repeating."""
    n = rng.normal(0, 1, (cells, cells * 2)).astype(np.float32)
    n = (n - n.min()) / (np.ptp(n) + 1e-6)
    img = Image.fromarray((n * 255).astype(np.uint8), "L").resize((w * 2, h), Image.BICUBIC)
    return np.asarray(img).astype(np.float32) / 255.0


def days_until(target):
    return (target - datetime.date.today()).days


def label(n):
    if n <= 0:
        return "TONIGHT", None
    return str(n), "DAY REMAINS" if n == 1 else "DAYS REMAIN"


def build_frames(n, outdir, quiet):
    plate = Image.open(PLATE).convert("RGB")
    pw, ph = plate.size
    m_warm, m_red = masks(plate)
    big, small = label(n)

    # a numeral can afford to be enormous; a seven-letter word at the same
    # weight runs into both edges of a 1080 frame
    f_num = ImageFont.truetype(FONT_B, 300 if small else 106)
    track_num = f_num.size * (0.03 if small else 0.12)
    f_word = ImageFont.truetype(FONT_R, 58)
    f_date = ImageFont.truetype(FONT_R, 34)

    # a scrim that arrives with the type and not a moment before, so the run-up
    # is the house and nothing else
    scrim = Image.new("L", (W, H), 0)
    ImageDraw.Draw(scrim).ellipse((-W * 0.35, H * 0.24, W * 1.35, H * 0.94), fill=150)
    scrim = scrim.filter(ImageFilter.GaussianBlur(150))

    rng = np.random.default_rng(7)

    # lantern flicker: fast, uneven, and clamped so it reads as flame and not as
    # a fault in the video
    fl = rng.normal(0, 1, 1024)
    fl = np.convolve(fl, np.ones(4) / 4, "same")
    fl = fl / (np.abs(fl).max() + 1e-6)

    fog_a = fog_texture(rng, 22, W, H)
    fog_b = fog_texture(rng, 40, W, H)

    # fog belongs on the ground. Fade it out above the doorway or the whole
    # frame turns into weather.
    yy = np.linspace(0, 1, H, dtype=np.float32)[:, None]
    fog_mask = np.clip((yy - 0.34) / 0.34, 0, 1) ** 1.4
    fog_mask *= np.clip((1.02 - yy) / 0.12, 0, 1)

    total = int(T_END * FPS)
    for i in range(total):
        t = i / FPS

        # the camera creeps. 26% across the take, decelerating, which is what a
        # slider looks like and what a zoom does not
        z = 1.0 + 0.26 * ease_out(min(t / T_END, 1.0))
        cw, ch = pw / z, ph / z
        # drift down as it pushes in, so the doorway climbs toward the middle
        # of frame instead of sliding out of the bottom of it
        oy = (ph - ch) * (0.50 + 0.22 * ease_out(t / T_END))
        box = (int((pw - cw) / 2), int(oy), int((pw - cw) / 2 + cw), int(oy + ch))

        fr = plate.crop(box).resize((W, H), Image.LANCZOS)
        warm = np.asarray(m_warm.crop(box).resize((W, H), Image.BILINEAR), np.float32) / 255.
        red = np.asarray(m_red.crop(box).resize((W, H), Image.BILINEAR), np.float32) / 255.

        x = np.asarray(fr).astype(np.float32)

        # --- the lanterns ---------------------------------------------------
        x += warm[..., None] * (34.0 * fl[i % fl.size]) * np.array([1.0, .72, .38], np.float32)

        # --- the light behind the door --------------------------------------
        # a slow breath under everything, a hard surge at T_SURGE, and a step up
        # that never comes back down once the house returns from the blink
        glow = 0.10 * np.sin(t * 2.1)
        glow += 1.45 * decay(t, T_SURGE, 3.2)
        glow += 0.55 * span(t, T_BLINK + 0.30, 0.5)
        x += red[..., None] * (46.0 * glow) * np.array([1.0, .22, .16], np.float32)

        # --- fog ------------------------------------------------------------
        oa = int((t * 26) % W)
        ob = int((W * 2 - 1) - (t * 41) % W)
        f = fog_a[:, oa:oa + W] * 0.62 + fog_b[:, ob - W:ob] * 0.38
        f = (f - 0.42) * fog_mask
        x += np.clip(f, 0, 1)[..., None] * 30.0 * np.array([.82, .86, 1.0], np.float32)

        # --- type -------------------------------------------------------------
        a_text = span(t, T_TEXT, 0.9)
        a_date = span(t, T_DATE, 0.9)
        if a_text > 0 or a_date > 0:
            fr = Image.fromarray(np.clip(x, 0, 255).astype(np.uint8))
            if a_text > 0:
                fr.paste(Image.new("RGB", (W, H), (2, 2, 3)), (0, 0),
                         scrim.point(lambda v: int(v * a_text)))
                # settle: the number arrives a hair large and comes to rest
                settle = 1.0 - 0.03 * (1 - a_text)
                y_num = H * 0.455 - f_num.size * settle * 0.62
                glow_text(fr, big, f_num, track_num, W / 2, y_num,
                          RED, a_text, 46, 0.55)
                if small:
                    glow_text(fr, small, f_word, f_word.size * 0.34, W / 2,
                              H * 0.455 + f_num.size * 0.46, RED, a_text, 26, 0.35)
            if a_date > 0:
                glow_text(fr, "SEPTEMBER 25", f_date, f_date.size * 0.32, W / 2,
                          H * 0.795, BONE, a_date * 0.85, 18, 0.20)
            x = np.asarray(fr).astype(np.float32)

        # --- grain, so 276 frames do not look like one photograph -------------
        x += rng.normal(0, 2.6, (H, W, 1)).astype(np.float32)

        # --- the blink --------------------------------------------------------
        # out in two frames, held for three, back over eight. Fast out and slow
        # back is what a light does; symmetrical is what a dissolve does.
        d = t - T_BLINK
        if -0.02 < d < 0.44:
            if d < 0.07:
                k = 1.0 - 0.94 * (d / 0.07)
            elif d < 0.17:
                k = 0.06
            else:
                k = 0.06 + 0.94 * ease_out((d - 0.17) / 0.27)
            x *= k

        # --- up from black at the head, down to black at the tail -------------
        if t < T_UP:
            x *= ease_out(t / T_UP)
        if t >= T_OUT:
            # near-linear. A quadratic ease-in holds the picture at full
            # brightness for most of the dissolve and then drops it all at once,
            # which reads as a cut rather than a fade.
            p = min((t - T_OUT) / (T_END - T_OUT), 1.0)
            x *= 1.0 - p ** 1.15

        Image.fromarray(np.clip(x, 0, 255).astype(np.uint8)).save(
            os.path.join(outdir, "f%05d.png" % i))
        if not quiet and i % 30 == 0:
            print("  frame %d/%d" % (i, total), file=sys.stderr)
    return total


def audio(path, silent):
    """A room tone that swells to the number and then stops dead, with a low hit
    under each of the three events. The cut to silence is the point; do not fade
    it out politely."""
    if silent:
        return None

    # one thud per beat, each an exponential fall on a 52Hz sine
    hits = "+".join(
        "%.2f*exp(-%.1f*max(0,t-%.2f))*between(t,%.2f,%.2f)" % (g, r, s, s, s + 1.2)
        for g, r, s in ((1.10, 9.0, T_SURGE), (1.60, 7.0, T_BLINK), (1.25, 6.0, T_TEXT))
    )
    swell = "volume=0.30+0.55*min(1\\,t/{:.2f}):eval=frame".format(T_TEXT)
    chain = (
        "[0]volume=0.5[a];[1]volume=0.22[b];[2]lowpass=f=220,volume=0.30[c];"
        "[3]volume='" + hits + "':eval=frame,lowpass=f=140[d];"
        "[a][b][c]amix=inputs=3:normalize=0," + swell + "[bed];"
        "[bed][d]amix=inputs=2:normalize=0,"
        "afade=t=in:st=0:d=1.6,afade=t=out:st={:.2f}:d=0.06".format(T_OUT - 0.06) +
        ",alimiter=limit=0.85,aformat=sample_rates=48000:channel_layouts=stereo"
    )
    subprocess.run([
        "ffmpeg", "-y", "-v", "error",
        # run the sources the full length and cut them dead at T_OUT instead of
        # ending them there: -shortest would otherwise trim the video and take
        # the dissolve to black with it
        "-f", "lavfi", "-i", "sine=frequency=44:duration=%.2f" % T_END,
        "-f", "lavfi", "-i", "sine=frequency=66:duration=%.2f" % T_END,
        "-f", "lavfi", "-i", "anoisesrc=color=brown:duration=%.2f" % T_END,
        "-f", "lavfi", "-i", "sine=frequency=52:duration=%.2f" % T_END,
        "-filter_complex", chain,
        "-t", "%.2f" % T_END, path,
    ], check=True)
    return path


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=None)
    ap.add_argument("--out", default=None)
    ap.add_argument("--silent", action="store_true")
    ap.add_argument("--quiet", action="store_true")
    a = ap.parse_args()

    if not os.path.exists(PLATE):
        sys.exit("missing %s - run tools/hero.py first" % PLATE)
    if shutil.which("ffmpeg") is None:
        sys.exit("ffmpeg not on PATH")

    n = a.days if a.days is not None else days_until(OPENS)
    out = a.out or os.path.join(ROOT, "reels", "countdown-%02d.mp4" % max(n, 0))
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)

    tmp = tempfile.mkdtemp(prefix="reel")
    try:
        print("building %s (%d days)" % (os.path.basename(out), n))
        build_frames(n, tmp, a.quiet)
        wav = audio(os.path.join(tmp, "a.wav"), a.silent)
        cmd = ["ffmpeg", "-y", "-v", "error",
               "-framerate", str(FPS), "-i", os.path.join(tmp, "f%05d.png")]
        if wav:
            cmd += ["-i", wav, "-c:a", "aac", "-b:a", "192k", "-shortest"]
        cmd += ["-c:v", "libx264", "-preset", "slow", "-crf", "18",
                "-pix_fmt", "yuv420p", "-movflags", "+faststart", out]
        subprocess.run(cmd, check=True)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    print("wrote", out, os.path.getsize(out), "bytes")


if __name__ == "__main__":
    main()
