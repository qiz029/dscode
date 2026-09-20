# Contributing

DSCODE is a macOS harness composed around DeepSeek Harness (DSH) packages: it patches, composes and adds plugins rather than forking the upstream runtime. Contributions are welcome.

## Requirements

- macOS 14 or later
- Node 22.19+ or 24+ (install from the checked-in lockfile)
- Chrome, if you exercise the Chrome MCP tools

## Setup

```bash
git clone https://github.com/qiz029/dscode.git
cd dscode
npm ci
npm run doctor      # optional: boots the real profile and reports local readiness
```

## Checks before opening a pull request

```bash
npm run lint
npm run check       # lint + typecheck + coverage + integration + package + eval
npm run test:e2e    # optional locally, needs a Docker daemon; CI runs it for you
```

`main` is protected, so a pull request merges only once two checks are green:

| Check | What it runs |
|---|---|
| `Checks` (`checks (22.19.0)`, `checks (24)`) | `npm run check` on macOS 14, both Node versions |
| `Linux e2e` (`linux-container`) | The same gate plus the installed-bundle Hub lifecycle inside `docker/e2e.Dockerfile`, on Linux |

The Linux job is also the only place `verify:hub` runs at all: it needs a sandbox nesting a dscode session refuses. Run it locally with `npm run test:e2e` when a Docker daemon is available. `npm run eval:compaction` runs the compaction evaluation on the offline pipeline; the live LongMemEval setup lives under `eval/`.

## House rules

- **Match the surrounding code.** Comment density, naming and formatting follow the file you are editing.
- **Keep patches explainable.** Upstream runtime behaviour is changed through the patch scripts; a patch must fail loudly when upstream drifts, never silently.
- **Cover the change.** Add or extend the nearest existing test; this repository tests behaviour, not implementation text.
- **Do not commit generated output** (`packages/tui/lib/`, `artifacts/`, `.runtime/`).

## Commit and pull request style

History uses a descriptive subject line plus a body explaining the situation, the change and why. Please do the same, and state which checks you ran.

## Releases

Releases are cut by the maintainer with `make release` and published with `make publish`; see [docs/hub-distribution.md](docs/hub-distribution.md). You do not need to bump versions in a pull request.

## Security

See [SECURITY.md](SECURITY.md).
