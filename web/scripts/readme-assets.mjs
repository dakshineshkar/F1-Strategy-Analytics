// Renders the README's architecture diagram (docs/assets/architecture.mmd) for `make readme-assets`:
// architecture-dark.svg / -light.svg and the PNG versions at 2x, a static image GitHub shows without the zoom
// controls it adds to a mermaid block. mermaid draws each row inside Playwright's Chromium (the devDependencies
// that render the report). This script stacks the rows on tinted bands and draws the labelled links between rows
// itself. mermaid cannot keep the rows left to right once their nodes link outside them: it drops a subgraph's
// direction as soon as one of its nodes links outside it.
//
//   node scripts/readme-assets.mjs <in.mmd> <outDir>
//
// Guards (exit 1): text smaller than 11 px when the image is shown 830 px wide (GitHub's content width), a link
// inside a row that does not run left to right, a label that overlaps a node or another label, or a link between
// rows that crosses a node or a label.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..");
const FONTS = path.join(WEB, "src", "fonts", "barlow-semi-condensed");
const MERMAID = path.join(WEB, "node_modules", "mermaid", "dist", "mermaid.min.js");

export const DISPLAY_WIDTH = 830;
export const MIN_TEXT_PX = 11;
const FONT_FAMILY = "Barlow Semi Condensed";
const NODE_FONT_PX = 18;
const LABEL_FONT_PX = 17;
const BAND_FONT_PX = 18;

// Layout of the composed image, in px of the SVG.
const PAD = 16; // canvas edge to band
const BAND_PAD_X = 18; // band edge to row
const BAND_TITLE_H = 34; // band top to row top (holds the stage name)
const BAND_PAD_BOTTOM = 14;
const LANE = 30; // distance between two horizontal lanes in a gutter
const GUTTER_PAD = 22; // band edge to the first lane
const LABEL_STRIP = 36; // below the last lane of a gutter: room for a label on a link's last leg
const CORRIDOR_GAP = 36; // right edge of the widest row a skip link passes to its first corridor
const CORRIDOR_STEP = 22;
const LABEL_PAD_X = 10;
const LABEL_PAD_Y = 3;

/** Colours of each theme. Layer hues avoid the amber reserved for the dashboard's call (hue 60-100). */
export const THEMES = {
  dark: {
    canvas: "#0c0f12",
    card: "#151a20",
    text: "#ebedf0",
    muted: "#b5bbc2",
    line: "#9fa5ad",
    layers: {
      sources: "#5cc8ff",
      storage: "#6f9dff",
      batch: "#3ddc97",
      ml: "#b48cff",
      streaming: "#ff9a52",
      serving: "#ff6b6b",
      api: "#2fd6c8",
      ui: "#e6e9ee",
      sim: "#f37fd8",
    },
    stages: { ROW_DATA: "#5cc8ff", ROW_BATCH: "#3ddc97", ROW_LIVE: "#ff9a52" },
    bandAlpha: 0.075,
    bandStrokeAlpha: 0.38,
  },
  light: {
    canvas: "#f6f7f9",
    card: "#ffffff",
    text: "#171b20",
    muted: "#484e55",
    line: "#585e66",
    layers: {
      sources: "#0a6fae",
      storage: "#2453c4",
      batch: "#11804f",
      ml: "#6a3fd0",
      streaming: "#b8460d",
      serving: "#c0263a",
      api: "#0b7f77",
      ui: "#3d4651",
      sim: "#a62b8d",
    },
    stages: { ROW_DATA: "#0a6fae", ROW_BATCH: "#11804f", ROW_LIVE: "#b8460d" },
    bandAlpha: 0.06,
    bandStrokeAlpha: 0.3,
  },
};

