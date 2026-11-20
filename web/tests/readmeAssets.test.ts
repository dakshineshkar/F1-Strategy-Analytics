// The README's architecture renderer (scripts/readme-assets.mjs): parsing, row sources, routing and guards.
// Only the browser-free functions are tested here; `make readme-assets` runs the whole script.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "scripts", "readme-assets.mjs");
const SOURCE = path.join(HERE, "..", "..", "docs", "assets", "architecture.mmd");

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}
interface Link {
  from: string;
  op: string;
  label: string | null;
  to: string;
}
interface Row {
  id: string;
  title: string;
  lines: string[];
  nodes: string[];
  clusters: Record<string, { title: string; members: string[] }>;
  links: Link[];
}
interface Diagram {
  rows: Row[];
  crossLinks: Link[];
  classes: Map<string, string>;
  rowOf: Map<string, number>;
}
interface MeasuredRow {
  width: number;
  height: number;
  boxes: Record<string, Box>;
  clusters: string[];
}
interface RoutedLink extends Link {
  points: { x: number; y: number }[];
  labelBox: Box;
}
interface Layout {
  width: number;
  height: number;
  links: RoutedLink[];
  crossings: number;
  problems: string[];
}
interface Theme {
  canvas: string;
  layers: Record<string, string>;
  stages: Record<string, string>;
}
interface ReadmeAssets {
  THEMES: { dark: Theme; light: Theme };
  parseDiagram(text: string): Diagram;
  rowSource(diagram: Diagram, rowIndex: number, theme: string): string;
  effectivePx(fontPx: number, svgWidth: number, displayWidth?: number): number;
  mix(color: string, base: string, alpha: number): string;
  escapeXml(text: string): string;
  rectsOverlap(a: Box, b: Box, gap?: number): boolean;
  segmentHitsRect(p: { x: number; y: number }, q: { x: number; y: number }, rect: Box): boolean;
  laneCrossings(spans: { a: number; b: number }[], order: number[]): number;
  bestLaneOrder(spans: { a: number; b: number }[]): { order: number[]; crossings: number };
  layout(diagram: Diagram, rows: MeasuredRow[], labelSize: (text: string) => { w: number; h: number }): Layout;
}

let m: ReadmeAssets;

function at<T>(items: readonly T[], i: number): T {
  const item = items[i];
  if (item === undefined) throw new Error(`no item ${i}`);
  return item;
}
beforeAll(async () => {
  m = (await import(pathToFileURL(SCRIPT).href)) as ReadmeAssets;
});

const SMALL = `flowchart TB
    subgraph ROW_A["Top"]
        direction LR
        subgraph G["Group"]
            A1["a one"]
            A2["a two"]
        end
        A1 --> A2
    end
    subgraph ROW_B["Bottom"]
        direction LR
        B1["b one"]
        B2["b two"]
        B1 --> B2
    end
    A2 -->|"down"| B1
    G <-->|"both ways"| B2
    class A1,A2 sources
    class B1 api
    class B2 ui
`;

