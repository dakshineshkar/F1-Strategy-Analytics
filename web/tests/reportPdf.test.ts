// Step 18a: the report renderer (scripts/report-pdf.mjs) in its browser-free --html mode.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
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
