"""Smoke-test a packaged depot-core: it starts, answers, and reaches every tool.

    python scripts/smoke-core.py src-tauri/binaries/depot-core-<triple>[.exe]

Catches what unit tests cannot: a module PyInstaller left out of the bundle
only fails when the frozen binary imports it.
"""
from __future__ import annotations

import json
import subprocess
import sys
import tempfile
from pathlib import Path


def main(binary: str) -> None:
    with tempfile.TemporaryDirectory() as d:
        repo = Path(d) / "repo"
        repo.mkdir()
        (repo / "a.py").write_text("x = 1  # TODO\n", encoding="utf-8")
        requests = [
            ("core.ping", {}),
            ("needle.build_index", {"roots": [str(repo)], "index_path": str(Path(d) / "index.json")}),
            ("relay.history", {"store_dir": str(Path(d) / "relay")}),
            ("pulse.snapshot", {}),
            ("blackbox.scan", {"root": str(repo), "report_path": str(Path(d) / "report.json")}),
            ("forge.list", {"store_dir": str(Path(d) / "forge")}),
            ("switchyard.state", {"state_path": str(Path(d) / "state.json")}),
        ]
        stdin = "".join(json.dumps({"id": i, "method": m, "params": p}) + "\n" for i, (m, p) in enumerate(requests))
        proc = subprocess.run([binary], input=stdin, capture_output=True, text=True, timeout=180)
        replies = {}
        for line in proc.stdout.splitlines():
            message = json.loads(line)
            if "id" in message:
                replies[message["id"]] = message
        failed = False
        for i, (method, _) in enumerate(requests):
            reply = replies.get(i)
            ok = reply is not None and "result" in reply
            failed |= not ok
            print(f"{'ok  ' if ok else 'FAIL'} {method}" + ("" if ok else f": {reply.get('error') if reply else 'no reply'}"))
        if failed:
            print(proc.stderr[-4000:], file=sys.stderr)
            sys.exit(1)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
