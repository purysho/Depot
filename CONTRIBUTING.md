# Contributing to Depot

## What we need most right now

- Bug reports with reproduction steps and platform details
- Platform-specific edge cases (macOS and Linux especially welcome)
- Feedback on the plugin protocol and event catalogue before the panels are built
- README corrections and documentation improvements

## How to run from source

Requirements: Node.js 22.12+, Rust (stable), and the
[Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform.

```bash
npm install
npm run tauri dev
```

The frontend alone runs in a browser with `npm run dev` (port 1420). Calls to
the Rust side return empty results there, so most UI work does not need the
desktop shell. `http://localhost:1420/#gallery` shows every shared component.

## How to run tests

```bash
npm run typecheck
npm run lint
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

## Pull request checklist

- [ ] Typecheck, lint and both test suites pass locally
- [ ] New behaviour is covered by a test, or the reason it cannot be is explained
- [ ] `CHANGELOG.md` updated under `## [Unreleased]`
- [ ] A new Tauri command has a typed wrapper in `src/ipc.ts` and only the permission it needs in `src-tauri/capabilities/`
- [ ] A new event type is added to the catalogue in `docs/PLUGIN_PROTOCOL.md`
- [ ] UI changes were checked with the keyboard, and a screenshot is attached

## Code style

- Colours, type sizes, spacing and radii come from `src/design/tokens.ts`
  only. Tailwind's default palette is switched off, so a raw `bg-blue-500` will
  not build; a raw hex in a component will fail review.
- Shared components live in `src/design/components/` and use plain Tailwind —
  no component-library dependency.
- Icons are [Lucide](https://lucide.dev/icons/). Check the name exists in the
  `lucide-react` version in `package.json`; several icons were renamed in 1.x.
- Status and tool identity are never shown by colour alone: pair colour with
  an icon, a label or a position.
- All persistent state is owned by Rust and written under `~/.depot/`. React
  stores hold caches and UI state only; do not use `localStorage`.
- Only `src/ipc.ts` calls `invoke`.

## Commit messages

Explain the reasoning and the alternative rejected. A subject line that states
the change is fine; a body that only restates the diff is not useful.

## Reporting security issues

See [SECURITY.md](SECURITY.md). Do not put exploit details in a public issue.
