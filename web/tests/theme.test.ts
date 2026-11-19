import { describe, expect, it } from "vitest";

import {
  COMPOUND_TOKENS,
  contrastRatio,
  dark,
  darkPalette,
  inGamut,
  light,
  lightPalette,
  oklchCss,
  oklchToHex,
  parseThemeChoice,
  themeBootScript,
  themeCss,
  THEME_STORAGE_KEY,
  type Palette,
  type Theme,
} from "@/lib/theme";

const AA_TEXT = 4.5;
const AA_UI = 3;

/** Every text colour × every ground it is drawn on, plus every UI mark × its grounds. The same table is
 * printed into docs/design/DESIGN.md by web/scripts/contrast-report.mjs. */
export const TEXT_ROLES = ["text", "muted", "faint", "signalInk", "gain", "loss", "danger"] as const;
export const GROUNDS = ["bg", "surface", "surface2", "raised"] as const;
export const UI_ROLES = ["border", "focus", "signalMark", "grid", "gain", "loss"] as const;

function pairs(t: Theme): [string, string, string, number][] {
  const out: [string, string, string, number][] = [];
  for (const bg of GROUNDS) {
    for (const fg of TEXT_ROLES) out.push([t[fg], t[bg], `${fg} on ${bg}`, AA_TEXT]);
    for (const fg of UI_ROLES) out.push([t[fg], t[bg], `${fg} (mark) on ${bg}`, AA_UI]);
  }
  // a flagged tower row: its text, numbers and flag mark sit on the signal wash
  for (const fg of ["text", "muted", "signalInk"] as const) out.push([t[fg], t.signalWash, `${fg} on signalWash`, AA_TEXT]);
  out.push([t.signalMark, t.signalWash, "signalMark on signalWash", AA_UI]);
  out.push([t.focus, t.signalWash, "focus on signalWash", AA_UI]);
  // the call's probability chip and alert type chips: ink on the signal fill
  out.push([t.signalOn, t.signal, "signalOn on signal", AA_TEXT]);
  // the banner (legacy names) and the placeholder (F34) use faint on surface2 (inputs)
  out.push([t.bannerInk, t.bannerBg, "banner", AA_TEXT]);
  out.push([t.faint, t.surface2, "placeholder (faint) on input", AA_TEXT]);
  return out;
}

describe.each([
  ["dark", dark],
  ["light", light],
] as const)("%s theme meets WCAG AA", (_name, theme) => {
  it.each(pairs(theme))("%s on %s (%s) ≥ %d:1", (fg, bg, _label, min) => {
    expect(contrastRatio(fg, bg)).toBeGreaterThanOrEqual(min);
  });

  it("every chart line is ≥ 3:1 against every chart ground", () => {
    for (const c of theme.lines) for (const g of [theme.bg, theme.surface, theme.surface2]) expect(contrastRatio(c, g)).toBeGreaterThanOrEqual(AA_UI);
  });

  it("every compound colour is ≥ 3:1 against every ground", () => {
    for (const k of COMPOUND_TOKENS) for (const g of [theme.bg, theme.surface, theme.surface2]) expect(contrastRatio(theme.compounds[k], g), k).toBeGreaterThanOrEqual(AA_UI);
  });

  it("tyre-age and range bars are visible against their track (≥ 3:1)", () => {
    expect(contrastRatio(theme.bar, theme.surface2)).toBeGreaterThanOrEqual(AA_UI);
    expect(contrastRatio(theme.bar, theme.surface)).toBeGreaterThanOrEqual(AA_UI);
  });

  it("chart grid lines are visible (≥ 3:1)", () => {
    expect(contrastRatio(theme.grid, theme.surface)).toBeGreaterThanOrEqual(AA_UI);
  });

  it("the focus ring is never the signal amber (amber is reserved for the call)", () => {
    expect(theme.focus).not.toBe(theme.signal);
    expect(theme.focus).not.toBe(theme.signalMark);
  });
});

