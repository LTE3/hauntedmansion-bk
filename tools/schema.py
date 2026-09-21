# Writes the JSON-LD blocks that make the house eligible for Google's event
# rich results.
#
# The nights are generated, never typed. There are nineteen of them, each with
# its own doors time, last entry and availability state, and a hand-maintained
# copy would be wrong within a week - the presale opens September 25 and every
# night has to flip from PreOrder to InStock on that date, then to SoldOut as
# it fills. Typing that nineteen times is how a site ends up advertising seats
# it does not have, which is the one thing Google penalises hardest here.
#
# So this reads hm_events and hm_products - the same rows checkout charges
# against - and rewrites the block between the markers. Run it whenever the
# calendar changes, then run tools/csp.py, because the block is a <script> and
# the page's CSP hash covers it.
#
#   python tools/schema.py            # rewrite from the live database
#   python tools/schema.py --check    # non-zero exit if a page is stale
#
# The street address is deliberately absent. Google's event rich result needs
# location.name and an address, but not a streetAddress - locality, region and
# country validate on their own. That costs the map pin and nothing else, and
# the address stays where it belongs, which is in the ticket email.

import json
import os
import re
import sys
import urllib.request

SITE = "https://hauntedmansionbk.com"
BRAND = "Haunted Mansion BK"
OPERATOR = "Pulse Ticketing LLC"
PROJECT = "tqeunmqnaoyrerkbhokk"
PRESALE = "2026-09-25T10:00:00-04:00"
TZ = "-04:00"  # October 2026 is entirely EDT; DST ends November 1.

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEYS = r"C:\Users\danie\.secrets\keys.md"

START = "<!-- schema:start -->"
END = "<!-- schema:end -->"

# How long after last entry the house is empty. The walk is about an hour, per
# the FAQ; the last group through gets the same hour as the first.
WALK_MINUTES = 60


def token():
    with open(KEYS, encoding="utf-8", errors="replace") as f:
        m = re.search(r"sbp_[A-Za-z0-9]+", f.read())
    if not m:
        sys.exit("no management token in keys.md")
    return m.group(0)


def query(sql):
    req = urllib.request.Request(
        "https://api.supabase.com/v1/projects/%s/database/query" % PROJECT,
        data=json.dumps({"query": sql}).encode(),
        headers={"Authorization": "Bearer " + token(), "Content-Type": "application/json"},
        method="POST",
    )
    return json.load(urllib.request.urlopen(req))


