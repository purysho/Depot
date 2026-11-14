"""Pulse: process and connection snapshots, plus port changes between them."""
from __future__ import annotations

import threading
from typing import Any

from pulse import providers
from pulse.models import ProcessInfo

from depot_core.server import Context, Server

LISTEN_STATES = {"listen", "listening"}

_lock = threading.Lock()
_collect_lock = threading.Lock()


def _port(address: str) -> int | None:
    """Port from '127.0.0.1:8080', '[::]:22', '*:68' or '0.0.0.0:443'."""
    _, sep, tail = address.rpartition(":")
    if not sep or not tail.isdigit():
        return None
    port = int(tail)
    return port if 0 < port < 65536 else None


def _host(address: str) -> str:
    host = address.rpartition(":")[0].strip("[]")
    return host or "*"


def listening_ports(processes: list[ProcessInfo]) -> list[dict[str, Any]]:
    found: dict[tuple[int, int], dict[str, Any]] = {}
    for proc in processes:
        for conn in proc.connections:
            if conn.state.lower() not in LISTEN_STATES or conn.protocol.lower() != "tcp":
                continue
            port = _port(conn.local)
            if port is None:
                continue
            found.setdefault(
                (proc.pid, port),
                {"pid": proc.pid, "process_name": proc.name, "address": _host(conn.local), "port": port, "protocol": "tcp"},
            )
    return sorted(found.values(), key=lambda x: (x["port"], x["pid"]))


def snapshot(_params: dict[str, Any], ctx: Context, collect=None) -> dict[str, Any]:
    # One snapshot at a time: the poller and a manual refresh could otherwise
    # both diff against the same previous set and announce a port twice.
    with _collect_lock:
        return _snapshot(ctx, collect)


def _snapshot(ctx: Context, collect=None) -> dict[str, Any]:
    processes = (collect or providers.collect_processes)()
    listening = listening_ports(processes)
    current = {(x["pid"], x["port"]): x for x in listening}

    server_state = ctx._server.state  # noqa: SLF001 — adapter-owned state
    with _lock:
        previous = server_state.get("pulse.listening")
        server_state["pulse.listening"] = current

    # The first snapshot only establishes the baseline: every port already open
    # is not "new", and announcing them all would flood the timeline.
    if previous is not None:
        for key in sorted(current.keys() - previous.keys()):
            ctx.event("pulse.port_listening", current[key])
        for key in sorted(previous.keys() - current.keys()):
            ctx.event("pulse.port_closed", {"pid": key[0], "port": key[1]})

    ctx.event(
        "pulse.snapshot",
        {"process_count": len(processes), "listening": [{"pid": x["pid"], "port": x["port"]} for x in listening]},
    )
    return {"processes": [proc.to_dict() for proc in processes], "listening": listening}


def register(server: Server) -> None:
    server.register("pulse.snapshot", lambda params, ctx: snapshot(params, ctx))
