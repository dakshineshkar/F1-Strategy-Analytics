/** Design tokens of Pit Wall, the single source for the CSS custom properties (``themeCss``) and for the
 * contrast tests. Colours are authored in OKLCH; the hex fallback of each is derived here (``oklchToHex``),
 * and every contrast check runs on that derived hex. Dark (graphite) is the primary theme; light is the
 * same system re-derived, never an inversion. One signal amber is reserved for the undercut call;
 * gain is blue and loss is orange (never red/green alone, and always with a sign, arrow or text).
 * See docs/design/DESIGN.md for the rules and the validation results. */

/** [lightness 0–1, chroma, hue in degrees] */
export type Oklch = readonly [number, number, number];

export const COMPOUND_TOKENS = ["soft", "medium", "hard", "inter", "wet", "unknown"] as const;
export type CompoundToken = (typeof COMPOUND_TOKENS)[number];

/** The OKLCH source of one theme. */
export interface Palette {
  /** page ground */
  bg: Oklch;
  /** panels */
  surface: Oklch;
  /** inset wells, table stripes, inputs */
  surface2: Oklch;
  /** the status strip, chips, hovered rows */
  raised: Oklch;
  /** hairline dividers (decorative; never the only boundary of a control) */
  rule: Oklch;
  /** control and data-mark outlines (≥ 3:1 on every surface) */
  border: Oklch;
  text: Oklch;
  muted: Oklch;
  /** the quietest text: units, captions, placeholders (still ≥ 4.5:1) */
  faint: Oklch;
  /** the undercut call's fill (alert chips, the call's probability band) */
  signal: Oklch;
  /** ink on the signal fill */
  signalOn: Oklch;
  /** signal-coloured text on any surface */
  signalInk: Oklch;
  /** signal-coloured marks (flag bar, gauge marker), ≥ 3:1 on the surfaces */
  signalMark: Oklch;
  /** the tinted ground of a flagged tower row */
  signalWash: Oklch;
  gain: Oklch;
  loss: Oklch;
  focus: Oklch;
  danger: Oklch;
  /** chart grid lines */
  grid: Oklch;
  /** The categorical chart colours: four, the largest set that passes the dataviz validator on **all**
   * pairs (normal-vision ΔE ≥ 15, protan/deutan ΔE ≥ 8, ≥ 3:1 on the surface) in this theme. Never cycled:
   * a fifth series and beyond is drawn in the neutral grid colour with a dash and its end label
   * (``seriesColour`` in lib/chart.ts), and no view that shows team colours uses them. */
  lines: Oklch[];
  /** Tyre compounds: data colours in the sport's convention, always with a glyph shape and a letter. */
  compounds: Record<CompoundToken, Oklch>;
}

const N = 255; // the graphite hue (cool, low chroma)

export const darkPalette: Palette = {
  bg: [0.165, 0.008, N],
  surface: [0.2, 0.009, N],
  surface2: [0.235, 0.01, N],
  raised: [0.27, 0.011, N],
  rule: [0.33, 0.012, N],
  border: [0.6, 0.014, N],
  text: [0.945, 0.005, N],
  muted: [0.79, 0.012, N],
  faint: [0.72, 0.014, N],
  signal: [0.82, 0.155, 80],
  signalOn: [0.2, 0.03, 80],
  signalInk: [0.84, 0.15, 82],
  signalMark: [0.82, 0.155, 80],
  signalWash: [0.285, 0.05, 78],
  gain: [0.76, 0.12, 245],
  loss: [0.71, 0.165, 36],
  focus: [0.93, 0.04, 215],
  danger: [0.72, 0.16, 22],
  grid: [0.55, 0.012, N],
  lines: [
    [0.66, 0.115, 215],
    [0.66, 0.15, 135],
    [0.54, 0.15, 40],
    [0.54, 0.15, 320],
  ],
  compounds: {
    soft: [0.69, 0.199, 25.5],
    medium: [0.93, 0.14, 110],
    hard: [0.957, 0.006, N],
    inter: [0.765, 0.172, 152],
    wet: [0.722, 0.148, 252],
    unknown: [0.763, 0.021, N],
  },
};

