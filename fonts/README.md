# Fonts

Every face is served from this origin. Nothing loads from
`fonts.googleapis.com`, for three reasons:

1. **Speed.** A remote stylesheet meant a DNS lookup, a TLS handshake and a
   round trip for the CSS had to finish before the browser learned the URL of
   a single font file. That was 376ms of blocked render at the front of a page
   whose entire job is to be looked at immediately.
2. **Privacy.** Every visitor's IP address went to a third party, on a site
   that publishes a page describing what it collects.
3. **It stops being someone else's outage.** One host, ours, same as the
   photograph.

The `.woff2` files are Google's own, fetched unmodified from
`fonts.gstatic.com`.

## What is here, and what is not

Three families, and only the faces something actually selects:

| Family | Weights | Role |
|---|---|---|
| Creepster | 400 | display: headings, the dayline, the countdown, drawer nav |
| Barlow Condensed | 500, 600, 700 | labels, kickers, leads, buttons |
| DM Sans | 500, 600, 700 | body copy |

The homepage h1 is the poster's own lettering (`v/img-poster/logo.png`);
Creepster is what it falls back to if the picture fails. Buttons stay in
Barlow Condensed on purpose: a horror face at button size costs
legibility on the one control that matters.

Barlow Condensed and DM Sans come in `latin` and `latin-ext`; Creepster is
published as `latin` only. The `unicode-range` on every `@font-face` means
`latin-ext` is fetched only when a glyph inside it is actually rendered — an
accented name typed into the form, most often never.

Cinzel, Cormorant Garamond and Space Grotesk were removed with the poster
retheme (2026-09-15). The display role was then tried three ways the same
day - Butcherman (its A drops its crossbar below ~40px), Nosifer (wide,
live for a few hours) and Creepster - and the owner picked Creepster from
the side-by-side at `looks.html`. Faces tried on that bench and not
chosen (Butcherman, Nosifer, Rubik Wet Paint, and the six candidates for the
lead line under the countdown) stay under `v/fonts/` with their licences;
no visitor page references them. Special Elite there is Apache 2.0, not OFL.

## Licence

All three are under the SIL Open Font License 1.1. The upstream licence text,
including each family's copyright line, is in the `OFL-*.txt` files beside the
fonts; they were taken from `github.com/google/fonts`. The OFL permits
redistribution and self-hosting like this; it requires that these notices ship
with the fonts, which is what they are doing here.

## Changing them

`@font-face` rules live in each page's inline `<style>`, and the CSP hash
covers that block — so after any edit, run:

    python tools/csp.py

`tools/test_page.py` asserts every live page still serves its own fonts,
that no page has a `fonts.googleapis.com` link, that `font-src` is `'self'`,
and that every file named in an `@font-face` exists.
