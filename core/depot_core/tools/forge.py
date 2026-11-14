"""Forge: the workspace's workflows, and running them with live progress."""
from __future__ import annotations

import threading
import time
from typing import Any

from forge.engine import WorkflowRunner
from forge.models import Workflow
from forge.storage import ForgeStore

from depot_core import params as p
from depot_core.server import Context, Server, invalid, not_found

_runs: dict[str, WorkflowRunner] = {}
_lock = threading.Lock()


def _store(params: dict[str, Any]) -> ForgeStore:
    store_dir = p.path(params, "store_dir")
    assert store_dir is not None
    return ForgeStore(store_dir)


def list_workflows(params: dict[str, Any], _ctx: Context) -> list[dict[str, Any]]:
    return [w.to_dict() for w in _store(params).load()]


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


def run(params: dict[str, Any], ctx: Context) -> dict[str, Any]:
    """Runs to completion. Progress arrives as bus events and forge.log lines."""
    run_id = p.string(params, "run_id")
    workflow_id = p.string(params, "workflow_id")
    try:
        workflow = Workflow.from_dict(p.mapping(params, "workflow"))
    except ValueError as exc:
        raise invalid(str(exc)) from exc
    assert run_id is not None

    def on_event(kind: str, data: dict[str, Any]) -> None:
        if kind == "step_started":
            ctx.event("forge.step_started", {"run_id": run_id, "step_index": data["index"], "step_id": data["step_id"], "type": data["type"], "label": data["label"]})
        elif kind == "step_succeeded":
            ctx.event("forge.step_succeeded", {"run_id": run_id, "step_index": data["index"], "step_id": data["step_id"], "duration_ms": data["duration_ms"]})
        elif kind == "step_failed":
            ctx.event(
                "forge.step_failed",
                {
                    "run_id": run_id,
                    "step_index": data["index"],
                    "step_id": data["step_id"],
                    "label": data["label"],
                    "error": data["error"],
                    "pid": data["pid"],
                    "exit_code": data["exit_code"],
                },
            )

    runner = WorkflowRunner(lambda line: ctx.stream("forge.log", {"run_id": run_id, "line": line}), on_event=on_event)
    with _lock:
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
    ctx.event("forge.run_started", {"run_id": run_id, "workflow_id": workflow_id, "name": workflow.name, "steps": len(workflow.steps)})
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


def stop_all(_server: Server) -> None:
    with _lock:
        runners = list(_runs.values())
    for runner in runners:
        runner.stop()


def register(server: Server) -> None:
    server.register("forge.list", list_workflows)
    server.register("forge.save", save_workflows)
    server.register("forge.run", run)
    server.register("forge.stop", stop)
