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
# The street address is published, by the owner's decision on 2026-09-21. It
# was withheld until then as a marketing mechanic, and withholding it cost the
# map pack and any Google Business Profile - the largest local-SEO lever there
# is for a business that lives or dies on one neighbourhood in one month. The
# address now appears in the schema, on the page and in the directory copy,
# and those three have to agree: a listing whose address contradicts the site
# is worse for local ranking than no listing.

from datetime import date
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
STREET = "428 Johnson Avenue"
TZ = "-04:00"  # October 2026 is entirely EDT; DST ends November 1.

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEYS = r"C:\Users\danie\.secrets\keys.md"

START = "<!-- schema:start -->"
END = "<!-- schema:end -->"

# How long after last entry the house is empty. The walk is about an hour, per
# the FAQ; the last group through gets the same hour as the first.
WALK_MINUTES = 60

WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday",
            "Friday", "Saturday", "Sunday")
MONTHS = ("January", "February", "March", "April", "May", "June", "July",
          "August", "September", "October", "November", "December")

# One sentence, carried by the series and by every night under it. Google
# asks for a description on an Event and there was none; this is the
# wording the series already shipped with, not new copy.
SERIES_DESCRIPTION = ("A walk-through Halloween haunted attraction in Bushwick, "
                      "Brooklyn. Thursday through Sunday nights, October 2026. "
                      "Ages 13 and over.")

# Real, already-public images, not new assets. card.jpg is the same file
# every page already serves as og:image and twitter:image, so naming it here
# states nothing the pages do not already broadcast. icon-512.png is the
# manifest icon and is square, which card.jpg (1200x630) does not cover.
EVENT_IMAGES = [SITE + "/v/img-cali/card.jpg?v=3", SITE + "/img/icon-512.png"]

# The attraction's own profile, not the operator's - it goes on the
# EntertainmentBusiness node, not the Organization. Confirmed live on
# 2026-09-22: HAUNTED MANSION BROOKLYN, 23K followers. sameAs is the
# documented way to tell Google that a profile and a site are one entity,
# and until now nothing on the site pointed at the account at all.
PROFILES = ["https://www.instagram.com/hauntedmansionbk/"]


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


def night_name(iso):
    """"Thursday, October 1" - what a searcher reads, not "2026-10-01".

    Google prints Event.name verbatim in an event rich result, so the ISO
    date was going in front of people. Same night, named the way someone
    would say it out loud.
    """
    d = date(*[int(x) for x in iso.split("-")])
    return "%s, %s %d" % (WEEKDAYS[d.weekday()], MONTHS[d.month - 1], d.day)


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
    return {
        "@type": "Place",
        "@id": SITE + "/#venue",
        "name": BRAND,
        "address": {
            "@type": "PostalAddress",
            "streetAddress": STREET,
            "addressLocality": "Brooklyn",
            "addressRegion": "NY",
            "postalCode": "11237",
            "addressCountry": "US",
        },
        # Geocoded from the address above through OpenStreetMap Nominatim on
        # 2026-09-21, place_rank 30, which is house-level. Verified twice, by
        # the agent that proposed it and again before it was committed. It is
        # still a third-party geocode rather than a number the owner gave, so
        # check it against the Business Profile pin if one is ever created.
        "geo": {"@type": "GeoCoordinates", "latitude": 40.7078433, "longitude": -73.9311942},
        "hasMap": "https://www.google.com/maps/search/?api=1&query=428+Johnson+Avenue%2C+Brooklyn%2C+NY+11237",
    }


def breadcrumbs(*trail):
    """trail is (name, url) pairs after Home.

    Built from the drawer nav the pages already carry, not invented. Home
    to one real section is the site's actual depth: no page here is more
    than one click from the homepage, so a deeper trail would be a lie.
    """
    items = [{"@type": "ListItem", "position": 1, "name": "Home", "item": SITE + "/"}]
    for i, (name, url) in enumerate(trail, start=2):
        items.append({"@type": "ListItem", "position": i, "name": name, "item": url})
    return {"@type": "BreadcrumbList", "itemListElement": items}


def hours(events):
    """One rule per distinct (opens, closes) pair, read off the calendar.

    This used to be a single hand-written rule saying every night runs
    17:00 to 23:15. Ten of the nineteen close at 22:00, which the Event
    entries on nights.html and the visible FAQ answer both already said.
    A crawler that reads two of this site's own sources against a third
    has no reason to trust any of them, so the rule is derived now and
    cannot drift from the calendar again.
    """
    live = [e for e in events if e["is_active"]]
    spans = {}
    for row in live:
        opens = row["doors"][:5]
        closes = plus_minutes(row["last_entry"], WALK_MINUTES)[:5]
        day = date.fromisoformat(row["event_date"]).strftime("%A")
        spans.setdefault((opens, closes), [])
        if day not in spans[(opens, closes)]:
            spans[(opens, closes)].append(day)
    dates = sorted(row["event_date"] for row in live)
    return [
        {
            "@type": "OpeningHoursSpecification",
            "dayOfWeek": days,
            "opens": opens,
            "closes": closes,
            "validFrom": dates[0],
            "validThrough": dates[-1],
        }
        for (opens, closes), days in sorted(spans.items())
    ]