export const lightPalette: Palette = {
  bg: [0.955, 0.004, N],
  surface: [0.99, 0.002, N],
  surface2: [0.93, 0.005, N],
  raised: [0.905, 0.006, N],
  rule: [0.85, 0.007, N],
  border: [0.56, 0.014, N],
  text: [0.22, 0.012, N],
  muted: [0.42, 0.014, N],
  faint: [0.48, 0.014, N],
  signal: [0.82, 0.155, 80],
  signalOn: [0.2, 0.03, 80],
  signalInk: [0.5, 0.1, 70],
  signalMark: [0.6, 0.12, 86],
  signalWash: [0.94, 0.06, 88],
  gain: [0.48, 0.13, 250],
  loss: [0.49, 0.16, 38],
  focus: [0.32, 0.08, N],
  danger: [0.5, 0.18, 27],
  grid: [0.58, 0.012, N],
  lines: [
    [0.6, 0.15, 150],
    [0.48, 0.15, 255],
    [0.6, 0.15, 295],
    [0.48, 0.15, 15],
  ],
  compounds: {
    soft: [0.53, 0.207, 22.3],
    medium: [0.5, 0.1, 100],
    hard: [0.445, 0.023, N],
    inter: [0.481, 0.118, 151.5],
    wet: [0.465, 0.146, 254.8],
    unknown: [0.506, 0.022, 83],
  },
};

/** The derived hex values of one theme. (The legacy alias names accent, ok, warn, info, banner and bar were
 * removed in redesign step 4B, when the last page that read them moved to the roles.) */
export interface Theme {
  bg: string;
  surface: string;
  surface2: string;
  raised: string;
  rule: string;
  border: string;
  text: string;
  muted: string;
  faint: string;
  signal: string;
  signalOn: string;
  signalInk: string;
  signalMark: string;
  signalWash: string;
  gain: string;
  loss: string;
  focus: string;
  danger: string;
  grid: string;
  lines: string[];
  compounds: Record<CompoundToken, string>;
}

// --- OKLCH → sRGB (Björn Ottosson's OKLab matrices) ------------------------------------------------

