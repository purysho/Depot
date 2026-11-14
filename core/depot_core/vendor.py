"""Make the pinned tool cores importable.

From source, the tools are git submodules under vendor/<tool> at the
repository root. In the packaged sidecar, PyInstaller has already bundled
them, so nothing needs adding.
"""
from __future__ import annotations

import sys
from pathlib import Path

TOOLS = ("needle", "relay", "pulse", "blackbox", "forge", "switchyard")


def vendor_root() -> Path:
    return Path(__file__).resolve().parents[2] / "vendor"


def install() -> None:
    if getattr(sys, "frozen", False):
        return
    root = vendor_root()
    for tool in TOOLS:
        path = str(root / tool)
        if path not in sys.path:
            sys.path.insert(0, path)


def versions() -> dict[str, str]:
    """Version of each pinned tool core, as each one declares it."""
    install()
    found: dict[str, str] = {}
    for tool, module in (("needle", "needle"), ("relay", "relay"), ("pulse", "pulse"), ("forge", "forge")):
        try:
            found[tool] = __import__(module).__version__
        except Exception:  # noqa: BLE001 — report what can be found
            found[tool] = "unknown"
    found["blackbox"] = "pinned"
    found["switchyard"] = "pinned"
    return found
