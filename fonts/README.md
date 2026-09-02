# Fonts

These four families used to be loaded from `fonts.googleapis.com`. They are
served from this origin now, for three reasons:

1. **Speed.** A remote stylesheet meant a DNS lookup, a TLS handshake and a
   round trip for the CSS had to finish before the browser learned the URL of
   a single font file. That was 376ms of blocked render at the front of a page
   whose entire job is to be looked at immediately.
2. **Privacy.** Every visitor's IP address went to a third party, on a site
   that publishes a page describing what it collects.
3. **It stops being someone else's outage.** One host, ours, same as the
   photograph.

The `.woff2` files are Google's own, fetched unmodified from
`fonts.gstatic.com` — byte for byte what the `<link>` tag used to pull, so
nothing about the rendering changed.

## What is here, and what is not

Only the faces something actually selects. The old link requested seven and
four were ever used: Space Grotesk 500 and 600, and DM Sans 400, were being
downloaded by nobody.

| Family | Weights | Used by |
|---|---|---|
| DM Sans | 500, 600, 700 | index |
| Space Grotesk | 700 | index |
| Cinzel | 400 | privacy, 404 |
| Cormorant Garamond | 300, 400 | privacy (300, 400), 404 (300) |

Each comes in `latin` and `latin-ext`. The `unicode-range` on every
`@font-face` means `latin-ext` is fetched only when a glyph inside it is
actually rendered — an accented name typed into the form, most often never.

## Licence

All four are under the SIL Open Font License 1.1. The upstream licence text,
including each family's copyright line, is in the `OFL-*.txt` files beside the
fonts; they were taken from `github.com/google/fonts`. The OFL permits
redistribution and self-hosting like this; it requires that these notices ship
with the fonts, which is what they are doing here.

## Changing them

`@font-face` rules live in each page's inline `<style>`, and the CSP hash
covers that block — so after any edit, run:

    python tools/csp.py

`tools/test_page.py` asserts all three live pages still serve their own fonts,
that no page has a `fonts.googleapis.com` link, that `font-src` is `'self'`,
and that every file named in an `@font-face` exists.
