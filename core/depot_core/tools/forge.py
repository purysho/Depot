"""Forge: the workspace's workflows, and running them with live progress."""
from __future__ import annotations

import json
import re
import threading
import time
from pathlib import Path
from typing import Any

from forge.engine import WorkflowRunner
from forge.models import Workflow
from forge.storage import ForgeStore

from depot_core import params as p
from depot_core import redact
from depot_core.server import Context, CoreError, Server, invalid, not_found

# Fields each step type cannot run without. Forge's engine refuses blank
# paths too; checking here as well reports every problem before anything runs.
REQUIRED = {
    "command": ("command",),
    "copy": ("source", "target"),
    "move": ("source", "target"),
    "mkdir": ("path",),
    "write": ("path",),
    "delete": ("path",),
    "http": ("url",),
    "open": ("path",),
}
PATH_FIELDS = ("path", "source", "target")
_SCHEME = re.compile(r"^[a-zA-Z][a-zA-Z0-9+.-]*:")


def check_required(workflow: dict[str, Any]) -> None:
    problems = []
    for i, step in enumerate(workflow.get("steps") or [], 1):
        config = step.get("config") or {}
        for key in REQUIRED.get(step.get("type"), ()):
            if not str(config.get(key) or "").strip():
                problems.append(f"step {i} ({step.get('type')}): {key} is empty")
    if problems:
        raise invalid("; ".join(problems))


def anchor(workflow: dict[str, Any], base: Path) -> dict[str, Any]:
    """Resolve each step against the workspace folder instead of wherever
    depot-core happens to run: a command with no working folder runs in the
    workspace, and relative paths are relative to it. The workflow on disk is
    unchanged. depot-core's own working folder is never changed (it is shared
    by every thread)."""
    steps = []
    for step in workflow.get("steps") or []:
        config = dict(step.get("config") or {})
        if step.get("type") == "command":
            cwd = str(config.get("cwd") or "").strip()
            config["cwd"] = str(base / Path(cwd).expanduser()) if cwd else str(base)
        for key in PATH_FIELDS:
            raw = str(config.get(key) or "").strip()
            if not raw or (step.get("type") == "open" and _SCHEME.match(raw) and not Path(raw).drive):
                continue  # blank is refused elsewhere; URLs are opened as they are
            path = Path(raw).expanduser()
            config[key] = str(path if path.is_absolute() else base / path)
        steps.append({**step, "config": config})
    return {**workflow, "steps": steps}


def event_label(step: dict[str, Any], index: int) -> str:
    """The name shown in events and the timeline. A step's own name if it has
    one, else its type and number: Forge's automatic label is the command
    line itself, which can carry passwords and tokens."""
    name = str(step.get("name") or "").strip()
    return redact.text(name) if name else f"{step.get('type', 'step')} step {index + 1}"

_runs: dict[str, WorkflowRunner] = {}
_lock = threading.Lock()


def _store(params: dict[str, Any]) -> ForgeStore:
    store_dir = p.path(params, "store_dir")
    assert store_dir is not None
    return ForgeStore(store_dir)


def list_workflows(params: dict[str, Any], _ctx: Context) -> list[dict[str, Any]]:
    return [w.to_dict() for w in _store(params).load()]


def import_workflow(params: dict[str, Any], _ctx: Context) -> list[dict[str, Any]]:
    """Add a workflow from a .forge.json file (Forge's own export format) to
    the workspace's workflows. Importing never runs anything."""
    path = p.path(params, "path")
    assert path is not None
    store = _store(params)
    try:
        workflow = ForgeStore.import_workflow(path)
    except FileNotFoundError as exc:
        raise not_found(f"File not found: {path}") from exc
    except (ValueError, json.JSONDecodeError) as exc:
        raise invalid(f"Not a Forge workflow: {exc}") from exc
    workflows = store.load() + [workflow]
    store.save(workflows)
    return [w.to_dict() for w in workflows]


def export_workflow(params: dict[str, Any], _ctx: Context) -> dict[str, Any]:
    """Write one workflow to a .forge.json file that standalone Forge can import."""
    path = p.path(params, "path")
    index = p.integer(params, "index", 0, low=0, high=10_000)
    assert path is not None
    workflows = _store(params).load()
    if index >= len(workflows):
        raise not_found("That workflow no longer exists")
    ForgeStore.export_workflow(workflows[index], path)
    return {"path": str(path), "name": workflows[index].name}


def save_workflows(params: dict[str, Any], _ctx: Context) -> dict[str, Any]:
    raw = params.get("workflows")
    if not isinstance(raw, list) or not all(isinstance(w, dict) for w in raw):
        raise invalid("workflows must be a list of objects")
    try:
        workflows = [Workflow.from_dict(w) for w in raw]
    except ValueError as exc:  # unknown step type
        raise invalid(str(exc)) from exc
    _store(params).save(workflows)
    return {"saved": len(workflows)}


