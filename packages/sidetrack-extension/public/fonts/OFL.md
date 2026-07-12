# Bundled fonts — SIL Open Font License 1.1

These woff2 files are **latin-subset** builds of open-source typefaces,
bundled locally so the side panel never makes a runtime network font
request (privacy: nothing leaves the device). They are served from the
extension bundle root (`chrome-extension://<id>/fonts/…`), wired via
`@font-face` at the top of `entrypoints/sidepanel/style.css`.

| File | Family | Weights | Variable |
| --- | --- | --- | --- |
| `newsreader-var.woff2` | Newsreader (display serif) | 400–600 | yes |
| `ibm-plex-sans-var.woff2` | IBM Plex Sans (body sans) | 400–600 | yes |
| `ibm-plex-mono-400.woff2` | IBM Plex Mono (mono) | 400 | no |
| `ibm-plex-mono-500.woff2` | IBM Plex Mono (mono) | 500 | no |

Total added weight: ~192 KB (well under the ~400 KB budget).

## Licenses (all SIL OFL 1.1)

- **Newsreader** — Copyright 2019 The Newsreader Project Authors
  (https://github.com/productiontype/Newsreader). Licensed under the SIL
  Open Font License, Version 1.1.
- **IBM Plex Sans** and **IBM Plex Mono** — Copyright © 2017 IBM Corp.
  (https://github.com/IBM/plex). Licensed under the SIL Open Font
  License, Version 1.1.

The full SIL Open Font License 1.1 text is available at
https://openfontlicense.org and in each upstream repository. The OFL
permits bundling, subsetting, and redistribution within a larger work
(this extension) provided the fonts are not sold on their own and this
notice is retained. Reserved Font Names ("Newsreader", "IBM Plex") are
unchanged; the subset builds are not renamed.
