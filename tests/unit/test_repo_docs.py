"""Clone-and-run documentation of Step 17: README, docs/reproduce.md and CITATION.cff."""

from __future__ import annotations

import re
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parents[2]
TEAM = ("Parinith D.", "Dakshinesh K.", "Rohan Deore", "Kaushal V.")


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
    names = [f"{a['given-names']} {a['family-names']}" for a in doc["authors"]]
    assert names == list(TEAM)
    assert all("email" not in a for a in doc["authors"])
    assert doc["repository-code"].startswith("https://github.com/")


def test_readme_has_the_clone_and_run_essentials() -> None:
    readme = _text("README.md")
    for needle in (
        "```mermaid",
        "make up",
        "make sample-data",
        "make demo",
        "SYNTHETIC DEMO DATA",
        "Windows 11 + WSL 2",
        "Linux / macOS",
        ".wslconfig",
        "docs/reproduce.md",
        "DATA_LICENSES.md",
        "CITATION.cff",
        "DA231o",
        "Data Wranglers",
        "## Limitations",
        "## Key results",
        "0.670 [0.421, 0.898]",  # copied from docs/model_results.md
    ):
        assert needle in readme, needle
    for name in TEAM:
        assert name in readme, name
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
        assert part in readme.split("```mermaid", 1)[1].split("```", 1)[0], part


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
    "13. Limitations and threats to validity",
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
        assert f"| {name} | TODO: fill in |" in text, name
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
            assert rel.startswith(("results/", "docs/design/before/", "docs/design/after/")), rel


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