/** Linear-light sRGB channels of an OKLCH colour, unclamped (a channel outside 0–1 is out of gamut). */
export function oklchToLinearRgb([l, c, h]: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180;
  const a = c * Math.cos(rad);
  const b = c * Math.sin(rad);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

/** True when the colour fits sRGB (a tolerance of 0.0005 per linear channel absorbs rounding). */
export function inGamut(o: Oklch): boolean {
  return oklchToLinearRgb(o).every((v) => v >= -0.0005 && v <= 1.0005);
}

function encode(v: number): number {
  const x = Math.min(1, Math.max(0, v));
  return x <= 0.0031308 ? 12.92 * x : 1.055 * x ** (1 / 2.4) - 0.055;
}

/** ``#rrggbb`` of an OKLCH colour (clamped into sRGB). */
export function oklchToHex(o: Oklch): string {
  return (
    "#" +
    oklchToLinearRgb(o)
      .map((v) => Math.round(encode(v) * 255).toString(16).padStart(2, "0"))
      .join("")
  );
}

function decode(v: number): number {
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

type Rgb = [number, number, number];

/** Linear-light sRGB of a ``#rrggbb`` colour. */
function hexToLinear(hex: string): Rgb {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m || !m[1]) throw new Error(`not a #rrggbb colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => decode(c / 255)) as Rgb;
}

/** OKLab ``[L, a, b]`` of linear sRGB (the inverse of the matrices above). */
function linearToOklab([r, g, b]: Rgb): Rgb {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const mm = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s,
  ];
}

/** OKLab ``[L, a, b]`` of a ``#rrggbb`` colour. */
export function hexToOklab(hex: string): Rgb {
  return linearToOklab(hexToLinear(hex));
}

/** Dichromat simulation in linear sRGB (Viénot, Brettel and Mollon 1999). */
const CVD = {
  protan: [
    [0.11238, 0.88762, 0],
    [0.11238, 0.88762, 0],
    [0.00401, -0.00401, 1],
  ],
  deutan: [
    [0.29275, 0.70725, 0],
    [0.29275, 0.70725, 0],
    [-0.02234, 0.02234, 1],
  ],
} as const;
export type Vision = "normal" | keyof typeof CVD;

function simulate(rgb: Rgb, vision: Vision): Rgb {
  if (vision === "normal") return rgb;
  return CVD[vision].map((row) => Math.min(1, Math.max(0, row[0] * rgb[0] + row[1] * rgb[1] + row[2] * rgb[2]))) as Rgb;
}

/** Colour difference ΔE of two ``#rrggbb`` colours: Euclidean OKLab distance × 100 (the scale of the dataviz
 * validator: 15 is the normal-vision floor between two series, 8 the colour-blind target), as seen with normal
 * vision or simulated protanopia / deuteranopia. */
export function deltaE(a: string, b: string, vision: Vision = "normal"): number {
  const p = linearToOklab(simulate(hexToLinear(a), vision));
  const q = linearToOklab(simulate(hexToLinear(b), vision));
  return 100 * Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** CSS ``oklch()`` text of a colour. */
export function oklchCss([l, c, h]: Oklch): string {
  return `oklch(${+(l * 100).toFixed(2)}% ${+c.toFixed(4)} ${+h.toFixed(2)})`;
}

type Role = Exclude<keyof Palette, "lines" | "compounds">;
const ROLES = [
  "bg", "surface", "surface2", "raised", "rule", "border", "text", "muted", "faint", "signal", "signalOn",
  "signalInk", "signalMark", "signalWash", "gain", "loss", "focus", "danger", "grid",
] as const satisfies readonly Role[];

function resolve(p: Palette): Theme {
  const t = Object.fromEntries(ROLES.map((r) => [r, oklchToHex(p[r])])) as Record<Role, string>;
  const compounds = Object.fromEntries(COMPOUND_TOKENS.map((k) => [k, oklchToHex(p.compounds[k])])) as Record<CompoundToken, string>;
  return { ...t, lines: p.lines.map(oklchToHex), compounds };
}

export const dark: Theme = resolve(darkPalette);
export const light: Theme = resolve(lightPalette);

// --- CSS emission -----------------------------------------------------------------------------------

const VAR: Record<Role, string> = {
  bg: "--bg",
  surface: "--surface",
  surface2: "--surface-2",
  raised: "--raised",
  rule: "--rule",
  border: "--border",
  text: "--text",
  muted: "--muted",
  faint: "--faint",
  signal: "--signal",
  signalOn: "--signal-on",
  signalInk: "--signal-ink",
  signalMark: "--signal-mark",
  signalWash: "--signal-wash",
  gain: "--gain",
  loss: "--loss",
  focus: "--focus",
  danger: "--danger",
  grid: "--grid",
};

/** ``--name:#hex;--name:oklch(…);``: the hex first, so a browser without OKLCH keeps it. */
function decl(name: string, o: Oklch): string {
  return `${name}:${oklchToHex(o)};${name}:${oklchCss(o)};`;
}

function vars(p: Palette): string {
  const roles = ROLES.map((r) => decl(VAR[r], p[r])).join("");
  const lines = p.lines.map((c, i) => decl(`--line-${i}`, c)).join("");
  const compounds = COMPOUND_TOKENS.map(
    (k) => `${decl(`--compound-${k}`, p.compounds[k])}--compound-${k}-ink:${inkOn(oklchToHex(p.compounds[k]))};`,
  ).join("");
  return roles + lines + compounds + `--elev-pop:${elevation(p)};`;
}

/** The one elevation (popovers): a hairline ring; on light also a soft drop. On dark a drop shadow reads as
 * glow, so the ring and the lighter surface carry it alone (DESIGN.md, Elevation). */
function elevation(p: Palette): string {
  const ring = "0 0 0 1px var(--rule)";
  if (p.bg[0] < 0.5) return ring;
  const [l, c, h] = p.text;
  return `${ring}, 0 16px 32px -16px oklch(${+(l * 100).toFixed(2)}% ${c} ${h} / 0.28)`;
}

/** Non-colour tokens, the same in both themes. */
export const SCALE = {
  /** type scale (px): 11 is the floor for any text */
  font: { "2xs": 11, xs: 12, sm: 13, md: 14, lg: 16, xl: 20, "2xl": 28 },
  /** 4 px spacing grid */
  space: { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40 },
  radius: { sm: 2, md: 4, lg: 6 },
  /** motion: every transition is ≤ 200 ms */
  duration: { fast: 120, base: 160, slow: 200 },
  ease: { out: "cubic-bezier(0.22, 1, 0.36, 1)", inOut: "cubic-bezier(0.65, 0, 0.35, 1)" },
  /** the timing tower's fixed row height (px) */
  rowHeight: 28,
} as const;

function scaleVars(): string {
  const f = Object.entries(SCALE.font).map(([k, v]) => `--fs-${k}:${v / 16}rem;`).join("");
  const s = Object.entries(SCALE.space).map(([k, v]) => `--sp-${k}:${v / 16}rem;`).join("");
  const r = Object.entries(SCALE.radius).map(([k, v]) => `--radius-${k}:${v}px;`).join("");
  const d = Object.entries(SCALE.duration).map(([k, v]) => `--dur-${k}:${v}ms;`).join("");
  return (
    f + s + r + d +
    `--ease-out:${SCALE.ease.out};--ease-in-out:${SCALE.ease.inOut};` +
    `--row-h:${SCALE.rowHeight / 16}rem;`
  );
}

/** The theme stylesheet. Dark is the default whatever the OS says; ``data-theme="light"`` picks light, and
 * ``data-theme="auto"`` follows ``prefers-color-scheme``. Without JavaScript the page is dark. */
export const themeCss =
  `:root{${scaleVars()}}` +
  `:root,:root[data-theme="dark"]{color-scheme:dark;${vars(darkPalette)}}` +
  `:root[data-theme="light"]{color-scheme:light;${vars(lightPalette)}}` +
  `@media (prefers-color-scheme: light){:root[data-theme="auto"]{color-scheme:light;${vars(lightPalette)}}}`;

// --- theme choice (the top-bar switch) ------------------------------------------------------------------

export const THEME_CHOICES = ["dark", "light", "auto"] as const;
export type ThemeChoice = (typeof THEME_CHOICES)[number];
export const THEME_STORAGE_KEY = "f1sa.theme";

/** A stored value as a choice; anything else (missing, blocked storage, junk) is the default, dark. */
export function parseThemeChoice(v: unknown): ThemeChoice {
  return typeof v === "string" && (THEME_CHOICES as readonly string[]).includes(v) ? (v as ThemeChoice) : "dark";
}

/** The inline script that sets ``html[data-theme]`` before the first paint (no flash of the wrong theme). It
 * reads the stored choice inside try/catch, so blocked storage falls back to dark. */
export const themeBootScript =
  `(function(){var t="dark";try{var v=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});` +
  `if(v==="light"||v==="auto"||v==="dark")t=v;}catch(e){}document.documentElement.setAttribute("data-theme",t);})();`;

// --- contrast ------------------------------------------------------------------------------------------

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m || !m[1]) throw new Error(`not a #rrggbb colour: ${hex}`);
  const n = parseInt(m[1], 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG 2.x contrast ratio of two #rrggbb colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** Black or white text on ``hex``, whichever contrasts more (bar labels on compound colours). */
export function inkOn(hex: string): "#000000" | "#ffffff" {
  return contrastRatio("#000000", hex) >= contrastRatio("#ffffff", hex) ? "#000000" : "#ffffff";
}
