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
#   python tools/sitemap.py            # rewrite the dates
#   python tools/sitemap.py --check    # non-zero exit if any date is wrong
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


def last_commit(path):
    r = subprocess.run(["git", "log", "-1", "--format=%cs", "--", path],
                       capture_output=True, text=True, cwd=ROOT)
    return r.stdout.strip()


def main():
    check = "--check" in sys.argv
    with open(SITEMAP, encoding="utf-8", newline="") as f:
        s = f.read()

    stale = []
    out = []
    pos = 0
    for m in re.finditer(r"<loc>(.*?)</loc>\s*<lastmod>(.*?)</lastmod>", s, re.S):
        url, current = m.group(1), m.group(2)
        page = url[len(SITE):] or "index.html"
        full = os.path.join(ROOT, page)
        if not os.path.exists(full):
            sys.exit("sitemap lists %s, which is not in the repo" % page)
        date = last_commit(page)
        if not date:
            sys.exit("%s has no commits - commit it before listing it" % page)
        if date != current:
            stale.append("%-22s %s -> %s" % (page, current, date))
        out.append(s[pos:m.start(2)])
        out.append(date)
        pos = m.end(2)
    out.append(s[pos:])

    if not stale:
        print("sitemap.xml: all dates current")
        return
    for line in stale:
        print("  " + line)
    if check:
        print("%d stale date(s)" % len(stale))
        sys.exit(1)
    with open(SITEMAP, "w", encoding="utf-8", newline="") as f:
        f.write("".join(out))
    print("%d date(s) updated" % len(stale))


if __name__ == "__main__":
    main()