describe("parseDiagram", () => {
  it("splits rows, nested clusters, links inside rows and labelled links between rows", () => {
    const d = m.parseDiagram(SMALL);
    expect(d.rows.map((r) => [r.id, r.title])).toEqual([
      ["ROW_A", "Top"],
      ["ROW_B", "Bottom"],
    ]);
    expect(at(d.rows, 0).nodes).toEqual(["A1", "A2"]);
    expect(at(d.rows, 0).clusters.G).toEqual({ title: "Group", members: ["A1", "A2"] });
    expect(at(d.rows, 0).links).toEqual([{ from: "A1", op: "-->", label: null, to: "A2" }]);
    expect(d.crossLinks).toEqual([
      { from: "A2", op: "-->", label: "down", to: "B1" },
      { from: "G", op: "<-->", label: "both ways", to: "B2" },
    ]);
    expect(d.rowOf.get("G")).toBe(0);
    expect(d.classes.get("B2")).toBe("ui");
  });

  it("refuses unlabelled, upward, unknown or row-leaving links and stray subgraphs", () => {
    expect(() => m.parseDiagram(SMALL.replace('-->|"down"| B1', "--> B1"))).toThrow(/without a label/);
    expect(() => m.parseDiagram(SMALL.replace('A2 -->|"down"| B1', 'B1 -->|"up"| A2'))).toThrow(/must run down/);
    expect(() => m.parseDiagram(SMALL.replace('-->|"down"| B1', '-->|"down"| ZZ'))).toThrow(/unknown node/);
    expect(() => m.parseDiagram(SMALL.replace("        A1 --> A2", "        A1 --> B2"))).toThrow(/leaves the row/);
    expect(() => m.parseDiagram(SMALL.replace('subgraph ROW_B["Bottom"]', 'subgraph OTHER["Bottom"]'))).toThrow(
      /is not a row/,
    );
    expect(() => m.parseDiagram(SMALL.replace(/\n {4}end\n {4}subgraph ROW_B/, "\n    subgraph ROW_B"))).toThrow(
      /unclosed subgraph/,
    );
  });

  it("reads the committed architecture source: three rows, every node classed and every link labelled", () => {
    const d = m.parseDiagram(readFileSync(SOURCE, "utf8"));
    expect(d.rows.map((r) => r.id)).toEqual(["ROW_DATA", "ROW_BATCH", "ROW_LIVE"]);
    for (const r of d.rows) for (const id of r.nodes) expect(m.THEMES.dark.layers[d.classes.get(id) ?? ""]).toBeDefined();
    const pairs = d.crossLinks.map((l) => `${l.from}>${l.to}`);
    for (const p of ["FEAT>MOD", "SC>SS", "LAKE>SIM", "SIM>API"]) expect(pairs).toContain(p);
    expect(d.crossLinks.every((l) => l.label)).toBe(true);
  });
});

describe("rowSource", () => {
  it("draws one row left to right with the theme's colour per class and dashed cluster borders", () => {
    const d = m.parseDiagram(SMALL);
    const src = m.rowSource(d, 0, "dark");
    expect(src.startsWith("flowchart LR\n")).toBe(true);
    expect(src).not.toContain("ROW_A");
    expect(src).toContain(`classDef sources fill:#151a20,stroke:${m.THEMES.dark.layers.sources}`);
    expect(src).toContain("class A1,A2 sources");
    expect(src).toMatch(/style G .*stroke-dasharray:5 4/);
    expect(m.rowSource(d, 1, "light")).toContain(`stroke:${m.THEMES.light.layers.api}`);
    expect(() => m.rowSource(d, 0, "sepia")).toThrow(/unknown theme/);
  });

  it("keeps the amber reserved for the dashboard's call (HSL hue 40-70) out of every layer and stage colour", () => {
    const hue = (hex: string): number => {
      const channel = (i: number): number => parseInt(hex.slice(i, i + 2), 16) / 255;
      const [r, g, b] = [channel(1), channel(3), channel(5)];
      const max = Math.max(r, g, b);
      const min = Math.min(r, g, b);
      if (max === min) return -1;
      const d = max - min;
      const h = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
      return (h * 60 + 360) % 360;
    };
    for (const theme of Object.values(m.THEMES))
      for (const c of [...Object.values(theme.layers), ...Object.values(theme.stages)]) {
        const h = hue(c);
        expect(h >= 40 && h <= 70, `${c} has hue ${h.toFixed(0)}`).toBe(false);
      }
  });
});

