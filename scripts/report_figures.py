"""Report-only copies of five figures, re-plotted from the committed ``results/*.csv``.

    uv run python scripts/report_figures.py

The PNGs in ``results/`` are drawn for a screen and become unreadable when they are printed at
A4 text width. This script re-draws the same data at the report's size (7 in wide, 8-10 pt
text) and keeps only the panels the report discusses. It reads ``results/`` and never writes it;
its only outputs are the PNGs in ``docs/report/figures/``. No value is recomputed: every point is
a value of a CSV row, selected the way the original plot selects it.

| Output | Source | Report figure |
|---|---|---|
| ``feature_importance.png`` | ``results/feature_importance_G3.5_k2.csv`` | Figure 2 |
| ``scalability_build.png`` | ``results/scalability.csv`` (build cells) | Figure 6 |
| ``partitioning_laps.png`` | ``results/partitioning.csv`` (laps dataset) | Figure 7 |
| ``ablation_lr_primary.png`` | ``results/ablation_paired.csv`` (LR, G=3.5, k=2) | Figure 9 |
| ``whatif_checks.png`` | ``results/whatif_consistency.csv`` (ordering, backtest bins) | Figure 10 |
"""

from __future__ import annotations

import csv
import sys
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "src"))

from f1sa.bench.report import (  # noqa: E402
    MASTER_LABEL,
    MASTER_ORDER,
    SERIES_COLORS,
    _build_points,
    _missing_build_cells,
    read_csv_rows,
)

RESULTS = REPO / "results"
OUT = REPO / "docs" / "report" / "figures"
WIDTH_IN = 7.0
DPI = 200
INK, MUTED, GRID = "#0b0b0b", "#52514e", "#e4e3df"
HIGHLIGHT = "#c0392b"

plt.rcParams.update(
    {
        "font.family": "DejaVu Sans",
        "font.size": 9,
        "axes.titlesize": 9.5,
        "axes.labelsize": 9,
        "xtick.labelsize": 8.5,
        "ytick.labelsize": 8.5,
        "legend.fontsize": 8.5,
        "axes.edgecolor": "#b5b4ae",
        "axes.labelcolor": INK,
        "text.color": INK,
        "xtick.color": MUTED,
        "ytick.color": MUTED,
        "svg.hashsalt": "f1sa",
    }
)


def _style(ax: Any) -> None:
    ax.grid(True, color=GRID, linewidth=0.7)
    ax.set_axisbelow(True)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)


def _save(fig: Any, name: str) -> Path:
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / name
    fig.savefig(path, dpi=DPI, bbox_inches="tight", pad_inches=0.04, metadata={"Software": None})
    plt.close(fig)
    return path


def _rows(name: str) -> list[dict[str, str]]:
    """Rows of ``results/<name>``; lines starting with ``#`` (a provenance comment) are skipped."""
    with (RESULTS / name).open(newline="", encoding="utf-8") as fh:
        return list(csv.DictReader(line for line in fh if not line.startswith("#")))


# ------------------------------------------------------------------ Figure 2
def feature_importance() -> Path:
    """The two panels of results/feature_importance_G3.5_k2.png, stacked: the features ranked by
    value per method as ``model.pipeline.plot_importance`` ranks them, cut to the top 10 (the
    original shows 15) so the figure fits the report page."""
    rows = _rows("feature_importance_G3.5_k2.csv")
    panels = (
        ("gbt_importance", "(a) GBT importance", "importance"),
        (
            "permutation_pr_auc_drop",
            "(b) LR permutation PR-AUC drop (2024 validation)",
            "PR-AUC drop",
        ),
    )
    fig, axes = plt.subplots(2, 1, figsize=(WIDTH_IN, 3.6))
    for ax, (method, title, xlabel) in zip(axes, panels, strict=True):
        sel = [r for r in rows if r["method"] == method and r["value"] not in ("", "nan")]
        sel = sorted(sel, key=lambda r: -float(r["value"]))[:10][::-1]
        ax.barh(
            [r["feature"] for r in sel], [float(r["value"]) for r in sel], color=SERIES_COLORS[0]
        )
        ax.set_title(title, loc="left")
        ax.set_xlabel(xlabel)
        ax.tick_params(axis="y", labelsize=7.2)
        _style(ax)
        ax.grid(False, axis="y")
    fig.tight_layout(h_pad=1.0)
    return _save(fig, "feature_importance.png")


