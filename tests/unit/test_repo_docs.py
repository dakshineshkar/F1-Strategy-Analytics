"""Clone-and-run docs of Step 17: README, docs/README.md, docs/reproduce.md and CITATION.cff."""

from __future__ import annotations

import json
import re
import subprocess
import tomllib
from pathlib import Path

import yaml

import f1sa

REPO = Path(__file__).resolve().parents[2]
# Full names as written in the course proposal, in its order.
TEAM = ("Parinith D", "Dakshineshkar N R", "Rohan Nitin Deore", "Vadnere Kaushal Nitin")
# CITATION.cff splits them into given and family names (Vadnere is the family name, written first).
CITATION_AUTHORS = (
    ("Parinith", "D"),
    ("Dakshineshkar", "N R"),
    ("Rohan Nitin", "Deore"),
    ("Kaushal Nitin", "Vadnere"),
)


def _text(rel: str) -> str:
    return (REPO / rel).read_text(encoding="utf-8")


def _makefile_targets_writing_results() -> set[str]:
    """Targets whose recipe takes RECORD (writes results/ only with RECORD=1)."""
    targets: set[str] = set()
    current = None
    for line in _text("Makefile").splitlines():
        m = re.match(r"^([a-z][a-z0-9-]*):(?!=)", line)
        if m:
            current = m.group(1)
            if "RECORD=1" in line:
                targets.add(current)
        elif line.startswith("\t") and current and re.search(r"_RECORD\)|RECORD\)", line):
            targets.add(current)
    return targets


def test_citation_cff_names_the_team_and_licence() -> None:
    doc = yaml.safe_load(_text("CITATION.cff"))
    assert doc["cff-version"] == "1.2.0" and doc["type"] == "software"
    assert doc["license"] == "MIT"
    names = [(a["given-names"], a["family-names"]) for a in doc["authors"]]
    assert names == list(CITATION_AUTHORS)
    assert all("email" not in a for a in doc["authors"])
    assert doc["repository-code"].startswith("https://github.com/")


def test_readme_has_the_clone_and_run_essentials() -> None:
    readme = _text("README.md")
    for needle in (
        "<picture>",
        'srcset="docs/assets/architecture-dark.svg"',
        'srcset="docs/assets/architecture-light.svg"',
        'src="docs/assets/architecture-dark.png"',
        "](docs/getting-started.md)",
        "docs/README.md",
        "docs/reproduce.md",
        "DATA_LICENSES.md",
        "CITATION.cff",
        "DA231o",
        "Data Wranglers",
        "## Key results",
        "](docs/results.md)",
    ):
        assert needle in readme, needle
    # The quick start moved to docs/getting-started.md and the headline numbers to docs/results.md.
    getting_started = _text("docs/getting-started.md")
    for needle in (
        "make up",
        "make sample-data",
        "make demo",
        "SYNTHETIC DEMO DATA",
        "reproduce.md#prerequisites",
    ):
        assert needle in getting_started, needle
    assert "0.670 [0.421, 0.898]" in _text("docs/results.md")  # copied from docs/report/report.md
    assert "## Limitations" not in readme  # scope lives in the report, section 13
    for name in TEAM:
        assert name in readme, name
    # The architecture is a static image drawn from docs/assets/architecture.mmd.
    diagram = _text("docs/assets/architecture.mmd")
    for part in (
        "HDFS",
        "RDD",
        "MLlib",
        "Kafka",
        "Structured Streaming",
        "Redis",
        "FastAPI",
        "Next.js",
    ):
        assert part in diagram, part


def test_reproduce_has_the_prerequisites_for_both_host_types() -> None:
    doc = _text("docs/reproduce.md")
    assert "## Prerequisites" in doc
    for needle in ("Windows 11 + WSL 2", "Linux / macOS", ".wslconfig"):
        assert needle in doc, needle


