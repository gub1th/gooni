# AGENTS.md

Agent instructions for this repo live in **`CLAUDE.md`** — goal, data model,
architecture index, project rules, validation commands, and schema-change
workflow. Read that; it is kept honest in the same PR as any change that
invalidates it.

(The old operating manual that lived here described the pre-ambient-loop
architecture — Spaces, Todos-in-Gooni, feed-as-home — all nuked in v2,
2026-07. Rather than maintain two overlapping docs, this file is now a
pointer.)

## Desktop app codesigning

The Electron shell (`desktop/`) is signed with a **self-signed** identity,
`Gooni Dev Signing` (no Apple Developer account). Why: macOS ties TCC grants
(camera, Accessibility, Screen Recording) to the code-signature identity, so a
stable self-signed cert keeps grants across rebuilds where unsigned/ad-hoc
builds re-prompted every time. One-time per machine:
`desktop/scripts/setup-signing.sh` (idempotent) creates the identity in the
login keychain; `npm run pack` / `npm run dist` in `desktop/` then sign
automatically via the `build.mac.identity` field in `desktop/package.json`.
Details: `desktop/README.md` ▸ Codesigning.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
