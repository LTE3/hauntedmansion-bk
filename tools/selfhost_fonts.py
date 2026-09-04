# -*- coding: utf-8 -*-
"""Serve every typeface from this origin instead of from Google.

    python tools/selfhost_fonts.py            # every page under v/
    python tools/selfhost_fonts.py v/23-thread.html

A page that links fonts.googleapis.com sends every visitor's IP address to
Google before a single word is drawn, on a site whose privacy page lists who
sees what. The live page stopped doing that in August; the pages under v/
still did, because their generators write the Google link. This takes any
page with that link, asks Google for the stylesheet the browser would have
asked for, downloads exactly the woff2 files it names - latin and latin-ext
only, the pages are in English - into fonts/ beside the page, and replaces
the link with the same @font-face rules pointing at the local files. Files
are byte for byte what Google serves; the page renders the same.

Run it again after gen.py or gen2.py rewrites a page, then tools/csp.py: the
policy is derived from the page, and this changes what the page loads.

Each family's licence (all are SIL Open Font License 1.1) is fetched from the
google/fonts repository into fonts/OFL-<family>.txt, because the OFL asks that
the licence travel with the font files.
"""
import io, os, re, sys, glob, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# A modern browser string, so Google answers with woff2 and unicode-range
# subsets rather than the ttf it serves to unknown agents.
UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36")
KEEP = ("latin", "latin-ext")
LINK = re.compile(r'<link href="(https://fonts\.googleapis\.com/css2\?[^"]+)" rel="stylesheet">\r?\n?')
PRE = re.compile(r'<link rel="preconnect" href="https://fonts\.g(?:oogleapis|static)\.com"(?: crossorigin)?>\r?\n?')
BLOCK = re.compile(r'/\* ([\w-]+) \*/\s*(@font-face\s*\{[^}]*\})', re.S)
OFL = "https://raw.githubusercontent.com/google/fonts/main/ofl/%s/OFL.txt"


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


def slug(family):
    return re.sub(r"[^a-z0-9]", "", family.lower())


def faces(css):
    for subset, block in BLOCK.findall(css):
        if subset not in KEEP:
            continue
        fam = re.search(r"font-family:\s*'([^']+)'", block).group(1)
        style = re.search(r"font-style:\s*(\w+)", block).group(1)
        weight = re.search(r"font-weight:\s*([\d ]+)", block).group(1).strip()
        url = re.search(r"url\((https://fonts\.gstatic\.com/[^)]+)\)", block).group(1)
        yield subset, fam, style, weight, url, block


def process(path, cache, licences):
    raw = io.open(path, "rb").read().decode("utf-8")
    m = LINK.search(raw)
    if not m:
        return None
    fontdir = os.path.join(os.path.dirname(path), "fonts")
    os.makedirs(fontdir, exist_ok=True)
    css = fetch(m.group(1)).decode("utf-8")
    rules, fams = [], set()
    for subset, fam, style, weight, url, block in faces(css):
        fams.add(fam)
        if url not in cache:
            name = "%s-%s%s-%s.woff2" % (slug(fam), weight.replace(" ", "-"),
                                         "" if style == "normal" else "-" + style, subset)
            dest = os.path.join(fontdir, name)
            data = fetch(url)
            if not os.path.exists(dest) or io.open(dest, "rb").read() != data:
                io.open(dest, "wb").write(data)
            cache[url] = (name, len(data))
        rule = block.replace(url, "fonts/" + cache[url][0])
        rule = re.sub(r"\s+", " ", rule).replace("{ ", "{").replace("; }", "}").strip()
        rules.append("/* %s */ %s" % (subset, rule))
    for fam in fams:
        s = slug(fam)
        dest = os.path.join(fontdir, "OFL-%s.txt" % s)
        if s not in licences and not os.path.exists(dest):
            try:
                io.open(dest, "wb").write(fetch(OFL % s))
                licences[s] = True
            except Exception as e:  # noqa: BLE001 - report and carry on
                licences[s] = False
                print("  ! no licence file fetched for %s (%s)" % (fam, e))
    style = ("<style>\n"
             "/* Typefaces served from this origin: the same woff2 files Google's\n"
             "   stylesheet pointed at, so nothing leaves the site to draw a word.\n"
             "   Written by tools/selfhost_fonts.py; run it again after a generator\n"
             "   rewrites this page. */\n" + "\n".join(rules) + "\n</style>\n")
    if "\r\n" in raw:
        style = style.replace("\n", "\r\n")
    out = PRE.sub("", raw)
    out = LINK.sub(lambda _: style, out, count=1)
    io.open(path, "wb").write(out.encode("utf-8"))
    return len(rules), sorted(fams)


def main(argv):
    files = argv or sorted(glob.glob(os.path.join(ROOT, "v", "*.html")))
    cache, licences = {}, {}
    for f in files:
        r = process(f, cache, licences)
        if r is None:
            print("%-28s no Google Fonts link, untouched" % os.path.relpath(f, ROOT))
        else:
            print("%-28s %2d faces  %s" % (os.path.relpath(f, ROOT), r[0], ", ".join(r[1])))
    total = sum(n for _, n in cache.values())
    print("%d font files, %.0f KB; %d licence files" % (len(cache), total / 1024,
                                                        sum(1 for v in licences.values() if v)))


if __name__ == "__main__":
    main(sys.argv[1:])
