# Rewrites the lastmod date of every URL in sitemap.xml from that file's own
# last commit.
#
# The dates were hand-maintained, which means they were correct on the day
# someone typed them and drifting every day after. That matters more than it
# looks: lastmod is the main thing a crawler uses to decide whether a page is
# worth fetching again. A sitemap that still says September 17 after every
# title on the site changed is asking Google not to re-crawl the change, and
# ten days from opening a re-crawl is the whole point.
#
# Git is the source of truth rather than the filesystem mtime, because mtime
# changes when a file is merely checked out and tells you nothing about
# whether the content moved.
#
# It also rewrites the <image:image> block under each URL from that page's
# own markup - the <img> it paints, the <picture> fallback, the background
# photographs in its stylesheet and its og:image. Generated rather than kept
# by hand for the same reason as the dates: a hand-kept image list is correct
# until the first time someone swaps a photograph. Icons and the favicon are
# left out; they are furniture, not pictures anybody wants in image search.
#
#   python tools/sitemap.py            # rewrite the dates and the images
#   python tools/sitemap.py --check    # non-zero exit if either is wrong
#
# The set of URLs is deliberately NOT generated. Which pages search engines
# may have is an editorial decision - the workbenches and the ticket page are
# excluded on purpose - and a generator that walks *.html would quietly put
# them back the next time someone added one.

import re
import subprocess
import sys
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SITEMAP = os.path.join(ROOT, "sitemap.xml")
SITE = "https://hauntedmansionbk.com/"


# Anything matching these is furniture: tab icons, the installed-app icons,
# the social card's own alt art. None of them belong in image search.
SKIP = re.compile(r"(icon-|apple-touch|favicon)", re.I)
EXT = re.compile(r"\.(jpg|jpeg|png|webp|gif|avif)$", re.I)


def page_images(page):
    """Every content image the page actually paints, in the order it does."""
    with open(os.path.join(ROOT, page), encoding="utf-8", newline="") as f:
        html = f.read()
    found = []

    def add(raw):
        raw = raw.strip().split(" ")[0].split("?")[0]
        if not raw or raw.startswith("data:") or not EXT.search(raw):
            return
        if SKIP.search(raw):
            return
        url = raw if raw.startswith("http") else SITE + raw.lstrip("/")
        if not url.startswith(SITE):
            return
        if url not in found:
            found.append(url)

    # og:image first: it is the one the page nominates as its own picture.
    for m in re.finditer(r'<meta property="og:image" content="([^"]+)"', html):
        add(m.group(1))
    # The <img> a browser without <picture> support lands on - the jpg or png
    # rather than the webp beside it, so the sitemap names one file per
    # photograph instead of two encodings of it.
    for m in re.finditer(r"<img\b[^>]*\bsrc=\"([^\"]+)\"", html):
        add(m.group(1))
    # Background photographs. The plain url() only: the image-set() override
    # next to it is the same picture in webp.
    for m in re.finditer(r"background(?:-image)?:[^;}]*?url\(\"?([^\"')]+)", html):
        add(m.group(1))
    # A background photograph is declared twice - a plain url() that every
    # browser reads, then an image-set() naming the webp of the same picture.
    # They are one photograph, so the second encoding of a name already in
    # the list is dropped rather than offered to image search as a separate
    # image. The plain declaration comes first, so it is the one kept.
    seen, out = set(), []
    for url in found:
        stem = url.rsplit(".", 1)[0]
        if stem in seen:
            continue
        seen.add(stem)
        if not os.path.exists(os.path.join(ROOT, url[len(SITE):])):
            sys.exit("%s lists %s, which is not in the repo" % (page, url))
        out.append(url)
    return out


def image_block(page, indent="    "):
    out = []
    for url in page_images(page):
        out.append("%s<image:image>" % indent)
        out.append("%s  <image:loc>%s</image:loc>" % (indent, url))
        out.append("%s</image:image>" % indent)
    return out


def last_commit(path):
    r = subprocess.run(["git", "log", "-1", "--format=%cs", "--", path],
                       capture_output=True, text=True, cwd=ROOT)
    return r.stdout.strip()


def main():
    check = "--check" in sys.argv
    with open(SITEMAP, encoding="utf-8", newline="") as f:
        s = f.read()
    nl = "\r\n" if "\r\n" in s else "\n"

    stale = []

    def fix(m):
        block = m.group(0)
        url = re.search(r"<loc>(.*?)</loc>", block, re.S).group(1)
        page = url[len(SITE):] or "index.html"
        if not os.path.exists(os.path.join(ROOT, page)):
            sys.exit("sitemap lists %s, which is not in the repo" % page)
        date = last_commit(page)
        if not date:
            sys.exit("%s has no commits - commit it before listing it" % page)
        current = re.search(r"<lastmod>(.*?)</lastmod>", block, re.S).group(1)
        if date != current:
            stale.append("%-22s %s -> %s" % (page, current, date))

        # Rebuilt rather than edited: every image line is dropped and the
        # page's current images are written back under its lastmod, so a
        # photograph that left the page leaves the sitemap with it.
        kept = [l for l in block.split(nl)
                if "<image:" not in l and "</image:" not in l]
        out = []
        for line in kept:
            if "<lastmod>" in line:
                line = re.sub(r"<lastmod>.*?</lastmod>",
                              "<lastmod>%s</lastmod>" % date, line, count=1)
                out.append(line)
                out.extend(image_block(page))
            else:
                out.append(line)
        return nl.join(out)

    updated = re.sub(r"<url>.*?</url>", fix, s, flags=re.S)
    changed = updated != s
    if stale:
        for line in stale:
            print("  " + line)
    if not changed:
        print("sitemap.xml: all dates and images current")
        return
    if check:
        print("sitemap.xml is stale (%d date(s), and/or its images moved)" % len(stale))
        sys.exit(1)
    with open(SITEMAP, "w", encoding="utf-8", newline="") as f:
        f.write(updated)
    print("sitemap.xml rewritten (%d date(s) changed)" % len(stale))


if __name__ == "__main__":
    main()