def business(events):
    return {
        "@type": "EntertainmentBusiness",
        "@id": SITE + "/#business",
        "name": BRAND,
        "url": SITE + "/",
        "image": EVENT_IMAGES,
        "description": "A walk-through haunted attraction in Bushwick, Brooklyn. Sixty minutes inside, multiple rooms, live actors. October 2026. Ages 13 and over.",
        "address": venue()["address"],
        "sameAs": PROFILES,
        "parentOrganization": {"@id": SITE + "/#organization"},
        "openingHoursSpecification": hours(events),
    }


def offers(row, products):
    active = sorted((p for p in products if p["is_active"]), key=lambda p: p["tickets"])
    cents = [p["cents"] for p in active]
    if row["sold"] >= row["capacity"]:
        availability = "https://schema.org/SoldOut"
    elif date.today().isoformat() < PRESALE[:10]:
        # Before the presale opens nothing is buyable yet. Saying InStock then
        # is a lie a crawler can check.
        availability = "https://schema.org/PreOrder"
    else:
        # And after it opens, PreOrder is the same lie pointing the other way:
        # it tells a rich result the tickets cannot be bought when they can.
        # This used to be a date in a to-do list. It is a comparison now.
        availability = "https://schema.org/InStock"
    # The bundle is for this night and dies with it. A rich result still
    # advertising a $20 ticket to a night that already happened is exactly
    # the stale-availability failure this file exists to prevent.
    valid_until = row["event_date"]
    # The aggregate alone says $20 to $60 and leaves a reader to assume $60
    # buys a better seat. It buys four tickets. Nesting the real bundles is
    # what makes the quantity legible; unitCode C62 is the UN/CEFACT code
    # for a plain count.
    bundles = [
        {
            "@type": "Offer",
            "name": "%d ticket%s" % (p["tickets"], "" if p["tickets"] == 1 else "s"),
            "priceCurrency": "USD",
            "price": "%d" % (p["cents"] // 100),
            "availability": availability,
            "validFrom": PRESALE,
            "priceValidUntil": valid_until,
            "eligibleQuantity": {"@type": "QuantitativeValue", "value": p["tickets"], "unitCode": "C62"},
            "url": SITE + "/nights.html",
        }
        for p in active
    ]
    return {
        "@type": "AggregateOffer",
        "priceCurrency": "USD",
        "lowPrice": "%d" % (cents[0] // 100),
        "highPrice": "%d" % (cents[-1] // 100),
        "offerCount": "%d" % len(cents),
        "availability": availability,
        "validFrom": PRESALE,
        "priceValidUntil": valid_until,
        "url": SITE + "/nights.html",
        "offers": bundles,
        "inventoryLevel": {"@type": "QuantitativeValue", "value": max(row["capacity"] - row["sold"], 0)},
    }


CAST_ID = SITE + "/#cast"


def cast():
    """Who performs. Google reports every Event without one as incomplete.

    Six pages of the site say the rooms are worked by live actors, so the
    cast is the performer - there is no headliner to name and inventing one
    would be a lie. One node, referenced by every night, so the nineteen
    Events describe one company rather than nineteen.
    """
    return {
        "@type": "PerformingGroup",
        "@id": CAST_ID,
        "name": BRAND + " Cast",
        "description": "The live actors who work the rooms at %s." % BRAND,
    }


SERIES_ID = SITE + "/nights.html#series"


def series(events):
    """The whole season as one Event, so a page can point at it without
    listing all nineteen nights.

    The homepage is the page most likely to be the one Google ranks for
    "haunted house brooklyn", and it carried no Event of any kind - every
    night lived on nights.html. EventSeries is an Event subtype, so naming
    the season on the homepage makes it eligible for the event rich result
    too. The shared @id keeps this one season described on two pages rather
    than two seasons.
    """
    return {
        "@type": ["Event", "EventSeries"],
        "@id": SERIES_ID,
        "name": BRAND + " \u2014 October 2026",
        "description": SERIES_DESCRIPTION,
        "startDate": "%sT%s%s" % (events[0]["event_date"], events[0]["doors"][:5] + ":00", TZ),
        "endDate": "%sT%s%s" % (events[-1]["event_date"], plus_minutes(events[-1]["last_entry"], WALK_MINUTES), TZ),
        "eventStatus": "https://schema.org/EventScheduled",
        "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
        "location": {"@id": SITE + "/#venue"},
        "organizer": {"@id": SITE + "/#organization"},
        "performer": {"@id": CAST_ID},
        "image": EVENT_IMAGES,
        "typicalAgeRange": "13-",
        "isAccessibleForFree": False,
        "url": SITE + "/nights.html",
    }


def nights_graph(events, products):
    graph = [
        organization(),
        venue(),
        cast(),
        series(events),
        breadcrumbs(("Nights", SITE + "/nights.html")),
    ]
    for row in events:
        if not row["is_active"]:
            continue
        date = row["event_date"]
        graph.append(
            {
                "@type": "Event",
                "name": "%s \u2014 %s" % (BRAND, night_name(date)),
                "description": SERIES_DESCRIPTION,
                "superEvent": {"@id": SERIES_ID},
                "startDate": "%sT%s%s" % (date, row["doors"], TZ),
                "endDate": "%sT%s%s" % (date, plus_minutes(row["last_entry"], WALK_MINUTES), TZ),
                "eventStatus": "https://schema.org/EventScheduled",
                "eventAttendanceMode": "https://schema.org/OfflineEventAttendanceMode",
                "location": {"@id": SITE + "/#venue"},
                "organizer": {"@id": SITE + "/#organization"},
                "performer": {"@id": CAST_ID},
                "url": SITE + "/nights.html",
                "typicalAgeRange": "13-",
                "isAccessibleForFree": False,
                "image": EVENT_IMAGES,
                "maximumAttendeeCapacity": row["capacity"],
                "offers": offers(row, products),
            }
        )
    return {"@context": "https://schema.org", "@graph": graph}


def faq_graph(page_src):
    """FAQPage built by reading faq.html, not by restating it.

    The answers on that page are the owner's copy and are frozen. Retyping
    them here would create a second copy that drifts the first time one is
    edited, and Google treats schema that disagrees with the visible page as
    a reason to drop the rich result entirely. So the questions and answers
    are parsed out of the rendered markup - if the page says it, the schema
    says it, and there is no third place to keep in sync.
    """
    pairs = re.findall(
        r'<button class="faq-btn"[^>]*>(.*?)<span class="mark"'
        r'.*?<div class="faq-a"[^>]*><div>(.*?)</div></div>',
        page_src, re.S)
    if not pairs:
        sys.exit("faq.html: no question/answer pairs matched - markup changed")
    items = []
    for q, a in pairs:
        text = re.sub(r"<[^>]+>", " ", a)
        text = re.sub(r"\s+", " ", text).strip()
        question = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", "", q)).strip()
        # The address is published now, but a wrong one is worse than none:
        # a directory and a site that disagree both lose. So the check became
        # an equality check instead of a ban.
        m = re.search(r"\d{2,4}\s+[A-Z][a-z]+\s+(?:Ave|Avenue|St|Street)", text)
        if m and m.group(0) != STREET:
            sys.exit("faq.html: answer says %r, expected %r" % (m.group(0), STREET))
        items.append({
            "@type": "Question",
            "name": question,
            "acceptedAnswer": {"@type": "Answer", "text": text},
        })
    return {
        "@context": "https://schema.org",
        "@graph": [
            organization(),
            venue(),
            {
                "@type": "FAQPage",
                "@id": SITE + "/faq.html#faq",
                "name": "Haunted Mansion BK — questions and answers",
                "url": SITE + "/faq.html",
                "about": {"@id": SITE + "/#business"},
                "mainEntity": items,
            },
            breadcrumbs(("FAQ", SITE + "/faq.html")),
        ],
    }


def index_graph(events, breadcrumb=None):
    # The homepage gets no breadcrumb - a trail pointing at itself says
    # nothing. Every other page built from this graph gets its own.
    graph = [organization(), venue(), business(events), cast(), series(events)]
    if breadcrumb:
        graph.append(breadcrumb)
    return {"@context": "https://schema.org", "@graph": graph}


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
    stale |= write("index.html", block(index_graph(events)), check)
    # location.html gets the same business graph as the homepage. It is the
    # page that answers "where is it", which is the query the address was
    # published to win, and until now it was the only public page carrying no
    # structured data at all. Repeating the @id nodes across pages is correct:
    # it is one business described twice, not two businesses.
    stale |= write("location.html", block(index_graph(events, breadcrumbs(("Location", SITE + "/location.html")))), check)
    with open(os.path.join(ROOT, "faq.html"), encoding="utf-8") as f:
        stale |= write("faq.html", block(faq_graph(f.read())), check)
    # ages.html and groups.html carry a breadcrumb and nothing else. They are
    # leaf pages answering one question each; repeating the business graph on
    # them would tell Google nothing three other pages have not already said,
    # and BreadcrumbList is the one rich result they actually qualify for.
    stale |= write("ages.html", block(breadcrumbs(("Age and intensity", SITE + "/ages.html"))), check)
    stale |= write("groups.html", block(breadcrumbs(("Groups", SITE + "/groups.html"))), check)
    # experience.html, story.html and evidence.html were the last three
    # indexable pages carrying no structured data at all. They get the same
    # treatment as ages and groups: a breadcrumb and nothing else. Each is a
    # one-click section page, the trail is the drawer nav the pages already
    # show, and BreadcrumbList is the one rich result they qualify for.
    stale |= write("experience.html", block(breadcrumbs(("The experience", SITE + "/experience.html"))), check)
    stale |= write("story.html", block(breadcrumbs(("The story", SITE + "/story.html"))), check)
    stale |= write("evidence.html", block(breadcrumbs(("Evidence", SITE + "/evidence.html"))), check)
    active = sum(1 for e in events if e["is_active"])
    print("%d night(s) in the graph" % active)
    if check and stale:
        sys.exit(1)


if __name__ == "__main__":
    main()
