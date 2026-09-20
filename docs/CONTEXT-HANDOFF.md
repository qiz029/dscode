# DSCODE handoff — 2026-09-11 session checkpoint

> **Internal development note.** Not user documentation and not a maintained guide: it records one session's in-flight state and is kept for handoff between coding sessions. Behaviour that contradicts it should follow the code, the user guides under `docs/` and `CHANGELOG.md`.

Compact state for a fresh session. Read this, then `git status --short` and `git diff`.

## Locked decisions (do not re-litigate)

- **Mode A transcript**: Ink `<Static>` scrollback, no mouse capture, no in-place viewport.
  `patch-viewport.mjs` / `patch-scroll.mjs` are deleted; `verify-tui-viewport.mjs` is the Mode A verifier.
- **Money**: always `$X.XX` (2 decimals, never `~`), shown as `$cost / $balance` + peak emoji.
- **Emoji**: 🔥 peak / ❄️ off-peak from the balance response `Date` header clock (`trustedNow()`), 2 columns wide, one space before it.
- **Separators**: telemetry/footer parts join with half-width ` | `; the statusline model divider stays full-width ` ｜ ` (dim divider, asserted by `verify-effort-bar.mjs`).
- **Footer clip order** (drop first → last): average → cache hit → current; `context` and money are protected.
- **Cache hit colors**: `<90` red, `90–95` yellow, `95–98` green, `>98` blue. Only a recognised cache label is tinted.
- **Sandbox escalation**: agent self-review is a deterministic one-shot allowlist (`shell_retry` + `sandbox_permissions`, no shell metachars, budget 2/turn); never under `never` policy.

## Verified this session

- `npm run test:unit` → 161/161 pass.
- `npm run test:ui` → dark/light × 32/48/60/64/80/120 pass (render, scrollback, effort bar).
- `npm run test:integration` → all probes pass; `EXEC_PROBE_SKIPPED` (this shell denies PTY).
- `npm run setup` → local install refreshed; `.runtime/profiles/tui` ready (`npm start`).

## Status

The two-row footer shipped in `bae4f97` (pushed to `origin/main`) together with the
rest of this span of work: row 1 `● <title> ｜ <permission>`, row 2
`provider: model @ effort | current | average | context | $spend / $balance 🔥 | cache hit`,
with the ladder average → cache hit → current → bare-model header → context → header.
`npm run test:unit` 162/162, `npm run test:ui`, `npm run test:integration` and
`npm run test:package` all pass; `npm run setup` refreshed `.runtime/profiles/tui`.

## Environment gotchas

- Sandboxed shells deny PTY (`posix_openpt failed`), so the blocking-stdin exec path needs escalation to verify.
- Never `rg`/`grep` the repo root: the untracked `eval/private` venv is huge.
- Injected TUI source in `scripts/patch-style.mjs` lives inside a template literal — regex backslashes must stay doubled (`\d`), or they silently degrade to `d`.
- Patches are idempotent via `// dscode-*-vN` markers; drift throws `Pinned runtime patch drift`.
- The `review` tool fails with "ran out of output tokens" on this repo's diff size — narrow with `path` or skip.
