# Fonts

Cinzel, by Natanael Gama. Licensed under the SIL Open Font License 1.1
(https://scripts.sil.org/OFL). Pulled from Google Fonts.

Vendored rather than fetched at build time so `tools/reel.py` renders the same
letterforms as the page does. `index.html` loads Cinzel from Google Fonts as the
`--display` face; if that stack ever changes, replace these two files to match or
the reels stop looking like they came from the same house.