def _prepare(params: dict[str, Any]) -> tuple[Workflow, dict[str, Any], Path]:
    base = p.path(params, "base_dir")
    raw = p.mapping(params, "workflow")
    check_required(raw)
    assert base is not None
    if not base.is_dir():
        raise invalid(f"Workspace folder not found: {base}")
    try:
        return Workflow.from_dict(anchor(raw, base)), raw, base
    except ValueError as exc:  # unknown step type
        raise invalid(str(exc)) from exc


def validate(params: dict[str, Any], _ctx: Context) -> dict[str, Any]:
    """Everything forge.run checks before starting, without running anything."""
    workflow, _, _ = _prepare(params)
    return {"steps": len(workflow.steps)}


def run(params: dict[str, Any], ctx: Context) -> dict[str, Any]:
    """Runs to completion. Progress arrives as bus events and forge.log lines."""
    run_id = p.string(params, "run_id")
    workflow_id = p.string(params, "workflow_id")
    assert run_id is not None
    workflow, raw, _ = _prepare(params)
    labels = [event_label(s, i) for i, s in enumerate(raw.get("steps") or [])]

    def on_event(kind: str, data: dict[str, Any]) -> None:
        if kind == "step_started":
            ctx.event("forge.step_started", {"run_id": run_id, "step_index": data["index"], "step_id": data["step_id"], "type": data["type"], "label": labels[data["index"]]})
        elif kind == "step_succeeded":
            ctx.event("forge.step_succeeded", {"run_id": run_id, "step_index": data["index"], "step_id": data["step_id"], "duration_ms": data["duration_ms"]})
        elif kind == "step_failed":
            ctx.event(
                "forge.step_failed",
                {
                    "run_id": run_id,
                    "step_index": data["index"],
                    "step_id": data["step_id"],
                    "label": labels[data["index"]],
                    "error": redact.text(data["error"]),
                    "pid": data["pid"],
                    "exit_code": data["exit_code"],
                },
            )

    runner = WorkflowRunner(lambda line: ctx.stream("forge.log", {"run_id": run_id, "line": line}), on_event=on_event)
    with _lock:
        # Checked under the same lock stop_all takes its list with, so a run
        # cannot slip in after shutdown has collected what to stop.
        if ctx.shutting_down:
            raise CoreError("shutting_down", "depot-core is shutting down")
        if run_id in _runs:
            raise invalid(f"run {run_id} is already running")
        _runs[run_id] = runner

    finished: dict[str, Any] = {"outcome": "failed", "failed_steps": 0}

    def capture(kind: str, data: dict[str, Any]) -> None:
        on_event(kind, data)
        if kind == "run_finished":
            finished.update(data)

    runner.on_event = capture
    started = time.monotonic()
    ctx.event("forge.run_started", {"run_id": run_id, "workflow_id": workflow_id, "name": redact.text(workflow.name), "steps": len(workflow.steps)})
    try:
        runner.run(workflow)
    finally:
        with _lock:
            _runs.pop(run_id, None)
        duration_ms = round((time.monotonic() - started) * 1000)
        ctx.event(
            "forge.run_finished",
            {"run_id": run_id, "outcome": finished["outcome"], "failed_steps": finished["failed_steps"], "duration_ms": duration_ms},
        )
    return {"run_id": run_id, "outcome": finished["outcome"], "failed_steps": finished["failed_steps"], "duration_ms": duration_ms}


def stop(params: dict[str, Any], _ctx: Context) -> dict[str, Any]:
    run_id = p.string(params, "run_id")
    with _lock:
        runner = _runs.get(run_id or "")
    if runner is None:
        raise not_found(f"no running workflow {run_id}")
    runner.stop()
    return {"stopping": run_id}


def active(_params: dict[str, Any], _ctx: Context) -> list[str]:
    """Run ids still running, so the panel can reattach after being reopened."""
    with _lock:
        return list(_runs)


def stop_all(_server: Server, wait: float = 15.0) -> None:
    """Stop every run (each kills its command's whole process group) and wait
    for them to finish."""
    with _lock:
        runners = list(_runs.values())
    for runner in runners:
        runner.stop()
    deadline = time.monotonic() + wait
    while time.monotonic() < deadline:
        with _lock:
            if not any(r in _runs.values() for r in runners):
                return
        time.sleep(0.05)


def register(server: Server) -> None:
    server.register("forge.list", list_workflows)
    server.register("forge.save", save_workflows)
    server.register("forge.run", run)
    server.register("forge.stop", stop)
    server.register("forge.active", active)
    server.register("forge.validate", validate)
    server.register("forge.import", import_workflow)
    server.register("forge.export", export_workflow)
