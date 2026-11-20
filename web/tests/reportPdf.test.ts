// Step 18a: the report renderer (scripts/report-pdf.mjs) in its browser-free --html mode.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(HERE, "..", "scripts", "report-pdf.mjs");
const FIXTURE = path.join(HERE, "fixtures", "report", "report.md");

function render(): string {
  const out = path.join(mkdtempSync(path.join(tmpdir(), "report-html-")), "report.html");
  execFileSync(process.execPath, [SCRIPT, "--html", FIXTURE, out], { stdio: "pipe" });
  return readFileSync(out, "utf8");
}

describe("report-pdf --html", () => {
  const html = render();

  it("gives headings GitHub-style ids, deduplicated, and a linked table of contents", () => {
    expect(html).toContain('<h2 id="1-intro-code">1. Intro <code>code</code></h2>');
    expect(html).toContain('<h2 id="1-intro-code-1">');
    expect(html).toContain('<h3 id="11-sub-part-with-punctuation">');
    expect(html).toContain('<nav class="toc">');
    expect(html).toContain('<a href="#1-intro-code">');
    expect(html).toContain('<a href="#1-intro-code-1">');
    expect(html).toContain('<a href="#11-sub-part-with-punctuation">');
    expect(html).not.toContain("<!-- toc -->");
  });

  it("keeps mermaid source escaped for the browser and never emits a script tag", () => {
    expect(html).toContain('<pre class="mermaid">flowchart LR\n    A[&lt;script&gt;alert(1)&lt;/script&gt;] --&gt; B</pre>');
    expect(html).not.toContain("<script");
    expect(html).toContain('<pre><code class="language-python">x = 1 &lt; 2</code></pre>');
  });

  it("turns an image paragraph into a captioned figure resolved from the report's folder", () => {
    expect(html).toContain('<figure><img src="img.png" alt="Figure 1. A caption &amp; more">');
    expect(html).toContain("<figcaption>Figure 1. A caption &amp; more</figcaption>");
    expect(html).toContain(`<base href="${pathToFileURL(path.dirname(FIXTURE) + path.sep).href}">`);
  });

  it("starts the appendices on a new page and titles the document from its H1", () => {
    expect(html).toContain('<div class="appendices"></div>');
    expect(html).toContain("<title>Fixture Report &amp; Co</title>");
    expect(html).toContain("@page { size: A4;");
  });
});

describe("report-pdf --style course (docs/report/final_report.pdf)", () => {
  function renderCourse(): string {
    const out = path.join(mkdtempSync(path.join(tmpdir(), "report-html-")), "course.html");
    execFileSync(process.execPath, [SCRIPT, "--html", "--style", "course", FIXTURE, out], { stdio: "pipe" });
    return readFileSync(out, "utf8");
  }
  const html = renderCourse();

  it("sets A4, 2.5 cm margins, a 10 pt Times New Roman / Liberation Serif body and 9 pt tables", () => {
    expect(html).toContain("@page { size: A4; margin: 25mm; }");
    expect(html).toContain('body { font-family: "Times New Roman", "Liberation Serif", serif; font-size: 10pt;');
    expect(html).toContain('h1, h2, h3, h4 { font-family: "Times New Roman", "Liberation Serif", serif;');
    expect(html).toContain('code { font-family: "Courier New", "Liberation Mono", monospace;');
    expect(html).toMatch(/table \{[^}]*font-size: 9pt;/);
    expect(html).toContain("td code { font-size: 7.5pt; white-space: nowrap; }");
    expect(html).not.toContain("Barlow");
  });

  it("embeds the Liberation fonts from the files shipped next to the script", () => {
    for (const file of ["LiberationSerif-Regular.ttf", "LiberationSerif-Bold.ttf", "LiberationMono-Regular.ttf"]) {
      const url = pathToFileURL(path.join(HERE, "..", "scripts", "fonts", "liberation", file)).href;
      expect(html).toContain(`src:url("${url}") format("truetype")`);
      expect(statSync(fileURLToPath(url)).size).toBeGreaterThan(100_000);
    }
  });

  it("keeps the same Markdown handling: captioned figures and heading ids", () => {
    expect(html).toContain('<figure><img src="img.png" alt="Figure 1. A caption &amp; more">');
    expect(html).toContain('<h2 id="1-intro-code">');
  });

  it("leaves the default style unchanged", () => {
    expect(render()).toContain("@page { size: A4; margin: 14mm 14mm 16mm 14mm; }");
  });
});

describe("report-pdf styles and arguments", async () => {
  const mod = await import(pathToFileURL(SCRIPT).href);

  it("prints the course style with 25 mm margins on every side and page numbers only", () => {
    expect(mod.STYLES.course.margin).toEqual({ top: "25mm", right: "25mm", bottom: "25mm", left: "25mm" });
    const footer = mod.STYLES.course.footer("Title");
    expect(footer).toContain('class="pageNumber"');
    expect(footer).not.toContain("Title");
    expect(mod.STYLES.report.footer("Title")).toContain("Title");
    expect(mod.STYLES.course.cssPageSize).toBe(true);
    expect(mod.STYLES.report.cssPageSize).toBe(false);
  });

  it("parses flags in any order and rejects an unknown style or a missing file", () => {
    expect(mod.parseArgs(["--style", "course", "a.md", "b.pdf"])).toEqual({
      html: false,
      style: "course",
      files: ["a.md", "b.pdf"],
    });
    expect(mod.parseArgs(["--html", "a.md", "b.html"])).toEqual({ html: true, style: "report", files: ["a.md", "b.html"] });
    expect(() => mod.parseArgs(["--style", "poster", "a.md", "b.pdf"])).toThrow(/unknown style "poster"/);
    expect(() => mod.parseArgs(["--style"])).toThrow(/--style needs a name/);
    expect(() => mod.parseArgs(["a.md"])).toThrow(/usage/);
    expect(() => mod.styleOf("toString")).toThrow(/unknown style/);
  });

  it("keeps bracketed intervals on one line, only in text and only in the course style", () => {
    expect(mod.protectIntervals("<td>0.670 [0.421, 0.898]</td>")).toBe(
      '<td>0.670 <span class="nw">[0.421, 0.898]</span></td>',
    );
    expect(mod.protectIntervals("<p>ROC-AUC −0.062 [−0.126, −0.015] and [+0.002, +0.026]</p>")).toBe(
      '<p>ROC-AUC −0.062 <span class="nw">[−0.126, −0.015]</span> and <span class="nw">[+0.002, +0.026]</span></p>',
    );
    expect(mod.protectIntervals('<img alt="[0.1, 0.2]"><p>[x] and [1]</p>')).toBe(
      '<img alt="[0.1, 0.2]"><p>[x] and <span class="nw">[1]</span></p>',
    );
    expect(mod.STYLES.course.nowrapIntervals).toBe(true);
    expect(mod.STYLES.report.nowrapIntervals).toBe(false);
    expect(render()).not.toContain('class="nw"');
  });

  it("fails on the command line for an unknown style", () => {
    expect(() =>
      execFileSync(process.execPath, [SCRIPT, "--html", "--style", "poster", FIXTURE, "x.html"], { stdio: "pipe" }),
    ).toThrow(/unknown style/);
  });
});
