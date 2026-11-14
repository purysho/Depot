"""JSON-lines request/response server on stdin/stdout.

Messages, one JSON object per line:

  host → core   {"id": 7, "method": "needle.search", "params": {...}}
  core → host   {"id": 7, "result": ...}
                {"id": 7, "error": {"kind": "invalid", "message": "..."}}
  core → host   {"event": "needle.search_complete", "payload": {...}}   bus event
                {"stream": "forge.log", "params": {...}}                UI-only stream

Requests run on a thread pool, so a long scan does not block a search.
Writes to stdout are serialised by one lock, so lines never interleave.
Nothing else may print to stdout: stray output would corrupt the protocol,
so sys.stdout is redirected to stderr while handlers run.
"""
from __future__ import annotations

import json
import os
import signal
import sys
import threading
import traceback
from concurrent.futures import ThreadPoolExecutor
from typing import IO, Any, Callable

from depot_core import __version__, vendor


class CoreError(Exception):
    """An error reported to the host with a kind it can act on."""

    def __init__(self, kind: str, message: str):
        super().__init__(message)
        self.kind = kind
        self.message = message


def invalid(message: str) -> CoreError:
    return CoreError("invalid", message)


def not_found(message: str) -> CoreError:
    return CoreError("not_found", message)


class Context:
    """Passed to every handler: how to publish bus events and UI streams."""

    def __init__(self, server: "Server"):
        self._server = server

    def event(self, event_type: str, payload: dict[str, Any]) -> None:
        self._server.send({"event": event_type, "payload": payload})

    def stream(self, name: str, params: dict[str, Any]) -> None:
        self._server.send({"stream": name, "params": params})


Handler = Callable[[dict[str, Any], Context], Any]


class Server:
    # Long-running work (a Forge run) holds a worker until it ends, so keep
    # enough that quick requests such as Pulse snapshots are never starved.
    def __init__(self, out: IO[str], workers: int = 16):
        self._out = out
        self._lock = threading.Lock()
        self._handlers: dict[str, Handler] = {}
        self._pool = ThreadPoolExecutor(max_workers=workers, thread_name_prefix="depot-core")
        self.context = Context(self)
        self.state: dict[str, Any] = {}  # per-tool state that outlives one request
        self.host_gone = False

    def register(self, method: str, handler: Handler) -> None:
        if method in self._handlers:
            raise ValueError(f"duplicate method {method}")
        self._handlers[method] = handler

    def methods(self) -> list[str]:
        return sorted(self._handlers)

    def send(self, message: dict[str, Any]) -> None:
        """Write one message. Never raises: once Depot has gone, messages are
        dropped, so shutdown code that publishes events ("stopping web…")
        still gets on with stopping things."""
        line = json.dumps(message, ensure_ascii=False, separators=(",", ":"), default=str)
        with self._lock:
            if self.host_gone:
                return
            try:
                self._out.write(line + "\n")
                self._out.flush()
            except (OSError, ValueError):  # broken pipe, or stdout already closed
                self.host_gone = True

    def handle_line(self, line: str) -> None:
        line = line.strip()
        if not line:
            return
        try:
            message = json.loads(line)
        except json.JSONDecodeError as exc:
            self.send({"id": None, "error": {"kind": "invalid", "message": f"not JSON: {exc}"}})
            return
        request_id = message.get("id") if isinstance(message, dict) else None
        if not isinstance(message, dict) or not isinstance(message.get("method"), str):
            self.send({"id": request_id, "error": {"kind": "invalid", "message": "expected {id, method, params}"}})
            return
        self._pool.submit(self._dispatch, request_id, message["method"], message.get("params") or {})

    def _dispatch(self, request_id: Any, method: str, params: Any) -> None:
        handler = self._handlers.get(method)
        if handler is None:
            self.send({"id": request_id, "error": {"kind": "unknown_method", "message": f"no method {method}"}})
            return
        if not isinstance(params, dict):
            self.send({"id": request_id, "error": {"kind": "invalid", "message": "params must be an object"}})
            return
        try:
            result = handler(params, self.context)
        except CoreError as exc:
            self.send({"id": request_id, "error": {"kind": exc.kind, "message": exc.message}})
        except Exception as exc:  # noqa: BLE001 — any failure is reported, never crashes the core
            traceback.print_exc(file=sys.stderr)
            self.send({"id": request_id, "error": {"kind": "failed", "message": f"{type(exc).__name__}: {exc}"}})
        else:
            self.send({"id": request_id, "result": result})

    def shutdown(self) -> None:
        # Long-running work (workflows, sessions) is stopped by the caller
        # first; requests already received still get their reply.
        self._pool.shutdown(wait=True)


def build_server(out: IO[str]) -> Server:
    vendor.install()
    from depot_core.tools import blackbox, forge, needle, pulse, relay, switchyard

    server = Server(out)
    server.register("core.ping", lambda _p, _c: {"version": __version__, "tools": vendor.versions()})
    for module in (needle, relay, pulse, blackbox, forge, switchyard):
        module.register(server)
    return server


def stop_everything(server: Server) -> None:
    """Stop running workflows and sessions: nothing Depot started outlives it."""
    from depot_core.tools import forge, switchyard

    forge.stop_all(server)
    switchyard.stop_all(server)


def main() -> None:
    # Keep the protocol stream for ourselves; anything a tool core prints goes to stderr.
    protocol_out = sys.stdout
    sys.stdout = sys.stderr
    server = build_server(protocol_out)

    def on_terminate(_signum: int, _frame: object) -> None:
        stop_everything(server)
        os._exit(0)

    # Asked to stop by the OS (logout, `kill`): clean up the same way.
    signal.signal(signal.SIGTERM, on_terminate)
    try:
        for line in sys.stdin:
            server.handle_line(line)
    finally:
        # stdin closed: Depot quit, crashed or restarted us.
        stop_everything(server)
        server.shutdown()
