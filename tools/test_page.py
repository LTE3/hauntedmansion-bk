#!/usr/bin/env python3
"""The page's test suite.

Every change to this site has been verified by hand in a browser, which
works right up until the day someone is tired. These are the checks that
were being done by eye, written down so they run the same way every time.

    python tools/test_page.py            everything
    python tools/test_page.py --fast     skip the browser tests

Exit 0 all passed, 1 otherwise. A browser test needs playwright; without
it those are reported skipped rather than passed, because a suite that
quietly stops testing the thing it was written for is worse than no suite.
"""

import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PAGE = os.path.join(ROOT, "index.html")
OPENS = "2026-09-25"

PASS, FAIL, SKIP = [], [], []


def check(name, ok, detail=""):
    (PASS if ok else FAIL).append((name, detail))
    print("  %s %s%s" % ("PASS" if ok else "FAIL", name, ("  -- " + detail) if detail and not ok else ""))
    return ok


def skip(name, why):
    SKIP.append((name, why))
    print("  SKIP %s  -- %s" % (name, why))


def html():
    with open(PAGE, encoding="utf-8") as f:
        return f.read()


# --------------------------------------------------------------------------
# Static checks. These need no browser and catch the failures that have
# actually happened on this project rather than a generic checklist.
# --------------------------------------------------------------------------

def test_static():
    print("\nstatic")
    s = html()

    # csp.py rewrites the hashes of every inline <style> and <script>. Editing
    # CSS or JS without re-running it produces a page whose styles are silently
    # refused by the browser - it still renders, just wrong, which is the worst
    # possible failure mode. This is the check that catches it.
    r = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "csp.py"), "--check"],
                       capture_output=True, text=True, cwd=ROOT)
    check("CSP hashes match inline style/script bodies", r.returncode == 0 and "0 stale" in r.stdout,
          (r.stdout + r.stderr).strip()[-300:])

    r = subprocess.run([sys.executable, os.path.join(ROOT, "tools", "secretscan.py"), "--all"],
                       capture_output=True, text=True, cwd=ROOT)
    check("no live credentials in tracked files", r.returncode == 0, r.stdout.strip()[-300:])

    # The inline script is the whole of the page's behaviour and a syntax error
    # in it disables all of it at once.
    blocks = re.findall(r"<script(?![^>]*\bsrc=)[^>]*>(.*?)</script>", s, re.S)
    ok = len(blocks) > 0
    for i, b in enumerate(blocks):
        tmp = os.path.join(ROOT, "_t%d.js" % i)
        with open(tmp, "w", encoding="utf-8") as f:
            f.write(b)
        try:
            rc = subprocess.run(["node", "--check", tmp], capture_output=True).returncode
            ok = ok and rc == 0
        except FileNotFoundError:
            ok = None
        finally:
            os.remove(tmp)
    if ok is None:
        skip("inline JS parses", "node not on PATH")
    else:
        check("inline JS parses", ok)

    # The copy spec, as constraints. These are the owner's rules and the only
    # way they get broken is by someone forgetting them months later.
    check("no street address on the page",
          not re.search(r"\b\d{2,4}\s+[A-Z][a-z]+\s+(Ave|Avenue|St|Street|Rd|Road|Blvd|Pl|Place)\b", s))
    check("the neighbourhood clue is present", "BUSHWICK" in s.upper())
    check("no fabricated scarcity language",
          not re.search(r"only \d+ (spots|tickets|left)|\d+ people (are )?(viewing|waiting)|selling fast",
                        s, re.I))

    # Launch-day switches. These must be ON now and OFF on the 25th; the test
    # states which so nobody has to remember both halves.
    robots = os.path.join(ROOT, "robots.txt")
    dis = os.path.exists(robots) and "Disallow: /" in open(robots, encoding="utf-8").read()
    noindex = bool(re.search(r'<meta[^>]+name=["\']robots["\'][^>]+noindex', s, re.I))
    check("pre-launch: still hidden from search (delete both on launch day)", dis and noindex,
          "robots Disallow=%s noindex=%s" % (dis, noindex))

    # The day line is the one number on the page and the spec says a number
    # must be real. It is real only if it is computed from this attribute.
    m = re.search(r'class="dayline"[^>]*data-opens="(\d{4}-\d{2}-\d{2})"', s)
    check("day line reads its date from data-opens", bool(m), "attribute not found")
    if m:
        check("day line opens on " + OPENS, m.group(1) == OPENS, "found " + m.group(1))

    for frag, why in [
        ("eyeshow", "JS matches this keyframe name in animationend"),
        ("key-stage", "the eclipse and blackout classes hang off it"),
        ('id="done"', "the submit success panel"),
        ("hmGone", "the blackout flag"),
        ("aria-live", "the success panel must announce itself"),
        ("prefers-reduced-motion", "the motion opt-out"),
    ]:
        check("present: %s (%s)" % (frag, why), frag in s)


# --------------------------------------------------------------------------
# Browser checks. Everything below was previously done by looking at it.
# --------------------------------------------------------------------------