# ------------------------------------------------------------------ Figure 6
def _draw_build(ax: Any, xs: Sequence[float], pts: Sequence[tuple[float, ...]], i: int) -> None:
    ys = [p[1] for p in pts]
    err = [
        [y - p[2] for y, p in zip(ys, pts, strict=True)],
        [p[3] - y for y, p in zip(ys, pts, strict=True)],
    ]
    color = SERIES_COLORS[i]
    ax.errorbar(
        xs,
        ys,
        yerr=err,
        color=color,
        linewidth=1.8,
        marker="o",
        markersize=5,
        markeredgecolor="white",
        markeredgewidth=1.0,
        capsize=2.5,
        label=MASTER_LABEL[MASTER_ORDER[i]],
    )
    rerun = [(x, y) for x, y, p in zip(xs, ys, pts, strict=True) if p[4]]
    if rerun:
        ax.plot(
            [x for x, _ in rerun],
            [y for _, y in rerun],
            linestyle="none",
            marker="o",
            markersize=8,
            markerfacecolor="white",
            markeredgecolor=color,
            markeredgewidth=1.8,
        )


def scalability_build() -> Path:
    """The four build panels of results/scalability_build.png (same rows via ``_build_points``)."""
    rows = read_csv_rows(RESULTS / "scalability.csv")
    fig, axes = plt.subplots(2, 2, figsize=(WIDTH_IN, 5.8))
    ax_s, ax_r = axes[0][0], [axes[0][1], axes[1][0], axes[1][1]]
    for ax in ax_r[1:]:
        ax.sharey(ax_r[0])
    labels = {1: "1 (2024)", 3: "3 (2022-24)", 5: "5 (2021-25)"}
    titles = {1: "1 season (2024)", 3: "3 seasons (2022-24)", 5: "5 seasons (2021-25)"}
    for i, master in enumerate(MASTER_ORDER):
        pts = sorted(_build_points(rows, master, factor=1.0))
        if pts:
            _draw_build(ax_s, [p[0] for p in pts], pts, i)
        for ax, n in zip(ax_r, (1, 3, 5), strict=True):
            sel = sorted(_build_points(rows, master, n_seasons=float(n)), key=lambda p: p[5])
            if sel:
                _draw_build(ax, [p[5] for p in sel], sel, i)
    missing = _missing_build_cells(rows)
    for ax, n in zip(ax_r, (1, 3, 5), strict=True):
        factors = sorted(
            {
                int(float(r["factor"]))
                for r in rows
                if r.get("phase") == "build" and r.get("factor") and float(r["n_seasons"]) == n
            }
        )
        gone = sorted(
            {int(float(r["factor"])) for r, _ in missing if float(r.get("n_seasons") or 0) == n}
        )
        for f in gone:
            ax.annotate(
                "local[N]:\nno timing",
                (f, 0.05),
                xycoords=("data", "axes fraction"),
                ha="right",
                fontsize=7.5,
                color=MUTED,
            )
        ax.set_xscale("log", base=2)
        ax.set_xticks(factors, [f"x{f}" for f in factors])
        ax.minorticks_off()
        ax.set_xlabel("replication factor")
        ax.set_title(f"({'bcd'[(1, 3, 5).index(n)]}) Replication, {titles[n]}", loc="left")
    ax_s.set_xticks([1, 3, 5], [labels[n] for n in (1, 3, 5)])
    ax_s.set_xlabel("real seasons (x1)")
    ax_s.set_title("(a) Real seasons at x1", loc="left")
    for ax in (ax_s, *ax_r):
        ax.set_ylabel("median s per run")
        _style(ax)
    ax_s.legend(frameon=False, fontsize=8, loc="upper center", ncols=2)
    ax_s.set_ylim(top=ax_s.get_ylim()[1] * 1.15)
    fig.tight_layout(h_pad=1.2, w_pad=1.0)
    return _save(fig, "scalability_build.png")


