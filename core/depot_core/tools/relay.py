"""Relay: send HTTP requests and keep the workspace's request history."""
from __future__ import annotations

import threading
import uuid
from typing import Any

from relay.http_client import RelayError, build_url, perform_request
from relay.mock_server import MockResponse, MockServer
from relay.models import RequestSpec
from relay.storage import RelayStore

from depot_core import params as p
from depot_core import redact
from depot_core.server import Context, CoreError, Server, invalid, not_found

METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}


def _store(params: dict[str, Any]) -> RelayStore:
    store_dir = p.path(params, "store_dir")
    assert store_dir is not None
    return RelayStore(store_dir)


def _spec(raw: dict[str, Any]) -> RequestSpec:
    spec = RequestSpec.from_dict(raw)
    spec.method = spec.method.upper()
    if spec.method not in METHODS:
        raise invalid(f"Unsupported method {spec.method}")
    return spec


def send(params: dict[str, Any], ctx: Context) -> dict[str, Any]:
    spec = _spec(p.mapping(params, "request"))
    store = _store(params)
    request_id = uuid.uuid4().hex
    try:
        target = build_url(spec.url, spec.params)
    except RelayError as exc:
        raise invalid(str(exc)) from exc
    # Events are written to the timeline: no user:password@, no query string.
    ctx.event("relay.request_sent", {"request_id": request_id, "method": spec.method, "url": redact.url(target)})
    try:
        result = perform_request(spec)
    except RelayError as exc:
        store.add_history(spec)
        ctx.event("relay.request_failed", {"request_id": request_id, "error": redact.text(str(exc))})
        return {"request_id": request_id, "ok": False, "error": str(exc)}
    store.add_history(spec, result.status, result.elapsed_ms)
    ctx.event(
        "relay.response_received",
        {
            "request_id": request_id,
            "status": result.status,
            "elapsed_ms": round(result.elapsed_ms),
            "size_bytes": result.size_bytes,
        },
    )
    return {"request_id": request_id, "ok": True, "response": result.to_dict()}


def history(params: dict[str, Any], _ctx: Context) -> list[dict[str, Any]]:
    return _store(params).history()


# ── Saved requests (Relay's own store, in the workspace's relay folder) ──

def saved(params: dict[str, Any], _ctx: Context) -> list[dict[str, Any]]:
    return _store(params).saved()


def save(params: dict[str, Any], _ctx: Context) -> list[dict[str, Any]]:
    name = p.string(params, "name")
    assert name is not None
    store = _store(params)
    store.save_request(name.strip()[:200], _spec(p.mapping(params, "request")))
    return store.saved()


def delete_saved(params: dict[str, Any], _ctx: Context) -> list[dict[str, Any]]:
    name = p.string(params, "name")
    store = _store(params)
    store.delete_saved(name or "")
    return store.saved()


# ── Mock server (Relay's MockServer: 127.0.0.1 only) ──

_mocks: dict[int, MockServer] = {}
_mock_lock = threading.Lock()


def _routes_payload(server: MockServer) -> list[dict[str, Any]]:
    return [{"path": path, "status": r.status, "body": r.body} for path, r in sorted(server.routes.items())]


def mock_start(params: dict[str, Any], ctx: Context) -> dict[str, Any]:
    """Start a mock server answering the given routes. Port 0 picks a free one."""
    port = p.integer(params, "port", 0, low=0, high=65535)
    routes = params.get("routes")
    if not isinstance(routes, list) or not routes:
        raise invalid("routes must be a non-empty list")
    server = MockServer(port=port, logger=lambda line: ctx.stream("relay.mock_log", {"line": line}))
    server.routes = {}
    for route in routes:
        if not isinstance(route, dict):
            raise invalid("each route must be an object")
        status = route.get("status", 200)
        if not isinstance(status, int) or not 100 <= status <= 599:
            raise invalid("status must be an HTTP status code (100–599)")
        server.set_route(str(route.get("path") or "/"), MockResponse(status=status, body=str(route.get("body") or "")))
    with _mock_lock:
        if ctx.shutting_down:
            raise CoreError("shutting_down", "depot-core is shutting down")
        if port and port in _mocks:
            raise invalid(f"A mock server is already running on port {port}")
        try:
            server.start()
        except OSError as exc:
            raise invalid(f"Could not listen on port {port}: {exc.strerror or exc}") from exc
        _mocks[server.port] = server
    ctx.event("relay.mock_started", {"port": server.port, "routes": sorted(server.routes)})
    return {"port": server.port, "url": f"http://127.0.0.1:{server.port}", "routes": _routes_payload(server)}


def mock_stop(params: dict[str, Any], ctx: Context) -> dict[str, Any]:
    port = p.integer(params, "port", 0, low=1, high=65535)
    with _mock_lock:
        server = _mocks.pop(port, None)
    if server is None:
        raise not_found(f"No mock server on port {port}")
    server.stop()
    ctx.event("relay.mock_stopped", {"port": port})
    return {"stopped": port}


def mock_list(_params: dict[str, Any], _ctx: Context) -> list[dict[str, Any]]:
    with _mock_lock:
        servers = list(_mocks.values())
    return [{"port": s.port, "url": f"http://127.0.0.1:{s.port}", "routes": _routes_payload(s)} for s in servers]


def stop_all(_server: Server) -> None:
    with _mock_lock:
        servers = list(_mocks.values())
        _mocks.clear()
    for server in servers:
        server.stop()


def register(server: Server) -> None:
    server.register("relay.send", send)
    server.register("relay.history", history)
    server.register("relay.saved", saved)
    server.register("relay.save", save)
    server.register("relay.delete_saved", delete_saved)
    server.register("relay.mock_start", mock_start)
    server.register("relay.mock_stop", mock_stop)
    server.register("relay.mock_list", mock_list)
