// Renders the project report (docs/report/report.md) to an A4 PDF for `make report-pdf` (Step 18a).
// Markdown -> HTML with marked; ```mermaid blocks are drawn by mermaid inside Playwright's Chromium,
// which then prints the page (A4, page numbers in the footer, PDF bookmarks from the headings).
// Both packages are devDependencies only; nothing here is part of the dashboard.
//
//   node scripts/report-pdf.mjs [--style course] <in.md> <out.pdf>     # the PDF; prints page counts and size
//   node scripts/report-pdf.mjs --html [--style course] <in.md> <out.html>   # the HTML only (no browser; tests)
//
// Styles: `report` (default; docs/report/report.pdf) and `course` (docs/report/final_report.pdf, the course
// format: A4, 2.5 cm margins on every side, 10 pt body, 9 pt tables, page numbers only in the footer).
//
// Markers in the Markdown: `<!-- toc -->` is replaced by a linked table of contents (H2 and H3);
// `<!-- appendices -->` starts the appendices on a new page, and the body page count stops there.
// Chromium cannot print page numbers inside the table of contents; it links to each section instead.
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Marked } from "marked";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(HERE, "..");
const FONTS = path.join(WEB, "src", "fonts");
const MERMAID = path.join(WEB, "node_modules", "mermaid", "dist", "mermaid.min.js");
// Report-only fonts of the course style (SIL OFL 1.1; see fonts/liberation/README.md).
const REPORT_FONTS = path.join(HERE, "fonts", "liberation");
const SERIF = '"Times New Roman", "Liberation Serif", serif';
const MONO = '"Courier New", "Liberation Mono", monospace';
const TOC_MARKER = "<!-- toc -->";
const APPENDIX_MARKER = "<!-- appendices -->";

export function escapeHtml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function decodeEntities(text) {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

/** GitHub-style heading slug: lower case, punctuation dropped (letters, digits, `_` and `-` kept),
 * spaces to `-`. The Python link test (tests/unit/test_repo_docs.py) uses the same rule. */
export function slug(text) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}_\- ]/gu, "")
    .replace(/ /g, "-");
}

/** The report's HTML document and its headings. `baseDir` is the folder relative links resolve from;
 * `style` is a key of STYLES. */
