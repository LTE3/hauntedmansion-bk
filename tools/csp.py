# -*- coding: utf-8 -*-
"""Write the Content-Security-Policy meta into each page, hashes and all.

    python tools/csp.py            # rewrite the policies
    python tools/csp.py --check    # fail if any page's policy is stale

GitHub Pages serves static files and gives us no control over response
headers, so the policy has to travel in the document as
<meta http-equiv="Content-Security-Policy">. That works for everything here
except frame-ancestors, which is specified as ignored in meta - clickjacking
has to be handled another way and is noted at the bottom of this file.

Why this is a script and not four hand-typed meta tags: the policy names the
sha256 of every inline <script> and <style> on the page, so editing one
character of CSS invalidates the hash and the entire stylesheet stops
applying - silently, with a console error nobody reads and a page that looks
like the CSS 404'd. Any hand-edit to these files must be followed by a run of
this script, and --check in a pre-push hook or by hand catches the times it
was not.

The hash covers the element's text content *after* the HTML parser has seen
it, not the bytes on disk. That distinction is the whole trap: these files are
stored with CRLF, but the parser's input-stream preprocessing turns every CRLF
into a single LF before any element content exists, so the browser hashes
LF-only text. Hashing the file bytes verbatim gives a digest that is right
about the file and wrong about the page, and the only symptom is an unstyled
page. So: the files are read and written as bytes and never normalised on
disk, and newlines are normalised only on the way into the hash.
"""
import base64, hashlib, io, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUPABASE = "https://tqeunmqnaoyrerkbhokk.supabase.co"
FONTS_CSS = "https://fonts.googleapis.com"
FONTS_FILES = "https://fonts.gstatic.com"

# Per page: does it talk to the database, and does it load media or a manifest.
PAGES = {
    "index.html":   dict(connect=True,  media=True),
    "privacy.html": dict(connect=False, media=False),
    "404.html":     dict(connect=False, media=False),
    "v/index.html": dict(connect=False, media=False),
}

TAG = re.compile(rb"<(script|style)(?![a-zA-Z-])([^>]*)>(.*?)</\1\s*>", re.S | re.I)
META = re.compile(rb'[ \t]*<meta http-equiv="Content-Security-Policy"[^>]*>\r?\n', re.I)
REFERRER = re.compile(rb'[ \t]*<meta name="referrer"[^>]*>\r?\n', re.I)
ANCHOR = re.compile(rb"(<meta charset=[^>]*>\r?\n)", re.I)


def sha(body):
    # See the CRLF note at the top of this file. This is the parser's
    # own newline normalisation, reproduced: CRLF and a lone CR both
    # become LF. Without it every hash on every page is wrong.
    body = body.replace(b'\r\n', b'\n').replace(b'\r', b'\n')
    return "'sha256-%s'" % base64.b64encode(hashlib.sha256(body).digest()).decode()


def policy(html, opts):
    scripts, styles = [], []
    for m in TAG.finditer(html):
        kind, attrs, body = m.group(1).lower(), m.group(2), m.group(3)
        if b"src=" in attrs or b"href=" in attrs:
            continue          # external, covered by a host source instead
        (scripts if kind == b"script" else styles).append(sha(body))

    d = [
        # Nothing loads unless a directive below names it. Everything the page
        # actually uses is enumerated, so an injected <img>, <iframe>, ping,
        # websocket or worker has no fetch directive to fall back to.
        "default-src 'none'",
        # A single injected <base> would otherwise repoint every relative URL
        # on the page - all of the images, the audio, the stylesheet.
        "base-uri 'none'",
        # The form is submitted by fetch, never natively. Blocking native
        # submission also stops the no-JS fallback path, which would have put
        # the visitor's name and email in a URL query string.
        "form-action 'none'",
        "img-src 'self' data:",       # data: is the inline SVG favicon
        "style-src %s %s" % (" ".join(styles), FONTS_CSS),
        "font-src %s" % FONTS_FILES,
        "script-src %s" % (" ".join(scripts) if scripts else "'none'"),
        "connect-src %s" % (SUPABASE if opts["connect"] else "'none'"),
        "frame-src 'none'",
        "object-src 'none'",
    ]
    if opts["media"]:
        d += ["media-src 'self'", "manifest-src 'self'"]
    return "; ".join(d)


def render(html, opts):
    tags = (
        '<meta http-equiv="Content-Security-Policy" content="%s">\n'
        '<meta name="referrer" content="no-referrer">\n' % policy(html, opts)
    ).encode()
    if b"\r\n" in html:
        tags = tags.replace(b"\n", b"\r\n")
    html = META.sub(b"", REFERRER.sub(b"", html))
    m = ANCHOR.search(html)
    assert m, "no <meta charset> to anchor to"
    return html[:m.end(1)] + tags + html[m.end(1):]


check = "--check" in sys.argv
bad = 0
for name, opts in PAGES.items():
    p = os.path.join(ROOT, name.replace("/", os.sep))
    cur = io.open(p, "rb").read()
    new = render(cur, opts)
    if cur == new:
        print("  ok      %s" % name)
        continue
    bad += 1
    if check:
        print("  STALE   %s" % name)
    else:
        io.open(p, "wb").write(new)
        print("  written %s" % name)

if check and bad:
    sys.exit("\n%d page(s) have a stale policy. Run: python tools/csp.py" % bad)
print("\n%d page(s) %s" % (len(PAGES), "checked" if check else "up to date"))

# Not covered here, deliberately:
#
#   frame-ancestors  Ignored in a meta tag by specification, so the page can
#                    still be framed. GitHub Pages sends no X-Frame-Options
#                    either. Worth a real header once the site moves behind a
#                    host that can send one.
#   Trusted Types    require-trusted-types-for would be the next rung up, but
#                    the page builds no HTML from strings - every insertion is
#                    textContent - so there is nothing for it to protect yet.