def plus_minutes(hhmmss, minutes):
    h, m, _ = (int(x) for x in hhmmss.split(":"))
    total = h * 60 + m + minutes
    return "%02d:%02d:00" % (total // 60 % 24, total % 60)


def organization():
    return {
        "@type": "Organization",
        "@id": SITE + "/#organization",
        "name": OPERATOR,
        "url": SITE + "/",
        "logo": SITE + "/v/img-poster/logo.png",
        "description": "%s operates %s, a walk-through Halloween attraction in Bushwick, Brooklyn." % (OPERATOR, BRAND),
        "contactPoint": {"@type": "ContactPoint", "email": "admin@pulsetix.ai", "contactType": "customer service"},
    }


def venue():
    # Locality only. See the note at the top of this file.
    return {
        "@type": "Place",
        "@id": SITE + "/#venue",
        "name": BRAND,
        "address": {
            "@type": "PostalAddress",
            "addressLocality": "Brooklyn",
            "addressRegion": "NY",
            "addressCountry": "US",
        },
    }


def business():
    return {
        "@type": "EntertainmentBusiness",
        "@id": SITE + "/#business",
        "name": BRAND,
        "url": SITE + "/",
        "image": SITE + "/v/img-poster/logo.png",
        "description": "A walk-through haunted attraction in Bushwick, Brooklyn. Sixty minutes inside, multiple rooms, live actors. October 2026. Ages 13 and over.",
        "address": venue()["address"],
        "parentOrganization": {"@id": SITE + "/#organization"},
        "openingHoursSpecification": [
            {
                "@type": "OpeningHoursSpecification",
                "dayOfWeek": ["Thursday", "Friday", "Saturday", "Sunday"],
                "opens": "17:00",
                "closes": "23:15",
                "validFrom": "2026-10-01",
                "through": "2026-10-31",
            }
        ],
    }


def offers(row, products):
    cents = sorted(p["cents"] for p in products if p["is_active"])
    if row["sold"] >= row["capacity"]:
        availability = "https://schema.org/SoldOut"
    else:
        # Before the presale opens nothing is buyable yet. Saying InStock then
        # is a lie a crawler can check.
        availability = "https://schema.org/PreOrder"
    return {
        "@type": "AggregateOffer",
        "priceCurrency": "USD",
        "lowPrice": "%d" % (cents[0] // 100),
        "highPrice": "%d" % (cents[-1] // 100),
        "offerCount": "%d" % len(cents),
        "availability": availability,
        "validFrom": PRESALE,
        "url": SITE + "/nights.html",
    }


def nights_graph(events, products):
    series_id = SITE + "/nights.html#series"
    graph = [
        organization(),
        venue(),
        {
            "@type": "EventSeries",
            "@id": series_id,
            "name": BRAND + " \u2014 October 2026",
            "description": "A walk-through Halloween haunted attraction in Bushwick, Brooklyn. Thursday through Sunday nights, October 2026. Ages 13 and over.",
            "startDate": "%sT%s%s" % (events[0]["event_date"], events[0]["doors"][:5] + ":00", TZ),
            "endDate": "%sT%s%s" % (events[-1]["event_date"], plus_minutes(events[-1]["last_entry"], WALK_MINUTES), TZ),
            "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
            "location": {"@id": SITE + "/#venue"},
            "organizer": {"@id": SITE + "/#organization"},
            "url": SITE + "/nights.html",
        },
    ]
    for row in events:
        if not row["is_active"]:
            continue
        date = row["event_date"]
        graph.append(
            {
                "@type": "Event",
                "name": "%s \u2014 %s" % (BRAND, date),
                "superEvent": {"@id": series_id},
                "startDate": "%sT%s%s" % (date, row["doors"], TZ),
                "endDate": "%sT%s%s" % (date, plus_minutes(row["last_entry"], WALK_MINUTES), TZ),
                "eventStatus": "https://schema.org/EventScheduled",
                "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
                "location": {"@id": SITE + "/#venue"},
                "organizer": {"@id": SITE + "/#organization"},
                "url": SITE + "/nights.html",
                "typicalAgeRange": "13-",
                "maximumAttendeeCapacity": row["capacity"],
                "offers": offers(row, products),
            }
        )
    return {"@context": "https://schema.org", "@graph": graph}


def index_graph():
    return {"@context": "https://schema.org", "@graph": [organization(), venue(), business()]}


def block(data):
    body = json.dumps(data, indent=2, ensure_ascii=False)
    return '%s\n<script type="application/ld+json">\n%s\n</script>\n%s' % (START, body, END)


def write(path, text, check):
    full = os.path.join(ROOT, path)
    with open(full, encoding="utf-8", newline="") as f:
        page = f.read()
    if START in page:
        pattern = re.compile(re.escape(START) + r".*?" + re.escape(END), re.S)
        updated = pattern.sub(lambda _: text, page, count=1)
    else:
        marker = "</head>"
        if marker not in page:
            sys.exit("%s has no </head>" % path)
        updated = page.replace(marker, text + "\n" + marker, 1)
    if updated == page:
        print("  ok    %s" % path)
        return False
    if check:
        print("  STALE %s" % path)
        return True
    with open(full, "w", encoding="utf-8", newline="") as f:
        f.write(updated)
    print("  wrote %s" % path)
    return True


def main():
    check = "--check" in sys.argv
    events = query("select event_date,doors,last_entry,capacity,sold,is_active from hm_events order by event_date;")
    products = query("select code,tickets,cents,is_active from hm_products order by sort;")
    if not events or not products:
        sys.exit("hm_events or hm_products came back empty")
    stale = False
    stale |= write("nights.html", block(nights_graph(events, products)), check)
    stale |= write("index.html", block(index_graph()), check)
    active = sum(1 for e in events if e["is_active"])
    print("%d night(s) in the graph" % active)
    if check and stale:
        sys.exit(1)


if __name__ == "__main__":
    main()
