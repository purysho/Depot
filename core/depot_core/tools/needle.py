"""Needle: build an index of the workspace folders and search it."""
from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any

from needle.indexer import SearchIndex

from depot_core import params as p
from depot_core.server import Context, Server, not_found

# Loaded indexes, by path. Loading a large index takes seconds, so it is kept.
_cache: dict[str, SearchIndex] = {}
_lock = threading.Lock()
_build_locks: dict[str, threading.Lock] = {}


def _index_lock(key: str) -> threading.Lock:
    with _lock:
        return _build_locks.setdefault(key, threading.Lock())


def build_index(params: dict[str, Any], ctx: Context) -> dict[str, Any]:
    roots = p.strings(params, "roots")
    index_path = p.path(params, "index_path")
    assert index_path is not None
    key = str(index_path)
    with _index_lock(key):  # one build per index at a time
        incremental = index_path.exists()
        ctx.event("needle.index_started", {"roots": roots, "incremental": incremental})
        index = SearchIndex.load(index_path) if incremental else SearchIndex()
        stats = index.build(roots)
        index.save(index_path)
        with _lock:
            _cache[key] = index
        info = index.stats()
        payload = {
            "roots": roots,
            "documents": info["documents"],
            "terms": info["terms"],
            "scanned": stats.scanned,
            "duration_ms": round(stats.elapsed * 1000),
        }
        ctx.event("needle.index_complete", payload)
        return {**payload, "indexed": stats.indexed, "changed": stats.changed, "removed": stats.removed}


def _load(index_path: Path) -> SearchIndex:
    key = str(index_path)
    with _lock:
        cached = _cache.get(key)
    if cached is not None:
        return cached
    if not index_path.exists():
        raise not_found("This workspace has no index yet. Build it first.")
    index = SearchIndex.load(index_path)
    with _lock:
        _cache[key] = index
    return index


def search(params: dict[str, Any], ctx: Context) -> dict[str, Any]:
    index_path = p.path(params, "index_path")
    assert index_path is not None
    query = params.get("query", "")
    if not isinstance(query, str):
        query = ""
    limit = p.integer(params, "limit", 50, low=1, high=500)
    ext = params.get("ext") if isinstance(params.get("ext"), str) else None
    started = time.monotonic()
    result = _load(index_path).search(query, limit=limit, ext=ext)
    duration_ms = round((time.monotonic() - started) * 1000)
    if result.get("mode") == "search":
        ctx.event(
            "needle.search_complete",
            {"query": query, "result_count": len(result["results"]), "duration_ms": duration_ms},
        )
    return {**result, "duration_ms": duration_ms}


def index_info(params: dict[str, Any], _ctx: Context) -> dict[str, Any] | None:
    index_path = p.path(params, "index_path")
    assert index_path is not None
    if not index_path.exists():
        return None
    info = _load(index_path).stats()
    return {k: info[k] for k in ("documents", "terms", "total_size", "roots", "updated_at")}


def register(server: Server) -> None:
    server.register("needle.build_index", build_index)
    server.register("needle.search", search)
    server.register("needle.index_info", index_info)
