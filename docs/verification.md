# Current checks — 2026-09-12

Run `npm run check` for the maintained regression gate:

| Command | Scope |
|---|---|
| `npm test` / `npm run test:unit` | Unit and component contracts, including real launcher processes, mailbox transactions, communication orchestration and fresh upstream patches |
| `npm run test:coverage` | The same tests with a full first-party source inventory; unloaded files count as zero; line coverage must remain at least 75% |
| `npm run test:integration` | Six deterministic native Harness probes: bridge, messaging, ownership/input boundaries, cards, memory and login |
| `npm run test:ui` | Actual Ink login interactions and dark/light rendering at four terminal widths |
| `npm run test:package` | Build and unpack both npm tarballs; verify integrity, exported files, JS syntax, native lock dependency and absence of local state/build paths |

Tests use exact upstream archives verified against package-lock integrity, not already-patched developer dependencies. Cached npm content is read without mutation; cache misses fetch the exact locked tarball. Runtime patches are applied only in per-test temporary directories. The unit runner checks that the developer runtime files remain unchanged. Integration, UI and package checks also use disposable checkouts with local overlays and secrets excluded.

Coverage artifacts are `artifacts/local/coverage/summary.json` and `lcov.info`. The denominator contains first-party `.mjs` runtime, launcher, build and patch files; probe/check fixtures are excluded. Coverage printed by Node itself only measures loaded files and has a different denominator. Generated vendor modules are exercised by behavior and patch contracts, not included as first-party source.

The GitHub Actions workflow runs the gate on macOS with Node 22.19 and 24. Adding the workflow is not evidence of a remote CI pass. Local Unix socket and native flock access are required. No remote inference is performed. Package checks do not replace the separately requested clean npm/Hub install, upgrade/rollback and public-release verification below.

## What cannot run inside a dscode session — 2026-09-17

`verify:hub` (and therefore `make verify`, `make release` and `make publish`), `npm run doctor`, and any other check that boots a real dsh profile and lets it confine a command cannot complete **inside** a running dscode session on macOS. The nested harness applies its own Seatbelt profile, and `sandbox-exec: sandbox_apply` is refused to a process that is already confined, so the probe fails with `sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host`. A companion symptom is that a command allocating a new PTY fails with `posix_openpt: Operation not permitted`: the workspace-write profile grants file writes only to `/dev/null`, the workspace and the platform temp areas, and `/dev/ptmx` is not among them.

Asking for a wider sandbox does not lift this. `danger-full-access` widens the DSH *file policy*, while the OS-level profile that refuses the nested `sandbox_apply` remains in force, and a backgrounded command does not inherit the wider mode at all. Run these from a normal terminal instead: `make verify`, `make release`, `make publish` and `npm run doctor` all complete there, and the release workflow covers the same ground on CI.

Everything that does not spawn a nested confined harness still runs inside a session: `npm run check` (lint, coverage, integration probes, package checks and eval), `npm run test:unit`, `npm run test:coverage`, `npm run test:integration`, `npm run test:package` and `npm run test:eval`. To publish from here, push the `v<version>` tag — the release workflow carries the npm and Hub credentials (for 0.7.15 it built, verified and published from `v0.7.15`).

## Historical verification records

# Verification — 2026-09-11

## Passed

- Clean npm dependency resolution with every `@deepseek-ai/dsh*` module pinned to `0.1.5-rc.2`; lockfile integrity retained.
- Native DSH composition dump and actual DSH-Code `1.0.6` TUI startup with `--mode standard`; `/plugin` inspector rendered.
- Real standard Agent composition: 57 tools before progressive Computer Use activation, including live Chrome MCP tool discovery.
- Native Computer Use helper `0.3.2` initialized; its own integrity check and health handshake completed.
- The exact bundled `computer-use` skill loaded through the real Agent loop and exposed native execution tools. The doctor detects wrong same-name skills instead of declaring the catalog sufficient.
- Deterministic local LLM adapter drove real file write → read → edit → read → skill → shell calls. This tests the Agent and tool pipeline without an external inference service.
- Nonempty session flushed, disposed and resumed; assistant content, preset and Computer Use activation recovered from durable events.
- Agent-scoped compaction service and `/compact` command mounted.
- Official Hub schemas accepted the generated draft and release. Official Hub archive reader accepted `.dshprofile` and rejected modified content with the original hash. Repeated builds produced identical bytes.
- Live Hub CLI import dry-run resolved all three pinned bundles. It did not install or publish a Hub profile.

## Local prerequisites / unverified behavior

- macOS Accessibility: granted in the observed native-helper health response.
- Screen Recording: denied. Screenshot-dependent desktop work still requires local OS permission.
- No remote model request was performed. Configure a provider through `/model` or the local environment before using the coding agent for actual tasks. The fixture is plumbing evidence, not evidence of model quality.
- Chrome MCP initialization and tool discovery passed; browser navigation/click/screenshot actions were not exercised.
- Native desktop actions were not exercised. No user application was controlled by this probe.
- Compaction backend activation passed; actual LLM summarization and long-session retention quality remain untested.
- Cross-process user session resume via TUI should be exercised after a real task; the automated probe currently validates flush/dispose/reload within one runtime.
- A standalone Hub installation does not carry the repository npm dependency overrides. Its composition and activation remain `local_required`.

