# Fonts (self-hosted)

Loaded with `next/font/local` in `web/src/app/fonts.ts`. No font is requested from a third party at runtime, so
the dashboard works offline. Latin subset only (unicode range U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC,
U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215,
U+FEFF, U+FFFD), normal style, and only the weights the UI uses.

| Folder | Family | Files (weight) | Copyright | Licence |
|---|---|---|---|---|
| `barlow-semi-condensed/` | Barlow Semi Condensed | 500, 600, 700 | 2017 The Barlow Project Authors (https://github.com/jpt/barlow) | SIL Open Font License 1.1, `OFL.txt` |
| `barlow/` | Barlow | 400, 500 | 2017 The Barlow Project Authors (https://github.com/jpt/barlow) | SIL Open Font License 1.1, `OFL.txt` |
| `ibm-plex-mono/` | IBM Plex Mono | 400, 500, 600 | 2017 IBM Corp. | SIL Open Font License 1.1, `OFL.txt` |

Source: the npm packages `@fontsource/barlow-semi-condensed@5.3.0`, `@fontsource/barlow@5.3.0` and
`@fontsource/ibm-plex-mono@5.3.0` (the `files/<family>-latin-<weight>-normal.woff2` files and each package's
`LICENSE`, copied unchanged as `OFL.txt`). The packages are not a dependency of the app. The fonts are
unmodified; the OFL allows bundling them with software, provided the licence travels with them.
