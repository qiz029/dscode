# Maintainability and the vendored terminal — 2026-09-19

Status: living record. Reviewed against v0.7.22 (`3660300`); update it whenever the
checks or the vendored terminal change.

## Why this record exists

`packages/tui` is DSCODE's forked terminal, vendored as TypeScript source so it is
edited rather than patched as published output. Two paths erase types without
reading them — Node's type stripping at run time, `ts.transpileModule` in
`scripts/build-tui.mjs` at build time — and ESLint matches `**/*.mjs`, so until
2026-09-19 no compiler read any of its 28,506 lines. This records what is checked
now, what the numbers mean, and what is still unverified.

## What the checks cover

| Layer | Read by | At v0.7.22 |
|---|---|---|
| First-party `.mjs` (plugins, launcher, bundle, scripts, bin) | `npm run test:coverage` | 378 tests, 0 fail; 8969/10762 lines (83.34%); floor 75% |
| Vendored terminal `packages/tui/src` (68 `.ts`, 28,506 lines) | `npm run typecheck`, `npm run typecheck:strict`, `tests/tui-typecheck.test.mjs`, the component tests | 0 type errors; outside the coverage inventory |
| `docs/` and both READMEs | `scripts/check-docs.mjs` (run as a unit test) | links, index coverage, README agreement |
| Patch anchors against the pinned upstream | `tests/patches.test.mjs`, plus `replaceOnce` drift errors | fails loudly on an upstream bump |

The component tests mount real panels against an in-memory TTY (`tests/fixtures/tui-mount.mjs`, extracted from `tests/tui-render.test.mjs`). `tests/tui-render.test.mjs` covers the effort bar, the status line, the `/btw` panel, the activity line and the model picker; `tests/tui-panels.test.mjs` covers three keyboard surfaces nothing mounted before — the Grok panel, the statusline picker and the provider panel. `tests/tui-text.test.mjs` pins the wrapping helper, and `tests/dscode-paste.test.mjs` pins the paste markers (atomic under one backspace, expandable on submit).

The coverage percentage never described the whole repository. `scripts/checks.mjs`
now prints the unmeasured TypeScript tree beside it, and the `unmeasured` block of
`artifacts/local/coverage/summary.json` carries the same split: 68 files, 28,506
source lines that the 83.34% says nothing about. Those counts use raw source lines — the
only basis for files no test loads — not the lcov line basis the percentage itself uses,
so the two numbers are reported side by side but not summed.

## The typecheck gate

`packages/tui/tsconfig.json` plus `npm run typecheck`, wired into `npm run check`.

- `strictNullChecks` is on: it is what makes the fork's result unions
  (`{ok:true;value} | {ok:false;reason}`) narrow at all. With it off, the compiler
  widens the literal discriminants and reports the failure branch as an error
  instead — three of the first 31 errors were that artifact, not code defects.
- `noImplicitAny` is off in the base config, which reports roughly 420 errors across the
  vendored lines. It is **on** for the code DSCODE owns through the strict ratchet
  (`packages/tui/tsconfig.strict.json`, `npm run typecheck:strict`): the seed is
  `src/dscode/**`, and TypeScript follows its imports, so first-party files get real
  inference without pretending the rest is ready. Grow that `include`; the guardrail test
  fails if the seed or the flag disappears.
- `@types/react` is a devDependency. React ships no types, and without them every
  hook and prop in `app.ts` degrades to `any`: `useState(null)`, `useRef(null)` and
  whole prop objects stop being read, and generic calls such as `rankByName`
  silently fall back to their constraint. `tests/tui-typecheck.test.mjs` fails if
  that dependency or the `src` include is dropped.
- `lib` is ES2023 so `findLast` and `findLastIndex` are typed; both run on the
  Node versions the manifest requires. `ink` needs no extra types — it exports
  `types: ./build/index.d.ts`.

ESLint still never opens a `.ts` file. Extending it needs `typescript-eslint`,
which is not installed; until then `tsc` is the only static reader of the fork.

## Defects the gate found

The first green run needed 31 changes. Four were defects on paths a user actually
reaches, not type noise:

- `app.ts` called `wrapText(...)` for the email preview and `formatTokens(...)` for
  the compaction confirm panel without importing or defining either, so opening
  either surface threw `ReferenceError`. The preview now wraps through `wrapText`
  in `render/text.ts`, pinned by `tests/tui-text.test.mjs`.
- Eight `useStableInput(handler)` calls omitted the required `active` argument.
  Ink reads `undefined` as active, so behaviour was already "always active"; the
  parameter now defaults to `true` and the doc comment says so.
- The `/provider` action union was missing `{ kind: 'dscode-grok' }` although two
  call sites set it. JavaScript stored the value regardless, so the Grok panel worked
  at run time; the type was wrong, and with React's types installed the compiler
  flagged both the setter and the `kind === 'dscode-grok'` comparison.
- `DscodeProviderPanel` and the credential panel typed their state as `undefined`,
  so `directory.rows` and the credential status were never read by the compiler.

The rest is narrowing: `RgbTriple` parameters, `new Set<StatusItemId>`, explicit
map return types, a typed `fetch` JSON read, `EditResult.killed`, `ModelPanel`'s
props, and a `resumed` prop the header never accepted (an upstream artifact).

## Upgrading the fork

Taking a new upstream dsh-code release is a manual merge of the local delta (16 files,
+818/−151 at v0.7.22). The procedure, the provenance steps and what only a hand smoke test
can catch live in [vendored-tui-upgrade.md](vendored-tui-upgrade.md).

## Still unverified

- Implicit `any` (~420 errors) outside the strict ratchet, and the `app.ts` values that
  flow through untyped helpers by design.
- **The composer's key routing has no direct test.** `Input` takes 83 required props and is
  not exported; `App` takes 61. Mounting either needs a fake application, so the branches a
  user actually presses are covered only through the panels. Extracting the routing into a
  pure `(key, state) => action` function is the change that would fix it; see
  [vendored-tui-upgrade.md](vendored-tui-upgrade.md).
- Release and distribution scripts (`build-packages.mjs`, `publish-hub.mjs`,
  `distribute.mjs`, `doctor.mjs`) count as zero lines in the inventory; the release
  path is covered by the Hub workflow, not by a unit test.
- `DscodeEmailPanel`, `DscodeImapSetup` and `DscodeProviderPanel` still take untyped
  props, so their behaviour is covered only through the components that render them.
- Plugin entry points (`grok`, `exec`, `clipboard-image`, `session-bridge`,
  `session-cards`) are only partly loaded: their exported helpers are unit-tested,
  while the cordis mount path runs only inside a real session. `grok/index.mjs` and
  `exec/index.mjs` therefore sit near 30% in the inventory with no missing test
  behind that number.