def test_browser():
    print("\nbrowser")
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        skip("all browser tests", "playwright not installed")
        return

    import http.server
    import socketserver
    import threading

    os.chdir(ROOT)
    # Threading, not TCPServer: a page holding a connection open blocked
    # every later navigation until it timed out.
    handler = http.server.SimpleHTTPRequestHandler
    http.server.ThreadingHTTPServer.allow_reuse_address = True
    http.server.ThreadingHTTPServer.daemon_threads = True
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    port = srv.server_address[1]
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = "http://127.0.0.1:%d/index.html" % port

    try:
        with sync_playwright() as p:
            b = p.chromium.launch()
            _browser_cases(b, url)
            b.close()
    finally:
        srv.shutdown()


def _browser_cases(b, url):
    from datetime import date

    # --- loads clean -------------------------------------------------------
    errs = []
    pg = b.new_page(viewport={"width": 430, "height": 932})
    pg.on("pageerror", lambda e: errs.append("pageerror: %s" % e))
    pg.on("console", lambda m: errs.append("console.%s: %s" % (m.type, m.text)) if m.type == "error" else None)
    pg.goto(url, wait_until="load")
    pg.wait_for_timeout(1200)
    check("page loads with no console errors", not errs, "; ".join(errs[:3]))

    # --- the day count, against a clock we control -------------------------
    # The arithmetic is the part that can be wrong without looking wrong, and
    # it can only be wrong on days nobody is testing on. So test those days.
    y, m, d = (int(x) for x in OPENS.split("-"))
    cases = [
        ("2026-09-24", "One day remains"),
        ("2026-09-25", "Tonight"),
        ("2026-09-01", "24 days remain"),
        ("2026-03-01", "208 days remain"),
    ]
    for today, want in cases:
        ty, tm, td = (int(x) for x in today.split("-"))
        got = pg.evaluate(
            """([o, t]) => {
                 const m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(o);
                 const n = Math.round((Date.UTC(+m[1], +m[2]-1, +m[3]) - Date.UTC(t[0], t[1]-1, t[2])) / 86400000);
                 return n > 1 ? n + " days remain" : n === 1 ? "One day remains" : n === 0 ? "Tonight" : null;
               }""", [OPENS, [ty, tm, td]])
        check("day count on %s -> %r" % (today, want), got == want, "got %r" % got)

    # The day after opening the line must vanish rather than count backwards.
    hidden = pg.evaluate(
        """(o) => {
             const m = /^(\\d{4})-(\\d{2})-(\\d{2})$/.exec(o);
             const n = Math.round((Date.UTC(+m[1], +m[2]-1, +m[3]) - Date.UTC(2026, 8, 26)) / 86400000);
             return n < 0;
           }""", OPENS)
    check("day line hides itself after opening night", hidden)

    # And the live page agrees with today's real date.
    today = date.today()
    n = (date(y, m, d) - today).days
    want = ("%d days remain" % n) if n > 1 else "One day remains" if n == 1 else "Tonight" if n == 0 else ""
    got = pg.evaluate("() => document.querySelector('.dayline').textContent")
    check("live day line matches today's real date", got == want, "got %r want %r" % (got, want))

    # --- the submit blackout, without touching the database ----------------
    # fetch is stubbed, so this exercises the real success branch of the real
    # handler and writes nothing to Supabase.
    pg.evaluate("""() => {
        document.getElementById('modal')?.removeAttribute('hidden');
        window.fetch = async () => new Response('', {status: 201});
    }""")
    pg.fill("#name", "Test Person")
    pg.fill("#email", "test@example.invalid")
    pg.evaluate("() => document.querySelector('form').requestSubmit()")
    pg.wait_for_timeout(600)
    check("success panel shows after submit",
          pg.evaluate("() => getComputedStyle(document.getElementById('done')).display") == "block")
    check("blackout class applied on submit",
          pg.evaluate("() => document.querySelector('.key-stage').classList.contains('gone')"))
    check("blackout flag set", pg.evaluate("() => window.hmGone === true"))
    pg.wait_for_timeout(3800)
    st = pg.evaluate("""() => {
        const c = e => getComputedStyle(e);
        return {hole: c(document.querySelector('.keyhole')).filter,
                rim: c(document.querySelector('.key-outline path')).opacity,
                play: c(document.querySelector('.keyhole img')).animationPlayState};
    }""")
    check("porch darkened to brightness(0.18)", "brightness(0.18)" in st["hole"], st["hole"][-40:])
    check("rim survives at 0.4", st["rim"] == "0.4", st["rim"])
    check("heartbeat paused", st["play"] == "paused", st["play"])
    check("dialog is relabelled to the success heading",
          pg.evaluate("() => document.getElementById('modal').getAttribute('aria-labelledby')") == "done-title")
    pg.wait_for_timeout(2000)
    check("the eye does not return once the house is dark",
          pg.evaluate("() => getComputedStyle(document.querySelector('.key-eye')).opacity") == "0")
    pg.close()

    # --- submitting DURING the opening eclipse ------------------------------
    # This is the case that shipped broken. The eclipse animation runs from 2s
    # to 6.5s after load and animates the same properties the blackout sets;
    # an animation outranks an ordinary declaration, and the blackout also
    # pauses animations, so a submit inside that window froze the porch on a
    # mid-eclipse frame and left it there permanently. Anyone filling the form
    # quickly saw it. The suite above did not, because it waited.
    pg = b.new_page(viewport={"width": 430, "height": 932})
    pg.goto(url, wait_until="load")
    pg.wait_for_timeout(2600)          # inside the eclipse run
    pg.evaluate("""() => {
        document.getElementById('modal')?.removeAttribute('hidden');
        window.fetch = async () => new Response('', {status: 201});
    }""")
    pg.fill("#name", "Early Bird")
    pg.fill("#email", "early@example.invalid")
    pg.evaluate("() => document.querySelector('form').requestSubmit()")
    pg.wait_for_timeout(4200)
    st = pg.evaluate("""() => {
        const c = e => getComputedStyle(e);
        return {hole: c(document.querySelector('.keyhole')).filter,
                rim:  c(document.querySelector('.key-outline path')).opacity,
                glow: c(document.querySelector('.key-glow')).filter,
                wash: c(document.querySelector('.red-wash')).filter};
    }""")
    check("early submit: porch still reaches brightness(0.18)",
          "brightness(0.18)" in st["hole"], st["hole"][-40:])
    check("early submit: rim reaches 0.4 and is not frozen mid-eclipse",
          st["rim"] == "0.4", "froze at %s" % st["rim"])
    check("early submit: bloom reaches brightness(0.05)",
          "brightness(0.05)" in st["glow"], st["glow"])
    check("early submit: wash reaches brightness(0)",
          "brightness(0)" in st["wash"], st["wash"])
    pg.close()

    # --- reduced motion ----------------------------------------------------
    ctx = b.new_context(viewport={"width": 430, "height": 932}, reduced_motion="reduce")
    r = ctx.new_page()
    rerrs = []
    r.on("pageerror", lambda e: rerrs.append(str(e)))
    r.goto(url, wait_until="load")
    r.wait_for_timeout(1500)
    check("reduced motion: loads clean", not rerrs, "; ".join(rerrs[:2]))
    check("reduced motion: the eye never appears",
          r.evaluate("() => getComputedStyle(document.querySelector('.key-eye')).opacity") == "0")
    r.evaluate("() => {window.hmGone = true; document.querySelector('.key-stage').classList.add('gone')}")
    r.wait_for_timeout(3800)
    check("reduced motion: the blackout still applies as static state",
          "brightness(0.18)" in r.evaluate("() => getComputedStyle(document.querySelector('.keyhole')).filter"))
    r.close()

    # --- contrast ----------------------------------------------------------
    # A real defect shipped here once: the day line was set in the brand red,
    # which passes for the headline because large text owes 3:1 and fails for
    # 13px body text, which owes 4.5:1. Measure, do not eyeball.
    pg = b.new_page(viewport={"width": 430, "height": 932})
    pg.goto(url, wait_until="load")
    pg.wait_for_timeout(1200)
    ratios = pg.evaluate("""() => {
        const lum = c => { const v = c.map(x => { x /= 255;
              return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); });
            return 0.2126*v[0] + 0.7152*v[1] + 0.0722*v[2]; };
        const rgb = s => s.match(/\\d+/g).slice(0, 3).map(Number);
        const out = {};
        for (const sel of ['.dayline', '.lead', 'h1']) {
            const el = document.querySelector(sel); if (!el) continue;
            const fg = lum(rgb(getComputedStyle(el).color));
            // The ground behind the text is the page, not a parent's own paint.
            const bg = lum([12, 5, 5]);
            out[sel] = Math.round(((Math.max(fg,bg)+0.05)/(Math.min(fg,bg)+0.05)) * 100) / 100;
        }
        return out;
    }""")
    check("day line contrast >= 4.5:1 (13px body text)", ratios.get(".dayline", 0) >= 4.5,
          "%s:1" % ratios.get(".dayline"))
    check("lead paragraph contrast >= 4.5:1", ratios.get(".lead", 0) >= 4.5, "%s:1" % ratios.get(".lead"))
    check("headline contrast >= 3:1 (large text)", ratios.get("h1", 0) >= 3.0, "%s:1" % ratios.get("h1"))
    pg.close()


def main():
    fast = "--fast" in sys.argv
    print("testing %s" % PAGE)
    test_static()
    if fast:
        print("\nbrowser\n  SKIP all  -- --fast")
    else:
        test_browser()

    print("\n%d passed, %d failed, %d skipped" % (len(PASS), len(FAIL), len(SKIP)))
    if FAIL:
        print("\nfailures:")
        for name, detail in FAIL:
            print("  %s%s" % (name, ("\n      " + detail) if detail else ""))
    return 1 if FAIL else 0


if __name__ == "__main__":
    sys.exit(main())
