"""BLACKBOX: scan a repository with BLACKBOX's own analysis.

The optional Open Code Review integration is not here: Depot's Rust side runs
the separately installed `ocr` binary directly. See src/panels/blackbox/README.md.
"""
from __future__ import annotations

import json
from collections import Counter
from typing import Any

from blackbox_core import scan_repo

from depot_core import params as p
from depot_core.server import Context, Server, invalid

SEVERITIES = ("critical", "high", "medium", "low", "info")
HOTSPOTS_RETURNED = 50


def summarise(report: dict[str, Any]) -> dict[str, Any]:
    """What the panel needs: the full report can hold every file in the repository."""
    counts = Counter(f.get("severity") for f in report["findings"])
    keep = ("path", "language", "loc", "complexity", "git_touches", "inbound", "todo_count", "risk")
    return {
        "root": report["root"],
        "project": report["project"],
        "generated_at": report["generated_at"],
        "summary": report["summary"],
        "by_severity": {s: counts.get(s, 0) for s in SEVERITIES},
        "languages": report["languages"],
        "frameworks": report["frameworks"],
        "git": report["git"],
        "hotspots": [{k: f.get(k) for k in keep} for f in report["files"][:HOTSPOTS_RETURNED]],
        "cycles": report["cycles"][:20],
        "findings": [{**f, "source": "blackbox"} for f in report["findings"]],
    }


def scan(params: dict[str, Any], ctx: Context) -> dict[str, Any]:
    root = p.path(params, "root")
    report_path = p.path(params, "report_path")
    assert root is not None and report_path is not None
    if not root.is_dir():
        raise invalid(f"Not a folder: {root}")
    ctx.event("blackbox.scan_started", {"root": str(root)})
    try:
        report = scan_repo(root)
    except Exception as exc:
        ctx.event("blackbox.scan_failed", {"root": str(root), "error": str(exc)})
        raise
    result = summarise(report)
    report_path.parent.mkdir(parents=True, exist_ok=True)
    tmp = report_path.with_suffix(".tmp")
    tmp.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    tmp.replace(report_path)
    s = report["summary"]
    ctx.event(
        "blackbox.scan_complete",
        {
            "root": report["root"],
            "overall_risk": s["overall_risk"],
            "files": s["files"],
            "loc": s["loc"],
            "findings": result["by_severity"],
            "cycles": s["cycles"],
        },
    )
    return result


def last_report(params: dict[str, Any], _ctx: Context) -> dict[str, Any] | None:
    report_path = p.path(params, "report_path")
    assert report_path is not None
    if not report_path.exists():
        return None
    return json.loads(report_path.read_text(encoding="utf-8"))


def register(server: Server) -> None:
    server.register("blackbox.scan", scan)
    server.register("blackbox.last_report", last_report)
