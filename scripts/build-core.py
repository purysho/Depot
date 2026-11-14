"""Build depot-core as one executable for Tauri to bundle as a sidecar.

Output: src-tauri/binaries/depot-core-<rust target triple>[.exe], the name
Tauri's `bundle.externalBin` expects. Release builds then run:

    npm run tauri build -- --config src-tauri/tauri.bundle.conf.json

Requires: Python 3.10+, `pip install pyinstaller`, Rust (for the target
triple), and the tool submodules checked out (`git submodule update --init`).
"""
from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
TOOLS = ("needle", "relay", "pulse", "blackbox", "forge", "switchyard")


def target_triple() -> str:
    out = subprocess.run(["rustc", "-vV"], capture_output=True, text=True, check=True).stdout
    return next(line.split(": ", 1)[1] for line in out.splitlines() if line.startswith("host: "))


def main() -> None:
    for tool in TOOLS:
        if not any((ROOT / "vendor" / tool).iterdir()):
            sys.exit(f"vendor/{tool} is empty: run `git submodule update --init`")
    triple = target_triple()
    work = ROOT / "core" / "build"
    paths = [str(ROOT / "core")] + [str(ROOT / "vendor" / t) for t in TOOLS]
    cmd = [
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--console",
        "--name", "depot-core",
        "--distpath", str(work / "dist"), "--workpath", str(work / "tmp"), "--specpath", str(work),
        # The sidecar never shows a window; leave Tk out even where a tool's UI module is importable.
        "--exclude-module", "tkinter",
        *[arg for p in paths for arg in ("--paths", p)],
        "--collect-submodules", "depot_core",
        str(ROOT / "core" / "depot_core" / "__main__.py"),
    ]
    subprocess.run(cmd, check=True, cwd=ROOT)
    suffix = ".exe" if sys.platform == "win32" else ""
    out_dir = ROOT / "src-tauri" / "binaries"
    out_dir.mkdir(exist_ok=True)
    target = out_dir / f"depot-core-{triple}{suffix}"
    shutil.copy2(work / "dist" / f"depot-core{suffix}", target)
    print(f"Built {target.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
