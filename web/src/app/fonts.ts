import localFont from "next/font/local";

/** The three self-hosted families (web/src/fonts, Latin subset, OFL 1.1). Each exposes a CSS variable that
 * globals.css uses: --font-ui (labels, the tower, headings), --font-body (prose), --font-num (every number). */
export const fontUi = localFont({
  src: [
    { path: "../fonts/barlow-semi-condensed/barlow-semi-condensed-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "../fonts/barlow-semi-condensed/barlow-semi-condensed-latin-600-normal.woff2", weight: "600", style: "normal" },
    { path: "../fonts/barlow-semi-condensed/barlow-semi-condensed-latin-700-normal.woff2", weight: "700", style: "normal" },
  ],
  variable: "--font-ui",
  display: "swap",
  fallback: ["Arial Narrow", "system-ui", "sans-serif"],
});

export const fontBody = localFont({
  src: [
    { path: "../fonts/barlow/barlow-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../fonts/barlow/barlow-latin-500-normal.woff2", weight: "500", style: "normal" },
  ],
  variable: "--font-body",
  display: "swap",
  fallback: ["system-ui", "sans-serif"],
});

export const fontNum = localFont({
  src: [
    { path: "../fonts/ibm-plex-mono/ibm-plex-mono-latin-400-normal.woff2", weight: "400", style: "normal" },
    { path: "../fonts/ibm-plex-mono/ibm-plex-mono-latin-500-normal.woff2", weight: "500", style: "normal" },
    { path: "../fonts/ibm-plex-mono/ibm-plex-mono-latin-600-normal.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-num",
  display: "swap",
  fallback: ["ui-monospace", "monospace"],
});
