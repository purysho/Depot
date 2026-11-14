"""Switchyard: projects, services and sessions from Switchyard's own state.

Depot reads the same ~/.switchyard/state.json as the standalone app, so
projects and services defined in either appear in both. Sessions started from
Depot run inside depot-core and stop when Depot quits. Running the same session
from Depot and the standalone app at once is not supported; Switchyard's
preflight refuses to start services whose ports are already taken.
"""
from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any

import switchyard_core as sy
import switchyard_runtime as rt

from depot_core import params as p
from depot_core.server import Context, Server, invalid, not_found

# session_id -> running controller and our own bookkeeping
_sessions: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()


def _state_path(params: dict[str, Any]) -> Path:
    return p.path(params, "state_path", optional=True) or sy.STATE_FILE


def _runtime_path(params: dict[str, Any]) -> Path:
    return p.path(params, "runtime_path", optional=True) or rt.RUNTIME_FILE


def _ports(service: Any) -> list[int]:
    check = service.readiness
    if check.kind == "port" and str(check.target).strip().isdigit():
        return [int(str(check.target).strip())]
    return []


def state(params: dict[str, Any], _ctx: Context) -> dict[str, Any]:
    st = sy.load_state(_state_path(params))
    with _lock:
        running = {sid: entry["controller"].status for sid, entry in _sessions.items()}
    return {
        "projects": [
            {"id": pr.id, "name": pr.name, "path": pr.path, "tags": pr.tags, "pinned": pr.pinned, "notes": pr.notes}
            for pr in st.projects
        ],
        "services": [
            {
                "id": s.id,
                "project_id": s.project_id,
                "name": s.name,
                "command": s.command,
                "depends_on": s.depends_on,
                "ports": _ports(s),
                "readiness": sy.readiness_description(s.readiness),
            }
            for s in st.services
        ],
        "sessions": [
            {"id": se.id, "name": se.name, "service_ids": se.service_ids, "status": running.get(se.id, "IDLE")}
            for se in st.sessions
        ],
    }


def _publisher(ctx: Context, session_id: str, controller_box: dict[str, Any]):
    """Maps Switchyard's session events onto Depot's switchyard.* bus events."""

    def service_info(service_id: str | None) -> tuple[Any, int | None]:
        controller = controller_box["controller"]
        service = controller._service(service_id) if service_id else None  # noqa: SLF001
        managed = controller.processes.get(service_id) if service_id else None
        pid = managed.process.pid if managed and managed.process else None
        return service, pid

    started_at: dict[str, float] = {}

    def on_event(event: Any) -> None:
        kind = event.kind
        controller = controller_box["controller"]
        service, pid = service_info(event.service_id)
        base = (
            {"service_id": service.id, "name": service.name, "pid": pid, "ports": _ports(service)} if service else None
        )
        if kind == "session-start":
            names = [s.name for s in sy.topological_service_order(controller.state.services, controller.session.service_ids)]
            ctx.event("switchyard.session_started", {"session_id": session_id, "name": controller.session.name, "services": names})
        elif kind == "session-stop":
            reason = "failure" if controller_box.get("failed") else "user"
            ctx.event("switchyard.session_stopped", {"session_id": session_id, "reason": reason})
        elif base and kind == "service-start":
            started_at[service.id] = time.monotonic()
            ctx.event("switchyard.service_started", base)
        elif base and kind in ("ready", "restart-ready"):
            startup = round((time.monotonic() - started_at.get(service.id, time.monotonic())) * 1000)
            ctx.event("switchyard.service_ready", {**base, "startup_ms": startup})
        elif base and kind in ("service-exit", "not-ready", "restart-failed") and not controller_box.get("stopping"):
            reason = "exited" if kind == "service-exit" else "readiness_timeout"
            managed = controller.processes.get(service.id)
            code = managed.returncode if managed else None
            controller_box["failed"] = True
            ctx.event("switchyard.service_unhealthy", {**base, "reason": reason, "exit_code": code})
        elif base and kind == "service-stop":
            ctx.event("switchyard.service_stopped", {"service_id": service.id, "name": service.name, "exit_code": None})
        ctx.stream(
            "switchyard.session_event",
            {"session_id": session_id, "service_id": event.service_id, "kind": kind, "message": event.message, "ts": event.timestamp},
        )

    return on_event


def start_session(params: dict[str, Any], ctx: Context) -> dict[str, Any]:
    session_id = p.string(params, "session_id")
    st = sy.load_state(_state_path(params))
    runtime = rt.load_runtime(_runtime_path(params))
    session = next((s for s in st.sessions if s.id == session_id), None)
    if session is None:
        raise not_found(f"No Switchyard session {session_id}")
    checks = rt.session_preflight(st, session, runtime)
    blockers = [c for c in checks if c.level == "ERROR"]
    checks_out = [{"level": c.level, "name": c.name, "detail": c.detail, "service_id": c.service_id} for c in checks]
    if blockers:
        return {"started": False, "checks": checks_out}
    with _lock:
        if session_id in _sessions and _sessions[session_id]["controller"].running:
            raise invalid(f"{session.name} is already running")
        box: dict[str, Any] = {}
        controller = rt.ResilientSessionController(
            st,
            session,
            runtime,
            on_event=_publisher(ctx, session.id, box),
            on_line=lambda service, line: ctx.stream(
                "switchyard.log", {"session_id": session.id, "service_id": service.id, "line": line}
            ),
        )
        box["controller"] = controller
        _sessions[session.id] = box
    controller.start()
    return {"started": True, "checks": checks_out}


def stop_session(params: dict[str, Any], _ctx: Context) -> dict[str, Any]:
    session_id = p.string(params, "session_id")
    with _lock:
        box = _sessions.get(session_id or "")
    if box is None:
        raise not_found(f"Session {session_id} is not running in Depot")
    box["stopping"] = True
    box["controller"].stop()
    return {"stopped": session_id}


def status(_params: dict[str, Any], _ctx: Context) -> list[dict[str, Any]]:
    out = []
    with _lock:
        boxes = list(_sessions.items())
    for session_id, box in boxes:
        controller = box["controller"]
        services = []
        for sid in controller.session.service_ids:
            service = controller._service(sid)  # noqa: SLF001
            managed = controller.processes.get(sid)
            services.append(
                {
                    "id": sid,
                    "name": service.name if service else sid,
                    "status": controller.service_status(sid),
                    "pid": managed.process.pid if managed and managed.process and managed.running else None,
                }
            )
        out.append({"session_id": session_id, "status": controller.status, "services": services})
    return out


def stop_all(_server: Server) -> None:
    with _lock:
        boxes = list(_sessions.values())
    for box in boxes:
        box["stopping"] = True
        try:
            box["controller"].stop()
        except Exception:  # noqa: BLE001 — best effort on shutdown
            pass


def register(server: Server) -> None:
    server.register("switchyard.state", state)
    server.register("switchyard.start_session", start_session)
    server.register("switchyard.stop_session", stop_session)
    server.register("switchyard.status", status)
