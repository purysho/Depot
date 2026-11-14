"""Relay: send HTTP requests and keep the workspace's request history."""
from __future__ import annotations

import urllib.parse
import uuid
from typing import Any

from relay.http_client import RelayError, build_url, perform_request
from relay.models import RequestSpec
from relay.storage import RelayStore

from depot_core import params as p
from depot_core.server import Context, Server, invalid

METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}


def _store(params: dict[str, Any]) -> RelayStore:
    store_dir = p.path(params, "store_dir")
    assert store_dir is not None
    return RelayStore(store_dir)


def _without_query(url: str) -> str:
    """The URL as recorded in events: query values can hold tokens, so drop them."""
    parts = urllib.parse.urlsplit(url)
    return urllib.parse.urlunsplit((parts.scheme, parts.netloc, parts.path, "", ""))


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
    ctx.event("relay.request_sent", {"request_id": request_id, "method": spec.method, "url": _without_query(target)})
    try:
        result = perform_request(spec)
    except RelayError as exc:
        store.add_history(spec)
        ctx.event("relay.request_failed", {"request_id": request_id, "error": str(exc)})
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


def register(server: Server) -> None:
    server.register("relay.send", send)
    server.register("relay.history", history)
