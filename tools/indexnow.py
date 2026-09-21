# Tells Bing, Yandex and Seznam that our pages changed, instead of waiting for
# them to come and look.
#
# A new domain is not crawled because it is good, it is crawled because
# something pointed at it. With the opening ten days out, the gap between
# publishing a change and a crawler noticing is the whole cost. IndexNow closes
# that gap to minutes for the engines that support it.
#
# Google does not participate - it dropped its own sitemap ping in 2023 and
# takes submissions only through Search Console, which needs an account and a
# human. So this is not the Google answer. It is the half of the problem that
# can be solved without one, and Bing results also feed DuckDuckGo and ChatGPT
# search, which is not nothing for a business whose customers are searching on
# their phones.
#
#   python tools/indexnow.py           # submit every URL in sitemap.xml
#   python tools/indexnow.py --dry     # print what would be sent
#
# The key is deliberately public. IndexNow works by having the submitter host
# the key at the site root: fetching it is how the engine proves whoever
# submitted the URLs controls the domain. A key that were secret could not do
# that job. It is not a credential and belongs in the repo.

import json
import os
import re
import sys
import urllib.request
import urllib.error

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOST = "hauntedmansionbk.com"
ENDPOINT = "https://api.indexnow.org/indexnow"


def key():
    names = [n for n in os.listdir(ROOT) if re.fullmatch(r"[0-9a-f]{32}\.txt", n)]
    if len(names) != 1:
        sys.exit("expected exactly one IndexNow key file at the repo root, found %d" % len(names))
    name = names[0]
    with open(os.path.join(ROOT, name), encoding="utf-8") as f:
        body = f.read().strip()
    if body != name[:-4]:
        sys.exit("%s must contain exactly its own filename without .txt" % name)
    return body


def urls():
    with open(os.path.join(ROOT, "sitemap.xml"), encoding="utf-8") as f:
        found = re.findall(r"<loc>(.*?)</loc>", f.read(), re.S)
    # Submitting a URL we do not actually serve is how a domain earns a
    # reputation for wasting a crawler's time.
    for u in found:
        if not u.startswith("https://%s/" % HOST):
            sys.exit("sitemap contains an off-host URL: %s" % u)
    return found


def main():
    dry = "--dry" in sys.argv
    k = key()
    payload = {
        "host": HOST,
        "key": k,
        "keyLocation": "https://%s/%s.txt" % (HOST, k),
        "urlList": urls(),
    }
    print("%d URL(s) to %s" % (len(payload["urlList"]), ENDPOINT))
    for u in payload["urlList"]:
        print("  " + u)
    if dry:
        print("dry run, nothing sent")
        return

    # The key has to be fetchable before the submission is worth making: if it
    # 404s the whole batch is rejected and the only symptom is silence.
    check = "https://%s/%s.txt" % (HOST, k)
    try:
        with urllib.request.urlopen(check, timeout=20) as r:
            served = r.read().decode().strip()
    except urllib.error.HTTPError as exc:
        sys.exit("key file not live yet (%s on %s) - push and wait for Pages" % (exc.code, check))
    if served != k:
        sys.exit("%s serves %r, expected the key" % (check, served[:40]))

    req = urllib.request.Request(
        ENDPOINT,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json; charset=utf-8"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            print("HTTP %s %s" % (r.status, r.reason))
    except urllib.error.HTTPError as exc:
        # 422 usually means the key did not validate; print the body, because a
        # bare status here tells you nothing about which half failed.
        sys.exit("HTTP %s: %s" % (exc.code, exc.read().decode()[:300]))


if __name__ == "__main__":
    main()
