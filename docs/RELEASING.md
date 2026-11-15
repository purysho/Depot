# Releasing Depot

1. Update `CHANGELOG.md` and the version in `package.json`,
   `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`.
2. Push a tag: `git tag v0.1.0 && git push origin v0.1.0`.
3. `.github/workflows/release.yml` runs every test, builds depot-core and the
   bundles on Windows, macOS (Apple Silicon) and Linux, and attaches them to a
   **draft** GitHub Release.
4. Check the build log of each platform: the step **Write the release config**
   prints which signing was used. Install a bundle, then publish the draft.

## Code signing

Signing switches on per platform when its repository secrets exist
(Settings → Secrets and variables → Actions). With none set, bundles are
unsigned, as they are today. Linux bundles are not signed.

**This setup has not been run with real certificates yet.** The workflow
checks every signature it makes (`codesign --verify`, `stapler validate`,
`Get-AuthenticodeSignature`) and fails the release if one is missing, so the
first signed release will show any gap rather than ship it.

### macOS: Developer ID and notarization

| Secret | Value |
|---|---|
| `APPLE_CERTIFICATE` | Your *Developer ID Application* certificate exported as `.p12`, base64-encoded (`base64 -i cert.p12`) |
| `APPLE_CERTIFICATE_PASSWORD` | The password you set when exporting the `.p12` |
| `APPLE_SIGNING_IDENTITY` | The identity name, e.g. `Developer ID Application: Your Name (TEAMID1234)` (`security find-identity -v -p codesigning`) |
| `APPLE_API_ISSUER` | App Store Connect API: the Issuer ID shown above the keys table |
| `APPLE_API_KEY` | The key's Key ID |
| `APPLE_API_KEY_P8` | The contents of the downloaded `AuthKey_<id>.p8` file |

The first three sign; the last three also notarize. Signing without
notarization works but Gatekeeper will still warn on other Macs, and the
workflow prints a warning.

How it works: the workflow imports the certificate into a temporary keychain
**before** building depot-core, so PyInstaller signs the sidecar and every
library packed into it (`DEPOT_CODESIGN_IDENTITY`, `scripts/build-core.py`),
with the hardened runtime and `src-tauri/entitlements.plist`. Then
`scripts/release-config.py` adds the identity, hardened runtime and
entitlements to the Tauri config, Tauri signs the app around the sidecar, and
notarizes it with the API key.

### Windows: Azure Trusted Signing

| Secret | Value |
|---|---|
| `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` | An Entra app registration with the *Trusted Signing Certificate Profile Signer* role on the account |
| `AZURE_TRUSTED_SIGNING_ENDPOINT` | The account's endpoint, e.g. `https://eus.codesigning.azure.net` |
| `AZURE_TRUSTED_SIGNING_ACCOUNT` | The Trusted Signing account name |
| `AZURE_TRUSTED_SIGNING_PROFILE` | The certificate profile name |

The workflow installs `trusted-signing-cli`, and `scripts/release-config.py`
sets Tauri's `bundle.windows.signCommand` to it; Tauri runs it for each file
it signs. The check step then requires a valid signature on the installers,
`depot.exe` and `depot-core.exe`.

To use a different signing service, change the `signCommand` written by
`scripts/release-config.py`; its tests are in `core/tests/test_release_config.py`.
