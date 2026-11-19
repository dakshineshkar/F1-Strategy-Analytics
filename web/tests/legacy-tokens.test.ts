import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { themeCss } from "@/lib/theme";

/** Redesign step 4B removed the legacy token aliases (accent, ok, warn, info, banner, bar) and the legacy --radius
 * and --gap shorthands once no page read them. This guard keeps them out: no stylesheet, component or library file
 * may name one, and the emitted theme declares none. */
const LEGACY = /var\(--(accent|accent-ink|accent-bg|ok|warn|info|banner-bg|banner-ink|bar|radius|gap)\)/;
const SRC = join(__dirname, "..", "src");

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(css|tsx?)$/.test(name) ? [p] : [];
  });
}

describe("legacy token aliases (removed in step 4B)", () => {
  it("no source file reads one", () => {
    const hits = files(SRC).flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .map((line, i) => [line, i + 1] as const)
        .filter(([line]) => LEGACY.test(line))
        .map(([line, n]) => `${f.slice(SRC.length + 1)}:${n}: ${line.trim()}`),
    );
    expect(hits).toEqual([]);
  });

  it("the theme stylesheet declares none", () => {
    expect(themeCss).not.toMatch(/--(accent|accent-ink|accent-bg|ok|warn|info|banner-bg|banner-ink|bar|radius|gap):/);
  });

  it("the guard itself catches a use", () => {
    expect(LEGACY.test("color: var(--accent-ink);")).toBe(true);
    expect(LEGACY.test("border-radius: var(--radius-md);")).toBe(false);
  });
});
