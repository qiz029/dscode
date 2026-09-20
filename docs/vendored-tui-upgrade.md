# Taking a new upstream release of the vendored terminal — 2026-09-19

Status: living record, written at v0.7.22. The fork lives at `packages/tui`; read
[maintainability.md](maintainability.md) for what is and is not checked around it.

## The decision this records

DSCODE vendors the terminal for [dsh-code](https://github.com/unlinearity/dsh-code) as
**source** (`packages/tui`, manifest version `1.2.0-dscode.0`, MIT) rather than patching
published output, so the UI is edited as code. The alternative — keeping the delta to a
handful of files and taking upstream wholesale — was considered and **not** taken: the
fork now carries DSCODE surfaces (welcome header, activity line, footer telemetry, effort
bar, `/btw`, the email, provider and statusline panels) that reach into `app.ts`,
`index.ts` and `render/status.ts`. Those are the files an upstream release touches.

The consequence, stated plainly: **an upstream release is a manual merge.** This document
is the procedure; it is not automated.

## What DSCODE currently changes

Measured against the vendoring commit (`7083f23`, dsh-code 1.2.0): 16 files,
+818/−151 lines.

| File | Nature of the local delta |
|---|---|
| `src/app.ts` | The largest: DSCODE panels, composer band, command routing, footer |
| `src/index.ts` | Command registration and host wiring |
| `src/render/status.ts` | Footer telemetry, TPS/context columns |
| `src/btw.ts` | **New file** (`/btw` side questions) |
| `src/dscode/*` | DSCODE modules (chat, flags, model-search, paste, telemetry, welcome, clipboard-image) |
| `src/i18n.ts`, `src/locales/*` | DSCODE message keys |
| `src/render/projection.ts`, `src/render/text.ts` | Transcript folding, the wrapping helper |
| `src/kernel-panels.ts`, `src/mentions.ts`, `src/render/usage.ts` | Local fixes the typecheck gate found |

## Procedure

1. **Fetch the target upstream source.** `npm pack dsh-code@<version>` (or check out the
   upstream tag) into a scratch directory — not into `packages/tui`.
2. **Diff upstream-to-upstream.** Compare the new release with the version currently
   vendored (1.2.0) and read that diff first. Its size is the merge's real difficulty; a
   release that rewrites `app.ts` or `render/status.ts` touches everything DSCODE added.
3. **Three-way merge, don't re-apply by hand.** Use the vendoring commit as the base:
   `git merge-file -p packages/tui/src/<file> <upstream-1.2.0>/<file> <upstream-new>/<file>`
   per file, or a scratch branch that commits the upstream tree and merges DSCODE's delta.
   Working file-by-file keeps the 16-file delta visible.
4. **Bump the provenance.** `packages/tui/package.json`: the version suffix
   (`<upstream>-dscode.N`) and the description's upstream version. `scripts/build-packages.mjs`
   derives its third-party notice from that version prefix, so the notice follows.
5. **Run the gates.**
   ```bash
   npm run typecheck          # the whole vendored tree reads its own types
   npm run typecheck:strict   # noImplicitAny over src/dscode + its imports
   npm test                   # 378 unit and component contracts
   npm run build:packages     # regenerates packages/tui/lib and the bundle
   ```
   `tests/patches.test.mjs` and the `replaceOnce` anchors cover the *patched* DSH packages,
   not the fork; they are a separate surface and should be run too.
6. **Smoke-test by hand.** No upstream test suite is vendored, so behaviour upstream
   changed inside a merged file is only caught by looking. Walk these surfaces and compare
   with the previous release: welcome header and art; composer editing, paste collapse and
   the `!` shell mode; `/model` and the effort bar; `/provider` and the Grok panel;
   `/statusline`; the email panel; a compaction confirmation; `/btw`; the footer figures.
7. **Record it.** The release notes name the upstream version taken; `maintainability.md`
   gets the new file and line counts if the tree moved.

## What fails loudly, and what does not

| Surface | Coverage on upgrade |
|---|---|
| Types | `npm run typecheck` — 0 errors expected; a merge that loses an import fails immediately |
| First-party `.mjs` behaviour | `npm test` — 378 tests, 8s |
| Component frames | `tests/tui-render.test.mjs`, `tests/tui-panels.test.mjs` |
| Patched upstream anchors | `replaceOnce` throws on drift; `tests/patches.test.mjs` |
| Upstream-internal behaviour | **Nothing.** Only step 6 catches it |
| Composer key routing | **Nothing** — see the gap below |

## Known gap that makes this harder than it needs to be

`Input` (the composer) takes 83 required props and is not exported; `App` takes 61. There
is no fixture that mounts either without faking the whole application, so the key routing
with the most user-reachable branches has no direct test. Extracting that routing into a
pure function — one that takes the key event plus the current composer state and returns an
action — would make it testable without the fixture, and is the single change that would
most reduce the risk of this procedure. Recorded here rather than done.