def test_reproduce_lists_every_record_target_and_the_integration_tests() -> None:
    doc = _text("docs/reproduce.md")
    targets = _makefile_targets_writing_results()
    assert {
        "ablation-full",
        "stream-latency-suite",
        "redis-latency",
        "experiments-spark",
    } <= targets
    for t in sorted(targets):
        assert f"make {t}" in doc, t
    overwriting = (
        "features-sample model-eval-sample model-dev-full model-test-full model-test-summary "
        "stream-parity-full report-full etl-ti-full demo"
    )
    for t in overwriting.split():
        assert f"make {t}" in doc, t
    assert "tests/integration" in doc and "make test-int" in doc
    # Fix C: every RECORD path refuses
    assert "refuses" in doc and "overwrites, no guard" not in doc
    assert "OVERWRITE=1" in doc and "data/results_backup" in doc


# ---------------------------------------------------------------- Step 18a: the report
REPORT = "docs/report/report.md"
APPENDIX_MARKER = "<!-- appendices -->"
REPORT_SECTIONS = (
    "1. Abstract",
    "2. Problem and motivation",
    "3. System design",
    "4. Data",
    "5. Processing and features",
    "6. Undercut definition and detection",
    "7. Model",
    "8. Streaming and serving",
    "9. What-if simulator",
    "10. Dashboard",
    "11. Evaluation",
    "12. Results against the success metrics",
    "13. Scope and assumptions",
    "14. Reproducibility",
    "15. Conclusion and future work",
    "16. Team contributions",
    "17. References",
    "Appendix A. Claims and sources",
)


def _collapse(text: str) -> str:
    """Whitespace runs to one space, so a value wrapped across lines still matches."""
    return " ".join(text.split())


def _slug(heading: str) -> str:
    """GitHub-style heading anchor; the rule of ``slug`` in web/scripts/report-pdf.mjs."""
    plain = re.sub(r"`([^`]*)`", r"\1", heading)
    plain = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", plain).replace("*", "")
    return re.sub(r"[^\w\- ]", "", plain.lower()).replace(" ", "-")


def _report_links(text: str) -> list[str]:
    links = re.findall(r"\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)", text)
    links += re.findall(r"<img\s[^>]*src=\"([^\"]+)\"", text)
    return links


def _appendix_rows(text: str) -> list[tuple[str, str, str]]:
    """``(id, value, source)`` of every Appendix A row."""
    appendix = text.split("## Appendix A.", 1)[1]
    rows = []
    for line in appendix.splitlines():
        cells = [c.strip() for c in line.strip().strip("|").split("|")]
        if line.startswith("| A") and len(cells) == 5:
            rows.append((cells[0], cells[2], cells[3]))
    return rows


def test_report_has_every_section_the_team_and_open_contribution_cells() -> None:
    text = _text(REPORT)
    headings = re.findall(r"^## (.+)$", text, re.MULTILINE)
    assert headings == list(REPORT_SECTIONS)
    for name in TEAM:
        assert f"| {name} | TO BE COMPLETED BEFORE SUBMISSION |" in text, name
    assert text.count(APPENDIX_MARKER) == 1 and text.count("<!-- toc -->") == 1
    abstract = text.split("## 1. Abstract", 1)[1].split("## 2.", 1)[0]
    assert len(abstract.split()) <= 200


def test_report_links_and_images_resolve() -> None:
    text = _text(REPORT)
    base = REPO / "docs" / "report"
    anchors = {_slug(h) for h in re.findall(r"^#{1,6} (.+)$", text, re.MULTILINE)}
    links = _report_links(text)
    assert any(link.endswith(".png") for link in links)
    for link in links:
        if link.startswith(("http://", "https://", "mailto:")):
            continue
        if link.startswith("#"):
            assert link[1:] in anchors, link
            continue
        target = (base / link.split("#", 1)[0]).resolve()
        assert target.is_file(), link
        assert target.is_relative_to(REPO), link
        if target.suffix == ".png":
            rel = target.relative_to(REPO).as_posix()
            assert rel.startswith(
                ("results/", "docs/report/figures/", "docs/design/before/", "docs/design/after/")
            ), rel