# ------------------------------------------------------------------ Figure 7
def partitioning_laps() -> Path:
    """The four laps panels of results/partitioning_speedup.png (speedup_vs_simplest)."""
    rows = [r for r in _rows("partitioning.csv") if r.get("speedup_vs_simplest")]
    variants = (("none", "no cache"), ("cache", "cache()"), ("persist_disk", "persist(DISK_ONLY)"))
    combos = [(fs, lay) for fs in ("file", "hdfs") for lay in ("unpartitioned", "partitioned")]
    queries = (
        ("one_race", "one race"),
        ("one_season", "one season"),
        ("full_scan", "full scan"),
        ("join_agg", "join + aggregate"),
    )
    fig, axes = plt.subplots(2, 2, figsize=(WIDTH_IN, 5.2), sharey=True)
    width = 0.26
    for ax, (query, title) in zip(axes.flat, queries, strict=True):
        for vi, (variant, label) in enumerate(variants):
            ys = []
            for fs, lay in combos:
                match = [
                    r
                    for r in rows
                    if (r["dataset"], r["query"], r["fs"], r["layout"], r["variant"])
                    == ("laps", query, fs, lay, variant)
                ]
                ys.append(float(match[0]["speedup_vs_simplest"]) if match else 0.0)
            xs = [c + (vi - 1) * width for c in range(len(combos))]
            ax.bar(xs, ys, width=width - 0.02, color=SERIES_COLORS[vi], label=label)
        ax.axhline(1.0, color=MUTED, linewidth=1, linestyle="--")
        ax.set_xticks(range(len(combos)), [f"{fs}\n{lay}" for fs, lay in combos], fontsize=7.5)
        ax.set_title(f"laps x16: {title}", loc="left")
        _style(ax)
    for ax in axes[:, 0]:
        ax.set_ylabel("speed-up (x)")
    handles, labels = axes[0][0].get_legend_handles_labels()
    fig.legend(handles, labels, loc="upper center", frameon=False, ncols=3)
    fig.tight_layout(rect=(0, 0, 1, 0.94), h_pad=1.2)
    return _save(fig, "partitioning_laps.png")


# ------------------------------------------------------------------ Figure 9
def ablation_lr_primary() -> Path:
    """Calibrated LR at G=3.5, k=2: the nine paired differences of the report's ablation table."""
    rows = [
        r
        for r in _rows("ablation_paired.csv")
        if r["g"] == "3.5" and r["k"] == "2" and r["model"] == "lr_calibrated"
    ]
    metrics = (("pr_auc", "PR-AUC"), ("brier", "Brier"), ("roc_auc", "ROC-AUC"))
    diffs = ("real_tyre - real", "real_ti - real", "real_ti - real_tyre")
    fig, axes = plt.subplots(1, 3, figsize=(WIDTH_IN, 2.5), sharey=True)
    for ax, (metric, title) in zip(axes, metrics, strict=True):
        for yi, diff in enumerate(diffs):
            match = [r for r in rows if r["metric"] == metric and r["difference"] == diff]
            if not match:
                continue
            r = match[0]
            d, lo, hi = float(r["diff"]), float(r["ci_low"]), float(r["ci_high"])
            excludes_zero = lo > 0 or hi < 0
            color = HIGHLIGHT if excludes_zero else SERIES_COLORS[0]
            ax.plot([lo, hi], [yi, yi], color=color, linewidth=2)
            ax.plot([d], [yi], marker="o", color=color, markersize=6)
        ax.axvline(0, color=MUTED, linewidth=1, linestyle="--")
        ax.set_title(title, loc="left")
        ax.set_xlabel("difference")
        _style(ax)
        ax.grid(False, axis="y")
    axes[0].set_yticks(range(len(diffs)), [d.replace(" - ", " \u2212 ") for d in diffs])
    axes[0].set_ylim(len(diffs) - 0.5, -0.5)
    fig.tight_layout(w_pad=0.8)
    return _save(fig, "ablation_lr_primary.png")