describe.each([
  ["dark", darkPalette],
  ["light", lightPalette],
] as const)("%s palette (OKLCH source)", (_name, p: Palette) => {
  it("every colour is inside the sRGB gamut, so the hex fallback equals the OKLCH value", () => {
    const roles = Object.entries(p).filter(([k]) => k !== "lines" && k !== "compounds") as [string, Palette["bg"]][];
    for (const [k, o] of roles) expect(inGamut(o), k).toBe(true);
    for (const o of p.lines) expect(inGamut(o)).toBe(true);
    for (const k of COMPOUND_TOKENS) expect(inGamut(p.compounds[k]), k).toBe(true);
  });

  it("no chart line uses an amber hue (60–100°), which belongs to the call", () => {
    for (const [, , h] of p.lines) expect(h < 60 || h > 100).toBe(true);
  });

  it("four line colours, every pair at least ΔE 15 apart in OKLab (the validator's normal-vision floor)", () => {
    // the CVD half of the check is the dataviz validator's (results in docs/design/DESIGN.md)
    const lab = ([l, c, h]: Palette["bg"]) => [l, c * Math.cos((h * Math.PI) / 180), c * Math.sin((h * Math.PI) / 180)];
    expect(p.lines).toHaveLength(4);
    for (let i = 0; i < p.lines.length; i++)
      for (let j = i + 1; j < p.lines.length; j++) {
        const [a, b] = [lab(p.lines[i] as Palette["bg"]), lab(p.lines[j] as Palette["bg"])];
        expect(100 * Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!), `line-${i} vs line-${j}`).toBeGreaterThanOrEqual(15);
      }
  });
});

describe("OKLCH conversion", () => {
  it("matches reference sRGB values", () => {
    expect(oklchToHex([1, 0, 0])).toBe("#ffffff");
    expect(oklchToHex([0, 0, 0])).toBe("#000000");
    // OKLab reference: pure sRGB red is oklch(62.8% 0.2577 29.23)
    expect(oklchToHex([0.62796, 0.25768, 29.234])).toBe("#ff0000");
    expect(oklchCss([0.5, 0.1, 70])).toBe("oklch(50% 0.1 70)");
  });

  it("flags out-of-gamut colours", () => {
    expect(inGamut([0.5, 0.4, 150])).toBe(false);
    expect(inGamut([0.5, 0.05, 150])).toBe(true);
  });
});

describe("theme stylesheet", () => {
  it("is dark by default, light on request, and follows the OS only on auto", () => {
    expect(themeCss).toContain(`:root,:root[data-theme="dark"]{color-scheme:dark;--bg:${dark.bg};`);
    expect(themeCss).toContain(`:root[data-theme="light"]{color-scheme:light;--bg:${light.bg};`);
    expect(themeCss).toContain(`@media (prefers-color-scheme: light){:root[data-theme="auto"]{color-scheme:light;`);
    expect(themeCss).not.toContain("prefers-color-scheme: dark");
  });

  it("writes each colour as a hex fallback followed by its OKLCH value", () => {
    expect(themeCss).toContain(`--signal:${dark.signal};--signal:${oklchCss(darkPalette.signal)};`);
    expect(themeCss).toContain(`--line-0:${light.lines[0]};--line-0:${oklchCss(lightPalette.lines[0] as Palette["bg"])};`);
  });

  it("keeps the legacy names as aliases of the new roles", () => {
    expect(themeCss).toContain("--accent:var(--signal-mark);");
    expect(themeCss).toContain("--ok:var(--gain);");
    expect(themeCss).toContain("--warn:var(--loss);");
    expect(light.accent).toBe(light.signalMark);
  });

  it("emits the non-colour scale once", () => {
    expect(themeCss).toContain("--fs-2xs:0.6875rem;");
    expect(themeCss).toContain("--dur-slow:200ms;");
    expect(themeCss).toContain("--row-h:1.75rem;");
  });
});

describe("theme choice", () => {
  it("defaults to dark for anything that is not a known choice", () => {
    expect(parseThemeChoice("light")).toBe("light");
    expect(parseThemeChoice("auto")).toBe("auto");
    expect(parseThemeChoice("dark")).toBe("dark");
    expect(parseThemeChoice(null)).toBe("dark");
    expect(parseThemeChoice("sepia")).toBe("dark");
    expect(parseThemeChoice(1)).toBe("dark");
  });

  it("the boot script reads storage inside try/catch and falls back to dark", () => {
    expect(themeBootScript).toContain(`localStorage.getItem("${THEME_STORAGE_KEY}")`);
    expect(themeBootScript).toMatch(/try\{.*\}catch\(e\)\{\}/);
    const html = { attrs: {} as Record<string, string> };
    const doc = { documentElement: { setAttribute: (k: string, v: string) => (html.attrs[k] = v) } };
    const run = (storage: unknown) => new Function("localStorage", "document", themeBootScript)(storage, doc);
    run({ getItem: () => "light" });
    expect(html.attrs["data-theme"]).toBe("light");
    run({
      getItem: () => {
        throw new Error("blocked");
      },
    });
    expect(html.attrs["data-theme"]).toBe("dark");
    run({ getItem: () => "neon" });
    expect(html.attrs["data-theme"]).toBe("dark");
  });
});

describe("contrastRatio", () => {
  it("matches the WCAG reference values", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 5);
    expect(contrastRatio("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
    expect(() => contrastRatio("red", "#fff")).toThrow();
  });
});
