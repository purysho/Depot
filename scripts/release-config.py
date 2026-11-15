"""Write the Tauri config for a release build, with signing when it is set up.

    python scripts/release-config.py OUT.json

Starts from src-tauri/tauri.bundle.conf.json (which bundles depot-core) and
adds, only when the matching environment variables are set:

- macOS (APPLE_SIGNING_IDENTITY): the signing identity, hardened runtime and
  src-tauri/entitlements.plist. Notarization is then done by Tauri from
  APPLE_API_ISSUER / APPLE_API_KEY / APPLE_API_KEY_PATH, which the workflow
  sets.
- Windows (AZURE_TRUSTED_SIGNING_ENDPOINT, _ACCOUNT, _PROFILE): a signCommand
  that signs each file with Azure Trusted Signing through trusted-signing-cli.
  Tauri replaces %1 with the file to sign.

With none of them set, the output is the bundle config unchanged: an
unsigned build, as before. Prints what it enabled. See docs/RELEASING.md.
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def env(name: str) -> str:
    return os.environ.get(name, "").strip()


def build(platform: str) -> tuple[dict, list[str]]:
    config = json.loads((ROOT / "src-tauri" / "tauri.bundle.conf.json").read_text(encoding="utf-8"))
    bundle = config.setdefault("bundle", {})
    enabled: list[str] = []
    if platform == "darwin" and env("APPLE_SIGNING_IDENTITY"):
        bundle["macOS"] = {
            "signingIdentity": env("APPLE_SIGNING_IDENTITY"),
            "hardenedRuntime": True,
            "entitlements": "entitlements.plist",
        }
        enabled.append("macOS signing")
        if env("APPLE_API_KEY_PATH"):
            enabled.append("macOS notarization")
    trusted = [env(f"AZURE_TRUSTED_SIGNING_{k}") for k in ("ENDPOINT", "ACCOUNT", "PROFILE")]
    if platform == "win32" and all(trusted):
        endpoint, account, profile = trusted
        bundle["windows"] = {
            "signCommand": f"trusted-signing-cli -e {endpoint} -a {account} -c {profile} -d Depot %1",
        }
        enabled.append("Windows signing")
    return config, enabled


def main() -> None:
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    config, enabled = build(sys.platform)
    Path(sys.argv[1]).write_text(json.dumps(config, indent=2) + "\n", encoding="utf-8")
    print("Signing: " + (", ".join(enabled) if enabled else "none (unsigned build)"))


if __name__ == "__main__":
    main()
