"""scripts/release-config.py: signing is added only when its settings exist."""
from __future__ import annotations

import importlib.util
import os
import unittest
from pathlib import Path
from unittest import mock

SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "release-config.py"
spec = importlib.util.spec_from_file_location("release_config", SCRIPT)
release_config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release_config)

MAC = {"APPLE_SIGNING_IDENTITY": "Developer ID Application: Example (TEAM123456)", "APPLE_API_KEY_PATH": "/tmp/k.p8"}
WIN = {
    "AZURE_TRUSTED_SIGNING_ENDPOINT": "https://eus.codesigning.azure.net",
    "AZURE_TRUSTED_SIGNING_ACCOUNT": "acct",
    "AZURE_TRUSTED_SIGNING_PROFILE": "prof",
}


class ReleaseConfigTests(unittest.TestCase):
    def build(self, platform, env):
        with mock.patch.dict(os.environ, env, clear=True):
            return release_config.build(platform)

    def test_no_secrets_means_the_bundle_config_unchanged(self):
        for platform in ("darwin", "win32", "linux"):
            config, enabled = self.build(platform, {})
            self.assertEqual(config["bundle"], {"externalBin": ["binaries/depot-core"]})
            self.assertEqual(enabled, [])

    def test_macos_signing_uses_the_hardened_runtime_and_entitlements(self):
        config, enabled = self.build("darwin", MAC)
        mac = config["bundle"]["macOS"]
        self.assertEqual(mac["signingIdentity"], MAC["APPLE_SIGNING_IDENTITY"])
        self.assertTrue(mac["hardenedRuntime"])
        self.assertTrue((SCRIPT.parents[1] / "src-tauri" / mac["entitlements"]).is_file())
        self.assertEqual(enabled, ["macOS signing", "macOS notarization"])
        self.assertEqual(config["bundle"]["externalBin"], ["binaries/depot-core"])

    def test_windows_signing_needs_all_three_settings(self):
        config, enabled = self.build("win32", WIN)
        self.assertIn("-e https://eus.codesigning.azure.net -a acct -c prof", config["bundle"]["windows"]["signCommand"])
        self.assertTrue(config["bundle"]["windows"]["signCommand"].endswith("%1"))
        partial = dict(WIN)
        del partial["AZURE_TRUSTED_SIGNING_PROFILE"]
        self.assertEqual(self.build("win32", partial)[1], [])

    def test_settings_for_another_platform_are_ignored(self):
        self.assertEqual(self.build("linux", {**MAC, **WIN})[1], [])
        self.assertNotIn("windows", self.build("darwin", {**MAC, **WIN})[0]["bundle"])


if __name__ == "__main__":
    unittest.main()