export function renderHtml(markdown, baseDir, style = "report") {
  const look = styleOf(style);
  const headings = [];
  const used = new Map();
  const marked = new Marked({ gfm: true });
  marked.use({
    renderer: {
      heading({ tokens, depth }) {
        const inner = this.parser.parseInline(tokens);
        const plain = decodeEntities(inner.replace(/<[^>]*>/g, ""));
        let id = slug(plain);
        const n = used.get(id) ?? 0;
        used.set(id, n + 1);
        if (n > 0) id = `${id}-${n}`;
        headings.push({ depth, id, html: inner });
        return `<h${depth} id="${id}">${inner}</h${depth}>\n`;
      },
      code({ text, lang }) {
        if ((lang ?? "").trim() === "mermaid") return `<pre class="mermaid">${escapeHtml(text)}</pre>\n`;
        const cls = lang ? ` class="language-${escapeHtml(lang.trim())}"` : "";
        return `<pre><code${cls}>${escapeHtml(text)}</code></pre>\n`;
      },
      paragraph({ tokens }) {
        const only = tokens.filter((t) => !(t.type === "text" && t.raw.trim() === ""));
        if (only.length === 1 && only[0]?.type === "image") {
          const img = only[0];
          const caption = img.title ?? img.text;
          return (
            `<figure><img src="${escapeHtml(img.href)}" alt="${escapeHtml(img.text)}">` +
            `<figcaption>${escapeHtml(caption)}</figcaption></figure>\n`
          );
        }
        return `<p>${this.parser.parseInline(tokens)}</p>\n`;
      },
    },
  });
  let body = marked.parse(markdown);
  if (look.nowrapIntervals) body = protectIntervals(body);
  const title = headings.find((h) => h.depth === 1)?.html.replace(/<[^>]*>/g, "") ?? "Report";
  const toc = headings
    .filter((h) => h.depth === 2 || h.depth === 3)
    .map((h) => `<li class="toc-${h.depth}"><a href="#${h.id}">${h.html}</a></li>`)
    .join("\n");
  body = body.replace(TOC_MARKER, `<nav class="toc"><h2 class="toc-title">Contents</h2><ul>\n${toc}\n</ul></nav>`);
  body = body.replace(APPENDIX_MARKER, '<div class="appendices"></div>');
  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<base href="${pathToFileURL(baseDir + path.sep).href}">
<title>${escapeHtml(decodeEntities(title))}</title>
<style>${look.css()}</style>
</head>
<body>
${body}
</body>
</html>
`;
  return { html, headings, title: decodeEntities(title) };
}

function font(family, file, weight) {
  const url = pathToFileURL(path.join(FONTS, file)).href;
  return `@font-face{font-family:"${family}";src:url("${url}") format("woff2");font-weight:${weight};font-style:normal}`;
}

function reportCss() {
  return `
${font("Barlow Semi Condensed", "barlow-semi-condensed/barlow-semi-condensed-latin-600-normal.woff2", 600)}
${font("Barlow Semi Condensed", "barlow-semi-condensed/barlow-semi-condensed-latin-700-normal.woff2", 700)}
${font("IBM Plex Mono", "ibm-plex-mono/ibm-plex-mono-latin-400-normal.woff2", 400)}
${font("IBM Plex Mono", "ibm-plex-mono/ibm-plex-mono-latin-600-normal.woff2", 600)}
@page { size: A4; margin: 14mm 14mm 16mm 14mm; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: "DejaVu Serif", Georgia, serif; font-size: 8.9pt; line-height: 1.36; color: #111; background: #fff; margin: 0; }
h1, h2, h3, h4 { font-family: "Barlow Semi Condensed", "DejaVu Sans", sans-serif; line-height: 1.15; break-after: avoid; page-break-after: avoid; }
h1 { font-size: 22pt; font-weight: 700; margin: 0 0 4pt; }
h2 { font-size: 13.5pt; font-weight: 700; margin: 11pt 0 3pt; border-bottom: 0.6pt solid #999; padding-bottom: 2pt; }
h3 { font-size: 10.5pt; font-weight: 600; margin: 7pt 0 2pt; }
h4 { font-size: 9.5pt; font-weight: 600; margin: 8pt 0 2pt; }
p { margin: 0 0 4pt; orphans: 3; widows: 3; }
ul, ol { margin: 0 0 4pt; padding-left: 14pt; }
li { margin: 0 0 0.6pt; }
li > ul, li > ol { margin: 0.6pt 0 0; }
a { color: #0b4f8a; text-decoration: none; }
code, pre { font-family: "IBM Plex Mono", "DejaVu Sans Mono", monospace; font-size: 7.8pt; }
code { background: #f2f2f2; padding: 0 1.5pt; border-radius: 1.5pt; overflow-wrap: anywhere; }
pre { background: #f5f5f5; padding: 5pt 6pt; border-radius: 2pt; white-space: pre-wrap; break-inside: avoid; margin: 0 0 6pt; }
pre code { background: none; padding: 0; }
pre.mermaid { background: none; text-align: center; padding: 0; margin: 4pt 0 6pt; }
pre.mermaid svg { max-width: 100%; height: auto; max-height: 150mm; }
table { border-collapse: collapse; width: 100%; margin: 3pt 0 6pt; font-size: 7.6pt; line-height: 1.3; }
thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
th, td { border: 0.5pt solid #aaa; padding: 1.8pt 3pt; vertical-align: top; text-align: left; }
th { background: #e9e9e9; font-family: "Barlow Semi Condensed", "DejaVu Sans", sans-serif; font-weight: 600; font-size: 8pt; }
td code { font-size: 7pt; overflow-wrap: normal; word-break: normal; }
figure { margin: 4pt 0 8pt; text-align: center; break-inside: avoid; page-break-inside: avoid; }
figure img { display: block; width: 100%; max-height: 240mm; object-fit: contain; }
figure.pair { break-inside: auto; page-break-inside: auto; }
figure.pair > div { break-inside: avoid; page-break-inside: avoid; }
figure.pair > div + div { margin-top: 3mm; }
figure.pair figcaption { break-before: avoid; page-break-before: avoid; }
figcaption { font-size: 7.8pt; color: #333; margin-top: 2pt; text-align: left; }
blockquote { margin: 0 0 6pt; padding: 2pt 8pt; border-left: 2pt solid #999; color: #333; }
hr { border: 0; border-top: 0.5pt solid #999; margin: 8pt 0; }
.toc { margin-bottom: 6pt; }
.toc ul { list-style: none; padding-left: 0; columns: 3; column-gap: 12pt; font-size: 8pt; }
.toc li { break-inside: avoid; }
.toc .toc-3 { padding-left: 8pt; font-size: 7.5pt; }
.toc-title { border: 0; }
.appendices { break-before: page; page-break-before: always; }
`;
}

function courseCss() {
  const ttf = (family, file, weight) => {
    const url = pathToFileURL(path.join(REPORT_FONTS, file)).href;
    return `@font-face{font-family:"${family}";src:url("${url}") format("truetype");font-weight:${weight};font-style:normal}`;
  };
  return `
${ttf("Liberation Serif", "LiberationSerif-Regular.ttf", 400)}
${ttf("Liberation Serif", "LiberationSerif-Bold.ttf", 700)}
${ttf("Liberation Mono", "LiberationMono-Regular.ttf", 400)}
@page { size: A4; margin: 25mm; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font-family: ${SERIF}; font-size: 10pt; line-height: 1.25; color: #111; background: #fff; margin: 0; }
strong, b { font-weight: 700; }
h1, h2, h3, h4 { font-family: ${SERIF}; font-weight: 700; line-height: 1.15; break-after: avoid; page-break-after: avoid; }
h1 { font-size: 15pt; margin: 0 0 4pt; text-align: center; }
h2 { font-size: 12pt; margin: 9pt 0 3pt; }
h3 { font-size: 10.5pt; margin: 6pt 0 2pt; }
h4 { font-size: 10pt; margin: 5pt 0 2pt; }
p { margin: 0 0 4pt; orphans: 3; widows: 3; }
.byline { text-align: center; margin: 0 0 8pt; line-height: 1.3; }
ul, ol { margin: 0 0 4pt; padding-left: 13pt; }
li { margin: 0 0 1pt; }
a { color: inherit; text-decoration: none; }
code { font-family: ${MONO}; font-size: 8.5pt; }
table { border-collapse: collapse; width: 100%; margin: 3pt 0 6pt; font-size: 9pt; line-height: 1.2; break-inside: avoid; page-break-inside: avoid; }
table:has(tbody > tr:nth-child(7)) { break-inside: auto; page-break-inside: auto; }
thead { display: table-header-group; }
tr { break-inside: avoid; page-break-inside: avoid; }
th, td { border: 0.5pt solid #999; padding: 1.5pt 3pt; vertical-align: top; text-align: left; }
th { background: #ececec; font-weight: 700; }
td code { font-size: 7.5pt; white-space: nowrap; }
.nw { white-space: nowrap; }
figure { margin: 4pt 0 6pt; text-align: center; break-inside: avoid; page-break-inside: avoid; }
figure img { display: block; width: 100%; height: auto; max-height: 150mm; object-fit: contain; margin: 0 auto; }
figcaption { font-size: 9pt; color: #222; margin-top: 3pt; text-align: left; }
`;
}

/** Wraps every bracketed interval such as `[0.421, 0.898]` or `[−0.126, −0.015]` in a no-wrap span, so a line or
 * table cell never breaks inside the brackets. Only text between tags is touched. */
export function protectIntervals(html) {
  return html
    .split(/(<[^>]*>)/)
    .map((part) =>
      part.startsWith("<") ? part : part.replace(/\[([−+-]?\d[^\][<>\n]{0,40})\]/g, '<span class="nw">[$1]</span>'),
    )
    .join("");
}

const FOOTER = (title) =>
  `<div style="font-family:'DejaVu Sans',sans-serif;font-size:7.5px;color:#555;width:100%;padding:0 14mm;` +
  `display:flex;justify-content:space-between"><span>${escapeHtml(title)}</span>` +
  `<span>Page <span class="pageNumber"></span> of <span class="totalPages"></span></span></div>`;

// The footer is a separate document that cannot load the page's fonts; it falls back to a system serif.
const COURSE_FOOTER = () =>
  `<div style="font-family:${SERIF.replace(/"/g, "'")};font-size:8px;color:#444;width:100%;text-align:center">` +
  `Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`;

/** Page look per style: CSS, PDF margins (the same as the CSS @page margins) and footer. */
export const STYLES = {
  report: {
    css: reportCss,
    margin: { top: "14mm", right: "14mm", bottom: "16mm", left: "14mm" },
    footer: FOOTER,
    cssPageSize: false,
    nowrapIntervals: false,
  },
  course: {
    css: courseCss,
    margin: { top: "25mm", right: "25mm", bottom: "25mm", left: "25mm" },
    footer: COURSE_FOOTER,
    // Exactly 210 x 297 mm from the CSS @page rule; Chromium's built-in "A4" format is 210.2 x 297.3 mm.
    cssPageSize: true,
    nowrapIntervals: true,
  },
};

/** The style named `name`; throws on an unknown name. */
export function styleOf(name) {
  if (!Object.hasOwn(STYLES, name)) {
    throw new Error(`unknown style ${JSON.stringify(name)} (expected one of: ${Object.keys(STYLES).join(", ")})`);
  }
  return STYLES[name];
}

/** Number of pages of a PDF written by Chromium (its page objects are uncompressed). */
export function pdfPageCount(bytes) {
  const text = bytes.toString("latin1");
  return (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}

async function printPdf(browser, html, title, outPath, tmp, style = "report") {
  const look = styleOf(style);
  const htmlPath = path.join(tmp, `page-${Date.now()}-${Math.random().toString(36).slice(2)}.html`);
  writeFileSync(htmlPath, html);
  const page = await browser.newPage();
  try {
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
    if (html.includes('class="mermaid"')) {
      await page.addScriptTag({ path: MERMAID });
      await page.evaluate(async () => {
        const m = /** @type {any} */ (window).mermaid;
        m.initialize({
          startOnLoad: false,
          theme: "neutral",
          securityLevel: "strict",
          fontFamily: "DejaVu Sans",
          themeVariables: { fontSize: "15px" },
          flowchart: { wrappingWidth: 400, nodeSpacing: 30, rankSpacing: 40 },
        });
        await m.run({ querySelector: "pre.mermaid" });
      });
      const failed = await page.$$eval("pre.mermaid", (els) => els.filter((e) => !e.querySelector("svg")).length);
      if (failed) throw new Error(`${failed} mermaid diagram(s) did not render`);
    }
    await page.evaluate(async () => {
      await document.fonts.ready;
      await Promise.all(
        Array.from(document.images).map((img) =>
          img.complete ? Promise.resolve() : new Promise((r) => img.addEventListener("load", r, { once: true })),
        ),
      );
    });
    const broken = await page.$$eval("img", (imgs) => imgs.filter((i) => i.naturalWidth === 0).map((i) => i.src));
    if (broken.length) throw new Error(`images that did not load: ${broken.join(", ")}`);
    await page.pdf({
      path: outPath,
      format: "A4",
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: look.footer(title),
      margin: look.margin,
      preferCSSPageSize: look.cssPageSize,
      outline: true,
      tagged: true,
    });
  } finally {
    await page.close();
  }
}

/** `{ html, style, files }` from the command line: `[--html] [--style <name>] <in> <out>`, flags in any order. */
export function parseArgs(argv) {
  let html = false;
  let style = "report";
  const files = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--html") html = true;
    else if (arg === "--style") {
      const name = argv[i + 1];
      if (name === undefined) throw new Error("--style needs a name");
      styleOf(name);
      style = name;
      i += 1;
    } else files.push(arg);
  }
  if (files.length !== 2) {
    throw new Error("usage: report-pdf.mjs [--html] [--style report|course] <in.md> <out.pdf|out.html>");
  }
  return { html, style, files };
}

async function main(argv) {
  const { html: htmlOnly, style, files } = parseArgs(argv);
  if (htmlOnly) {
    const [input, output] = files;
    const { html } = renderHtml(readFileSync(input, "utf8"), path.dirname(path.resolve(input)), style);
    writeFileSync(output, html);
    console.log(`wrote ${output}`);
    return;
  }
  const [input, output] = files;
  const markdown = readFileSync(input, "utf8");
  const baseDir = path.dirname(path.resolve(input));
  const full = renderHtml(markdown, baseDir, style);
  const { chromium } = await import("@playwright/test");
  const tmp = mkdtempSync(path.join(tmpdir(), "report-pdf-"));
  const browser = await chromium.launch();
  try {
    await printPdf(browser, full.html, full.title, path.resolve(output), tmp, style);
    const total = pdfPageCount(readFileSync(output));
    let bodyNote = "";
    const cut = markdown.indexOf(APPENDIX_MARKER);
    if (cut >= 0) {
      const body = renderHtml(markdown.slice(0, cut), baseDir, style);
      const bodyPdf = path.join(tmp, "body.pdf");
      await printPdf(browser, body.html, body.title, bodyPdf, tmp, style);
      const pages = pdfPageCount(readFileSync(bodyPdf));
      bodyNote = ` (body ${pages}, appendices ${total - pages})`;
    }
    const kb = (statSync(output).size / 1024).toFixed(1);
    console.log(`wrote ${output}: ${total} pages${bodyNote}, ${kb} KiB`);
  } finally {
    await browser.close();
    rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    console.error(`report-pdf: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
