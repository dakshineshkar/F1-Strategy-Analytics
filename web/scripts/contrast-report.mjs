// Prints the WCAG contrast table of every text/ground and mark/ground pair of the Pit Wall theme, in both
// themes, as Markdown (pasted into docs/design/DESIGN.md). The colours come from src/lib/theme.ts, the
// single source; Node 26 imports the TypeScript module directly (type stripping).
//
//   node scripts/contrast-report.mjs            # the Markdown table
//   node scripts/contrast-report.mjs --check    # exit 1 if any pair is below its AA threshold
import { contrastRatio, dark, light } from "../src/lib/theme.ts";

const TEXT = ["text", "muted", "faint", "signalInk", "gain", "loss", "danger"];
const UI = ["border", "focus", "signalMark", "grid", "gain", "loss"];
const GROUNDS = ["bg", "surface", "surface2", "raised"];

function rows(t) {
  const out = [];
  for (const fg of TEXT) for (const bg of GROUNDS) out.push([`${fg}`, bg, t[fg], t[bg], 4.5]);
  for (const fg of ["text", "muted", "signalInk"]) out.push([fg, "signalWash", t[fg], t.signalWash, 4.5]);
  out.push(["signalOn", "signal", t.signalOn, t.signal, 4.5]);
  out.push(["faint (placeholder)", "surface2", t.faint, t.surface2, 4.5]);
  for (const fg of UI) for (const bg of GROUNDS) out.push([`${fg} (mark)`, bg, t[fg], t[bg], 3]);
  out.push(["signalMark (mark)", "signalWash", t.signalMark, t.signalWash, 3]);
  out.push(["focus (mark)", "signalWash", t.focus, t.signalWash, 3]);
  t.lines.forEach((c, i) => {
    for (const bg of ["bg", "surface", "surface2"]) out.push([`line-${i} (mark)`, bg, c, t[bg], 3]);
  });
  for (const [k, c] of Object.entries(t.compounds)) for (const bg of ["bg", "surface", "surface2"]) out.push([`compound ${k} (mark)`, bg, c, t[bg], 3]);
  return out.map(([fg, bg, a, b, min]) => ({ fg, bg, a, b, min, ratio: contrastRatio(a, b) }));
}

const check = process.argv.includes("--check");
let failed = 0;
for (const [name, t] of [["dark", dark], ["light", light]]) {
  const r = rows(t);
  const bad = r.filter((x) => x.ratio < x.min);
  failed += bad.length;
  if (check) continue;
  const min = (k) => Math.min(...r.filter((x) => x.min === k).map((x) => x.ratio));
  console.log(`\n### ${name[0].toUpperCase()}${name.slice(1)} theme: ${r.length} pairs, ${r.length - bad.length} pass, ${bad.length} fail`);
  console.log(`Lowest text pair ${min(4.5).toFixed(2)}:1 (needs 4.5), lowest mark pair ${min(3).toFixed(2)}:1 (needs 3).\n`);
  console.log("| Foreground | Ground | Colours | Ratio | Needs | AA |");
  console.log("|---|---|---|---|---|---|");
  for (const x of r) console.log(`| ${x.fg} | ${x.bg} | \`${x.a}\` on \`${x.b}\` | ${x.ratio.toFixed(2)} | ${x.min} | ${x.ratio >= x.min ? "pass" : "**FAIL**"} |`);
}
if (check) console.log(failed ? `${failed} pair(s) below AA` : "all pairs meet AA");
process.exit(failed ? 1 : 0);