Run `npm run doctor` to regenerate local evidence. On this workstation the agent sandbox can report `EMFILE` for filesystem watchers; the identical probe passed outside that sandbox. A test failure remains a failure and is not silently downgraded.

## Decisions from integration

- Use official Chrome DevTools MCP through the native DSH MCP bridge instead of Web-only browser/MCP manager panels.
- Keep upstream standard Agent composition and its compaction isolation intact.
- Isolate `DSH_AGENTS_HOME`: the existing global Orca skill called `computer-use` otherwise wins discovery and prevents native DSH Computer Use activation.
- Declare DSH-Code optional peers explicitly and override the entire runtime version family; npm initially retained mixed rc.1/rc.2 versions until clean installation.
- No custom agent engine, browser extension, or replacement compaction backend is introduced.
# Auto review 增量验证

新增独立 reviewer 插件，真实 agent 集成测试覆盖允许、拒绝、无效模型输出转人工、usage 和会话恢复。测试多注册一个仅测试用的 MCP 工具，因此 doctor 显示 58 个工具，正常安装仍是原来的 57 个。详细边界见 [auto-review.md](auto-review.md)。远程审核模型未实测。

## TUI controls verification

- 20 unit/package tests pass, including hook validation, MCP idle protection, skill conflict discovery and TUI patch drift.
- Real profile probe dispatches `/status`, `/doctor`, `/mcp`, `/skills`, `/hooks`, reloads hooks, disables/enables/reconnects Chrome MCP and checks tool deregistration/discovery.
- A real native hook subprocess denies the deterministic adapter's bash call with `HARNESS_HOOK_DENIED`; native hook events are recorded. Existing auto-review and nonempty session resume regressions pass.
- Actual terminal check: `/status` works from bare startup; `/clear` changed session suffix `a0dbc0d4` to `e8d34f1c`, then `/resume` restored `a0dbc0d4`.
- Distribution archive was extracted to a fresh temporary directory; offline `npm ci` installed 571 packages and setup applied the pinned TUI patch. Local hook configuration is excluded from the archive.
- These checks made no paid inference requests. Native Computer Use reported Accessibility granted and Screen Recording denied on this workstation.

## DSCODE persistent shell and Ultra

- 23 tests pass. The actual native DeepSeek serializer was driven through mocked HTTP: Ultra advertises in model metadata, sends `max`, preserves input objects, and adds collaboration text only to normal agent requests.
- The real profile additionally mounts `dscode`, confirms standalone file tools are absent, executes persistent cwd/export/file-patch checks, resets/cancels the shell, and verifies the fresh retry environment.
- Both human rejection and the independent automatic reviewer block a `shell_retry` escalation; the reviewer fixture asserts the resolved workdir and fresh-environment description.
- A real in-process child runs with an isolated shell and inherited Ultra. Deterministic manual compaction and the same model-selection restoration helper used by TUI preserve Ultra on the resumed next request.
- Actual TUI reports `/mode · current dscode`; `/effort` lists Ultra and accepts `deepseek-official/deepseek-flash@ultra`.
- A fresh tar extraction under `/tmp/dscode-ultra-dist.kb3Zax` installs 571 locked packages offline, completes setup and runs CLI help. No paid DeepSeek inference or model-quality benchmark was performed.

## npm + Hub release candidate (2026-09-11)

- 28 unit/contract tests passed.
- The launcher tarball installed independently with npm in a temporary prefix.
- A loopback registry supplied the unpublished bundle to the real Hub lifecycle and dsh-cli installer. The launcher's private npm-exec wrapper pinned DSH and pnpm together; no development runtime substitution was used in the final run.
- The installed shared DSH modules matched 0.1.5-rc.2. The real installed bundle passed deterministic agent tests for shell, approvals, skills, hooks, subagents, compaction, session resume and telemetry.
- A deliberately rejected upgrade retained the old profile. A successful 0.1.0 -> 0.1.1-test upgrade and rollback restored 0.1.0 while retaining state outside the profile directory.
- The installed launcher opened the real TUI; Ultra appeared in the effort menu and the telemetry footer was right-aligned.
- `artifacts/local/hub-verification.json` records exact npm tarball integrities and the disposable test home. Publish tooling requires those exact tested artifacts.
- Public npm publication, Hub package claiming/discovery, public Hub installation, and a remote Git push remain separate steps. No remote-model inference or browser/desktop action was used by these tests.

## Public release 0.1.0

Source: https://github.com/qiz029/dscode. npm packages: @toddzheng024/dscode and @toddzheng024/dscode-bundle. Hub profile: dscode@0.1.0. Public Hub installation and doctor passed in a fresh state directory; the downloaded published .dshprofile passed the archive reader and content hash verification. See GitHub Releases for downloadable artifacts.

The public launcher tarball was installed into an isolated global npm prefix, then its actual `dscode` executable completed a fresh public Hub install and opened the TUI. At release time the package-name metadata endpoint still returned 404 while the exact-version metadata and tarball endpoints were available; README includes the verified direct npm registry tarball command. Both public npm tarball integrities match the tested local artifacts.
