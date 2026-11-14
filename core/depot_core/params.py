"""Small validators for request params, so a bad call fails with a clear message."""
from __future__ import annotations

from pathlib import Path
from typing import Any

from depot_core.server import invalid


def string(params: dict[str, Any], key: str, *, optional: bool = False) -> str | None:
    value = params.get(key)
    if value is None and optional:
        return None
    if not isinstance(value, str) or not value.strip():
        raise invalid(f"{key} must be a non-empty string")
    return value


def path(params: dict[str, Any], key: str, *, optional: bool = False) -> Path | None:
    value = string(params, key, optional=optional)
    if value is None:
        return None
    p = Path(value).expanduser()
    if not p.is_absolute():
        raise invalid(f"{key} must be an absolute path")
    return p


def strings(params: dict[str, Any], key: str) -> list[str]:
    value = params.get(key)
    if not isinstance(value, list) or not value or not all(isinstance(v, str) and v for v in value):
        raise invalid(f"{key} must be a non-empty list of strings")
    return value


def integer(params: dict[str, Any], key: str, default: int, *, low: int, high: int) -> int:
    value = params.get(key, default)
    if not isinstance(value, int) or isinstance(value, bool) or not low <= value <= high:
        raise invalid(f"{key} must be an integer from {low} to {high}")
    return value


def mapping(params: dict[str, Any], key: str) -> dict[str, Any]:
    value = params.get(key)
    if not isinstance(value, dict):
        raise invalid(f"{key} must be an object")
    return value