describe("helpers", () => {
  it("scales text to the display width", () => {
    expect(m.effectivePx(17, 1239)).toBeCloseTo((17 * 830) / 1239, 6);
    expect(m.effectivePx(16, 800, 800)).toBe(16);
    expect(() => m.effectivePx(16, 0)).toThrow(/invalid SVG width/);
  });

  it("mixes colours and escapes XML", () => {
    expect(m.mix("#ffffff", "#000000", 0.5)).toBe("#808080");
    expect(m.mix("#5cc8ff", "#0c0f12", 0)).toBe("#0c0f12");
    expect(m.escapeXml('a < b & "c" > d')).toBe("a &lt; b &amp; &quot;c&quot; &gt; d");
  });

  it("tests rectangles and segments against each other (touching is not overlapping)", () => {
    const r = { x: 10, y: 10, w: 10, h: 10 };
    expect(m.rectsOverlap(r, { x: 15, y: 15, w: 10, h: 10 })).toBe(true);
    expect(m.rectsOverlap(r, { x: 20, y: 10, w: 5, h: 5 })).toBe(false);
    expect(m.rectsOverlap(r, { x: 21, y: 10, w: 5, h: 5 }, 2)).toBe(true);
    expect(m.segmentHitsRect({ x: 0, y: 15 }, { x: 30, y: 15 }, r)).toBe(true);
    expect(m.segmentHitsRect({ x: 20, y: 0 }, { x: 20, y: 30 }, r)).toBe(false);
  });

  it("counts lane crossings and finds the order with the fewest", () => {
    // Link 0 enters at x=10 and leaves at x=50; link 1 enters at x=30 and leaves at x=0.
    const spans = [
      { a: 10, b: 50 },
      { a: 30, b: 0 },
    ];
    expect(m.laneCrossings(spans, [0, 1])).toBe(1);
    expect(m.laneCrossings(spans, [1, 0])).toBe(1);
    const parallel = [
      { a: 10, b: 40 },
      { a: 20, b: 60 },
    ];
    expect(m.bestLaneOrder(parallel).crossings).toBe(0);
    expect(m.bestLaneOrder(parallel).order).toEqual([1, 0]);
    expect(() => m.bestLaneOrder(Array.from({ length: 9 }, () => ({ a: 0, b: 1 })))).toThrow(/too many/);
  });
});

describe("layout", () => {
  const d = (): Diagram => m.parseDiagram(SMALL);
  const rows: MeasuredRow[] = [
    {
      width: 400,
      height: 100,
      boxes: { A1: { x: 20, y: 30, w: 80, h: 40 }, A2: { x: 200, y: 30, w: 80, h: 40 }, G: { x: 10, y: 10, w: 300, h: 80 } },
      clusters: ["G"],
    },
    { width: 300, height: 80, boxes: { B1: { x: 20, y: 20, w: 80, h: 40 }, B2: { x: 180, y: 20, w: 80, h: 40 } }, clusters: [] },
  ];
  const size = (text: string) => ({ w: text.length * 7, h: 14 });

  it("routes every link between rows down from its source to its target, with a clear label", () => {
    const geo = m.layout(d(), rows, size);
    expect(geo.problems).toEqual([]);
    for (const l of geo.links) {
      const first = at(l.points, 0);
      const last = at(l.points, l.points.length - 1);
      expect(last.y).toBeGreaterThan(first.y);
      for (let k = 1; k < l.points.length; k++) {
        const [p, q] = [at(l.points, k - 1), at(l.points, k)];
        expect(p.x === q.x || p.y === q.y).toBe(true); // orthogonal
      }
    }
    expect(m.rectsOverlap(at(geo.links, 0).labelBox, at(geo.links, 1).labelBox)).toBe(false);
    expect(geo.width).toBeGreaterThanOrEqual(400);
  });

  it("reports a label that cannot be placed clear of the nodes", () => {
    const bottom = at(rows, 1);
    const crowded: MeasuredRow[] = [at(rows, 0), { ...bottom, boxes: { ...bottom.boxes, X: { x: -100, y: -400, w: 2000, h: 800 } } }];
    expect(m.layout(d(), crowded, size).problems.length).toBeGreaterThan(0);
  });
});
