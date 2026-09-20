# AGENTS.md

For agents working in this repository. The human contribution flow lives in [CONTRIBUTING.md](CONTRIBUTING.md); this file covers only what a release is most likely to miss.

## Every release maintains the documentation

**Rule: a release is not just a version bump.** These four items ship in the same change as the code; if any one is missing, the tree is not releasable.

1. **Release notes** `docs/releases/<version>.md` must exist. `make attach` refuses outright while the GitHub release does not exist yet: `docs/releases/<version>.md is missing; write the release notes first`. Follow the recent files (for example `docs/releases/0.7.21.md`): a one-sentence summary, then per change what changed, why, and where the behaviour stops, ending with which checks actually ran and which paths have no automated case.
2. **`package.json` `version`** must match the git tag; `make version-check` rejects a mismatch.
3. **`docs/CHANGELOG.md`** gets this version's entry, newest first.
4. **Both READMEs stay in step**: `README.md` and `README.zh-CN.md` are two parallel texts, so a change to a feature description, a command, an install step or an index table on one side needs the other side.

## Cutting a release

Follow the [release checklist](docs/hub-distribution.md). Two rules break most runs: the tag must equal `v<package.json version>` exactly, and a version already on npm from a different build cannot be re-tagged, so bump `package.json` and cut a new tag instead. After pushing the tag, confirm the run with `gh run list --workflow=release.yml` and read a failure with `gh run view --job=<job-id> --log-failed`; a publish job that dies in about 30 seconds at the credential check is usually that version conflict, not a missing secret. `make release`, `make verify` and `npm run doctor` cannot run inside a dscode session because the nested sandbox is refused — run them from a normal terminal.

## Language

Documentation is English: `README.md`, everything under `docs/` including release notes and the changelog, and this file. `README.zh-CN.md` is the one maintained Chinese counterpart and must stay in step with `README.md`. Write new prose in English.

## Keep the two documentation layers apart

- **User guides** (every `docs/*.md` not listed below): written for users, describing current behaviour. A new guide must be linked from both README index tables.
- **Design and verification records** (`docs/session-messaging-design.md`, `docs/cloud-webapp-host.md`, `docs/verification.md`, `docs/CONTEXT-HANDOFF.md`): written for developers, recording the tradeoffs of the time or behaviour that no longer holds. They stay in the README's design-records table, never in the user-guide table.
- Every design record opens with a status line; keep that line true when you edit the file.

## Mechanical check after editing documentation

From the repository root:

```bash
node scripts/check-docs.mjs   # relative links, index coverage in both READMEs, README agreement
npm run lint
```

Commit only once the checker prints `clean` and lint passes. The same check runs as a unit test (`tests/docs-check.test.mjs`), so `npm run test:unit` covers it too. `npm run check` remains the full release gate, but it boots a real Harness and may not finish inside a session because of the sandbox; see [docs/verification.md](docs/verification.md).

## Keep the agent-facing prompt in step

The `dscode:docs` section in `plugins/dscode/index.mjs` tells the running agent which files are user guides and which are internal records. When you add a guide, update that list as well, or the agent will miss it or quote an internal file.