def test_appendix_a_values_appear_verbatim_in_their_source_and_the_report() -> None:
    text = _text(REPORT)
    body = _collapse(text.split(APPENDIX_MARKER, 1)[0])
    rows = _appendix_rows(text)
    assert len(rows) >= 40
    assert len({r[0] for r in rows}) == len(rows)
    for claim_id, value, source in rows:
        assert value, claim_id
        assert value in _collapse(_text(source)), f"{claim_id}: {value!r} not in {source}"
        assert value in body, f"{claim_id}: {value!r} not in the report body"


def test_report_pdf_is_committed_next_to_the_report() -> None:
    pdf = REPO / "docs" / "report" / "report.pdf"
    assert pdf.read_bytes()[:5] == b"%PDF-"


# ---------------------------------------------------------------- the course submission report
FINAL = "docs/report/final_report.md"
FINAL_TITLE = (
    "F1 Strategy Analytics at Scale: "
    "Event-Driven Undercut Detection and What-If Race Strategy Simulation"
)
FINAL_SECTIONS = (
    "## 1. Problem",
    "### 1.1 Definition",
    "### 1.2 Motivation",
    "### 1.3 Design Goals",
    "### 1.4 Features Required",
    "### 1.5 Scalability and Performance Goals",
    "## 2. Approach and Methods",
    "### 2.1 High-Level Design",
    "### 2.2 Architecture and Data Model",
    "#### Real-Time Serving Layer: Redis 8.10 Schema",
    "### 2.3 Big Data Platforms Used",
    "### 2.4 ML Methods Used",
    "## 3. Evaluation",
    "### 3.1 Experiment Design",
    "### 3.2 Challenges and Changes",
    "### 3.3 Scalability and Performance Metrics",
    "### 3.4 Feature Metrics",
    "### 3.5 Analysis",
    "## 4. Summary",
    "### 4.1 Achievement of Design Goals",
    "### 4.2 Changes and Additions",
    "### 4.3 Future Extensions",
    "## References",
)
FINAL_FIGURES = (
    "../assets/architecture-light.svg",
    "../design/after/d-light-mid.png",
    "figures/scalability_build.png",
    "figures/ablation_lr_primary.png",
)
# Every number of the course report is copied from these documents.
FINAL_NUMBER_SOURCES = (
    "docs/report/report.md",
    "docs/results.md",
    "docs/architecture.md",
    "docs/experiments.md",
    "docs/model_results.md",
    "docs/traceability.md",
)


def _final_body() -> str:
    """The report after the title and byline."""
    return _text(FINAL).split("## 1. Problem", 1)[1]


def _numbers_missing_from(text: str, sources: dict[str, str]) -> list[str]:
    """Numbers of ``text`` that appear, digit-bounded, in none of ``sources``.

    Section numbers in headings, Figure/Section references, URLs and list-item numbers are not
    data and are skipped.
    """
    text = re.sub(r"^#{2,4} [\d.]+ ?", "", text, flags=re.M)
    text = re.sub(r"\b(Figure|Section) \d+(\.\d+)?", "", text)
    text = re.sub(r"https?://\S+", "", text)
    text = re.sub(r"^\d+\. ", "", text, flags=re.M)
    missing = []
    for number in sorted(set(re.findall(r"\d+(?:[.,]\d+)*", text))):
        pattern = re.compile(r"(?<![\d.,])" + re.escape(number) + r"(?![\d]|[.,]\d)")
        if not any(pattern.search(source) for source in sources.values()):
            missing.append(number)
    return missing


def test_numbers_missing_from_finds_only_numbers_absent_from_every_source() -> None:
    sources = {"a": "PR-AUC 0.670 [0.421, 0.898] on 49 attempts", "b": "12.71 messages/s"}
    text = (
        "## 3.4 Metrics\nFigure 4 shows 0.670 and 12.71 at 49; "
        "0.67 and 2.71 and 1,252 are not there.\n1. item"
    )
    assert _numbers_missing_from(text, sources) == ["0.67", "1,252", "2.71"]


