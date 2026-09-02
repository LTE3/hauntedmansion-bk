# -*- coding: utf-8 -*-
r"""Write the Content-Security-Policy meta into every page, hashes and all.

    python tools/csp.py            # rewrite the policies
    python tools/csp.py --check    # fail if any page's policy is stale

GitHub Pages serves static files and gives us no control over response
headers, so the policy has to travel in the document as
<meta http-equiv="Content-Security-Policy">. That works for everything here
except frame-ancestors, which is specified as ignored in meta; see the note at
the bottom of this file.

Why this is a script and not twenty hand-typed meta tags: the policy names the
sha256 of every inline <script> and <style> on the page, so editing one
character of CSS invalidates the hash and the entire stylesheet stops
applying - silently, with a console message nobody reads and a page that looks
like the CSS 404'd. Any hand-edit to these files must be followed by a run of
this script, and --check catches the times it was not.

The trap, found the hard way: the hash covers the element's text content
*after* the HTML parser has seen it, not the bytes on disk. These files are
stored with CRLF, but the parser's input-stream preprocessing turns every CRLF
into a single LF before any element content exists, so the browser hashes
LF-only text. Hashing the file bytes verbatim gives a digest that is right
about the file and wrong about the page. The files stay CRLF on disk; only the
hash input is normalised.
"""
import base64, glob, hashlib, io, os, re, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SUPABASE = "https://tqeunmqnaoyrerkbhokk.supabase.co"
FONTS_CSS = "https://fonts.googleapis.com"
FONTS_FILES = "https://fonts.gstatic.com"

# Every page in the site, found rather than listed. A hand-kept table is one
# more thing to forget to update, and a page missing from it ships with no
# policy at all - the failure that looks exactly like success.
PAGES = ["index.html", "privacy.html", "404.html"] + sorted(
    os.path.relpath(f, ROOT).replace(os.sep, "/")
    for f in glob.glob(os.path.join(ROOT, "v", "*.html")))

TAG = re.compile(rb"<(script|style)(?![a-zA-Z-])([^>]*)>(.*?)</\1\s*>", re.S | re.I)
# The trailing newline is optional on all three: two of the variant pages are
# minified onto single lines, so a pattern that insists on one silently
# matches nothing there and the old policy is never removed before the new one
# is inserted.
META = re.compile(rb'[ \t]*<meta http-equiv="Content-Security-Policy"[^>]*>(\r?\n)?', re.I)
REFERRER = re.compile(rb'[ \t]*<meta name="referrer"[^>]*>(\r?\n)?', re.I)
ANCHOR = re.compile(rb"<meta charset=[^>]*>", re.I)


def sha(body):
    # The parser's own newline normalisation, reproduced: CRLF and a lone CR
    # both become LF. See the note at the top. Without this every hash on
    # every page is wrong and every page renders unstyled.
    body = body.replace(b"\r\n", b"\n").replace(b"\r", b"\n")
    return "'sha256-%s'" % base64.b64encode(hashlib.sha256(body).digest()).decode()


def policy(html):
    """Derive the policy from what the page actually contains.

    Asking the file beats keeping a table beside it: a page that starts
    loading audio, or stops talking to the database, gets the right policy on
    the next run instead of the policy someone remembered to update.
    """
    scripts, styles, external_script = [], [], False
    for m in TAG.finditer(html):
        kind, attrs, body = m.group(1).lower(), m.group(2), m.group(3)
        if b"src=" in attrs or b"href=" in attrs:
            # An external file, covered by a host source rather than a hash.
            external_script = external_script or kind == b"script"
            continue
        (scripts if kind == b"script" else styles).append(sha(body))
    if external_script:
        scripts.append("'self'")

    # A page reaches the database either directly or through waitlist.js.
    connect = SUPABASE.encode() in html or b"waitlist.js" in html
    media = bool(re.search(rb"new Audio|<audio|<video", html, re.I))
    manifest = b'rel="manifest"' in html

    d = [
        # Nothing loads unless a directive below names it. Everything the page
        # actually uses is enumerated, so an injected iframe, image, ping,
        # websocket or worker has no fetch directive to fall back to.
        "default-src 'none'",
        # A single injected <base> would otherwise repoint every relative URL
        # on the page at once - the images, the audio, the stylesheet.
        "base-uri 'none'",
        # The form is submitted by fetch, never natively. Blocking native
        # submission also closes the no-JS fallback path, which would have put
        # the visitor's name and email into a URL query string.
        "form-action 'none'",
        "img-src 'self' data:",        # data: is the inline SVG favicon
        "style-src %s %s" % (" ".join(styles), FONTS_CSS),
        "font-src %s" % FONTS_FILES,
        "script-src %s" % (" ".join(scripts) if scripts else "'none'"),
        "connect-src %s" % (SUPABASE if connect else "'none'"),
        "frame-src 'none'",
        "object-src 'none'",
    ]
    if media:
        d.append("media-src 'self'")
    if manifest:
        d.append("manifest-src 'self'")
    return "; ".join(d)


def render(html):
    p = policy(html)
    html = META.sub(b"", REFERRER.sub(b"", html))
    m = ANCHOR.search(html)
    assert m, "no <meta charset> to anchor to"

    # Follow the file's own shape rather than imposing one. Most pages are
    # laid out a tag per line; two of the variants are minified onto a single
    # line, and pushing newlines into the middle of those would be a
    # gratuitous diff on a file this script is not otherwise rewriting.
    #
    # Both newline flavours have to be recognised, not just CRLF. These
    # files are authored on Windows but git stores them with LF, so a
    # Linux clone - CI included - reads LF, is told every page is
    # minified, and collapses the tags onto one line: 17 pages stale
    # forever there, while Windows silently puts them back.
    nxt = html[m.end():m.end() + 2]
    eol = b"\r\n" if nxt == b"\r\n" else (b"\n" if nxt[:1] == b"\n" else b"")
    tags = (b'<meta http-equiv="Content-Security-Policy" content="' + p.encode()
            + b'">' + eol + b'<meta name="referrer" content="no-referrer">' + eol)
    at = m.end() + len(eol)
    return html[:at] + tags + html[at:]


check = "--check" in sys.argv
stale = []
for name in PAGES:
    p = os.path.join(ROOT, name.replace("/", os.sep))
    cur = io.open(p, "rb").read()
    new = render(cur)
    if cur == new:
        continue
    stale.append(name)
    if not check:
        io.open(p, "wb").write(new)

verb = "stale" if check else "written"
for n in stale:
    print("  %-8s %s" % (verb, n))
print("\n%d page(s) checked, %d %s" % (len(PAGES), len(stale), verb))
if check and stale:
    sys.exit("\nRun: python tools/csp.py")

# Not covered here, deliberately:
#
#   frame-ancestors  Ignored in a meta tag by specification, so the page can
#                    still be framed, and GitHub Pages sends no
#                    X-Frame-Options either. Needs a real header, which needs
#                    a host that can send one.
#   Trusted Types    require-trusted-types-for would be the next rung up, but
#                    nothing here builds HTML from strings - every insertion
#                    is textContent - so there is nothing for it to protect.