export function escapeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** `color` mixed over `base` with `alpha` (both #rrggbb), as #rrggbb. */
export function mix(color, base, alpha) {
  const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [a, b] = [rgb(color), rgb(base)];
  return `#${a.map((v, i) => Math.round(v * alpha + b[i] * (1 - alpha)).toString(16).padStart(2, "0")).join("")}`;
}

/** Size in px that text of `fontPx` in an SVG `svgWidth` wide has when shown `displayWidth` wide. */
export function effectivePx(fontPx, svgWidth, displayWidth = DISPLAY_WIDTH) {
  if (!(svgWidth > 0)) throw new Error(`invalid SVG width: ${svgWidth}`);
  return (fontPx * displayWidth) / svgWidth;
}

const DEF = /^([A-Za-z_]\w*)\s*(?:\[\[|\[\(|\(\[|\(\(|\[|\(|\{)/;
const LINK = /^([A-Za-z_]\w*)\s*(<-->|-->|-\.->|~~~)\s*(?:\|"([^"]*)"\|\s*)?([A-Za-z_]\w*)$/;
const SUBGRAPH = /^subgraph\s+([A-Za-z_]\w*)(?:\["([^"]*)"\])?$/;
const CLASS = /^class\s+([\w,]+)\s+(\w+)$/;

/**
 * The diagram's rows (`subgraph ROW_*` at the top level), the links between rows and the class assignments.
 * Each row has its id, title, the lines inside it, its node and cluster ids, its links and each cluster's members.
 */
export function parseDiagram(text) {
  const rows = [];
  const crossLinks = [];
  const classes = new Map();
  let row = null;
  let depth = 0;
  const stack = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("%%") || /^flowchart\b/.test(line)) continue;
    const sub = SUBGRAPH.exec(line);
    if (sub) {
      if (depth === 0) {
        if (!sub[1].startsWith("ROW_")) throw new Error(`top-level subgraph ${sub[1]} is not a row (ROW_*)`);
        row = { id: sub[1], title: sub[2] ?? sub[1], lines: [], nodes: [], clusters: {}, links: [] };
        rows.push(row);
      } else {
        row.lines.push(line);
        row.clusters[sub[1]] = { title: sub[2] ?? sub[1], members: [] };
        stack.push(sub[1]);
      }
      depth += 1;
      continue;
    }
    if (line === "end") {
      if (depth === 0) throw new Error("unbalanced `end`");
      depth -= 1;
      if (depth === 0) row = null;
      else {
        row.lines.push(line);
        stack.pop();
      }
      continue;
    }
    const cls = CLASS.exec(line);
    if (cls) {
      for (const id of cls[1].split(",")) classes.set(id, cls[2]);
      continue;
    }
    const link = LINK.exec(line);
    if (depth === 0) {
      if (!link) throw new Error(`unexpected line outside the rows: ${line}`);
      if (!link[3]) throw new Error(`link between rows without a label: ${line}`);
      crossLinks.push({ from: link[1], op: link[2], label: link[3], to: link[4] });
      continue;
    }
    if (line.startsWith("direction")) continue;
    row.lines.push(line);
    if (link) {
      row.links.push({ from: link[1], op: link[2], label: link[3] ?? null, to: link[4] });
      continue;
    }
    const def = DEF.exec(line);
    if (!def) throw new Error(`cannot read line: ${line}`);
    row.nodes.push(def[1]);
    for (const c of stack) row.clusters[c].members.push(def[1]);
  }
  if (depth !== 0) throw new Error("unclosed subgraph");
  if (rows.length === 0) throw new Error("no ROW_* subgraph");
  const rowOf = new Map();
  rows.forEach((r, i) => {
    for (const id of [...r.nodes, ...Object.keys(r.clusters)]) rowOf.set(id, i);
  });
  for (const l of crossLinks) {
    for (const end of [l.from, l.to]) if (!rowOf.has(end)) throw new Error(`unknown node in link: ${end}`);
    if (rowOf.get(l.from) >= rowOf.get(l.to)) throw new Error(`a link between rows must run down: ${l.from} -> ${l.to}`);
  }
  for (const r of rows)
    for (const l of r.links)
      for (const end of [l.from, l.to])
        if (rowOf.get(end) !== rows.indexOf(r)) throw new Error(`link in ${r.id} leaves the row: ${l.from} -> ${l.to}`);
  return { rows, crossLinks, classes, rowOf };
}

/** The mermaid source of one row in one theme: the row's lines, its classes and the theme's class colours. */
export function rowSource(diagram, rowIndex, theme) {
  const row = diagram.rows[rowIndex];
  const t = THEMES[theme];
  if (!t) throw new Error(`unknown theme: ${theme}`);
  const out = ["flowchart LR", ...row.lines.map((l) => `    ${l}`)];
  const byClass = new Map();
  for (const id of row.nodes) {
    const cls = diagram.classes.get(id);
    if (!cls) throw new Error(`node ${id} has no class`);
    if (!t.layers[cls]) throw new Error(`class ${cls} has no colour`);
    byClass.set(cls, [...(byClass.get(cls) ?? []), id]);
  }
  for (const [cls, ids] of byClass) {
    out.push(`    classDef ${cls} fill:${t.card},stroke:${t.layers[cls]},stroke-width:2px,color:${t.text}`);
    out.push(`    class ${ids.join(",")} ${cls}`);
  }
  for (const [id, cluster] of Object.entries(row.clusters)) {
    const hue = t.layers[diagram.classes.get(cluster.members[0]) ?? ""] ?? t.line;
    out.push(`    style ${id} fill:${t.canvas},fill-opacity:0,stroke:${hue},stroke-width:1.5px,stroke-dasharray:5 4`);
  }
  return `${out.join("\n")}\n`;
}

export function rectsOverlap(a, b, gap = 0) {
  return a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap;
}

/** Whether the axis-aligned segment [p, q] passes through the inside of `rect` (touching its edge is not). */
export function segmentHitsRect(p, q, rect) {
  const [x0, x1] = [Math.min(p.x, q.x), Math.max(p.x, q.x)];
  const [y0, y1] = [Math.min(p.y, q.y), Math.max(p.y, q.y)];
  return x0 < rect.x + rect.w && x1 > rect.x && y0 < rect.y + rect.h && y1 > rect.y;
}

/**
 * Crossings in one gutter. `spans[i] = {a, b}`: link i comes down into the gutter at x = a, runs along its lane
 * and leaves downwards at x = b. `order[i]` is its lane (0 = top). A link's lower leg crosses every lane below it
 * whose span contains its x, and its upper leg every lane above it whose span contains its x.
 */
export function laneCrossings(spans, order) {
  let n = 0;
  const inside = (x, s) => x > Math.min(s.a, s.b) && x < Math.max(s.a, s.b);
  for (let i = 0; i < spans.length; i++)
    for (let j = 0; j < spans.length; j++) {
      if (i === j || order[i] >= order[j]) continue; // i above j
      if (inside(spans[i].b, spans[j])) n += 1; // i's lower leg through j's lane
      if (inside(spans[j].a, spans[i])) n += 1; // j's upper leg through i's lane
    }
  return n;
}

function permutations(n) {
  if (n === 0) return [[]];
  const out = [];
  for (const p of permutations(n - 1))
    for (let i = 0; i <= p.length; i++) out.push([...p.slice(0, i), n - 1, ...p.slice(i)]);
  return out;
}

/** The lane of each span with the fewest crossings (ties: the first found, top to bottom by source x). */
export function bestLaneOrder(spans) {
  if (spans.length > 8) throw new Error("too many links in one gutter");
  let best = null;
  for (const order of permutations(spans.length)) {
    const c = laneCrossings(spans, order);
    if (!best || c < best.crossings) best = { order, crossings: c };
  }
  return best;
}

function spread(rect, count, index) {
  return rect.x + (rect.w * (index + 1)) / (count + 1);
}

/**
 * Lays out the measured rows on bands and routes the links between rows.
 * `rows[i] = {width, height, boxes: {id: {x, y, w, h}}}` (boxes of nodes and clusters, in the row's own pixels);
 * `labelSize(text) -> {w, h}`. Returns the canvas size, each row's origin, the bands, the routed links with their
 * label boxes, and every overlap found (an empty list when the drawing is clean).
 */
export function layout(diagram, rows, labelSize) {
  const n = rows.length;
  const rowX = PAD + BAND_PAD_X;
  const links = diagram.crossLinks.map((l) => ({
    ...l,
    r0: diagram.rowOf.get(l.from),
    r1: diagram.rowOf.get(l.to),
    size: labelSize(l.label),
  }));
  // One gutter between rows g and g+1 carries every link with r0 <= g < r1.
  const gutterLinks = Array.from({ length: n - 1 }, (_, g) => links.filter((l) => l.r0 <= g && g < l.r1));
  const skips = links.filter((l) => l.r1 - l.r0 > 1);
  // Corridors: right of the widest row a skip link passes through.
  const corridorBase = (l) => {
    let right = 0;
    for (let r = l.r0 + 1; r < l.r1; r++) right = Math.max(right, rowX + rows[r].width);
    return right + CORRIDOR_GAP;
  };
  const maxRowWidth = Math.max(...rows.map((r) => r.width));
  const baseX = skips.length ? Math.max(...skips.map(corridorBase)) : 0;

  // Vertical placement: bands and gutters (the gutter height depends on its lane count).
  const origins = [];
  const bands = [];
  const gutters = [];
  let y = PAD;
  for (let i = 0; i < n; i++) {
    const top = y;
    origins.push({ x: rowX, y: top + BAND_TITLE_H });
    y = top + BAND_TITLE_H + rows[i].height + BAND_PAD_BOTTOM;
    bands.push({ y: top, h: y - top });
    if (i < n - 1) {
      const lanes = Math.max(1, gutterLinks[i].length);
      const h = GUTTER_PAD * 2 + (lanes - 1) * LANE + LABEL_STRIP;
      gutters.push({ top: y, bottom: y + h });
      y += h;
    }
  }
  const height = y + PAD;

  const abs = (i, id) => {
    const b = rows[i].boxes[id];
    if (!b) throw new Error(`no box for ${id} in row ${i}`);
    return { x: origins[i].x + b.x, y: origins[i].y + b.y, w: b.w, h: b.h };
  };
  for (const l of links) {
    l.src = abs(l.r0, l.from);
    l.dst = abs(l.r1, l.to);
  }

  // Endpoints: links leaving one box (or arriving at one) share its edge, ordered by the other end's x.
  const centre = (r) => r.x + r.w / 2;
  const assignEnds = (key, box, other) => {
    const groups = new Map();
    for (const l of links) groups.set(l[key], [...(groups.get(l[key]) ?? []), l]);
    for (const group of groups.values()) {
      group.sort((p, q) => centre(p[other]) - centre(q[other]));
      group.forEach((l, i) => (l[box] = spread(l[key === "from" ? "src" : "dst"], group.length, i)));
    }
  };
  assignEnds("from", "sx", "dst");
  assignEnds("to", "tx", "src");

  // Try every order of corridors for the skip links; in each gutter take the lane order with fewest crossings.
  let best = null;
  for (const perm of permutations(skips.length)) {
    skips.forEach((l, i) => (l.cx = baseX + perm[i] * CORRIDOR_STEP));
    let crossings = 0;
    let length = 0;
    const orders = gutterLinks.map((gl, g) => {
      const spans = gl.map((l) => ({
        a: g === l.r0 ? l.sx : l.cx,
        b: g === l.r1 - 1 ? l.tx : l.cx,
      }));
      const lane = bestLaneOrder(spans);
      crossings += lane.crossings;
      length += spans.reduce((s, sp) => s + Math.abs(sp.a - sp.b), 0);
      return lane.order;
    });
    if (!best || crossings < best.crossings || (crossings === best.crossings && length < best.length))
      best = { perm, orders, crossings, length };
  }
  skips.forEach((l, i) => (l.cx = baseX + best.perm[i] * CORRIDOR_STEP));
  const laneY = (g, l) => gutters[g].top + GUTTER_PAD + best.orders[g][gutterLinks[g].indexOf(l)] * LANE;

  const width = Math.max(rowX + maxRowWidth + BAND_PAD_X + PAD, skips.length ? baseX + (skips.length - 1) * CORRIDOR_STEP + BAND_PAD_X + PAD : 0);

  // Paths.
  for (const l of links) {
    const pts = [{ x: l.sx, y: l.src.y + l.src.h }];
    for (let g = l.r0; g < l.r1; g++) {
      const ly = laneY(g, l);
      const x = g === l.r1 - 1 ? l.tx : l.cx;
      pts.push({ x: pts[pts.length - 1].x, y: ly }, { x, y: ly });
    }
    pts.push({ x: l.tx, y: l.dst.y });
    l.points = pts.filter((p, i) => i === 0 || p.x !== pts[i - 1].x || p.y !== pts[i - 1].y);
  }

  const nodes = [];
  rows.forEach((r, i) => {
    for (const id of Object.keys(r.boxes)) if (!r.clusters?.includes(id)) nodes.push({ id, ...abs(i, id) });
  });
  const segments = links.flatMap((l) => l.points.slice(1).map((q, k) => ({ link: l, p: l.points[k], q })));

  // Labels: on one of the link's lanes, at the first spot that is clear of nodes, other links and placed labels
  // (the lane nearest the target first, from the middle of the lane outwards).
  for (const l of links) {
    const w = l.size.w + LABEL_PAD_X * 2;
    const h = l.size.h + LABEL_PAD_Y * 2;
    const candidates = [];
    for (let g = l.r1 - 1; g >= l.r0; g--) {
      const ly = laneY(g, l);
      const a = g === l.r0 ? l.sx : l.cx;
      const b = g === l.r1 - 1 ? l.tx : l.cx;
      const [lo, hi] = [Math.min(a, b), Math.max(a, b)];
      for (const f of [0.5, 0.35, 0.65, 0.2, 0.8, 0.08, 0.92]) {
        const cx = lo + (hi - lo) * f;
        if (cx - w / 2 >= lo - 1 && cx + w / 2 <= hi + 1) candidates.push({ x: cx - w / 2, y: ly - h / 2, w, h });
      }
    }
    // In the gutter's label strip, on the last leg (over the link itself), then beside it.
    const strip = gutters[l.r1 - 1].bottom - LABEL_STRIP / 2 - GUTTER_PAD / 2 - h / 2;
    for (const dx of [-w / 2, 5, -5 - w]) candidates.push({ x: l.tx + dx, y: strip, w, h });
    const clear = (box) =>
      box.x >= PAD &&
      box.x + box.w <= width - PAD &&
      !nodes.some((nb) => rectsOverlap(box, nb, 2)) &&
      !segments.some((s) => s.link !== l && segmentHitsRect(s.p, s.q, box)) &&
      !links.some((m) => m !== l && m.labelBox && rectsOverlap(box, m.labelBox, 3));
    l.labelBox = candidates.find(clear) ?? candidates[0];
  }

  // Overlaps that remain: labels against nodes and labels, link segments against nodes (not their own ends)
  // and labels.
  const problems = [];
  for (const l of links) {
    for (const nb of nodes) if (rectsOverlap(l.labelBox, nb, 2)) problems.push(`label "${l.label}" overlaps ${nb.id}`);
    for (const m of links)
      if (m !== l && links.indexOf(m) > links.indexOf(l) && rectsOverlap(l.labelBox, m.labelBox, 2))
        problems.push(`labels "${l.label}" and "${m.label}" overlap`);
    for (let k = 1; k < l.points.length; k++) {
      const [p, q] = [l.points[k - 1], l.points[k]];
      for (const nb of nodes)
        if (nb.id !== l.from && nb.id !== l.to && segmentHitsRect(p, q, nb))
          problems.push(`link ${l.from} -> ${l.to} crosses ${nb.id}`);
      for (const m of links)
        if (m !== l && segmentHitsRect(p, q, m.labelBox)) problems.push(`link ${l.from} -> ${l.to} runs under the label "${m.label}"`);
    }
  }
  return { width, height, origins, bands, links, crossings: best.crossings, problems };
}

function fontFace(weight) {
  const file = path.join(FONTS, `barlow-semi-condensed-latin-${weight}-normal.woff2`);
  const b64 = readFileSync(file).toString("base64");
  return `@font-face{font-family:"${FONT_FAMILY}";src:url(data:font/woff2;base64,${b64}) format("woff2");font-weight:${weight};font-style:normal}`;
}

/** The composed SVG: canvas, bands with stage names, the mermaid rows, then the links between rows on top. */
export function composeSvg(diagram, rowSvgs, geo, theme, fonts) {
  const t = THEMES[theme];
  const W = Math.ceil(geo.width);
  const H = Math.ceil(geo.height);
  const out = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="arch-title arch-desc">`,
    `<title id="arch-title">F1 Strategy Analytics architecture</title>`,
    `<desc id="arch-desc">Three stages. Data in: Jolpica-F1, TracingInsights and optional FastF1 are ingested by rate-limited clients through HttpFS into an HDFS lake (raw, clean, features, archive). Batch: Spark builds clean and feature tables; MLlib trains LR and GBT with Platt calibration; the calibrated LR is deployed as a scorer. Live: one race is replayed through Kafka into Spark Structured Streaming, which writes Redis; FastAPI serves state, SSE, replay control, the what-if simulator and the archive to the Next.js dashboard.</desc>`,
    `<defs><style>${fonts}`,
    `.band-title{font-family:"${FONT_FAMILY}",sans-serif;font-weight:700;font-size:${BAND_FONT_PX}px}`,
    `.xlabel{font-family:"${FONT_FAMILY}",sans-serif;font-weight:600;font-size:${LABEL_FONT_PX}px;fill:${t.text};text-rendering:geometricPrecision}`,
    `</style>`,
    `<marker id="xarrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${t.line}"/></marker>`,
    `</defs>`,
    `<rect width="${W}" height="${H}" fill="${t.canvas}"/>`,
  );
  diagram.rows.forEach((row, i) => {
    const hue = t.stages[row.id] ?? t.line;
    const b = geo.bands[i];
    out.push(
      `<rect x="${PAD}" y="${b.y}" width="${W - 2 * PAD}" height="${b.h}" rx="10" fill="${mix(hue, t.canvas, t.bandAlpha)}" stroke="${mix(hue, t.canvas, t.bandStrokeAlpha)}" stroke-width="1"/>`,
      `<text class="band-title" x="${PAD + BAND_PAD_X}" y="${b.y + 24}" fill="${hue}">${escapeXml(row.title)}</text>`,
    );
  });
  diagram.rows.forEach((_, i) => {
    const o = geo.origins[i];
    out.push(rowSvgs[i].replace(/^<svg\b/, `<svg x="${o.x}" y="${o.y}"`));
  });
  for (const l of geo.links) {
    const d = l.points.map((p, k) => `${k ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ");
    const start = l.op === "<-->" ? ` marker-start="url(#xarrow)"` : "";
    const dash = l.op === "-.->" ? ` stroke-dasharray="5 4"` : "";
    out.push(`<path d="${d}" fill="none" stroke="${t.line}" stroke-width="1.6"${dash}${start} marker-end="url(#xarrow)"/>`);
  }
  for (const l of geo.links) {
    const b = l.labelBox;
    out.push(
      `<rect x="${b.x.toFixed(1)}" y="${b.y.toFixed(1)}" width="${b.w.toFixed(1)}" height="${b.h.toFixed(1)}" rx="4" fill="${t.canvas}" stroke="${mix(t.line, t.canvas, 0.45)}" stroke-width="1"/>`,
      // textLength pins the label to its measured width: scaled down (GitHub, the report PDF), hinting would
      // otherwise widen the glyphs past the box.
      `<text class="xlabel" x="${(b.x + b.w / 2).toFixed(1)}" y="${(b.y + b.h / 2).toFixed(1)}" text-anchor="middle" dominant-baseline="central"${l.size ? ` textLength="${l.size.w.toFixed(1)}" lengthAdjust="spacingAndGlyphs"` : ""}>${escapeXml(l.label)}</text>`,
    );
  }
  out.push(`</svg>`);
  return `${out.join("\n")}\n`;
}

function mermaidConfig(theme) {
  const t = THEMES[theme];
  return {
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    look: "classic",
    htmlLabels: false,
    fontFamily: `"${FONT_FAMILY}", sans-serif`,
    themeVariables: {
      darkMode: theme === "dark",
      background: t.canvas,
      fontFamily: `"${FONT_FAMILY}", sans-serif`,
      fontSize: `${NODE_FONT_PX}px`,
      primaryColor: t.card,
      primaryTextColor: t.text,
      primaryBorderColor: t.line,
      lineColor: t.line,
      textColor: t.text,
      titleColor: t.muted,
      clusterBkg: "transparent",
      clusterBorder: t.line,
      edgeLabelBackground: t.canvas,
    },
    flowchart: { htmlLabels: false, wrappingWidth: 600, nodeSpacing: 22, rankSpacing: 36, padding: 10, diagramPadding: 6, curve: "basis" },
  };
}

/** Render, measure and compose one theme in the page. Returns the SVG and what the guards found. */
async function renderTheme(page, diagram, theme, fonts) {
  const rows = [];
  const rowSvgs = [];
  for (let i = 0; i < diagram.rows.length; i++) {
    const id = `arch-${theme}-${i}`;
    const res = await page.evaluate(
      async ({ id, src, config, clusters }) => {
        const m = /** @type {any} */ (window).mermaid;
        m.initialize(config);
        const { svg } = await m.render(id, src);
        const host = document.createElement("div");
        host.innerHTML = svg;
        document.body.appendChild(host);
        const el = host.querySelector("svg");
        const vb = el.viewBox.baseVal;
        el.removeAttribute("style");
        el.setAttribute("width", String(vb.width));
        el.setAttribute("height", String(vb.height));
        const origin = el.getBoundingClientRect();
        const boxes = {};
        const box = (node) => {
          const r = node.getBoundingClientRect();
          return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height };
        };
        for (const node of el.querySelectorAll("g.node")) {
          const m2 = new RegExp(`^${id}-flowchart-(.+)-\\d+$`).exec(node.id);
          const shape = node.querySelector("rect, path, polygon, circle");
          if (m2) boxes[m2[1]] = box(shape ?? node);
        }
        for (const c of clusters) {
          const g = el.querySelector(`g.cluster[id="${id}-${c}"] rect`);
          if (g) boxes[c] = box(g);
        }
        const out = { svg: new XMLSerializer().serializeToString(el), width: vb.width, height: vb.height, boxes };
        host.remove();
        return out;
      },
      { id, src: rowSource(diagram, i, theme), config: mermaidConfig(theme), clusters: Object.keys(diagram.rows[i].clusters) },
    );
    rows.push({ width: res.width, height: res.height, boxes: res.boxes, clusters: Object.keys(diagram.rows[i].clusters) });
    rowSvgs.push(res.svg);
  }
  const labels = diagram.crossLinks.map((l) => l.label);
  const sizes = await page.evaluate(
    ({ labels, family, px }) => {
      const ns = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(ns, "svg");
      document.body.appendChild(svg);
      const out = {};
      for (const text of labels) {
        const t = document.createElementNS(ns, "text");
        t.setAttribute("style", `font-family:"${family}";font-weight:600;font-size:${px}px`);
        t.textContent = text;
        svg.appendChild(t);
        const b = t.getBBox();
        out[text] = { w: b.width, h: b.height };
      }
      svg.remove();
      return out;
    },
    { labels, family: FONT_FAMILY, px: LABEL_FONT_PX },
  );
  const geo = layout(diagram, rows, (text) => sizes[text]);
  const problems = [...geo.problems];
  // Every solid link inside a row runs left to right (node to node, node to cluster or cluster to cluster).
  diagram.rows.forEach((row, i) => {
    for (const l of row.links) {
      if (l.op !== "-->") continue;
      const a = rows[i].boxes[l.from];
      const b = rows[i].boxes[l.to];
      if (!a || !b) problems.push(`no box for ${l.from} or ${l.to}`);
      else if (b.x + b.w / 2 <= a.x + a.w / 2) problems.push(`${row.id}: ${l.from} -> ${l.to} does not run left to right`);
    }
  });
  const svg = composeSvg(diagram, rowSvgs, geo, theme, fonts);
  return { svg, geo, problems };
}

async function main(argv) {
  const [input, outDir] = argv;
  if (!input || !outDir) throw new Error("usage: readme-assets.mjs <in.mmd> <outDir>");
  const diagram = parseDiagram(readFileSync(input, "utf8"));
  const fonts = [fontFace(600), fontFace(700)].join("");
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  let failed = false;
  try {
    for (const theme of Object.keys(THEMES)) {
      const page = await browser.newPage({ deviceScaleFactor: 2, viewport: { width: 2400, height: 1800 } });
      try {
        await page.setContent(`<!doctype html><html><head><style>${fonts} body{margin:0}</style></head><body></body></html>`);
        await page.evaluate(async (family) => {
          await document.fonts.load(`600 16px "${family}"`);
          await document.fonts.load(`700 16px "${family}"`);
        }, FONT_FAMILY);
        await page.addScriptTag({ path: MERMAID });
        const { svg, geo, problems } = await renderTheme(page, diagram, theme, fonts);
        const svgPath = path.join(outDir, `architecture-${theme}.svg`);
        const pngPath = path.join(outDir, `architecture-${theme}.png`);
        writeFileSync(svgPath, svg);
        await page.setContent(`<!doctype html><html><body style="margin:0">${svg}</body></html>`);
        await page.evaluate(() => document.fonts.ready);
        const minFont = await page.evaluate(() =>
          Math.min(...Array.from(document.querySelectorAll("svg text")).filter((t) => (t.textContent ?? "").trim()).map((t) => parseFloat(getComputedStyle(t).fontSize))),
        );
        const px = effectivePx(minFont, geo.width);
        if (px < MIN_TEXT_PX) problems.push(`smallest text ${minFont}px is ${px.toFixed(1)}px at ${DISPLAY_WIDTH}px wide (< ${MIN_TEXT_PX})`);
        await page.locator("body > svg").screenshot({ path: pngPath, omitBackground: false });
        const kb = (Buffer.byteLength(svg) / 1024).toFixed(1);
        console.log(
          `wrote ${svgPath} (${Math.ceil(geo.width)} x ${Math.ceil(geo.height)}, ${kb} KiB) and ${pngPath} (2x); ` +
            `smallest text ${minFont}px = ${px.toFixed(1)}px at ${DISPLAY_WIDTH}px; lane crossings ${geo.crossings}`,
        );
        for (const p of problems) console.error(`  ${theme}: ${p}`);
        if (problems.length) failed = true;
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  if (failed) throw new Error("the diagram failed its guards (see above)");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`readme-assets: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