def test_final_report_heading_byline_and_sections_in_the_course_order() -> None:
    text = _text(FINAL)
    assert text.startswith(f"# {FINAL_TITLE}\n")
    byline = text.split("## 1. Problem", 1)[0]
    # The proposal's layout: a centred 2x2 grid, each name on one line with its email below it,
    # in reading order (first row Parinith D, Dakshineshkar N R; second row the other two).
    emails = (
        "parinithd@iisc.ac.in",
        "dakshineshk1@iisc.ac.in",
        "rohandeore@iisc.ac.in",
        "kaushalvadn1@iisc.ac.in",
    )
    # Names in bold, emails in regular weight.
    cells = re.findall(r"^<div><strong>([^<]+)</strong><br>([^<]+)</div>$", byline, re.MULTILINE)
    assert cells == list(zip(TEAM, emails, strict=True))
    assert "display: grid; grid-template-columns: repeat(2," in byline
    assert "<style>h1 { color: #1F3864; }</style>" in byline  # the proposal's dark-blue title
    assert "DA231o, Indian Institute of Science, Bengaluru" in byline
    headings = re.findall(r"^#{2,4} .+$", text, re.MULTILINE)
    assert headings == list(FINAL_SECTIONS)
    assert "<!-- toc -->" not in text and APPENDIX_MARKER not in text


def test_final_report_has_four_figures_that_resolve_and_no_file_paths_in_the_body() -> None:
    text = _text(FINAL)
    images = [link for link in _report_links(text) if link.endswith((".png", ".svg"))]
    assert sorted(images) == sorted(FINAL_FIGURES)
    for link in images:
        assert (REPO / "docs" / "report" / link).resolve().is_file(), link
    captions = re.findall(r"(?:!\[|<figcaption>)(Figure \d+)\.", text)
    assert captions == ["Figure 1", "Figure 2", "Figure 3", "Figure 4"]
    # Image targets are links, not body text.
    body = re.sub(r'(?:\]\(|src=")[^)"]+[)"]', "", _final_body())
    for needle in ("results/", "docs/", "src/", "tests/", ".py", ".csv", "Source:"):
        assert needle not in body, needle
    assert re.search(r"\bmake (?:up|demo|[a-z0-9]+-[a-z0-9-]+)\b", body) is None  # no make targets


def test_final_report_numbers_appear_in_the_full_report_or_the_cited_docs() -> None:
    sources = {rel: _collapse(_text(rel)) for rel in FINAL_NUMBER_SOURCES}
    assert _numbers_missing_from(_final_body(), sources) == []


def test_final_report_makes_no_statement_about_the_proposal_itself() -> None:
    text = _text(FINAL)
    for word in ("proposal", "requirement"):
        assert word not in text.lower(), word
    assert "| Goal | Achieved |" in text


def test_final_report_pdf_is_committed_next_to_the_final_report() -> None:
    pdf = REPO / "docs" / "report" / "final_report.pdf"
    assert pdf.read_bytes()[:5] == b"%PDF-"


# ---------------------------------------------------------------- repository layout and links
# A deliberately broken image link: the input of the report-pdf "missing image" test.
LINK_FIXTURES = ("web/tests/fixtures/report/report.md",)
LINK = re.compile(
    r"\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)|<(?:img|a|source)\s[^>]*(?:src|href|srcset)=\"([^\"]+)\""
)


def _tracked_markdown() -> list[str]:
    """Tracked and new (not ignored) Markdown files, without the link fixtures."""
    out = subprocess.run(
        ["git", "ls-files", "-z", "--cached", "--others", "--exclude-standard", "--", "*.md"],
        cwd=REPO,
        check=True,
        capture_output=True,
    ).stdout.decode("utf-8")
    return sorted(f for f in out.split("\0") if f and f not in LINK_FIXTURES)