# ------------------------------------------------------------------ Figure 10
def _bins(
    rows: Sequence[Mapping[str, str]], subset: str, response: str, prefix: str
) -> tuple[list[float], list[float], int]:
    """(mean P, observed rate) of the non-empty 10-bin rows, and the subset's n."""
    by = {
        r["metric"]: r
        for r in rows
        if r["check"] == "backtest" and r["subset"] == subset and r["response"] == response
    }
    xs, ys = [], []
    for b in range(10):
        p, o = by.get(f"{prefix}_bin10_{b:02d}_mean_p"), by.get(f"{prefix}_bin10_{b:02d}_observed")
        if p and o and p["value"] and o["value"] and int(p["n"] or 0) > 0:
            xs.append(float(p["value"]))
            ys.append(float(o["value"]))
    n = int(by[f"{prefix}_brier"]["n"])
    return xs, ys, n


def whatif_checks() -> Path:
    """(a) the ordering check as stored (P(pit_next_lap) - P(pit_now) per gap and closing rate);
    (b) the 10-bin backtest reliability, the same three series as results/whatif_consistency.png."""
    rows = _rows("whatif_consistency.csv")
    fig, (ax_o, ax_r) = plt.subplots(1, 2, figsize=(WIDTH_IN, 4.0))
    markers = ("v", "o", "^")
    for i, rate in enumerate(("-0.5", "+0.0", "+0.5")):
        cells = []
        for r in rows:
            if r["check"] != "ordering" or r["metric"] != "p_next_minus_p_now":
                continue
            prefix = f"rate_{rate}_gap_"
            if r["subset"].startswith(prefix):
                cells.append((float(r["subset"][len(prefix) :]), float(r["value"]), r["pass"]))
        cells.sort()
        kind = "pass/fail" if any(c[2] for c in cells) else "info only"
        ax_o.plot(
            [c[0] for c in cells],
            [c[1] for c in cells],
            color=SERIES_COLORS[i],
            marker=markers[i],
            markersize=5,
            linewidth=1.8,
            label=f"closing {rate} s/lap ({kind})",
        )
        for g, v, ok in cells:
            if ok == "false":
                ax_o.plot(
                    [g],
                    [v],
                    marker="o",
                    markersize=12,
                    markerfacecolor="none",
                    markeredgecolor=HIGHLIGHT,
                    markeredgewidth=1.8,
                )
                ax_o.annotate(
                    "fails",
                    (g, v),
                    xytext=(-30, 8),
                    textcoords="offset points",
                    color=HIGHLIGHT,
                    fontsize=8,
                )
    ax_o.axhline(0, color=MUTED, linewidth=1, linestyle="--")
    ax_o.set_title("(a) Ordering: P(pit_next_lap) \u2212 P(pit_now)", loc="left")
    ax_o.set_xlabel("gap at decision (s)")
    ax_o.set_ylabel("difference in P")
    ax_o.legend(
        frameon=False, fontsize=7.5, loc="upper center", bbox_to_anchor=(0.5, -0.2), ncols=1
    )
    _style(ax_o)
    ax_r.plot([0, 1], [0, 1], color=MUTED, linewidth=1, linestyle=":", label="perfect calibration")
    series = (
        ("2021-2024", "primary", "simulator", "simulator 2021-24", "o"),
        ("2021-2024", "model", "model", "model 2021-24", "s"),
        ("2025", "primary", "simulator", "simulator 2025 (held out)", "D"),
    )
    for i, (subset, response, prefix, label, marker) in enumerate(series):
        xs, ys, n = _bins(rows, subset, response, prefix)
        ax_r.plot(
            xs,
            ys,
            color=SERIES_COLORS[i],
            marker=marker,
            markersize=5,
            linewidth=1.8,
            label=f"{label} (n={n})",
        )
    ax_r.set(xlim=(0, 1), ylim=(0, 1))
    ax_r.set_title("(b) Backtest reliability, 10 bins", loc="left")
    ax_r.set_xlabel("mean predicted P")
    ax_r.set_ylabel("observed success rate")
    ax_r.legend(
        frameon=False, fontsize=7.5, loc="upper center", bbox_to_anchor=(0.5, -0.2), ncols=1
    )
    _style(ax_r)
    fig.tight_layout(w_pad=1.2)
    return _save(fig, "whatif_checks.png")


def main() -> None:
    for make in (
        feature_importance,
        scalability_build,
        partitioning_laps,
        ablation_lr_primary,
        whatif_checks,
    ):
        print(f"wrote {make().relative_to(REPO)}")


if __name__ == "__main__":
    main()