def _anchors(path: Path) -> set[str]:
    text = re.sub(r"```.*?```", "", path.read_text(encoding="utf-8"), flags=re.DOTALL)
    return {_slug(h.strip()) for h in re.findall(r"^#{1,6} (.+)$", text, re.MULTILINE)}


def _relative_links(text: str) -> list[str]:
    text = re.sub(r"```.*?```", "", text, flags=re.DOTALL)
    text = re.sub(r"`[^`\n]*`", "", text)
    links = []
    for m in LINK.finditer(text):
        link = (m.group(1) or m.group(2)).split(",")[0].split()[0]
        if not link.startswith(("http://", "https://", "mailto:")):
            links.append(link)
    return links


def test_every_relative_link_in_every_tracked_markdown_file_resolves() -> None:
    files = _tracked_markdown()
    assert "README.md" in files and "CONTRIBUTING.md" in files
    broken = []
    for rel in files:
        source = REPO / rel
        for link in _relative_links(source.read_text(encoding="utf-8")):
            target_part, _, anchor = link.partition("#")
            target = (source.parent / target_part).resolve() if target_part else source
            if not target.exists() or not target.is_relative_to(REPO):
                broken.append(f"{rel}: {link}")
            elif anchor and target.suffix == ".md" and anchor not in _anchors(target):
                broken.append(f"{rel}: {link} (no such heading)")
    assert broken == []


TRACKED_TOP_LEVEL = frozenset(
    {
        ".dockerignore", ".editorconfig", ".env.example", ".gitattributes", ".github",
        ".gitignore", ".pre-commit-config.yaml", "CHANGELOG.md", "CITATION.cff", "CONTRIBUTING.md",
        "DATA_LICENSES.md", "LICENSE", "Makefile", "README.md", "SECURITY.md", "data", "docker",
        "docker-compose.yml", "docs", "experiments", "pyproject.toml", "results", "scripts", "src",
        "tests", "uv.lock", "web",
    }
)  # fmt: skip
TRACKED_HIDDEN_NAMES = frozenset({".dockerignore", ".gitignore", ".gitkeep", ".npmrc", ".nvmrc"})


def test_tracked_top_level_entries_are_the_project_layout() -> None:
    """Only the project's own files are tracked: the top level is exactly the layout above, and
    below it a hidden name is one of a few known config files (local editor and tool state never
    is)."""
    out = subprocess.run(
        ["git", "ls-files", "-z"], cwd=REPO, check=True, capture_output=True
    ).stdout.decode("utf-8")
    files = [f for f in out.split("\0") if f]
    assert {f.split("/", 1)[0] for f in files} == TRACKED_TOP_LEVEL
    hidden = [
        f
        for f in files
        if "/" in f and not f.startswith(".github/")
        for part in f.split("/")[1:]
        if part.startswith(".") and part not in TRACKED_HIDDEN_NAMES
    ]
    assert hidden == []


def test_contributing_security_and_changelog_are_linked_and_versions_agree() -> None:
    for doc in ("CONTRIBUTING.md", "SECURITY.md", "CHANGELOG.md"):
        assert f"]({doc})" in _text("README.md"), doc
        assert f"](../{doc})" in _text("docs/README.md"), doc
    contributing = _text("CONTRIBUTING.md")
    for needle in ("make lint", "make typecheck", "make test", "make web-test", "make web-e2e"):
        assert needle in contributing, needle
    assert "docker compose down -v" in contributing and "RECORD=1" in contributing
    assert "private security advisory" in _text("SECURITY.md")
    top = re.search(r"^## \[(\d+\.\d+\.\d+)\] - \d{4}-\d{2}-\d{2}$", _text("CHANGELOG.md"), re.M)
    assert top is not None
    assert tomllib.loads(_text("pyproject.toml"))["project"]["version"] == top.group(1)
    assert json.loads(_text("web/package.json"))["version"] == top.group(1)
    assert f1sa.__version__ == top.group(1)
