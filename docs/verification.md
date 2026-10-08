# Current checks — 2026-09-22

Status: living verification record. The maintained gates below include installed terminal imports, real-browser checks and experimental upstream Desktop Host, shared Web UI and macOS Electron probes; dated sections retain the evidence and limits of their original runs.

## Desktop package identity and Plugin Hub candidate — 2026-10-08

The source candidate uses `@toddzheng024/dscode-desktop`, with an exported icon,
English/Chinese display metadata and a package-specific README. Ordinary packs
remain private. `pack-desktop-preset.mjs --release` permits public candidates
only for the qualified `0.2.0-rc.2` runtime; it does not publish them.

The Hub integration shares the public Hub API and `@dsh-plugin-hub/schemas`
contract across native Settings and read-only agent tools. Component/service
checks cover search, cursor and numbered pagination, reported scan states,
compatibility refusal, exact-version inspection, confirmation expiry,
duplicate/concurrent installation, cancellation before and during installation,
failed/restart-required outcomes, page remount and official-manager handoff.
Manager mutations in these tests use fixtures, not live npm installations.

Independent Host `0.2.0-rc.2` qualification passed initial and restart phases,
including authenticated Hub RPC, cross-origin refusal, DSCODE-only Hub tools,
custom-provider protocols, persistent/fresh/child shells and workspace scoping.
The official macOS Electron application also rendered the Hub settings page,
read the live public catalog, searched for `dscode`, opened its details and
disabled installation of the terminal-only bundle. The public API returned ten
categories, and a separate live request verified distinct first/second result
pages. The rendered check used a disposable Desktop home and no model account.

The maintained `npm run check` passed before the pagination and installation
race follow-ups (1,060 unit/component cases, 80.43% complete source inventory,
both TypeScript checks, native integration, package checks and 63 eval cases).
The follow-ups passed the focused 16-case suite and documentation checks.
Retained local logs are `artifacts/local/desktop-hub-check.log`,
`desktop-hub-native.log` and `desktop-hub-ui.log`; they are developer artifacts,
not public release receipts.

Still required before public Desktop distribution: real installation through
the new Hub UI, formal-package installation through official Add plugin,
migration from the private probe name, release automation and public package
verification. Live model quality and native Computer Use permissions retain
their previously documented qualification limits. No Desktop package has been
published by these checks.

Run `npm run check` for the maintained regression gate:

| Command | Scope |
|---|---|
| `npm test` / `npm run test:unit` | Unit and component contracts, including real launcher processes, mailbox transactions, communication orchestration, fresh upstream patches, and the terminal's rendered frames at four widths in dark and light |
| `npm run test:coverage` | The same tests with a full first-party source inventory; unloaded files count as zero; line coverage must remain at least 75% |
| `npm run typecheck` | The vendored terminal's TypeScript under `packages/tui/tsconfig.json`; run time and build time both erase those types unread, so this is the only static check of them |
| `npm run test:integration` | Nine deterministic native Harness probes: bridge, messaging, ownership/input boundaries, cards, memory, login, exec, triggers and trigger tools |
| `npm run test:package` | Build and unpack both npm tarballs; verify integrity, exported files, JS syntax, locked terminal runtime dependencies, native lock dependency and absence of local state/build paths |
| `npm run eval:browser -- --self-test` | Native DSCODE plus real Chrome on three multi-step loopback tasks, with independent submission, receipt and tab-retention checks. Scripted responses verify the evaluator; no model quality score. Live `eval:browser` supports DeepSeek or a saved custom provider with its configured authentication and remains outside CI. |
| `node scripts/verify-browser-eval-custom.mjs` | Native agent and real Chrome through scripted loopback Chat Completions, Responses and Anthropic endpoints. Checks screenshot bytes reaching the endpoint, dialog completion, single submission, receipt, tab retention and credential redaction. No live inference or model quality score; requires Chrome and runs separately from CI. |
| `npm run test:browser` | Real Chrome on loopback fixtures: forms, dialogs, screenshots, files, diagnostics, profile persistence, manual edits across handoff/resume, attached-browser preservation, site/Developer permissions and WebMCP execution with redirect and changed-definition refusal, preview identity across main/iframe reloads and frame insertion/removal; native Harness skill/tool scope, approval, handoff across turns and image admission. Requires Chrome; runs separately from `check` and in macOS CI. |
| `DSCODE_TEST_CHROME="/path/to/Chrome for Testing" node scripts/verify-browser-extension.mjs [extension-directory]` | Loads the real unpacked MV3 extension in an isolated profile; verifies pairing, shared-tab isolation, MCP DOM/forms/screenshots, cross-site iframe process swaps, dedicated/nested worker execution and restart, scoped console logs, new/close tab and user revocation. The optional directory tests an extracted package's extension; the receipt fingerprints all six extension files. Requires Chrome for Testing with extension-loading support; separate from CI and `check`. |
| `node scripts/verify-desktop-messaging.mjs /path/to/independent-runtime` | Packs the combined Desktop bundle and tests session cards, cost attribution, two-Host durable messaging, recovery, preset isolation and child task inheritance. Requires one of the explicitly supported Desktop runtimes; separate from CI and `check`. |
| `node scripts/verify-browser-electron-startup.mjs /path/to/Harness.app /path/to/runtime` | On macOS, occupies the default Desktop port, verifies the isolated official app chooses another port and serves authenticated tabs/screenshots, then interrupts a second launch before readiness and checks failure plus cleanup. Requires an initially unused loopback port 19387 and Chrome; set `DSCODE_TEST_CHROME` when needed. Separate from CI and `check`; does not drive rendered controls. |
| `node scripts/verify-desktop-custom-timeout.mjs /path/to/runtime /path/to/Harness.app` | Official macOS Desktop settings RPC against a loopback model with a real 35-second cold start; verifies successful text/tool tests, caller cancellation reaching the model HTTP request and a configured 100 ms idle timeout. Separate from CI and `check`; no rendered interaction or live inference. |
| `npm run test:e2e` | The whole gate inside a Linux container, plus the installed-bundle Hub lifecycle; needs a Docker daemon, so it is outside `npm run check` (see below) |

Tests use exact upstream archives verified against package-lock integrity, not already-patched developer dependencies. Cached npm content is read without mutation; cache misses fetch the exact locked tarball. Runtime patches are applied only in per-test temporary directories. The unit runner checks that the developer runtime files remain unchanged. Integration, UI and package checks also use disposable checkouts with local overlays and secrets excluded.

Coverage artifacts are `artifacts/local/coverage/summary.json` and `lcov.info`. The denominator contains first-party `.mjs` runtime, launcher, build and patch files; probe/check fixtures are excluded. Coverage printed by Node itself only measures loaded files and has a different denominator. Generated vendor modules are exercised by behavior and patch contracts, not included as first-party source. The vendored terminal's TypeScript sources are also outside that denominator: `summary.json` reports them under `unmeasured`, and `npm run typecheck` reads them instead (see [maintainability.md](maintainability.md)).

The GitHub Actions workflow runs the gate on macOS with Node 22.19 and 24. Adding the workflow is not evidence of a remote CI pass. Local Unix socket and native flock access are required. No remote inference is performed. Package checks do not replace the separately requested clean npm/Hub install, upgrade/rollback and public-release verification below.

`npm run verify:hub` also runs `scripts/verify-installed-tui.mjs` against the isolated native installation. It imports the bundle's public `/startup` and `/tui` entries and checks their plugin exports, resolving their transitive dependencies from the installed profile. A `--dump-config` success alone does not exercise those imports. The verification receipt records `terminalImports: true`, which publication requires alongside the existing installation and lifecycle checks. This import check does not render the interactive terminal.

## Desktop shell helper packaging — 2026-10-07

The combined Desktop preset previously told the agent to use DSCODE's unified-diff
`apply_patch`, but omitted that command from the package. A native Host probe
reproduced a failed edit when a different parent's `apply_patch` was found on PATH;
the file retained its original contents and the command demanded another patch
format. This affected Desktop packaging; the terminal bundle already supplied
its helper.

Desktop now includes the executable and prepends its directory only in the copied
persistent-terminal and fresh-shell providers' child environments. Child agents
use the same packaged helper. The Host environment is not mutated. Build-time
replacement requires the expected upstream anchors and changes only staged copies.
The source runtime remains unchanged.

Independent native Host probes passed for 0.2.0-rc.2 and 0.2.1-alpha.1 after an
npm pack/unpack round trip. They exercised an actual persistent-shell edit, a
nonwriting fresh-shell check, both child creation modes, unchanged Host PATH and
an actual native Standard shell without the DSCODE helper directory.

The full local gate passed 1,048 unit/component cases, 80.78% first-party line
coverage, both typechecks, native integration, package verification and 63 evaluator
cases. A regression case places an incompatible executable first on the inherited
PATH and verifies the Desktop environment still applies the intended patch without
modifying its parent environment. The official macOS Apple Silicon Desktop
0.2.0-rc.2 lifecycle passed all six boots; actual patch writes and nonwriting
`--check --reverse` passed after upgrade, rejected incompatible upgrade and
reinstallation. The existing real Chrome and persisted-state lifecycle checks
also passed. Its package SHA-256 is
`cebeaf4b302558046fc84939e2ccf807bbed1322c388c950c5481816577d9861`.

Evidence is retained under `artifacts/local/desktop-patch-*` and
`artifacts/local/desktop-install.json`. This is still an unpublished Desktop
qualification package; live inference and other operating-system Desktop installs
remain unqualified.

## First remote CI results and fixture corrections — 2026-10-07

The Browser/Desktop source was submitted as
[PR #6](https://github.com/qiz029/dscode/pull/6), initially at a6f3d0c.
All three initial required checks failed. Node 22.19 cancelled six account tests
because the serverless watch fixture's only remaining timeout was unreferenced;
the same failure was reproduced locally with the official Node 22.19 binary.
The deadline test now supplies a bounded referenced timer, representing the
live callback server's lifetime without changing production cancellation.

The Linux run also failed the poll CLI case when bubblewrap could not create a
namespace in Docker. A local container reproduced the original failure, and a
direct bubblewrap probe reported `Creating new namespace failed: Operation not
permitted`. Granting `SYS_ADMIN` to the disposable test container made the
bubblewrap probe pass. Both the local e2e launcher and CI now supply that
capability and disable the outer container's AppArmor profile, which can also
deny mounts despite the capability (see
[Docker's AppArmor mount example](https://github.com/docker-archive-public/docker.labs/blob/master/security/apparmor/README.md)).
There are no host directory or Docker socket mounts. The existing real
poll and script-ingress assertions remain in place; the production sandbox
still refuses to fall back to an unsandboxed command.

Once Linux could execute the sandboxed command, the exec probe exposed a second
platform assumption: its blocking command waited for the macOS-only stdin
inspector. Linux now exercises the existing explicit `exec --timeout 2` path,
requiring exit 124 and the timeout diagnostic within 30 seconds. macOS retains
the automatic stdin-wait interruption assertion. The focused Linux probe passed
with a real PTY and exited in 7.3 seconds, including process startup and cleanup.

The installed Hub probe subsequently reached the real patch command and found
that its fixture installation under `/tmp` was hidden by Linux workspace-write's
private temporary mount. A direct bubblewrap reproduction confirmed that the
same helper remained visible outside `/tmp`. The fixture now installs under an
isolated `artifacts/local/dscode-hub-verify-*` directory, matching the placement
of a normal Hub installation outside scratch space. The sandbox and installed
`apply_patch` assertion are unchanged.

Node 24 passed its main regression gate, then failed the real browser fixture
because the runner's Chrome preserved trailing spaces in accessible input
names. Explicit accessible names on the browser and evaluation fixtures remove
that ambiguity while retaining exact tool-target assertions.

During diagnosis, local Node 22.19 passed the full regression gate, including a
temporary additional process-result test: 1,048 unit/component cases, 80.81%
measured first-party line coverage, both typechecks, native integration, package
checks and 63 evaluator cases. The final fixture change retains the original
1,047-case unit suite and fixes the Docker execution environment. The real
Chrome suite and all three scripted browser evaluation scenarios passed on local
Node 24. The Docker context now excludes local research, npm caches, environment
files and local configuration. The final Linux ARM64 container passed all seven
e2e stages in 3.8 minutes: 1,041 unit cases passed with six existing macOS-only
skips, native integration, package verification, and the installed Hub lifecycle
including actual shell edits, failed upgrade preservation and successful rollback.
Updated remote macOS and Linux x64 CI results remain required; local passes do
not supersede a remote red check. Evidence is retained under
`artifacts/local/pr6-*`.

Remote follow-up at 70ccc4a still failed the Linux x64 poll fixture, despite the
local ARM64 container pass. The assertion now includes its fixture-only persisted
check output so a runner-specific sandbox failure is visible in CI, rather than
reporting only the resulting zero session count. Remote qualification remains open.
The output lives in each run's separate transcript tail, so the diagnostic reads
that file rather than only the outcome index; a local denied-container test
confirmed that the actual bubblewrap error reaches the assertion.

The second remote Node 24 main gate passed, then attached-browser startup failed
with an unavailable initial page list. The pinned Chrome MCP omits its pages field
when no regular targets exist. The disposable Chrome fixture now waits for its
original page target at the debugging endpoint before establishing MCP; it still
asserts the actual tool inventory and preserves the original tab on disconnect.

Remote diagnostics at 6bd8684 exposed `bwrap: pivot_root: Operation not permitted`.
The disposable e2e container now also disables its outer seccomp profile, since
Docker profiles can deny that syscall (see [Docker's seccomp documentation](https://docs.docker.com/engine/security/seccomp/)).
This setting applies only to the test container, without host mounts or Docker
socket access; DSCODE's inner sandbox and behavioral checks remain enabled.

## Distribution readiness review — 2026-10-07

The current working tree supports a controlled macOS Apple Silicon Desktop
preview. This conclusion covers the combined DSCODE plugin/preset installed
into official Harness Desktop 0.2.0-rc.2. It does not qualify a standalone
DSCODE application, all-platform Desktop support or live model reliability.

The latest local regression gate passed 1,047 unit/component tests, 80.81%
first-party line coverage, both TypeScript checks, lint, native integration,
package checks and 63 evaluator tests. The installed Desktop lifecycle passed
installation, upgrade, incompatible-update rejection, removal and reinstallation;
real Chrome access checks include queued cancellation. Model endpoints in these
checks are scripted fixtures. The private archive's SHA-256 was rechecked against
its installation receipt:
`ca304414cce65c3daad91938675b76cce0f9c13269ef781dc4cd7fcec5e4cca8`.
Local evidence is retained under `artifacts/local/browser-queued-cancel-*`;
generated evidence and packages are excluded from Git.

At the start of this review, read-only GitHub and npm inspection found the remote
main branch at 66c12c2, no open pull requests, and both public npm packages and the
latest GitHub release at 0.7.32. The feature work was still uncommitted at that
point. The existing release workflow
publishes the terminal bundle, Hub profile and launcher; it does not distribute
the private Desktop preset automatically.

Recommended release sequence: freeze feature scope, review and submit the source
changes, pass the protected branch's macOS and Linux checks, and conduct a real
model smoke test from a clean user installation. Prepare a new unused version,
release notes, changelog and paired READMEs before tagging. Verify the published
npm/Hub install and upgrade paths after publication. Distribute the Desktop
archive separately as an experimental preset with its exact Harness runtime
requirement and the installation/removal instructions in the browser guide.
The current 0.7.32 archive is a local candidate and must not replace a published
package at that version.

General remote HTTP MCP needs a separate release decision. An SDK-only loopback
probe found that @modelcontextprotocol/client 2.0.0 follows cross-origin redirects
and forwards a synthetic custom header and request body; candidate 2.3.1 rejects
those redirects while retaining direct and same-origin connections. No real
credentials were used. After repairing the fixture's handling of MCP ping and
unknown methods, native Host probes passed on 0.1.7-alpha.2, 0.2.0-rc.2 and
0.2.1-alpha.1: each reproduced forwarding with the old client, exercised actual
tool discovery and text execution through candidate direct/same-origin endpoints,
and observed no requests to the cross-origin target for candidate blocked cases.
Read-only inspection of the signed macOS application's archive confirmed its
MCP plugin and embedded client are 0.2.0-rc.2 and 2.0.0 respectively. Attempts to
run this separate fixture through the embedded CLI and Desktop Host entry points
timed out without a success marker; those processes were terminated and their
temporary homes removed. Signed-application execution of the candidate remains
unqualified. No production dependency was changed. Resolve and qualify this path before claiming general
remote HTTP MCP readiness; controlled preview scope should exclude it meanwhile.
The Chrome browser uses a separate stdio transport. Evidence is retained in
`artifacts/local/mcp-client-redirect-audit.json`,
`artifacts/local/mcp-client-host-audit.json`, and
`artifacts/local/mcp-host-desktop-{rc,alpha}.json`. These checks establish a
candidate repair path, not full MCP protocol compatibility or a shipped fix.

## MCP SDK update scope audit — 2026-10-07

The npm registry's current v1 SDK release is 1.32.1. The browser plugin and
Desktop browser builder retain their qualified 1.30.0 stdio client pin. Published
source comparison found identical client/index.js, client/stdio.js,
shared/stdio.js and types.js files in those versions. The shared protocol diff
concerns session-scoped task stores and task queues; connectChrome supplies no
such store or queue. HTTP transport and OAuth files have changed, but the browser
connection constructs StdioClientTransport only.

The [1.30.1 release](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.30.1)
changes HTTP server limits and resource URI handling;
[1.31.0](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.31.0)
binds OAuth credentials to their issuer;
[1.32.0](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.32.0)
changes HTTP redirect defaults, task-session isolation and server input handling.
[1.32.1](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/1.32.1)
lists documentation changes and its version bump. These changes do not establish
a browser stdio behavior improvement by themselves.

A separate dependency path owns general remote MCP access. The inspected
@deepseek-ai/dsh-mcp-client manifests for 0.1.7-alpha.2, 0.2.0-rc.2 and
0.2.1-alpha.1 all declare @modelcontextprotocol/client 2.0.0, and those independent
npm installations resolve that version. Its Host transport factory creates
StreamableHTTPClientTransport for remote endpoints. Updating the browser's v1
SDK would not update that v2 client or qualify the Host's HTTP/OAuth behavior.
The signed application's embedded dependency graph was not audited in this step.

Decision: keep the qualified browser pin and assess the Harness-owned v2 client
separately before proposing remote MCP changes. No dependency graph was modified.
The candidate tarball is isolated under .research/mcp-sdk-1.32.1-audit; it was
inspected, not executed. File hashes, manifest provenance and the protocol diff
are recorded in artifacts/local/mcp-sdk-upstream-audit.json and
artifacts/local/mcp-sdk-upstream-protocol.diff. This is a source-scope audit,
not a compatibility or vulnerability qualification of either SDK version.

## Prompt cancellation of queued browser operations — 2026-10-07

BrowserConnection previously observed cancellation only after earlier queue work
finished. A user could cancel a pending operation and still wait behind an
unrelated slow Chrome request. The queue now settles cancelled callers promptly,
checks cancellation before dispatch and keeps its internal ordering chain until
prior work settles. Cancelling a queued request neither interrupts its predecessor
nor releases that predecessor's slot. After dispatch, the action and native MCP
transport continue to own cancellation handling; completed effects cannot be undone.

Six new cases failed before the fix: queued tool calls, tab waits, handoff,
resume, cleanup and an already-aborted call. They now verify that cancellation
settles while an earlier request remains held, that following work cannot overtake
it, and that cancelled work never reaches Chrome or changes handoff state. The
focused browser/access/preview suites passed 140 cases.

The real Chrome access probe now holds an HTTP read initiated by evaluate_script,
queues and cancels a second script that would POST to a separate fixture endpoint,
and requires cancellation to settle within the probe's one-second deadline while
the earlier response remains open. The server observes zero cancelled writes,
including after the queue drains, and exactly one write from a fresh explicit
request. The rest of the access, CSS, WebMCP and annotation admission checks pass.
The one-second deadline is a test bound, not a product latency guarantee.

`npm run check` passed 1,047 unit/component cases at 80.81% measured first-party
line coverage, both typechecks, lint, native integration, package checks and
63 evaluation cases. Evidence is under `artifacts/local/browser-queued-cancel-*`.
Tests used isolated fixtures with no personal profile or live model inference.
No rendered UI walkthrough was needed for this queue-level change.

The signed macOS 0.2.0-rc.2 application and bundled CLI passed all six
installed lifecycle boots from the previous `8a042268b838` archive. Reinstallation
runs the updated real-browser access probe against the installed implementation,
including the queued-cancellation check. Upgrade, rejection, removal and reinstall
preserved the existing configuration, permission guard, sessions and other
lifecycle invariants. Chrome MCP remains 1.10.1.

Retained private archive: `dscode-desktop-0.7.32-dsh-0.2.0-rc.2-ca304414cce6.tgz`.
SHA-256: `ca304414cce65c3daad91938675b76cce0f9c13269ef781dc4cd7fcec5e4cca8`.
The archive and installed receipt digests match. Product version remains 0.7.32;
no commit, publication or version bump was performed. Windows/Linux installation
and other Desktop versions were not rerun for this queue change.

## Browser command connection receipts — 2026-10-07

Permission and configuration commands previously returned no connection fields.
The shared formatter treated that omission as disconnected, even when Chrome
was live. Commands now add the session's cached browser state after asynchronous
policy/configuration operations finish. Both readable receipts and `--json`
include it without an extra Chrome call. The status command also captures that
state after its permission read, so a concurrent stop, transport closure or
handoff is reflected when the receipt is produced. The formatter shows a manual
step only while connected; historical handoff data remains in JSON for inspection.
This resolves the command-history display issue noted in the preceding record.

Five pre-fix cases reproduced incorrect receipts across connected, handoff,
disconnected, disconnected-with-handoff and stopped states. The browser and
extension suites passed 72 cases after the fix. The new cases exercise eight
permission query/edit commands in readable and JSON forms, assert that no Chrome
calls or unintended stop occur, and cover six changes during held permission
reads. The native combined Desktop/browser probe on 0.2.0-rc.2 now checks the
connected receipt after a site block, the handoff receipt during a manual step,
and the disconnected receipt after stop. It passed with real Chrome.

`npm run check` passed 1,041 unit/component cases at 80.80% measured first-party
line coverage, both typechecks, lint, native integration probes, package checks
and 63 evaluation cases. Evidence is under
`artifacts/local/browser-command-status-*`. These checks used isolated fixtures
and scripted model responses. No live model inference or new rendered walkthrough
was performed for this command-history change.

The signed macOS application and bundled CLI also passed all six installed
lifecycle boots from the previous qualified `790bb32e77bd` archive: initialize,
install, upgrade, rejected incompatible update, remove and reinstall. The
upgraded, rejected and reinstalled phases verify connected, handoff and stopped
permission receipts plus idle observation of a grant edited through an independent
BrowserAccess instance. Each fixture edit restores its original policy; the
existing policy, permission-guard inode, session and other preservation checks
passed. The receipt includes the presentation module's content hash.

Retained private archive: `dscode-desktop-0.7.32-dsh-0.2.0-rc.2-8a042268b838.tgz`.
SHA-256: `8a042268b83847cea2618a646efc79bc510872dd225cc3a07caa37c71d5871ec`.
The archive and installed receipt digests match. It contains both this fix and
the preceding sidebar permission synchronization. Product version remains 0.7.32;
no commit, publication or version bump was performed.

## Visible Desktop permission synchronization — 2026-10-07

The idle sidebar observation now reads current BrowserAccess grants alongside
cached connection and handoff state, without Chrome calls or model messages.
The Host rechecks connection state after the permission read so a disconnection
during that await cannot restore stale grants or handoff information. Disconnected
browsers do not read permission files.

The visible client synchronizes permission changes every 2.5 seconds while idle.
A change to the selected origin's saved or temporary access, Developer grant, or
global Developer mode clears the preview and point and stops image polling,
while preserving the draft. Changes confined to other origins update the policy
without discarding the current capture. Existing activity epochs prevent a late
observation from overwriting a newer explicit permission change. Hidden panes
stop the observation. The Developer description now includes CSS inspection.

Three new cases failed before the change, reproducing stale UI after block,
temporary-grant removal and Developer-mode changes. The focused client/Host suite
then passed 108 cases, including unrelated-origin preservation and a late
observation racing with a new explicit grant. The combined native Desktop/browser
probe passed on 0.2.0-rc.2 with actual temporary-grant and revocation observations.
The signed macOS application was also exercised through its rendered controls:
open preview, capture, select a point, type a draft, then submit a site-block
command through the composer. Without clicking Refresh tabs, the panel displayed
Blocked, cleared pixels and the point, retained the draft and disabled Send
annotation. The session remained at one model turn and five steps; no annotation
was sent. Screenshot, accessibility text and source hashes are retained under
`artifacts/local/browser-permission-sync-rendered.*`.

`npm run check` passed 1,030 unit/component cases at 80.80% first-party
line coverage, both typechecks, lint, native integration, package checks and
63 evaluation cases. The extracted private package's composed client passed
81 component cases. The local package is `dscode-desktop-0.7.32-dsh-0.2.0-rc.2-0b6d75738fdf.tgz`,
SHA-256 `0b6d75738fdfa71b810a959d04a36d9c8b22c25edd0ff580ae548ef18331dc2f`. This archive was built and unpacked; the six-boot
installed lifecycle was not rerun for this sidebar change. The preceding dated
record retains that qualification for the previous package.

All evidence is under `artifacts/local/browser-permission-sync-*`. No live model,
personal browser profile or Windows/Linux rendered client was used. The
synchronization interval is an idle polling interval, not a latency guarantee
while another request is pending or the OS throttles the app. Inspection also
found a separate display issue: permission-only command results omit connection
state, and the shared formatter labels them disconnected even with a live browser.
That command-history wording remains a follow-up; it does not represent a transport
disconnection or bypass permission enforcement.

## Chrome MCP 1.10.1 promotion and installed Desktop migration — 2026-10-07

The root dependency, lockfile, Desktop builder and adapter guard now pin Chrome
DevTools MCP 1.10.1. The Electron qualification script reads the builder's shared
expected dependency map. The root product version remains 0.7.32. This promotion
supersedes the candidate-only status in the earlier dated records below.

The real access probe now checks the new `get_css_styles` tool with an actual
snapshot heading UID and explicit page ID. It refuses inspection without global
Developer mode and again without the site's Developer grant, returns the fixture's
inline color after both grants, and refuses access after Developer mode is turned
off. The installed package runs the same access probe after reinstallation.
User guides, both READMEs and the browser skill describe this permission boundary.

On the promoted dependency, `npm run check` passed: lint, both typechecks,
1,025 unit/component cases at 80.83% measured first-party `.mjs` line coverage,
native integration probes, package checks and 63 evaluation cases. The separate
`npm run test:browser` passed all real Chrome action, access/WebMCP, document,
large-PNG and native terminal Harness probes. The image cases retained exact
3,081,183-byte and 8,324,193-byte PNGs, file exports, annotation attachments,
oversize refusal and recovery. The combined native Desktop preset/browser probe
passed on both 0.2.0-rc.2 and 0.2.1-alpha.1.

The signed macOS 0.2.0-rc.2 application and its bundled CLI passed six isolated
boots: initialization, installation of the older package, upgrade, rejected
incompatible update, removal and reinstallation. The dependency resolved from
the installed bundle was 1.9.0 at baseline and 1.10.1 after upgrade, rejection
and reinstallation. The receipt fingerprints the MCP entry and screenshot adapter
as well as the other implementation files. Browser configuration, permission
guard, revocations, session history and the other existing lifecycle invariants
remained intact. The extracted composed client passed its 76 component cases.

Retained private archive: `dscode-desktop-0.7.32-dsh-0.2.0-rc.2-790bb32e77bd.tgz`.
SHA-256: `790bb32e77bdfcf9b03d0c8a43e1d93883e02fca0f5cf0d652ccd8af29d3bae0`.
The migration baseline is `bebd5b6d434cd0bd251fcd48dd6cd54e0ad1e4c0ffb560ba7f27328a0af50f1d`.
Evidence is under `artifacts/local/browser-mcp-upgrade-*`; the package digest
matches the installed lifecycle receipt. This is local macOS arm64 qualification,
without live model inference, a new rendered UI walkthrough, Windows/Linux
installation or public publication. No personal browser profile was used.

## Chrome MCP adapter migration across 1.9.0 and 1.10.1 — 2026-10-07

The large-PNG adapter now wraps the MCP server's public `registerTool` callback
for `take_screenshot`, preserving the registration result, callback arguments,
explicit-file behavior and per-request async image storage. It no longer depends
on ToolHandler's prototype layout. The existing behavioral tests now exercise
registration of an instance callback, matching the newer upstream shape.

Headless resize now uses `select_page` with `bringToFront` through the existing
connection before sending resize. Visible and attached browsers retain their
focus behavior. Selection failure, a new browser generation or permission
revocation after selection prevents resize dispatch. This replaces the old
mutation of upstream's `resizePage.handler`, which became a factory in 1.10.1.

The focused screenshot and browser suites passed 55 cases, including five new
resize dispatch cases. In an independent 1.10.1 installation, the four existing
real-Chrome scripts passed: browser actions, access/WebMCP, document identity and
large images. The image probe captured exact 3,081,183-byte and 8,324,193-byte PNGs
at 1280x800 and 1920x1440, preserved explicit file-only exports, rejected oversized
captures and recovered with fresh pixels. The same image probe passed on the
current 1.9.0 dependency. The real MV3 extension probe also passed on 1.10.1,
including sharing isolation, cross-process frame operations, worker scoping,
revocation and in-flight attachment cancellation. The candidate copy uses current browser sources with
only its local version guard changed to admit the independently installed 1.10.1.

`npm run check` passed on the shipped 1.9.0 dependency: lint, both typechecks,
1,025 unit/component cases at 80.83% measured first-party `.mjs` line coverage,
native integration probes, package checks and 63 evaluation cases. Source hashes
in `browser-mcp-registration-sources.json` confirm that the candidate adapter and
connection match the worktree, apart from the stated local version guard.
The combined native Desktop preset/browser probe also passed on Harness
0.2.0-rc.2 with its existing Chrome MCP 1.9.0 graph, covering capture, annotation,
stop/resume, permissions and restart. It does not qualify a 1.10.1 Desktop graph.

Evidence is under `artifacts/local/browser-mcp-registration-*` and
`artifacts/local/browser-mcp-1.10.1-*`. The root dependency and Desktop builder
still pin 1.9.0; passing these probes does not qualify a published or installed
Desktop package on 1.10.1. No personal browser profile or live model was used.

## Chrome DevTools MCP 1.10.1 compatibility investigation — 2026-10-07

The npm registry and official release API report Chrome DevTools MCP 1.10.1 as
latest, published on 2026-09-23. DSCODE remains pinned to 1.9.0. The
[1.10.0 release](https://github.com/ChromeDevTools/chrome-devtools-mcp/releases/tag/chrome-devtools-mcp-v1.10.0)
adds CSS inspection, changes tool definitions to factories and migrates the
bundled MCP SDK to v2; the
[1.10.1 release](https://github.com/ChromeDevTools/chrome-devtools-mcp/releases/tag/chrome-devtools-mcp-v1.10.1)
fixes bundled Node export resolution.

An independent installation under `.research/browser-mcp-1.10.1` keeps DSCODE's
current MCP client SDK 1.30.0 and WebSocket dependency. The existing document
identity adapter can install against its response class. The screenshot adapter
fails immediately with `Unsupported Chrome MCP screenshot adapter`: the new
ToolHandler uses an instance-field callback instead of the prototype method
wrapped by DSCODE. Separately, `resizePage` is now a factory; assigning its
`handler` property no longer wraps the generated headless resize action. Neither
finding requires changing installed dependency files or disabling the production
version check.

The existing 1.30.0 client successfully initialized both published MCP servers and
listed their tools over stdio. With identical default DSCODE launch flags, the
catalog grows from 30 to 31 tools, adding `get_css_styles` and removing none.
The JSON Schema dialect changes from draft-07 to 2020-12, and the raw schema
output changes for all existing tools. The catalog receipt includes normalized
comparisons separately from these serialization differences. This verifies
initialization and discovery only, not real Chrome actions, screenshots, WebMCP,
extension sharing or Desktop compatibility.

Evidence is retained under `artifacts/local/browser-mcp-1.10.1-*`: installation
log, failing adapter probe, protocol log and both full tool catalogs. The root
manifest and installed Chrome MCP remain at 1.9.0. Upgrade work must replace the
two obsolete interception points, preserve inline large PNGs and document
identity, then rerun the real-browser and native Desktop/package checks before
changing the shipped dependency pin. The newer registry MCP SDK 1.32.1 was
observed but was not installed or qualified as a DSCODE dependency.

## Disabled Desktop preview button presentation — 2026-10-07

All native buttons in Browser preview now share a renderer that applies muted
opacity and a `not-allowed` cursor when their existing `disabled` condition is
true. Available buttons retain their previous appearance. This is a presentation
change; request admission, keyboard semantics and action handlers are unchanged.

All 76 existing browser-client tests passed. The signed macOS 0.2.0-rc.2 app
loaded the combined preset in an isolated home. With the browser initially
stopped, Refresh preview and Send annotation appeared muted. Starting the
browser, capturing its new `about:blank` page and selecting the center restored
the available appearance. Stopping again restored muted controls and preserved
the draft. Accessibility states independently confirmed the native disabled
transitions; the model counter stayed at one turn and five steps.

Evidence is retained under `artifacts/local/browser-disabled-controls-*`, with
enabled/disabled screenshots, accessibility states, a receipt matching the shipped
client's source hash and the focused test log. No annotation was sent and no live
model or personal profile was used. The fixture was stopped and removed. Dark
theme and cursor appearance were not separately inspected. The previously
qualified private archive predates this styling change; the full release gate
was not repeated for this presentation-only change.

## Rendered Desktop observes extension revocation — 2026-10-07

The signed macOS 0.2.0-rc.2 app was launched with the browser-only bundle and a
real MV3 extension in an isolated Chrome for Testing profile. The existing
`verify-browser-electron.mjs --extension` fixture paired the extension, shared
one loopback page and left another page unshared. Native UI interaction opened
Browser preview, captured the shared page, selected its center and entered an
annotation draft; Send annotation was enabled before revocation.

The fixture's SIGUSR2 control invoked the extension popup's Stop all sharing
action. After its revocation marker, the visible Desktop pane automatically
removed the screenshot, point, tab selection and site controls. Capture and send
were disabled, the draft remained editable, and the disconnection notice appeared
without clicking Stop browser or Refresh tabs. The conversation stayed at one
turn and two steps, and no annotation receipt was created.

Evidence is retained under `artifacts/local/browser-extension-disconnect-*`:
a redacted fixture log, accessibility state, screenshot and receipt containing
the seven shipped browser/extension source fingerprints. Each shipped file was
compared with the current worktree. This checks the actual revocation-to-sidebar
path; it does not measure an exact notification latency, exercise a stalled
in-flight annotation, or qualify live model behavior. The test used no personal
profile or credentials. The launcher and extension browser were stopped and the
disposable home was removed. Runtime code was unchanged in this verification.

## Tab refresh observes browser disconnection — 2026-10-07

The client now handles an explicitly disconnected tab-list response through the
same transition as its idle connection observer. Previously, a disconnected
response with no tabs could erase the draft, while a response retaining cached
tabs or a handoff could keep obsolete controls visible. Refresh also marked the
connection unavailable before the idle observer could perform its cleanup.

Four client regression cases failed before the change and pass afterward. They
cover empty and retained tab lists, each with and without a historical handoff,
and verify draft preservation, pixel removal, disabled capture/send and the
following idle observation. A real `BrowserConnection` with a synthetic MCP
transport confirms the Host can return a disconnected status alongside historical
pages and handoff when transport closure coincides with a completed page listing.
This exercises the actual connection and Host response projection; Chrome and
native window interactions are not used to force that timing.

The focused client/preview suite passed 103 cases. Evidence is retained under
`artifacts/local/browser-refresh-disconnect-*`. The preceding full gate covered
1,015 cases before these five additional cases and this shared-transition change.

The retained private macOS 0.2.0-rc.2 package is
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-bebd5b6d434c.tgz`,
SHA-256 `bebd5b6d434cd0bd251fcd48dd6cd54e0ad1e4c0ffb560ba7f27328a0af50f1d`.
Its extracted composed client passed all 76 browser-client cases. The official
signed application's six lifecycle boots passed: initialization, previous-package
installation, upgrade, incompatible-update rejection, removal and reinstallation.
The installed receipt matches this archive's digest and uses the previous
`4bde0a52354d` package as its baseline. Browser stop/resume and preserved launch
settings passed after upgrade, rejection and reinstallation; real-Chrome access,
WebMCP and tab-refresh checks also passed after reinstallation. These lifecycle
checks do not drive the rendered sidebar race. The package remains unpublished.

## Desktop browser disconnection observation — 2026-10-07

The sidebar's idle cached-state request now projects connection status alongside
handoff state. A disconnected Host clears the selected tab, screenshot, point,
site controls and handoff banner while keeping the annotation draft. It does not
contact Chrome or start a model turn. A stale response cannot replace newer
preview work, and an explicit sidebar stop retains its own completion message.

Verification:

- `npm run check` passed: lint, both typechecks, 1,015 unit/component cases at
  80.79% measured first-party `.mjs` line coverage, native integration probes,
  package checks and 63 evaluation cases.
- The focused client and preview suites passed all 98 cases. New cases cover
  external disconnection during preview and handoff, draft retention across
  restart, and a late disconnected response arriving after a newer capture.
  The Host case checks disconnected state even when a historical handoff remains
  cached, without invoking Chrome, commands or permission methods.
- The combined native Desktop preset probe passed on Harness 0.2.0-rc.2 with
  real Chrome, including the disconnected cached-state projection after stop.
- In the signed macOS 0.2.0-rc.2 app with an isolated fixture, a fresh screenshot
  and center point were selected and an annotation draft was entered. Submitting
  `/browser stop` through the main composer automatically cleared the sidebar's
  pixels and tab selection without clicking its stop or refresh controls. The
  draft stayed visible, capture and send became disabled, and the model counter
  stayed at one turn and five steps. Starting from the sidebar selected the new
  `about:blank` tab, kept the draft and left send disabled pending a fresh capture.

Evidence is retained under `artifacts/local/browser-disconnect-sync-*`, including
the focused and native logs, the rendered screenshot and accessibility states
before and after restarting. This rendered run covers the composer stop path;
extension-driven disconnection and handoff disconnection were not separately
driven in the rendered app. No live model inference or personal profile was used.
The previously qualified private archive predates this source change.

## Installed Desktop controls and command input migration — 2026-10-07

The official macOS Desktop/bundled CLI lifecycle probe now checks command input
metadata after upgrade, incompatible-update rejection and reinstallation. All
13 parameterized DSCODE commands must retain a nonempty input hint without
attachment admission. Implementation fingerprints now include the six additional
command-registration modules, alongside the browser and composed client files.

With `DSCODE_TEST_CHROME`, those same three phases start the installed browser
using preserved launch preferences, capture a preview, enter handoff, read the
cached handoff projection, refuse capture while paused, resume through the
sidebar RPC, verify readable command history, reject the previous annotation
receipt and capture fresh pixels. The reinstalled phase also retains the
tab-refresh failure/recovery and installed access/WebMCP probes.

Migration from the previously qualified `61021abcad6b` archive passed all six
official Desktop boots: initialization, installation, upgrade, rejected update,
removal and reinstallation. Both new receipt phase lists contain `upgraded`,
`rejected` and `reinstalled`. Existing checks for session history, browser
configuration and permissions, credentials, mailbox, scheduling, email,
delegation and child worktrees also passed.

The retained private archive is
`dscode-desktop-0.7.32-dsh-0.2.0-rc.2-4bde0a52354d.tgz`, SHA-256
`4bde0a52354d3c160107cae893fc8b26d83da7465e6a8a8b5229b37129a60f66`.
The installed receipt matches that exact digest. Its extracted composed client
passed all 69 browser component tests, including resume, automatic handoff
observation, draft retention and late-response handling. Evidence is under
`artifacts/local/desktop-controls-*`.

This turn changed verification scripts only. The prior full gate covers the
packaged runtime implementation; it was not repeated. Documentation, lint and
whitespace checks passed. No live inference, Windows qualification, repository
version bump, commit or publication was performed. The package remains an
experimental local artifact.

## Desktop command input catalog — 2026-10-07

The same missing input metadata affected eight additional commands: `computer`,
`shell`, `review`, `memories`, `mailbox`, `dscode-doctor`, `dscode-mcp` and
`dscode-skills`. The packed native preset probe reproduced all eight missing
descriptors before the fix. Each now declares its argument hint. The probe
requires nonempty hints and no attachment admission for all 13 parameterized
DSCODE commands in the combined preset, including the already-correct browser,
delegation, login and scheduling commands. The check passed after the fix.

The signed macOS `0.2.0-rc.2` application was exercised through its composer with
memory and shell status, browser skill details, local doctor and Computer Use
status. Invalid review options, a nonexistent mailbox cancellation target, a
nonexistent MCP entry and invalid Computer Use arguments reached their existing
error handlers. All nine submissions retained the initial one model turn and
five steps. This qualifies parameter routing, not a full review or successful
mailbox cancellation. Valid review and model-assisted doctor behavior still use
models, and memory generation keeps its existing policy. Native Computer Use
status reported Accessibility denied; no OS permission was granted.

The packed preset's native initial/reload probe passed on both supported runtimes,
`0.2.0-rc.2` and `0.2.1-alpha.1`. Source fingerprints,
rendered command evidence and screenshots are under
`artifacts/local/desktop-command-input-*`. No Windows UI or live inference was
exercised.

The full regression gate passed: 1,012 unit/component tests, 80.84% first-party
line coverage, native integration and package checks, 63 evaluations and both
typechecks. Documentation, lint and whitespace checks passed. The isolated
signed-app launcher exited successfully and removed its temporary home. No
repository version change, commit or publication was made.

## Desktop browser command arguments — 2026-10-07

The browser command now declares its free-form input hint. Desktop's command
matcher only admits arguments for descriptors carrying `input`; bare commands
without that metadata can execute, but non-bare lines fall through to ordinary
messages. The packed native command directory reproduced the missing declaration
before the fix. Its probe now requires a nonempty hint and rejects attachment
acceptance, on both the initial Host and resumed session.

The signed macOS `0.2.0-rc.2` application accepted complete composer lines for
`/browser handoff 2`, `/browser resume` and `/browser tabs --json`. Handoff and
resume updated the already-open preview pane; the JSON query retained its
structured output. `/browser handoff invalid` produced the native command error.
The conversation remained at one model turn and five steps, with no ordinary
user messages added for these commands. This rendered check resolves the
composer gap recorded in the handoff-observation section below.

All 139 focused browser, preview and client tests passed. The packed combined
Desktop preset passed its native initial/reload probe with real Chrome,
including command input metadata, handoff/resume, preview, custom-model image
transport, permissions and restart behavior. Evidence is under
`artifacts/local/browser-command-input-*`. This small descriptor change did not
rerun the full gate; the preceding full run passed 1,012 unit/component tests and
63 evaluations before this change. No live inference or Windows UI was tested.
Documentation, lint and whitespace checks passed. The disposable Desktop
launcher exited successfully and removed its temporary home. No repository
version change, commit or publication was made.

## Desktop handoff state observation — 2026-10-07

Visible browser panes now poll a cached Host handoff projection every 2.5 seconds
while ordinary preview and control requests are idle. Reads do not overlap and
do not contact Chrome, load permissions, execute commands or create agent turns.
A change clears captured pixels and the selected point, preserves the draft and
updates the handoff banner. Hidden panes stop polling. Operation epochs and
effect disposal reject old responses after Stop, manual refresh or hide/reopen;
transient observation failures retry at the next visible tick.

Five client regressions failed before implementation. All 95 focused client and
preview tests passed afterward, including the Host's no-side-effect projection
with paused, resumed and absent browser connections. The combined native
`0.2.0-rc.2` preset probe passed with real Chrome, including the new authenticated
handoff projection before and after resume.

In the signed macOS application, a handoff executed through the fixture Host's
authenticated native command API appeared in the already-open pane without a
tab refresh or pane remount, while the typed annotation remained intact. The
external resume command also removed the banner without a tab refresh, keeping
the draft and requiring fresh pixels before sending. The fixture uses a scripted
model. Evidence is under
`artifacts/local/browser-handoff-sync-*`; this does not qualify live model
reasoning or Windows rendering.

The full regression gate passed: 1,012 unit/component tests, 80.84% first-party
line coverage, native integration and package checks, 63 evaluations and both
typechecks. Documentation, lint and whitespace checks passed. The signed-app
fixture exited successfully and its temporary home was removed. No repository
version, commit or publication changed.

The rendered check also exposed a separate existing command-entry gap: the
browser command lacks input metadata, and `/browser handoff 2` entered in the
Desktop composer was sent as ordinary text. Bare `/browser` worked. The Host
command API used for this state-observation check bypasses that composer gap;
the later browser-command-arguments check above fixes the descriptor and verifies
rendered parameter entry.

## Desktop browser handoff and resume controls — 2026-10-07

Browser preview now renders the handoff returned by the tab list, disables
capture and sending while paused, and offers the existing user resume command.
Both successful and failed resume requests invalidate the Host's old preview
receipt. The UI preserves drafts across resumed tab selection and requires a
fresh capture and point. Stop supersedes late successful or failed resume
responses. Opening the pane or refreshing tabs observes handoffs started
elsewhere; this change does not add push notifications or start an agent turn.

All 89 focused client/preview tests passed, including failed resume, changed tab
selection, Stop races and Host receipt invalidation. The packed combined preset
passed the native `0.2.0-rc.2` Host probe with real Chrome: paused capture was
refused, resume produced readable command history, old annotation receipts were
rejected and fresh capture succeeded. Existing restart and permission checks
also passed.

The signed macOS `0.2.0-rc.2` application was separately launched with the full
preset and an initial handoff. Rendered controls showed the manual step, resumed
control while keeping the draft, refused an expired preview, and accepted a
fresh selected screenshot. The scripted custom HTTP model received exactly one
annotation with matching image bytes, the retained text and pixel `(640, 400)`
in the `1280×800` image. Evidence, source fingerprints and screenshots are under
`artifacts/local/browser-sidebar-resume-*`. No live model inference or Windows
Desktop interaction was exercised. The earlier installed lifecycle package
does not include these new resume controls.

The full `npm run check` passed with 1,006 unit/component tests, 80.91% first-party
line coverage, native integration and package checks, 63 evaluations and both
typechecks. Documentation, lint and whitespace checks passed. The disposable
Desktop launcher exited successfully and removed its temporary home. No release,
repository version change, commit or publication was made.

## Installed browser commands and preserved launch configuration — 2026-10-07

The native Desktop lifecycle now seeds a named persistent profile, a custom
Chrome executable, headless mode and WebMCP in the baseline installation.
`browser/config.json` joins the files whose exact bytes must survive upgrade,
incompatible-update rejection, removal and reinstallation. Every installed Host
also checks the configuration through `/browser status --json`.

After upgrade, rejection and reinstallation, the probe changes the named
profile, selects isolated mode and restores the original profile, verifying
launch preferences at each step. With `DSCODE_TEST_CHROME`, the reinstalled Host
starts Chrome through the installed browser command using those preferences,
injects a page-list tool error, checks both command formats and native tool error
conversion, then restores refresh and stops the browser through the sidebar RPC.
The existing independent installed access probe remains active afterward.

Receipts distinguish configuration preservation, mode-setting checks and the
optional real-Chrome tab-refresh check. The implementation fingerprints now
include `plugins/browser/index.mjs`, where these command fixes live.

Migration from the qualified `cfa6bcecbe0c` package passed all six signed-app
boots and the expanded checks. The retained private package is
`dscode-desktop-0.7.32-dsh-0.2.0-rc.2-61021abcad6b.tgz`, SHA-256
`61021abcad6b5697ff6f1e11101aebc1846ad11a04a805cf46fefb1e82af5c25`.
Its digest matches the installed receipt; `plugins/browser/index.mjs` is the
only changed fingerprinted implementation entry. Configuration checks passed
after upgrade, rejected update and reinstallation, and the installed Chrome
tab-refresh and access probes both passed. Evidence is under
`artifacts/local/browser-command-*`.

The initial full gate exposed an asynchronous-save assumption in the terminal
output-budget test: it read the store after the input fixture's fixed 45 ms
delay. A controlled held save reproduced the same old-value assertion failure.
The test now observes actual save promises, checks the pending UI and unchanged
durable state while held, then releases and awaits persistence before checking
the result. It also awaits the reopened editor's save and settles outstanding
saves before removing its temporary home. All 14 custom-provider UI tests passed;
no provider runtime behavior was changed for this test correction.

The final full `npm run check` passed: 1,000 unit/component tests, native
integration and package checks, 63 evaluations and both typechecks. Documentation,
lint and whitespace checks also passed. No version, commit, publication, live
model inference or user profile changed.

## Managed mode changes preserve Chrome launch settings — 2026-10-07

`/browser use` previously rebuilt configuration without the custom executable
or headless setting, including when only the named persistent profile changed.
Managed targets (`persistent` and `isolated`) now carry those launch settings
forward. Mode-specific profile and debugging-URL fields still follow the new
command. Existing-browser targets (`connect`, `auto`, `extension`) continue to
clear incompatible launch settings; returning from one uses the ordinary
managed defaults. WebMCP remains preserved across all mode changes.

The regression failed before the fix because the first named-profile change
lost the configured binary path. It now verifies persistent-profile changes,
persistent/isolated switching, saved values and actual connection arguments.
Three additional cases protect attached-mode cleanup and return-to-managed
defaults. All 106 browser/configuration/access tests passed. Evidence is under
`artifacts/local/browser-mode-settings-*`.

The native Harness/real-Chrome probe also passed. Between real browser runs it
selected a named persistent profile and then isolated mode, checked both saved
launch fields through command JSON, and started Chrome again with the retained
configuration. The existing scoped-tool, approval, image, handoff and error
recovery checks stayed active. The model was scripted. Documentation, lint and
whitespace checks passed; this focused change did not rerun the complete gate
or rebuild the private Desktop package. No version, commit or publication changed.

## Tab refresh surfaces page-list tool errors — 2026-10-07

Both `/browser tabs` and the agent's `browser_tabs` status action previously
ignored `isError` on the page-list result and returned cached browser status as
success. A shared refresh helper now checks the result before returning status.
The plain and JSON commands report a command error; native tool execution
reports an error result. `/browser status` retains its documented last-observed
snapshot, and a fresh successful list restores ordinary tab results.

Three regression cases failed before the fix, covering the plain command, JSON
command and tool handler. They verify explicit failure, absence of cached tabs
in a command success response and recovery after the transport fixture resumes
normal lists. All 110 browser/access/preview tests passed.

The native Harness and real-Chrome runtime probe also passed. After real browser
startup it injected a page-list MCP error, checked both command forms and the
actual `ctx.tools.execute` error conversion, restored the native client and
verified successful tool refresh. Existing image admission, approvals, scope,
handoff and cleanup assertions remained active. The fixture model is scripted;
the injected error is not an actual Chrome outage. Evidence is under
`artifacts/local/browser-tabs-error-*`. This focused change did not repeat the
full release gate or rebuild the qualified private Desktop archive below.

## Custom Chrome paths follow native absolute-path rules — 2026-10-07

Browser configuration previously required `executablePath` to start with `/`,
rejecting valid Windows drive, UNC and extended-length paths. Validation now
uses the host's `node:path.isAbsolute`. Its path dependency can also be supplied
to exercise the production validator under both Node path implementations on
one host; persisted configuration and runtime launch use the native default.

Fifteen cross-platform validation cases cover accepted absolute paths, relative
and drive-relative rejection, and the existing attached-browser restrictions.
Seven failed before the fix. A separate native case verifies persistence and a
path containing spaces remaining one launch argument. All 115 configuration,
file-root, browser and access tests passed. The installation verifier also
fingerprints browser configuration and file-boundary modules, so a migration
must verify their installed bytes alongside the existing browser entries.

Evidence is under `artifacts/local/browser-config-paths-*`. Windows path semantics
are tested on macOS; this does not qualify a Windows executable launch, Desktop
installation or filesystem behavior.

The complete `npm run check` passed with 993 unit/component tests, native
integration and package checks, 63 evaluations, both typechecks and 80.93%
full-inventory line coverage. Documentation, lint and whitespace checks passed.

The two path corrections were packed as private
`dscode-desktop-0.7.32-dsh-0.2.0-rc.2-cfa6bcecbe0c.tgz`, SHA-256
`cfa6bcecbe0c596a9be90e7c463f8945c1ee4668bd9880f8c6eff520b2661eb7`.
Migration from `bfedd277fab6` passed all six signed macOS app boots, preserved
the existing lifecycle data and ran the real-Chrome access probe successfully
inside the reinstalled Host. The retained archive digest matches the installed
receipt. Browser configuration and file containment are the only changed
fingerprinted implementation entries. No version, commit or publication changed.

## Browser file containment uses native separators — 2026-10-07

The browser file guard canonicalized paths but rejected parent-relative paths
using only the POSIX `../` prefix. Node's Windows relative paths use `..\`,
so same-drive siblings, similarly named directories and other UNC shares could
pass that comparison. The extracted containment predicate now uses the selected
path implementation's separator; runtime calls use the native `node:path`.
Canonicalization and dispatch-time checks remain unchanged.

Sixteen cases exercise the production predicate with Node's POSIX and Windows
path implementations. Five Windows escapes failed before the fix and now pass
their refusal assertions. The cases also cover roots themselves, valid children,
case and mixed separators, another drive, UNC paths, extended-length paths and
a legal POSIX filename containing a backslash. All 99 file-root/browser/access
tests passed, including actual filesystem symlink and queued-path replacement
cases on macOS. Evidence is under `artifacts/local/browser-file-roots-*`.
This verifies Windows path semantics on macOS; it does not qualify a Windows
Desktop installation or Windows filesystem/reparse-point behavior.

The real-Chrome browser probe passed on macOS, including attached-browser
upload/export refusal after a queued symlink was redirected outside the root,
unchanged outside-file contents and successful recovery with an allowed path.
Documentation, lint and whitespace checks passed. This focused correction did
not rerun the complete release gate or rebuild the qualified private Desktop
archive recorded below. No user profile, version, commit or publication changed.

## Missing page-list metadata cannot reuse cached observations — 2026-10-07

The shared browser transport now requires every successful `list_pages`
response to contain a page array. Previously an absent, null or non-array value
left cached observations in place, allowing ordinary actions and post-action
checks to proceed without a current page list. Other tools, including native
WebMCP discovery, may still omit page metadata.

Five new cases failed before the fix: three malformed-list values allowed a
click against a page whose actual origin had changed, startup accepted no page
list, and a WebMCP write with a missing post-action list reported success. The
fixed cases check refusal before dispatch, explicit permission recovery,
startup transport cleanup and uncertainty handling without duplicate writes.
A sixth case caught a regression in the initial fix: rejecting a malformed
restart response before observing it lost the generation change. The final
implementation clears old ownership, retention, discovery and handoff identity
before rejecting such a response. All 106 browser/access/preview tests passed.

The real-Chrome access probe also passed with a missing post-action list after
a completed WebMCP write and missing list metadata during annotation admission
after independent navigation. It verified five deliberately requested server
writes, no replay during recovery, no stale annotation delivery and successful
fresh-capture recovery. Metadata loss is injected at the adapter boundary;
the site writes and navigation run in real Chrome. Evidence is under
`artifacts/local/browser-page-list-*`.

The final complete `npm run check` passed with 961 unit/component tests,
native integration and package checks, and 63 evaluations. Coverage was 80.93%
against the full first-party inventory. Both typechecks, documentation, lint
and whitespace checks passed.

The signed macOS Desktop lifecycle migrated from `5e20af0cbfb1` to private
`dscode-desktop-0.7.32-dsh-0.2.0-rc.2-bfedd277fab6.tgz`, SHA-256
`bfedd277fab6ce898d38cff42d0486eebcaf7dd5b6f91e1339ac37dcba1edeb7`.
All six boots and existing persistence checks passed. The reinstalled Host ran
the expanded real-Chrome access probe successfully, including both new metadata
failure cases. The retained package digest matches the installed receipt;
the connection is the only changed fingerprinted implementation entry.
No repository version, commit, publication, user profile or live model inference
was involved.

## Installed WebMCP access probe — 2026-10-07

`verify-browser-access.mjs` accepts an optional package-directory argument. It
loads the connection, access and preview modules from that directory; their
relative imports and MCP subprocess resolve against the same installation.
With no argument it continues to test the working tree.

When `DSCODE_TEST_CHROME` is set, `verify-desktop-install.mjs` runs that real
Chrome probe inside the official Desktop Host during the reinstallation boot,
using the installed package and the Host's dependency resolution. A failed
browser probe fails the lifecycle run. Its receipt records
`installedBrowserAccessVerified`; an omitted Chrome path records `false` and
does not claim browser execution coverage. The browser uses disposable state,
separate from the preserved installation profile.

The run migrated from the previously qualified `2be6427764d6` archive to
`dscode-desktop-0.7.32-dsh-0.2.0-rc.2-5e20af0cbfb1.tgz`, SHA-256
`5e20af0cbfb14dd77b4377d39d2f81ff84fe65a7ce3614ab875223e60b147ff7`.
The connection module was the only changed fingerprinted implementation entry.
All six signed-app boots passed, including incompatible-update rejection,
removal and reinstallation. The installed browser probe passed inside the
reinstalled Host: response loss, permission withholding and failed post-action
listing invalidated discovery without extra server writes. Its four deliberate
writes, permission boundaries and annotation admission checks also passed in
the separate default working-tree invocation. Persisted configuration,
credentials, permissions, sessions and the other existing lifecycle assertions
passed; temporary probe homes were removed.

The first attempt used a separate ordinary Node process and failed to resolve
the Host-provided `@deepseek-ai/dsh-llm` dependency before browser execution.
Moving the probe into the real Host fixed the verification environment without
adding a second core runtime to the package. Evidence is under
`artifacts/local/browser-webmcp-installed-*`, including that failed attempt,
the successful migration receipt and the matching retained private archive.
Documentation, lint and whitespace checks passed. This verification-only
change did not rerun the full release gate or use live model inference, and no
package version, commit or publication changed.

## WebMCP post-action failures invalidate discovery — 2026-10-07

The uncertainty handling below now also covers a successful tool response
followed by an unavailable page list or permission-withheld output. Those paths
already warned against replay and retained an owned tab, but left the discovery
record available after access or transport recovery. They now invalidate only
the affected page's discovery before returning the existing uncertainty error.

Three new cases reproduced the stale record after a post-action listing throw,
a listing error result and a permission revocation after the write. They now
verify one completed write, retained owned-tab evidence, unrelated-page
discovery preservation, refusal before rediscovery and explicit recovery.
All 77 browser/access tests passed. In real Chrome, the native access probe
also verified revocation after a completed site write and injected a page-list
failure after another real WebMCP execution. Restoring access or transport,
attempting execution without discovery, and rediscovering tools did not
increase the independent server-side write count. Four deliberately requested
writes were observed across the full probe.

Evidence is under `artifacts/local/browser-webmcp-postcheck-*`. Documentation,
lint and whitespace checks passed. This two-path follow-up was validated with
the focused suites and real-Chrome probe; the complete gate recorded below
preceded it. No live model, user profile or published package was involved.

## Uncertain WebMCP execution responses require inspection — 2026-10-07

A WebMCP execution whose response was lost previously propagated the transport
error while retaining its discovery record. The site could already have
completed a write, leaving a later retry able to invoke the same action without
explicit rediscovery. A thrown execution request now clears only the affected
page's discovery, retains an agent-owned tab, and explicitly reports that the
action may have completed and must not be replayed without inspection.
Ordinary action review remains required; a new discovery does not decide
whether repeating a site operation is appropriate.

The new unit case first completes the fake site's write and then loses
the response. It failed before the fix and now verifies one write, preserved
unrelated-page discovery, retained ownership, refusal before rediscovery, no
write during rediscovery and a deliberately requested fresh action. All 74
access and browser tests passed.

`verify-browser-access.mjs` also ran against real Chrome. Its adapter fault
throws after the real WebMCP tool response arrives, while a loopback server
independently counts the completed write. The follow-up refused execution and
rediscovery leave that count unchanged. The expanded native suite passed its
three deliberately requested server writes, existing permission and document
checks, and annotation-admission cases. This is controlled response-loss
injection, not a real network outage or live-model decision test. Evidence is
under `artifacts/local/browser-webmcp-uncertain-*`; no user profile or public
package was changed.
The complete `npm run check` gate passed with 952 unit/component tests, native
integration and package checks, and 63 evaluations. Documentation checks,
lint, both typechecks and `git diff --check` also passed.

## Installed distribution of the latest browser sidebar controls — 2026-10-07

The current combined preset was packed for Harness 0.2.0-rc.2 as
`dscode-desktop-0.7.32-dsh-0.2.0-rc.2-2be6427764d6.tgz`, SHA-256
`2be6427764d6190c2a6b1c238e9dc63e8b8673c08f5a49717e81f0e5b293401f`.
The official signed application's bundled CLI installed the older qualified
`e41ba5a74ab1` package, upgraded to the current implementation, rejected an
incompatible update, removed the package and reinstalled the current archive.
All six isolated application boots passed, including initial profile creation.

The lifecycle verifier now fingerprints both browser Desktop modules as well
as the composed client, connection, preview and extension files. The changed
entries are the Desktop host, browser client and composed client. After upgrade,
incompatible-update rejection and reinstallation, the installed stop RPC
succeeds and records matching readable command history. This no-browser stop
check verifies installed routing and idempotent control; real-Chrome stopping
is qualified separately below. The initial older package does not need the new
stop action. Removal still withdraws the preview RPC.

Saved provider configuration, credentials, site grants and revocations,
permission-guard identity, session history, deferred messages, scheduling,
email state and child worktrees survived the lifecycle checks. No second core
runtime was installed. The private archive's extracted composed client passed
all 60 browser-client cases. Its client and composed-client hashes match the
latest rendered Electron stop/restart verification, including the corrected
restart notice. The installed file hashes match this same archive.

Receipts are under `artifacts/local/browser-controls-distribution-*`; the
archive remains under `artifacts/desktop/packages/`. Temporary installation
and extraction homes were removed. Lifecycle-only version suffixes exist in
disposable staged manifests; the repository version remains unchanged. This
qualifies the macOS Apple Silicon 0.2.0-rc.2 carrier, not Windows or alpha
Desktop installers. Nothing was published or installed into the user's profile.

## Session-scoped browser stop from the Desktop sidebar — 2026-10-07

Browser preview now exposes **Stop browser** through the authenticated preview
RPC, executing the existing user `/browser stop` command and recording readable
status in the conversation. The command retains its existing startup
cancellation, scoped-tool withdrawal, browser ownership and profile rules.
Client stop shares the serialized control lane with permission changes, while
invalidating older ordinary requests immediately. It clears the selected tab,
pixels, point and automatic refresh but retains the annotation draft. Restart
requires a fresh image and point. Already admitted messages cannot be recalled.

Nine new component cases initially failed with the missing control. They now
cover stop during startup, capture, tab listing and annotation, both success and
failure of the superseded response, draft reuse after restart, duplicate stop
suppression and retry after a stop failure. All 83 preview/client cases passed;
the freshly packed combined client's 60 cases passed as well.
The complete `npm run check` gate passed lint, both typechecks, 951
unit/component tests, native integration and package checks, and 63 evaluations.

The full-preset real-Chrome probe stops through the sidebar RPC, confirms tool
withdrawal and rejection of tabs and old annotations, starts again, captures a
fresh preview and stops twice to check idempotency. This passed on native
Harness 0.2.0-rc.2 and 0.2.1-alpha.1 in both initial and restored-session
processes for each runtime. Receipts and logs are under
`artifacts/local/browser-sidebar-stop-*`.

The signed macOS Apple Silicon Electron 0.2.0-rc.2 window was then exercised
with a real Chrome capture held in the browser-only fixture. **Stop browser**
remained enabled, completed before the capture response was released, cleared
the selected tab and preserved the draft. The late response did not restore
the preview. Restarting, capturing `about:blank` and selecting a fresh point
delivered exactly one image-bearing annotation with the original draft.

That run exposed an obsolete stopped notice remaining visible after restart
until the next capture. Startup now clears the notice immediately. Eight
existing stop/restart component cases reproduced this display issue with a
new assertion before the fix; all 83 preview/client cases passed afterward.
A second signed Electron run using the combined DSCODE preset verified that
the notice disappears during startup and stays absent after reconnection,
while the draft remains intact. Its receipt fingerprints the current browser
client and the composed Desktop client. Screenshots and redacted logs are
retained under the same prefix. Both applications were stopped and their
disposable homes removed. Other pending-operation variants remain covered by
component tests. No user installation, published package or repository version
changed. The complete gate above preceded the one-line notice adjustment;
the focused suites, rendered follow-up, docs checker and lint cover that edit.

## Permission changes release obsolete preview request locks — 2026-10-07

Permission controls already invalidated an earlier capture, tab list or
annotation response. However, the old request retained the shared busy flag
until its transport settled. A completed permission change could therefore
leave refresh and startup disabled indefinitely. Each ordinary request now
owns its lock, and permission changes release the obsolete lock while keeping
permission writes serialized. Completion of an older request cannot release a
new request's lock. This changes client recovery only; it does not cancel an
already dispatched Host action or recall an admitted annotation.

Six new component cases hold capture, tab-list and annotation responses through
a site block, then start a new tab refresh before the old response returns.
They failed before the fix. They now pass for both old success and old failure,
including protection against duplicate new refreshes, stale pixels, stale
permissions and draft loss. A failed permission write also re-enables recovery
before an older capture settles. The preview and client suites passed all 74
cases; the freshly packed combined Desktop client passed all 51 client cases.
`npm run check` also passed lint, both typechecks, 942 unit/component tests,
the native integration and package gates, and 63 evaluations. The documentation
checker reported clean and `git diff --check` passed.

The signed macOS Apple Silicon Electron 0.2.0-rc.2 application also exercised
the production browser client in the browser-only bundle with a real Chrome
capture held by `DSCODE_BROWSER_UI_HOLD_CAPTURE=1`. While the first response was
still held, **Block site** re-enabled refresh controls and retained the draft.
After **Always allow**, a new capture completed and its center could be selected.
The fixture markers confirm that this fresh preview was observed before the
old response was released. Releasing it preserved the fresh image, point,
permission display and draft. Sending then delivered exactly one image-bearing
annotation whose timestamp identified the new capture. The client bytes in
the staged bundle matched the current source.

Evidence is under `artifacts/local/browser-permission-recovery-*`, including
the private package receipt, rendered screenshots, native hold/release and
annotation receipts, and a redacted Electron launcher log. The package
extraction and the stopped application's disposable home were removed.
Late failure and overlapping-new-request lock ownership remain component-test
cases; the rendered run covers capture recovery and stale-response rejection.
No user installation, published package or repository version was changed.

## Rendered Desktop verification of readable browser startup — 2026-10-07

The signed macOS Apple Silicon Harness 0.2.0-rc.2 application was started with
the combined preset in a disposable home and `DSCODE_BROWSER_UI_START_STOPPED=1`.
In Browser preview, annotation text was entered before clicking **Start browser**.
The text survived first-tab selection. Expanding the new command row displayed
readable connected status, isolated/headless mode, the `about:blank` tab and
command guidance, without the previous JSON object.

**Refresh preview** returned a 1280 by 800 Chrome image. Selecting its center
enabled **Send annotation**. Sending admitted exactly one image and comment,
cleared the unchanged draft and displayed the image-delivery confirmation.
The scripted custom HTTP model received the exact provider-ready image bytes
and replied `DESKTOP_ANNOTATION_OK`. The staged browser Desktop host module's
bytes matched the current source.

Screenshots, the image-transport receipt and a token-redacted launcher log are
under `artifacts/local/browser-readable-electron*`. The isolated application
was stopped and its temporary home removed. This adds rendered Electron
evidence to the native Host checks below; it does not qualify Windows or live
model understanding. No user installation or repository version changed.

## Readable browser startup in Desktop conversation history — 2026-10-07

The sidebar previously executed `/browser start --json`. The command service
persists its result before returning it to the caller, so parsing that result
for the RPC also left the internal JSON in the conversation. Sidebar startup
now executes the ordinary text command and returns its message as an
acknowledgement; the client continues to refresh tabs through the separate RPC.
Explicit JSON commands retain their existing output.

The packed full-preset browser probe now stops Chrome, starts it through the
authenticated sidebar RPC, and reads the actual new `command/done` event. It
requires readable connected status, checks the acknowledgement against that
persisted text, refreshes tabs, captures a fresh screenshot, and confirms that
an explicit `/browser start --json` still returns parseable connected status.
The new history assertion failed before the fix on Harness 0.2.0-rc.2.

After the fix, the same packed native Host check passed on 0.2.0-rc.2 and
0.2.1-alpha.1 through initial startup and session restoration in a second Host
process for each runtime. The existing
68 browser preview and client tests also passed. Evidence is under
`artifacts/local/browser-start-readable-*`. These checks use real Chrome and
scripted loopback model responses; they do not render Electron's conversation
rows, perform live model inference, or install into the user's profile. No
package was published or repository version changed.

## Rendered Desktop verification of a draft written before browser startup — 2026-10-07

The full-preset Electron fixture now accepts
`DSCODE_BROWSER_UI_START_STOPPED=1`. It prepares the normal scripted session,
stops its browser, and reports `browserInitiallyStopped` before native UI work.
The flag is forwarded only to the disposable fixture; it does not change the
product's startup behavior.

In the signed official macOS Apple Silicon Harness 0.2.0-rc.2 application, the
Browser preview panel initially showed the start-browser error, no selected tab
and disabled capture/send controls. Native UI input entered
`Keep this draft through the first browser start.` before pressing Start browser.
When the first `about:blank` tab appeared, the text remained and Send annotation
was still disabled. Refresh preview returned a real 1280×800 screenshot;
selecting its center enabled sending. The subsequent click admitted exactly one
annotation with the original text and image. The loopback model endpoint
confirmed exact provider-ready image bytes and replied `DESKTOP_ANNOTATION_OK`;
the pane cleared the acknowledged text and showed its image-delivery notice.

The running composed client matched the extracted client from private package
`a67a667ee07d550292734edcf9239ee7c9c9c63439b5660c14748fbd06a7a01f`.
Evidence is under `artifacts/local/browser-initial-draft-electron*`, including
screenshots before sending and after acknowledgement. The launcher exited,
saved its receipt and removed the disposable home. No user profile or installed
package was changed. This proves the first-selection path in the rendered
application with a real blank Chrome page; it is not live model inference or
Windows qualification. Documentation, lint and whitespace checks passed.

## Keep annotation drafts when the first browser tab becomes available — 2026-10-07

Browser preview now distinguishes selecting the first available tab from
replacing a previously selected tab. Text entered while the browser has not
started or its tab list is empty survives the first successful selection. An
existing draft associated with a closed tab is still cleared when the panel
falls back to another tab; same-tab navigation continues to retain it.

Two regressions failed before the change because their previously entered text
became empty after Start browser or Refresh tabs. They now verify the text is
retained, sending remains disabled until a fresh screenshot and point exist,
and the eventual annotation uses that text and the new receipt exactly once.
The existing closed-tab/navigation case also explicitly checks the intended
draft retention boundary. All 45 preview component cases passed from source and
against the newly packed composed client.

Evidence is under `artifacts/local/browser-initial-draft-*`. This is component
interaction and packaged-client verification; the new first-selection flow was
not driven in a rendered Electron window. The private package is newer than
the installed-lifecycle package qualified below. No user installation was
changed and no package was published.
The full project gate passed 936 unit/component cases, native integration and
package checks, and 63 evaluations. The added closed-tab assertion was checked
in the focused source/packed runs after that gate's unit phase. Documentation,
lint and whitespace checks also passed.

## Browser recovery in a new Host process on both Desktop runtimes — 2026-10-07

The combined preset verifier previously exercised browser behavior only in its
initial process; its second process checked custom model configuration. The
second process now resumes the same browser conversation, confirms the earlier
annotation response is still present, verifies persisted allowed and blocked
origins, and checks that no live MCP browser connection was inherited. It then
explicitly starts Chrome and repeats navigation, screenshots, preview RPC,
image annotation, receipt reuse rejection, permission revocation and shutdown.
A separate newly created full-preset Agent confirms browser tools remain scoped.

The scripted HTTP fixture now inspects the latest user message when identifying
an annotation. Historical annotations in a resumed conversation must not replace
the current browser task. Each run admits exactly one new annotation and checks
the image received by the HTTP endpoint against the corresponding stored
attachment's provider-ready bytes. Initial and restart results are recorded
separately, along with the tested tarball SHA-256.

Both independent native Hosts passed with the current packed preset and real
Chrome: Harness 0.2.1-alpha.1 and 0.2.0-rc.2. The alpha tarball SHA-256 is
`55bd2a76c62a514a0b305ba145249a35b5cfeaf74f631a8d86f64a2c1d48d098`;
the release-candidate run used the same
`e41ba5a74ab18b2dccabceac17661a03bc95112b1fb559022c6f204f0963c66a`
package qualified below. All 43 preview component cases also passed against
the alpha archive's extracted composed client. Source runtime hashes were
unchanged. Evidence is under `artifacts/local/browser-restart-*`.

These are independent Host process restarts with a shared disposable home,
not in-process plugin hot reload or rendered Electron interaction. No new alpha
installer, Windows execution, live model inference or restoration of a running
browser after a crash is qualified. No package was published or installed into
a user's profile. The source gate remains the preceding 934 unit/component
cases and 63 evaluations; the affected native probes, packed component cases,
documentation, lint and whitespace checks were rerun for this verification work.

## Qualify the packaged extension and Desktop upgrade — 2026-10-07

The current private Desktop preset was packed for official Harness 0.2.0-rc.2
without changing the repository version or publishing a package. Its SHA-256 is
`e41ba5a74ab18b2dccabceac17661a03bc95112b1fb559022c6f204f0963c66a`.
The preceding installed baseline was
`fe228e42e02ab9af7b8829e32a9a797fe535e27e97c9f7326a4e12f59ad9f7ab`.
The browser connection, extension popup and extension worker differ between
those actual archives.

The extension verifier now accepts an extracted extension directory and records
the SHA-256 of its manifest, popup HTML/CSS/module, worker and protocol. This run
unpacked the new tarball, checked those bytes plus the browser connection and
preview modules against the current source, and loaded that unpacked extension
into disposable Chrome for Testing. The complete native extension probe passed,
including pending-pairing recovery, immediate cancellation, live popup state,
page isolation, screenshots, iframe/worker behavior and revocation. The tested
extension was taken from the archive; the BrowserConnection test driver still
imports the byte-identical source module.

The installed lifecycle verifier now fingerprints those six extension files as
well as the previously checked plugin implementations. The real signed macOS
Apple Silicon application completed initialization, baseline install, upgrade,
rejected incompatible update, removal and reinstall. Each applicable phase
checked the installed bytes. Configuration, credentials, site grants and
revocations, permission guard inode, sessions, deferred mailbox, schedules,
email preferences and named child worktrees survived. The removed plugin's RPCs
were withdrawn; reinstall restored them without a second core runtime or
duplicate deferred delivery. Both receipts identify the same package and
extension hashes.

Evidence is under `artifacts/local/browser-extension-distribution-*`; the
content-addressed tarball is under `artifacts/desktop/packages/`. Lifecycle
version suffixes exist only in disposable staged fixtures. No user installation
or profile was changed, and no package was published. This qualifies macOS
Apple Silicon on Harness 0.2.0-rc.2; it does not qualify Windows, a fresh rendered
annotation flow or live model inference. The previous full source gate remains
934 unit/component cases and 63 evaluations; this change reran the affected
native package/lifecycle probes and documentation, lint and whitespace checks.

## Keep the open extension popup in sync with sharing — 2026-10-07

Connected popups now refresh worker status approximately once per second,
including shared-tab titles, closed tabs and remote disconnection. Background
reads keep sharing controls available. A share or stop action invalidates an
older scheduled read and any late response from a read already in progress.
Pending pairing retains its faster 250 ms refresh; disconnected popups stop
polling. Closing the popup destroys its document and timers.

Three new regressions failed before the change: closed tabs remained in the
popup and connected state scheduled no further reads. The corrected tests
cover tab removal, remote disconnection, controls remaining enabled during a
delayed status read, and late success/error responses unable to overwrite stop.
All 26 focused popup, worker, protocol and relay cases pass.

The native MV3 probe renames a real shared page, closes a second shared page,
and later pairs with a fresh relay before closing that relay remotely. Without
reloading the popup, its list and controls update, the disconnection reason
appears and the toolbar badge clears. The verifier polls DOM state independently
of animation frames because the fixture popup can be a background page; its
initial animation-frame wait timed out even though both the worker response and
displayed title had already updated. The complete extension suite passes with
that observation corrected.

Evidence is under `artifacts/local/browser-extension-live-status-*`. Tests use
disposable Chrome for Testing and loopback fixtures, with no live inference,
manual toolbar interaction or changes to the user's installed extension.
The full project gate passed 934 unit/component cases, native integration and
package checks, and 63 evaluations. Documentation, lint and whitespace checks
also passed.

## Restore pending pairing after reopening the extension popup — 2026-10-07

The worker now reports pending pairing, and a newly opened popup exposes its
stop control, disables duplicate pairing and refreshes that state every 250 ms
until the attempt settles. A later user action invalidates any scheduled older
refresh. The worker explicitly cancels a pending WebSocket wait on stop and
settles it on close, error or timeout, clearing its timer and temporary handlers.
Chrome attachment work already in progress still has to settle before another
pairing can start.

Three new popup/worker regressions failed before the change. The updated cases
cover pending-state restoration, eventual connection, stop invalidating a
scheduled refresh, immediate connection-wait cancellation and subsequent
pairing. Three additional worker cases cover close, error and timeout cleanup.
All 23 focused popup, worker, protocol and relay cases pass.

The native MV3 fixture accepts a real TCP connection but withholds the WebSocket
upgrade. It closes the original popup page, opens a fresh one, verifies pending
state and stops the attempt. Within a two-second assertion deadline, the popup
returns to its stopped state and enables pairing; the extension's real debugger
command is refused because its attachment is gone. Pairing immediately with
the normal relay then succeeds and the existing complete extension suite passes.
This uses a disposable extension page in Chrome for Testing, not a manual click
on the system toolbar. No live inference, user browser profile or installed
extension is involved. Evidence is under
`artifacts/local/browser-extension-reopen-*`.
The full project gate passed 931 unit/component cases, native integration and
package checks, and 63 evaluations. Documentation, lint and whitespace checks
also passed.

## Stop sharing while the extension popup is busy — 2026-10-07

The popup exposes **Stop all sharing** during pairing and keeps it enabled
while another tab is being shared. Each action owns a revision: stopping
invalidates an older tab lookup or request, so its eventual success, failure
or button cleanup cannot overwrite the newer popup state. A cancelled lookup
never dispatches its pairing or sharing request. The worker's existing
revocation path releases any debugger attachment already in progress.

Three regressions execute the production popup module with controlled DOM and
Chrome adapters. They reproduce the disabled stop control, a late sharing
success or error, and cancellation before a delayed pairing lookup returns.
All three failed before the change; all 17 popup, worker, protocol and relay
cases passed afterward.

The real unpacked MV3 verification clicks Share and Stop in the same browser
task, while Chrome's active-tab lookup is pending. It confirms the stop control
remains enabled, the relay closes, subsequent MCP reads fail, the popup returns
to its stopped state and the toolbar badge clears. Existing isolation, iframe,
worker and attachment-cancellation probes also pass. Delayed RPC success and
failure are qualified by the controlled popup tests, not native fault injection.

Evidence is under `artifacts/local/browser-extension-stop-*`. The native run
uses disposable Chrome for Testing with loopback fixtures and no live model
inference. No user's installed extension or browser profile was changed.
The full project gate passed 925 unit/component cases, native integration and
package checks, and 63 evaluations. Documentation, lint and whitespace checks
also passed.

## Extension badge follows the current sharing connection — 2026-10-07

The extension worker no longer clears the toolbar badge when an older stop
finishes detaching after a new connection has been paired. Shutdown checks
whether another connection now owns the state before clearing the badge.

A worker-level regression executes the production worker with the real
SharedTabs implementation and controlled Chrome/WebSocket adapters. It holds
the old debugger detach, pairs a second tab, then releases the old stop. Before
the fix, the new connection remained live while its badge became empty. After
the fix, its **ON** badge, socket and attachment remain intact; ordinary stop
still clears the badge, closes the socket and releases the attachment. All 14
worker, protocol and relay cases passed.

The native MV3 verification also checks the real toolbar badge after pairing and
after stopping through the popup, alongside its existing page-scope, iframe,
worker and revocation probes. The delayed-detach overlap is qualified by the
controlled worker test; the native run covers normal badge transitions.
Evidence is under `artifacts/local/browser-extension-badge-*`. The extension
was loaded only in disposable Chrome for Testing; no user's Chrome profile or
installed extension was changed.
The full project gate passed with 922 unit/component cases, native integration
and package checks, and 63 evaluations. Documentation, lint and whitespace
checks also passed.

## Preserve tabs after post-action verification failure — 2026-10-07

A failure while refreshing the page list after an operation now retains its
confirmed owned target as `unverified-action`. This covers a successful
`new_page` result followed by a transport exception or tool-level listing error:
the request has no input page ID, so the ordinary tool-result retention hook
could not protect it. The error reports that the action may have completed and
requires inspection before any retry. A reconnect observation clears ownership
before this retention check, preventing retention of recycled page IDs.

Two unit regressions failed before the change, and a separate real Chrome run
confirmed that cleanup closed the just-created tab after its verification
response was lost. The updated native probe keeps that tab while still closing
an unrelated temporary tab and preserving the user-created and explicitly kept
tabs. The fault is injected only after real Chrome returns a new-page result;
there is no simulated tab creation or automatic replay. A third regression
covers ID reuse after Chrome restarts during verification.

Evidence is under `artifacts/local/browser-unverified-tab-*`. No rendered
Desktop interaction or live model inference was used, and no package was
published or installed by this change.
The complete real-browser suite passed. The full project gate passed 920
unit/component tests, native integration/package checks and 63 evaluations;
documentation, lint and whitespace checks also passed.

## Permission revocation before browser dispatch — 2026-10-07

BrowserConnection now checks site and Developer permission again after awaited
admission, WebMCP and file preparation, immediately before sending the operation
to Chrome. A revocation visible to this final read prevents dispatch. Permission
may still change after the read, and an action already sent cannot be undone;
the existing post-action output withholding remains in place.

Four regressions reproduced a dispatched action after initial admission had
passed but another BrowserAccess instance revoked ordinary, site Developer,
global Developer or temporary access. The pre-fix real Chrome probe also
reproduced one actual navigation request after a site block. After the change,
all 93 focused browser/access/preview cases passed and the native probe observed
zero blocked navigation requests followed by one successful explicitly
reauthorized request. No operation was automatically replayed.

Evidence is under `artifacts/local/browser-dispatch-revocation-*`. The changes
remain local and are newer than the installed package qualified below.
The complete real-browser suite passed, including handoff/resume, file-boundary
checks, WebMCP, document identity, large images and the native Harness probe.
The full `npm run check` gate also passed: 917 unit/component cases, native
integration/package checks and 63 evaluations. Documentation, lint and
`git diff --check` passed after the verification record was updated.

## Installed migration across browser implementations — 2026-10-07

The signed macOS Harness 0.2.0-rc.2 application and its bundled CLI passed a
complete installation lifecycle starting with the previously qualified private
package `885c5d6135cb` and upgrading to the current browser implementation.
The baseline package SHA-256 was
`885c5d6135cb0ab2788e938fed29b3a557662705fa5116f46ea00ca4107ab2e3`;
the current package SHA-256 is
`fe228e42e02ab9af7b8829e32a9a797fe535e27e97c9f7326a4e12f59ad9f7ab`.

The verifier now accepts a baseline whose browser code changed even when custom
model configuration code did not. It records both package digests and hashes for
custom configuration, browser connection, preview admission and the composed
Desktop client, and checks the installed files after install, upgrade, rejected
update and reinstall. This run changed the latter three entries. Legacy custom
configuration fixtures remain selected only when that configuration code differs.

All six native boots passed: initialize, installed, upgraded, rejected, removed
and reinstalled. Configuration, credentials, browser grants/revocations and the
permission guard inode survived, alongside persisted sessions, deferred messages,
scheduled work, email state and named-child worktrees. Incompatible installation
left the current implementation intact; removal withdrew its RPCs; reinstall
restored them and resumed pending work without duplicate delivery. The verifier
exited zero after cleaning its disposable home. The upgrade uses a private
staged version; no repository version bump, commit or publication was performed.

Evidence is in `artifacts/local/browser-current-install-package.json` and
`artifacts/local/browser-current-install-migration.{json,log}`. This qualifies
installed Host behavior across the named implementation change. It does not
test an official application upgrade, another operating system, live inference
or rendered browser interactions; those UI checks have separate dated records.

## Browser capture age includes delivery — 2026-10-07

Preview receipt age now starts immediately before the screenshot request, after
the initial page listing. Chrome provides no pixel capture timestamp, so this
is a conservative lower bound that includes queueing, transfer and final page
verification. A screenshot already sixty seconds old when returned is refused
before creating a receipt or marking an owned tab for preview retention.

Three regression cases failed before the change. All 66 preview/client cases
passed afterward, including rejection at exactly sixty seconds and recovery
with a new capture. The real Chrome document probe also passed. It advances a
fixture clock after real screenshot delivery to simulate 59,999 ms and 60,000 ms
of age, verifies rejection without attachment writes, then sends a fresh capture.
It also reruns the existing iframe reload, process swap, insertion and removal
cases. This is deterministic clock qualification, not a sixty-second network
delay or a rendered Electron test; no live model was used.

Evidence is under `artifacts/local/browser-capture-age-*`. The change remains
local and does not update previously built Desktop packages.
The full `npm run check` gate passed with 913 unit/component tests, native
integration/package checks and 63 evaluations; documentation, lint and whitespace
checks also passed.

## Browser sidebar draft retention — 2026-10-07

The browser pane retains its current session's text and selected Chrome tab in
memory while hidden. Its screenshot, point, refresh timer and pending UI lock
are still disposed. The native sidebar registration opts into `keepMounted`,
so selecting another sidebar tab preserves the draft owner as well. Closing the
pane, changing sessions or reloading the application does not persist drafts.
Late list responses cannot change the reopened selection, and send acknowledgements
clear only an unedited draft, including when the pane has been reopened.

Four regression cases failed before the implementation. All 43 client cases
passed afterward, both from source and from the composed private package. The
official macOS Harness 0.2.0-rc.2 application separately verified switching from
Browser preview to Start and back, collapsing/reopening the sidebar, preserved
text with no old screenshot, a fresh capture and point, and one successful
annotation carrying the preserved text and exact provider-ready image bytes to
the scripted local HTTP model. The sent draft cleared and the rendered chat
showed `DESKTOP_ANNOTATION_OK`. This run used no live model inference.

The full gate passed with 910 unit/component tests, native integration/package
checks and 63 evaluations. Evidence and screenshots are under
`artifacts/local/browser-sidebar-draft-*`; the private package SHA-256 is
`c6c8c2606e333e0169032d756c2c245b7abe749fb80a2b768a14b35f3fa40c74`.
The actual rendered composed client matched that package byte for byte. The
package remains local; this run does not qualify its installed CLI lifecycle.

## Browser annotation delivery feedback — 2026-10-07

The preview confirmation now describes the actual image projection. Image-capable
routes retain their image-delivery confirmation; text-only routes and failed model
metadata lookups explicitly say that the model will receive text only and that
the screenshot is saved in the conversation.

The two text-only feedback assertions failed against the previous implementation.
After the change, all 59 preview and Desktop client tests passed, including
durable screenshot retention on metadata failure. The real Harness/Chrome runtime
probe also passed: an image-capable annotation reached the scripted adapter with
an image, and a text-only annotation reached it without image blocks while
returning the text-only confirmation. Both paths use native attachment handling.
Evidence is under `artifacts/local/browser-annotation-feedback-*`. No live model
inference or rendered Electron interaction was performed for this wording change.
The full `npm run check` gate passed with 906 unit/component tests, native
integration and package checks, and 63 evaluations. Documentation checks, lint
and `git diff --check` also passed. The change remains local and unpublished.

## Harness 0.2.1-alpha.1 compatibility after browser updates — 2026-10-07

The current complete Desktop preset passed an npm pack/unpack round trip and
independent native Host initial/reload boots against the installed Harness
0.2.1-alpha.1 source runtime. The probe verified persistent/fresh shells,
spawn/fork and workspace isolation, custom credentials and settings RPC,
Chat Completions/Responses/Anthropic image input, browser tool scope, screenshot
and annotation delivery, permission revocation, and permissions following a
navigated capture. The runtime-source integrity checks passed.

The four MCP image-projection regressions were also copied with the current
adapter into a disposable directory resolving this exact runtime's dependencies.
All passed: a canonical 9 MiB image reached the durable projection, malformed
base64 was refused before storage, image capability and cancellation admission
remained enforced, and an unrecognized adapter source shape was refused. This
separate projection check uses a fixture attachment store; it complements the
native Host's real attachment/model transport checks rather than replacing them.
The disposable directory was removed.

Evidence is under `artifacts/local/browser-alpha-compatibility-*`. The runtime-
specific private package SHA-256 is
`d0ccee838a215c6a66873ff41a69e719342b1a1539cc5e5b07f2f90af161c681`.
Its browser connection, registration, image adapter, screenshot adapter, preview
and client files match the current worktree. This run did not render the alpha
Web UI, install an alpha desktop application or test its CLI installation
lifecycle. Signed macOS application interaction remains qualified on 0.2.0-rc.2
as recorded below. Production source was unchanged from the 905-test full gate;
no repository version was bumped and nothing was published.

## Compact rendered browser preview — 2026-10-07

The previous 1280 × 820 desktop screenshots showed the always-open permission
section pushing the annotation field and send button below the visible panel.
The default view now uses a collapsed permission summary, smaller spacing and a
fitted image limited to 30% of the window height. Its visible and accessible
summary names the current access decision. Expanding it exposes the same exact
origin, site controls and nested Developer controls. **Expand image** still
provides a larger view; these display changes do not resize the saved PNG.

The signed macOS arm64 Harness 0.2.0-rc.2 application rendered the complete preset
at 1280 × 820. The screenshot, comment field and send button were visible together
in the default fitted view. Native interaction verified permission expansion,
Developer status remaining off, image expansion and return to fit, and selection
of the orange button at pixel (117, 247) in the 1280 × 800 source image. Sending
the typed comment delivered one annotation through the production custom HTTP
adapter; the loopback model verified the provider-ready image bytes and returned
`DESKTOP_ANNOTATION_OK`. The field cleared after success. The final composed client
was byte-compared with private package
`0ba0926b90d1f56651d107250ee3b3426a7de821b2600000fab02853ebd4c32a`.

The 39 existing client interaction cases and full `npm run check` passed: 905
unit/component tests, native integration and package checks, and 63 evaluations.
The final native launcher exited with code zero and removed its isolated home;
the earlier layout-inspection fixture was also stopped and removed. Evidence,
including ready-to-send and successful-send screenshots, is under
`artifacts/local/browser-preview-layout-*`. This visual qualification covers the
stated macOS window size; shorter windows and expanded permission/image views
can still require scrolling. No live inference, new OS permission, repository
version bump or publication was involved. The installer lifecycle was not rerun
for this client-only change.

## Rendered Desktop navigation draft recovery — 2026-10-07

The signed macOS arm64 Harness 0.2.0-rc.2 application ran the current complete
DSCODE preset in an isolated home. The staged composed client, connection,
browser registration and preview modules were byte-compared with private package
`e0359a83c553` (full SHA-256 in the following section). Only the interactive
loopback fixture gained a file-controlled URL-fragment change; production source
remains unchanged from the 905-test full gate recorded below.

In the rendered Browser preview, a 1280 × 800 capture received a selected point
and a typed comment. The fixture then changed its URL to `#draft-review`.
Clicking **Refresh tabs** displayed the new address, removed the old screenshot
and point, kept the complete draft and disabled **Send annotation**. Refreshing
the preview retained the text and still required a new point. Selecting the
orange button chose pixel (115, 246); sending delivered exactly one annotation
with the new URL, preserved text and image through the production custom HTTP
adapter. The loopback model verified the provider-ready attachment bytes and the
conversation displayed `DESKTOP_ANNOTATION_OK`. The input cleared after success.

Developer mode stayed off, no live credentials or inference were used, and the
launcher exited with code zero and removed its isolated home. Screenshots of the
preserved draft and successful send, the annotation receipt and redacted launcher
log are under `artifacts/local/browser-navigation-draft-electron-*` (the launcher
log is `artifacts/local/browser-navigation-draft-electron.log`). This rendered
case covers fragment navigation; same-site and cross-site URL changes retain
their component qualification. It does not replace the separate native installer
lifecycle or establish live-model visual understanding. Nothing was published.

## Retention requested during tab cleanup — 2026-10-07

Two deterministic regressions reproduced cleanup closing a tab after it was
marked for retention while cleanup awaited a page-list or site-permission read.
A real Chrome fixture reproduced the same closure by holding the second native
page-list response, marking the candidate for preview retention, then releasing
the response. Cleanup had checked retention only before awaiting those reads.

Cleanup now rechecks both ownership and retention after each read and before
dispatching a close. The two regression cases verify that no close is sent, that
the retention reason survives and that a later cleanup still preserves the tab.
The real Chrome fixture verifies that the newly retained tab stays open while
an unmarked temporary tab closes and the original user and handoff tabs remain.
All 48 focused browser and preview cases and the complete real-browser suite
passed. The latter also covers manual handoff/resume, WebMCP document binding,
frame identity, large PNGs and native Harness tool/image/approval behavior.
The full `npm run check` passed: 905 unit/component tests, native integration and
package checks, and 63 evaluations.

Evidence is retained under `artifacts/local/browser-cleanup-retention-*`, including
the original unit and real-Chrome failures. Private package SHA-256 is
`e0359a83c55314a18f254da65137786a2c038bf5f9440ce49993c30b1e21f428`;
its connection module matches the source and its guide/changelog match the
Desktop documentation transformations. Retention cannot cancel a close already
dispatched to Chrome. The later rendered Desktop qualification is recorded above;
native installation was not rerun for this package. No repository version was
bumped and nothing was published.

## WebMCP discovery and review document binding — 2026-10-07

The real Chrome WebMCP fixture reproduced execution from a stale discovery after
a same-URL reload registered an identical tool definition. Seven initial unit
regressions also failed for replaced or unavailable documents and changes during
discovery or execution revalidation. URL and definition equality alone did not
identify the document whose tools the agent had inspected.

Discovery records now retain the existing browser-issued frame document identity.
Page observations invalidate records whose document changed or became unavailable.
Discovery compares its before/after identities and connection generation. Native
Chrome MCP's WebMCP discovery result omits page metadata, so execution explicitly
observes pages again after reading registration and before dispatch. A failed or
missing observation invalidates the discovery. The native tool-admission binding
also retains document identity; rediscovery in a replacement document cannot
transfer an earlier review, even when its URL and definition match.

All 115 focused access, tool-registration, preview and review cases passed. Cases
cover native-shaped discovery without page metadata, a reload while reading that
discovery, missing revalidation metadata, and a stale review through the real MCP
tool definition followed by one newly reviewed execution. The complete real-Chrome
browser suite passed, including the same-URL reload rejection, fresh discovery,
two deliberately counted WebMCP writes, in-flight permission revocation, frame
identity, large screenshots and native Harness tool/approval/image behavior.
Developer mode was off for the reload/discovery/execution case.

The full `npm run check` passed: 903 unit/component tests, native integration and
package checks, and 63 evaluations. The private package's updated browser modules
and bundled skill match the source; its guide and changelog match the expected
Desktop link transformations.

Evidence is retained under `artifacts/local/browser-webmcp-document-*`. The new
private Desktop package SHA-256 is
`2c0c303af715ca573812ad68f4dcd08e44150d8b9a7f2d76f3c36566502da86c`.
This change does not make registration checks atomic with execution or attest to
website code: a registration can still change after the last observation. The
same-URL reload was exercised in real Chrome; changes during discovery were
controlled component fixtures. Rendered Desktop and its installation lifecycle
were not rerun for this package. No repository version was bumped and nothing
was published.

## Annotation drafts across same-tab navigation — 2026-10-07

Three client regression cases reproduced lost text when **Refresh tabs** observed
same-site navigation, a fragment-only URL change or cross-site navigation in the
selected tab. All three failed with an empty draft before the fix. The client
now separates a change of selected tab from navigation within that tab. A changed
URL or document invalidates the old screenshot and point, stops automatic refresh
and explains that the draft was kept. Sending requires a fresh capture and point.
Choosing another tab or falling back after tab closure retains its prior behavior.

All 39 React client interaction cases passed against the source and again against
the composed client extracted from the private Desktop package. Each new case
also sends the preserved text with a fresh capture token and verifies that the
successful send clears the draft. The package SHA-256 is
`3243c4a82042ed7085ef0eaf848a5a7c167b22f67bb1f9a2bfe8fc26a92f8e5d`.
The full `npm run check` also passed: 892 unit/component tests, native integration
and package checks, and 63 evaluations. Evidence is retained under
`artifacts/local/browser-navigation-draft-*`.
The navigation cases are component and packaged-client checks; rendered Electron interaction
and native installation were not rerun for this client-only change. The separate
lifecycle qualification below remains tied to package `885c5d6135cb`.
No repository version was bumped and nothing was published.

## Large PNG preview and model projection — 2026-10-07

A real Chrome fixture reproduced a 3,081,183-byte PNG being refused despite the
preview's 12 MiB limit. Chrome MCP offloads screenshots at 2,000,000 bytes to a
temporary file. The scoped adapter now retains the trusted PNG buffer inline
through 12 MiB while preserving the upstream file write and path response. It
does not read paths from tool output. Explicit file exports, other tools,
non-PNG formats and failed calls retain their existing behavior; concurrent
requests cannot share captured buffers. The stdio allowance is 20 MiB to carry
the maximum image's 16 MiB base64 representation plus response metadata.

Native Desktop then exposed a second failure: the upstream MCP client's repeated
base64-validation regex exhausted the stack on large image results. A 9 MiB
unit fixture reproduced that failure. A version- and source-guarded in-memory
module adapter replaces that regex with a flat character check, preserving the
original exact base64 round trip, image admission and durable projection logic.
Installed dependency files remain untouched; unknown source shapes fail closed.

The real-browser verifier passed 1280 × 800 (3,081,183 bytes) and 1920 × 1440
(8,324,193 bytes) captures, including a response above the old 10 MiB transport
limit. Explicit exports remained file-only. A 2560 × 1920 image above 12 MiB was
refused, and reducing the viewport restored capture and annotation. Boundary,
concurrency, malformed input, capability and cancellation cases also passed.

The signed macOS arm64 Harness 0.2.0-rc.2 application displayed a 2000 × 1500
fixture in the full local DSCODE preset. Selecting pixel (133, 224) and sending
a comment delivered exactly one image annotation to the scripted loopback model,
which returned `DESKTOP_ANNOTATION_OK`. Both tool screenshots and annotation
images reached the endpoint. The byte assertion covers the attachment pipeline's
provider-ready image; that pipeline may resize or re-encode the original PNG.
Developer mode stayed off. The launcher exited successfully and cleaned its home.

The final `npm run check` passed 889 unit/component tests, native integration and
package checks, and 63 evaluations. The complete browser suite passed before the
MCP validation adapter; its native Harness runtime probe was rerun successfully
after that adapter. The final private preset passed pack/unpack and independent
native Host initial/reload boots. This Host probe is separate from rendered UI.
Evidence is retained under `artifacts/local/browser-preview-large-images-*`.
Package SHA-256 is
`885c5d6135cb0ab2788e938fed29b3a557662705fa5116f46ea00ca4107ab2e3`.
The rendered run preceded only a diagnostic sourceURL comment in the adapter;
the final package and regression gate include that comment.

The same package then passed the signed application's bundled CLI lifecycle:
initialization, installation, upgrade, incompatible-update rejection, removal
and reinstallation each completed an official Desktop boot. Both package digest
fields in the lifecycle receipt match the SHA-256 above. The upgrade fixture
changes only its private staged package version; it does not establish migration
from an older browser implementation. Configuration, credentials, browser grants
and revocations, the shared permission guard inode, persisted sessions, deferred
messages, scheduling state and named-child worktrees survived the operations.
An incompatible update left the previous profile intact and bootable. Removal
withdrew the package's RPCs, and reinstallation resumed existing sessions and
pending work without duplicate delivery. The verifier exited with code zero
after cleanup. Its retained log and receipt are
`artifacts/local/browser-preview-large-images-install.log` and
`artifacts/local/browser-preview-large-images-install.json`.

The lifecycle probe validates installed Host behavior, permissions and RPC
registration; rendered screenshots and annotations are covered by the separate
Electron run above. These checks do not qualify other operating systems, an
in-place official-application upgrade or live model reasoning. Upstream screenshot
temporary file behavior remains unchanged. No repository version was bumped and
nothing was published.

## Headless preview viewport and background resizing — 2026-10-07

The real-Chrome verifier reproduced an initial 1200 × 2029 PNG, matching the
tall image seen in the previous native Desktop run. Headless persistent and
isolated launches now pass the pinned Chrome MCP's `--viewport 1280x800` option.
Visible and attached launch modes receive no viewport override.

A stronger screenshot assertion also exposed an existing background-tab resize
problem: `resize_page` changed Chrome's window bounds to 640 pixels wide while
the page layout and screenshot stayed at 1280. Waiting 500 ms did not change the
result. A direct Puppeteer probe confirmed that activating that same tab updated
its layout. The in-memory MCP adapter now activates the target before the native
resize handler, limited to `--headless` processes; installed dependency files
remain untouched. The real verifier checks initial 1280 × 800 pixels, a background
tab resized to 640 × 800, and a persistent-profile restart restored to 1280 × 800.
Its existing form, dialog, upload, ownership, handoff and attached-browser checks
also pass.

The signed macOS arm64 Harness 0.2.0-rc.2 application ran the complete local DSCODE
preset in an isolated home. Its rendered Browser preview showed the new landscape
image. Clicking the fixture's orange button selected pixel (119, 246); sending a
comment delivered one 1280 × 800 screenshot annotation through the production
custom HTTP adapter. The loopback model verified exact attachment bytes and the
conversation displayed `DESKTOP_ANNOTATION_OK`. Developer mode stayed off. The
launcher exited successfully and removed the isolated home.

`npm run check` passed: 879 unit/component tests, native integration and package
checks, and 63 evaluations. Evidence is under
`artifacts/local/browser-preview-viewport-*`, including the original failure,
resize diagnosis, successful Chrome run, rendered screenshot and annotation
receipt. The private package is `90da64732c6f` (SHA-256
`90da64732c6f3ebe3573256d4bcf1691d1a270384a8002d27af585ceb322fdb9`).
The complete preset also passed an npm pack/unpack round trip and two independent
native Host boots on Harness 0.2.0-rc.2, including browser capture, annotation,
permission revocation and the production custom-model routes. That probe is
separate from the rendered Electron run and does not drive its controls.
This run does not qualify other operating systems or live model reasoning. The
new headless behavior does not change emulated device metrics; callers using
device emulation must manage that override separately. No repository version
was bumped and nothing was published.

## Rendered Desktop iframe annotation recovery — 2026-10-07

The official signed macOS arm64 Harness 0.2.0-rc.2 application ran the complete
DSCODE preset in an isolated home. Its seven browser and composed-client sources
were byte-compared with private package `37fd32e3f49d`; this run stages that source
through the build helper rather than installing the tarball. The interactive
fixture now contains a cross-site iframe and accepts a local revision-file change
that reloads that iframe at the same URL. A load receipt records the parent-page
request count, child-document request count and loaded revision.

Through the rendered native Browser preview panel, a screenshot and selected
point were followed by an iframe-only reload. **Send annotation** displayed the
page-change refusal, removed the image and selected point, disabled sending and
retained the typed draft. No annotation receipt reached the scripted model.
**Refresh preview**, a new point and **Send annotation** then admitted exactly
one message, displayed `DESKTOP_ANNOTATION_OK` in the conversation and showed the
success notice. The production custom HTTP adapter delivered the exact durable
attachment image bytes, verified against the attachment store.

A second screenshot and draft were followed by another iframe-only reload.
**Refresh tabs** removed the old image and point, disabled sending, preserved the
second draft and displayed the page-change notice. The model receipt remained at
one annotation. The fixture recorded one parent request and three iframe loads,
confirming that neither reload refreshed the main page. Developer mode remained
off; no real provider credentials or OS screenshot/input permissions were granted.

The launcher exited successfully, retained its annotation receipt and removed the
isolated home. The three screenshots, final accessibility state, redacted launcher
log and source/transport evidence are under
`artifacts/local/browser-frame-documents-electron-*`. This adds rendered native
UI evidence to the previous Host and Chrome checks. Only the interactive probe
and this verification record changed in this turn; production sources and the
private package are unchanged. Documentation, lint and whitespace checks passed.
The preceding 879-test full gate was not rerun for this probe/document-only change.

This run covers the official macOS isolated-browser mode. Rendered Windows/Linux
and the combined full-preset extension mode were not requalified, and the scripted
HTTP endpoint establishes transport rather than live-model quality. DOM-only
updates remain outside the document-identity check. No commit, version bump,
package publication or persistent application installation changed.

## Embedded-document preview identity — 2026-10-07

A real Chrome regression reproduced acceptance of an old annotation after only
an iframe reloaded. Inspecting CDP established that a main target's
`Page.getFrameTree` omits out-of-process iframes, including their descendants;
traversing only that response would leave cross-site editors unprotected.

The pinned MCP adapter now borrows each active page-frame CDP session and reads
one frame tree per session. It checks document loaders, URLs, parent relationships
and complete frame coverage, then verifies that frame objects, sessions and
observed lifecycle state did not change while the reads awaited responses.
Incomplete or changing observations provide no preview identity. A bounded hash
binds the main document and embedded documents without adding iframe URLs to the
page list. It does not attach to unrelated targets, evaluate page JavaScript or
detach MCP's borrowed sessions. On attachment to already loaded pages, Puppeteer's
lifecycle loader cache can be empty; the adapter accepts the CDP loader while
still requiring any populated cache to agree.

The new `scripts/verify-browser-preview-documents.mjs` is part of
`npm run test:browser`. In an isolated Chrome attached through the normal connect
mode, it refuses old receipts after same-process, cross-process and nested iframe
reloads, a cross-to-same-process navigation, iframe removal and iframe insertion.
Every case keeps the main loader unchanged, confirms the cached receipt still
matches before admission, rejects before attachment storage, and sends a fresh
capture successfully. Blank and srcdoc iframes remain capturable. A real MV3
extension run also refuses a cross-process iframe reload while the main document
stays unchanged, accepts a fresh capture, and passes its existing worker, iframe,
sharing, revocation and ownership checks. Developer mode stays off for these
preview cases. Annotation storage and message receivers in these two admission
probes are stubs; this is not live model inference.

The full browser suite passed, including ordinary Chrome operations, access
revocation, WebMCP and the native Harness tool/skill/approval/image contract.
All 82 focused unit/component/custom-image checks and all 36 client cases against
the extracted combined package client passed. The packed full preset also passed
in an independent native Harness 0.2.0-rc.2 Host with real Chrome, durable image
storage and exact projected image bytes reaching the scripted model endpoint;
its reload Host run passed. This does not qualify rendered Electron UI.

The final `npm run check` passed 879 unit/component tests, native integration and
package checks, and 63 evaluations. Documentation, lint and whitespace checks
passed.

Probe development exposed two fixture issues, retained in the diagnostic logs:
navigating through an iframe's retiring CDP session can lose its reply on a
process swap, so the fixture changes iframe src through the unchanged parent;
and the extension's initial shared navigation could race service-worker
activation, so it now waits for the fixture worker to activate before navigating.
No production permission boundary was relaxed for these fixtures.

The private package is
`dscode-desktop-0.7.32-dsh-0.2.0-rc.2-37fd32e3f49d.tgz`, SHA-256
`37fd32e3f49de361b077032db56c21f77b460cc95659636e51fbd782d0cbfd37`.
Its browser adapter and client match the worktree. Compared with `057cbca660b9`,
only those files, the composed client, browser guide and changelog changed.
The repository's browser test command also includes the new native verifier.

DOM-only changes inside a retained document are still not identified, and
observation and enqueue are not atomic against external navigation. The agent
must inspect the live page before acting on historical pixels. Installer
lifecycle, rendered Electron UI, Windows/Linux UI and live-model quality were
not requalified. No repository version, commit or publication changed. Evidence
is retained under `artifacts/local/browser-frame-documents-*`, including the
failing native regression, frame-tree/session investigations, diagnostics,
focused and full-gate logs, browser-suite and extension logs, package receipt,
packed-client log and native preset receipt.

## Preview document identity — 2026-10-07

Four preview regressions reproduced acceptance after a same-URL reload before
submission, during attachment storage and during capture, plus capture without
a verifiable document. A client regression showed that refreshing the tab list
kept the old screenshot and sendable point after a same-URL reload.

The browser child now loads a version-checked, in-memory adapter for Chrome MCP
1.9.0. Its page-list responses include the main-frame CDP frame/loader identity
read through an owned temporary CDP session; the session is detached after each
read. No page JavaScript is evaluated and no installed dependency is rewritten.
Unavailable or URL-inconsistent metadata yields an unavailable identity while
ordinary tool output remains available. Preview capture requires an identity
and compares it, the URL and connection generation before and after the
screenshot. Annotation admission and the Desktop capture return boundary also
compare the captured document. Refreshing the tab list after a document change
removes the old pixels and point, stops automatic refresh and keeps the draft.

All 68 focused preview, client, adapter and custom-image checks passed, including
stable identities, loader changes, URL fragments, protocol failure, closure and
CDP-session disposal. Three custom-image fixtures needed the new document field;
their existing durable image-byte assertions remain unchanged. The combined
client extracted from the private package passed all 36 client cases.

The final `npm run check` passed 865 unit/component tests, native integration and
package checks, and 63 evaluations. Documentation, lint and whitespace checks
passed. The earlier full-gate failure was limited to the three custom-image
fixtures that lacked a document identity; its log is retained separately.

The real Chrome access probe refuses a same-URL reload during attachment storage
while its cached page observation still describes the original document. A
fresh capture sends successfully. The real unpacked MV3 extension probe reloads
the shared tab externally, refuses its old receipt, and accepts a fresh capture;
Developer mode stays off. Its existing iframe, worker, sharing, revocation and
ownership checks also passed. These admission probes use stub attachment stores
and scripted message receivers. A separate packed full preset passed in a native
Harness 0.2.0-rc.2 Host with real Chrome and durable image storage: the annotation
image bytes reached the scripted custom-model HTTP endpoint, and its reload Host
run passed. Neither probe constitutes rendered Electron UI qualification.

The private package is
`dscode-desktop-0.7.32-dsh-0.2.0-rc.2-057cbca660b9.tgz`, SHA-256
`057cbca660b9b2be6ddb6f7270a238f0cca78ae5f91f0ad9f829f18563d441a4`.
Its six browser sources match the worktree. Compared with `4b02907b63b2`, the
changed files are those sources, the combined client, browser guide and changelog.

This identifies main-document reloads at the next observation, including the
refresh required before annotation admission. It does not observe DOM-only
changes or iframe-only reloads and does not make observation and message enqueue
atomic against external navigation. Captured pixels remain historical context.
Installer lifecycle, rendered Electron UI, Windows/Linux UI and live-model quality
were not requalified. No repository version, commit or publication changed.
Evidence is retained under `artifacts/local/browser-document-identity-*`, including
before/focused/packed-client/full-gate logs, the real Chrome and extension logs,
the native preset receipt and the content-addressed package receipt.

## Annotation admission after asynchronous waits — 2026-10-07

Seven regressions reproduced annotations being queued after a page navigated
or closed during image storage, after a browser generation changed during model
lookup, after expiry or request cancellation during the final permission read,
and when an external navigation only became visible on a subsequent page-list
refresh. A separate boundary case showed that the server accepted a receipt
at exactly 60 seconds although the UI already marked it expired.

Annotation admission now checks cancellation, browser control, generation,
known page URL and freshness after the initial permission check, image storage
and model lookup. After those waits it requests a fresh page list, checks site
permission again, and synchronously repeats the admission checks before
queueing the message. Receipts expire at 60 seconds. The receipt is still
consumed before attachment storage, so concurrent or repeated sends cannot
queue twice. If the final check fails after storage, an image may already exist
in the attachment store, but no annotation message is queued; the user needs a
new capture. The existing UI error path keeps the typed draft.

All 58 focused preview, Desktop client and custom-image checks passed. The final
`npm run check` passed 855 unit/component tests, native integration and package
checks, and 63 evaluations. Documentation, lint and whitespace checks passed.

The real Chrome access probe now changes or closes the tab through native MCP
while a stub attachment service yields. The BrowserConnection page cache is
confirmed unchanged until annotation admission refreshes it. Both stale sends
are refused without queueing a message; a fresh screenshot sends successfully,
and duplicate admission is refused. The same probe retains its site/Developer
permission, WebMCP and revocation checks. A separate packed full Desktop preset
ran in a native Harness 0.2.0-rc.2 Host with real Chrome and real durable image
storage: the annotation's exact projected image bytes reached the scripted
custom-model HTTP endpoint, and the reload Host run passed. Both processes
exited successfully and cleaned their disposable homes.

The private package is
`dscode-desktop-0.7.32-dsh-0.2.0-rc.2-4b02907b63b2.tgz`, SHA-256
`4b02907b63b2f553f7a6a50fd74443ce631f8b2d93697c541e07d33110452cea`.
Its preview source matches the worktree. Compared with `6cbd09195445`, only
that source, the browser guide and changelog changed.

This checks the latest observed page ID, URL and connection generation. It
cannot distinguish a same-URL reload or DOM-only change, and does not make
browser observation and message enqueue atomic against external navigation.
The message continues to describe captured past pixels and instructs the agent
to inspect the live page before acting. Rendered native UI, installer lifecycle,
Windows/Linux UI and live-model quality were not requalified. No repository
version, commit or publication changed. Evidence is
`artifacts/local/browser-annotation-admission-regression.json`, retained
before/focused/full-gate logs, real-Chrome access log and native preset receipt
and log alongside it.

## Preview permission origin after navigation — 2026-10-07

Refreshing a preview after navigation updated its pixels and caption but left
the tab list and permission panel at the previous URL. Consequently a visible
new-site screenshot could coexist with a **Block site** action targeting the
old origin. The capture RPC now returns a fresh permission snapshot, and the
client updates the selected tab's URL and permissions together with the image.
The Host rechecks site access and browser control after the permission read,
and refuses a replaced frame, changed generation or changed page URL before
returning it. Existing permission epochs continue to discard responses from
before a permission mutation.

Four regressions failed before the fix. Component cases cover both a changed
hostname and a changed port: the tab label, ordinary access, Developer access
and block action follow the new capture, the annotation draft survives, and
the old point is cleared. Host cases check the returned permission snapshot and
revocation during its asynchronous read. The expiry fixture now includes the
permission snapshot returned by the current capture RPC; its existing expiry
assertions remain intact. All 45 focused checks passed, as did all 35 browser
client cases run against the combined client extracted from the private tarball.

The packed combined preset ran in an independent native Harness 0.2.0-rc.2 Host
with real headless Chrome. An initial tab listing observed the original loopback
origin. A scripted model then navigated that same page to a second loopback port
inside a normal agent turn, preserving the native approval audit boundary. A
capture returned the second URL, its session-only grant and the first origin's
separate persistent grant. The subsequent annotation's exact image bytes reached
the scripted custom model endpoint. Blocking the new origin refused another
capture. The verifier completed both its initial and reload Host runs and cleaned
its disposable home. Its first attempt had invoked an approval-requiring tool
outside an open turn; only the probe was changed to use the normal turn flow.

The full `npm run check` passed 848 unit/component tests, native integration and
package checks, and 63 evaluations. Documentation, lint and whitespace checks
passed. The local private package is
`dscode-desktop-0.7.32-dsh-0.2.0-rc.2-6cbd09195445.tgz`, SHA-256
`6cbd091954454848b4318c8941bc4b451dcf2b0d1ddb3323e76b97b1d5d8a409`.
Its browser Host/client bytes match the worktree. Compared with `5505d1efa8ee`,
only those two sources, the combined client, browser guide and changelog changed.

This run does not establish rendered native Electron interaction, live-model
quality, an installed upgrade lifecycle or Windows/Linux UI behavior. No
repository version, commit or publication changed. Evidence is
`artifacts/local/browser-preview-origin-regression.json`, the before/focused/
packed-client/full-gate logs, the native receipt and log, and the retained
probe-diagnosis log alongside it.

## Optional model-metadata boundaries — 2026-10-07

Five regressions reproduced distinct failures in custom-model discovery:
cancellation during oMLX's optional `/models/status` request returned a
successful partial catalog; a non-array `models` value and null entries caused
uncaught errors; invalid context/output values discarded valid base-catalog
limits; and an output budget larger than the known context suppressed a valid
base-catalog budget. Discovery now checks caller cancellation after awaited
catalog and metadata reads, accepts an array for optional model metadata,
ignores null entries and chooses the first valid positive integer limit. An
output budget must be smaller than the known context window. Invalid optional
values fall back to valid base-listing values; unknown limits remain absent.

The real loopback HTTP regression waits until `/models/status` is active,
then aborts the caller and observes response closure and an explicit discovery
cancellation error. Fixtures also cover a missing optional endpoint, a null
response, malformed entries, invalid numbers, and an oversized output budget.
All 65 focused provider, terminal editor and Desktop settings tests passed.

The official signed macOS arm64 Desktop 0.2.0-rc.2 and its bundled CLI completed
the six native lifecycle phases using private package
`dscode-desktop-0.7.32-dsh-0.2.0-rc.2-5505d1efa8ee.tgz`, SHA-256
`5505d1efa8ee1e0568cb43831e496d672507d1e80b06850c83d75983f365256c`.
The installed probe now delays the base catalog, optional oMLX metadata and
model inference separately. In each installed phase, explicit cancellation
closed each model HTTP request within five seconds and returned the expected
cancelled RPC result while the caller connection remained open. Discovery
worked afterward. This exercised 12 cancellations and 12 discovery retries
across install, upgrade, boot after an incompatible-update rejection, and
reinstallation. Removal withdrew the endpoint. Existing configuration,
credential, session, permission and other lifecycle assertions also passed.
The owned native fixture exited successfully and removed its temporary home.

The final `npm run check` passed 844 unit/component tests, native integration
and package checks, and 63 evaluations. Documentation, lint and whitespace
checks also passed.

The package's custom service source matches the worktree. Compared with
`1dc5599dac14`, only that service, the provider guide and changelog changed.
No rendered UI interaction, real remote model, older-implementation migration,
or Windows/Linux Desktop qualification was repeated for this change. No
repository version, commit or publication changed.

Evidence is `artifacts/local/custom-discovery-metadata-regression.json`, the
before/focused/full-gate logs, installed lifecycle receipt and installed log
alongside it.

## Installed model-request cancellation — 2026-10-07

The native installer probe now starts delayed discovery and model-test requests
through the installed authenticated custom-model RPC. It keeps each caller's
HTTP request open and sends a separate cancellation command. The loopback model
must observe response closure within five seconds; discovery must return its
cancellation error and the model test must return its cancelled probe result.
Each cancellation is followed by successful model discovery. The saved
provider and credential are reused through a temporary draft; no test endpoint
or changed thinking choice is saved.

The first probe draft retained the saved oMLX thinking override while pointing
to a generic fixture. That correctly failed validation before HTTP dispatch.
The probe now uses provider-default thinking in its separate generic draft,
and reports an early RPC failure directly instead of waiting for a server
arrival that cannot occur. No production behavior changed for that fixture
correction.

The official signed macOS arm64 Desktop 0.2.0-rc.2 and its bundled CLI passed
initialization, install, upgrade, incompatible-update rejection, removal and
reinstallation using package `1dc5599dac14`. Explicit discovery/test cancellation
and successful discovery afterward passed in all four installed phases:
`installed`, `upgraded`, `rejected` and `reinstalled`. The initial install and
reinstall used the exact content-addressed archive; the upgrade used the same
implementation with a temporary fixture-only version suffix. Saved image and
thinking choices, user context limits, explicit blank output budgets,
server-reported limits and model registration all survived. Existing lifecycle
assertions also verified credentials, sessions, communication, scheduling,
email, child worktrees and browser permission state, including the permission
guard inode. Removing the bundle withdrew the custom settings endpoint.

A second complete lifecycle started from the older `9d420dff9f48` package,
whose custom configuration implementation hash differs from the current one.
The initial legacy boot retained its numeric output override. After upgrade,
after an incompatible update was rejected, and after reinstall, both explicit
cancellations and discovery retries passed against the current implementation.
Cancellation is intentionally not required from the initial legacy package.
Together the two runs closed 14 model HTTP requests through explicit
cancellation and completed 14 subsequent discovery retries. Both native runs
exited successfully and cleaned their disposable homes.

All 27 focused custom-Desktop and composition tests passed, together with
documentation, lint and whitespace checks. The full production gate was not
rerun for these probe-only changes; its preceding 837-test/63-evaluation result
remains recorded below. Evidence is
`artifacts/local/desktop-install-cancel-evidence.json`, separate current and
migration receipts/logs, focused checks and retained fixture-failure diagnostics.

This run exercises installed Host RPC, not rendered Desktop controls, a real
remote model, or another operating system. The preceding rendered cancellation
run remains separate evidence. The probes and verification record changed;
production sources and the private package hash remain unchanged. No release,
repository version, commit or publication changed.

## Desktop model-request cancellation — 2026-10-07

Desktop model discovery and tests now expose **Cancel request** outside the
busy form, retain the draft and unsaved key after cancellation, reject late
results, and abort on settings unmount. Saves and removals remain
non-cancellable. Six new component regressions failed before implementation;
the resulting suite also covers a failed cancellation acknowledgement and the
Host's explicit cancellation endpoint.

The first rendered test exposed a transport distinction: aborting the renderer
fetch changed the UI to cancelled, while the official Electron application's
protocol proxy kept the model HTTP request alive. The existing direct Host HTTP
cancellation probe did not cover that proxy. The client now sends a separate
cancellation RPC with a random request ID and waits for its acknowledgement,
with a ten-second acknowledgement deadline. A failure reports that server
cancellation could not be confirmed. The Host combines its controller with the
HTTP request signal and aborts outstanding controllers on plugin disposal.
Only discovery and tests accept IDs; saves and removals reject them. A bounded
128-entry registry retains completed IDs and early cancellation markers for
60 seconds, rejecting duplicate starts and cancellation-before-start races
within that interval. Unexpired active requests are never evicted by cleanup.

In the official signed macOS arm64 Desktop 0.2.0-rc.2, a loopback scripted model
was configured with a 180-second first-response delay. Native UI interaction
performed discovery, started a test, and clicked **Cancel request**. The form
showed **Request cancelled.**, kept its unsaved provider and key, and offered
another test; the model server logged its HTTP response closing. A second test
started successfully, and closing Settings closed that request too. Both
cancellations occurred before fixture shutdown. No provider or account key was
saved, and no live model inference or OS permission grant was used. The owned
fixture exited successfully and removed its temporary home.

The native run preceded a lint-driven refactor that moved cancellation-error
throwing out of `finally`, plus Host indentation cleanup. Its staged source
hashes are retained separately; the final package is therefore not claimed as
byte-identical to the rendered run. Component tests cover both RPC failure and
cancellation-acknowledgement failure after the refactor. Discovery cancellation
and late-result handling have component coverage, but were not separately
clicked against a delayed discovery endpoint in the native application.

The final `npm run check` passed: 837 unit/component tests, native integration
and package checks, and 63 evaluations. Documentation, lint and whitespace
checks also passed.

The local private package is
`dscode-desktop-0.7.32-dsh-0.2.0-rc.2-1dc5599dac14.tgz`, SHA-256
`1dc5599dac1479b3ac27e78ca2f10d77ed30e00f989e64c103841a5bb503f612`.
Its custom Host/client sources match the final worktree. Compared with
`dd9e7feb0f76`, only those two sources, the combined client, this feature's user
guide and changelog changed. Installer lifecycle, real remote models and
Windows/Linux Desktop were not requalified in this run. No repository version,
commit or publication changed.

Evidence is `artifacts/local/desktop-model-cancel-regression.json`, the retained
before/final native logs, native transport receipt, source hashes, screenshot,
and final full-gate log alongside it.

## Desktop model-test cold-start timeout — 2026-10-07

The Desktop settings RPC imposed an extra 30-second total deadline over the
custom adapter's configured stream idle timeout (180 seconds by default).
The new native timeout probe reproduced a 35-second cold start returning only
`Probe: failed — Cancelled` before the fix. The settings transport now forwards
caller cancellation while leaving timeout ownership with discovery and model
inference. Discovery retains its own ten-second request timeout; model tests
retain the adapter's configured idle timer without a separate total cutoff.

`verify-desktop-custom-timeout.mjs` launches the official signed macOS arm64
0.2.0-rc.2 app with the combined bundle and authenticates to its real settings
RPC. The local fixture delays the first text response for 35 seconds. After the
fix all three text/tool stages passed in 35045 ms; vision/thinking/long context
remained explicitly untested. A second delayed request was cancelled through
the caller's AbortSignal, and the model server observed its HTTP connection
close. A third request with a 100 ms model idle timeout returned the expected
failed probe. The final verifier run exited zero after its child cleaned up;
it removes stale receipts at startup and writes success only after cleanup.
No native UI control or real inference service was exercised.

The full product gate exited zero: 828 unit/component tests, 81.04% measured
line coverage, both typechecks, native integration/package checks and 63
evaluator tests. Documentation, lint and whitespace checks passed. The package is
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-dd9e7feb0f76.tgz`,
SHA-256 `dd9e7feb0f76bc0341fc38d6bf2c7760d6378f348bfd4b0871aaa6ab09d2928a`.
Its custom Host entry matches both the worktree and the source hash read from
the staged native fixture. Compared with `89ad430fe54d`, only that entry, the
provider guide and Unreleased changelog changed. This package has not repeated
the separate native CLI installation/upgrade lifecycle.

Evidence is `artifacts/local/desktop-custom-timeout-regression.json`,
`desktop-custom-timeout.json`, before/after/full-gate logs and retained sanitized
Host logs. No repository version or publication changed.

## Migration from an earlier Desktop implementation — 2026-10-07

The lifecycle verifier now accepts an optional third argument naming a retained
baseline tarball. It validates that archive against its sidecar receipt, checks
package/runtime identity and requires its custom configuration implementation to
differ from the current source. It checks the installed configuration entry's
hash after initial install, upgrade and reinstallation, so a renamed package or
cached older implementation cannot stand in for a real code change.

```bash
node scripts/verify-desktop-install.mjs \
  '/Volumes/DeepSeek Harness 0.2.0-rc.2-arm64/DeepSeek Harness.app' \
  .research/desktop-official-runtime \
  artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-9d420dff9f48.tgz
```

The actual retained `9d420dff9f48` archive created the initial configuration,
sessions, permissions and other lifecycle state. The native CLI then installed
current `89ad430fe54d` code under a disposable upgrade-version suffix. All six
native boot phases passed, including rejection of an incompatible update,
removal and reinstallation of the exact current `89ad430fe54d` archive. Persisted
configuration and credential hashes, permission guard identity, resumed sessions,
mailbox dedup, schedules, email data and child-task state passed the existing
assertions across this implementation change.

The old implementation cannot persist an explicitly blank user output-budget
marker. This migration case therefore seeds a supported numeric user override
(2000 tokens), alongside the user context, thinking/image choices and another
model's server-reported limits. Native settings RPC and LLM registry checks
verify those values on every installed boot. A separate default invocation of
the updated verifier also passed all six phases with the current implementation
and the explicitly blank user budget. The migration receipt's
`customDefaultOutputPreserved: false` means that case was not exercised by the
old implementation; the control receipt confirms it separately.

The old archive SHA-256 is
`9d420dff9f48c6c142cfabffe7f1f3df57849b77526976b654a0941ebb3975a8`;
the current archive remains
`89ad430fe54d9c099b193a3d4c14caf0b3cd13c8550f7ffa803b44b68a2f42bb`.
Their configuration entry hashes differ and matched the installed files at the
expected stages. Evidence is `artifacts/local/desktop-install-migration-evidence.json`,
`desktop-install-migration.json`, `desktop-install-migration-control.json` and
the corresponding logs. Both probes exited zero; documentation, lint and
whitespace checks passed. This qualifies this earlier local Desktop package,
not all historic versions, migration from the terminal-only distribution,
runtime-engine upgrades or downgrades. No rendered interaction or live inference
was performed. Production sources and package bytes are unchanged, so the
preceding full product gate remains current. No version or publication changed.

## Installed Desktop model-setting lifecycle — 2026-10-07

The signed macOS arm64 Desktop 0.2.0-rc.2 and its bundled `dsh` CLI completed all
six lifecycle phases for the current package: initialize, installed, upgraded,
rejected incompatible update, removed and reinstalled. The lifecycle fixture
now creates custom models through the authenticated settings RPC and reads that
same RPC on every subsequent installed Host boot. It checks exact model records,
credential redaction/resolution and the native LLM registry, beyond file hashes.

The first model preserves a 48000-token user context, explicitly blank user
output budget, thinking On and text/image input. The restored native model
resolves a 4096-token default output budget and high reasoning effort. A second
model preserves server-source context/output metadata, its 8192-token output
budget and text-only input. Both IDs reappear in the native model catalog after
upgrade, rejected update and reinstallation. Removing the bundle withdraws the
custom settings RPC (404), while the saved configuration and credential bytes
remain unchanged for reinstallation.

The existing lifecycle checks also passed for browser permissions/revocations,
the persistent permission-guard inode, session resume, deferred mailbox dedup,
provider accounts, schedules/jobs, email data, usage, delegation, child worktrees
and waiting questions. The probe exited zero and cleaned its disposable home.
The upgrade suffix applies only to a disposable package of the same current
code; this does not qualify migration from older implementation code or rollback.
The application starts natively, but this run does not interact with its rendered
controls or call a live inference service.

The installed package SHA-256 is
`89ad430fe54d9c099b193a3d4c14caf0b3cd13c8550f7ffa803b44b68a2f42bb`, matching
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-89ad430fe54d.tgz`
exactly. The 37 focused provider/composition tests, documentation, lint and
whitespace checks passed. This turn changes only lifecycle probes and this
record; the preceding 828-test full product gate remains current.
Evidence is `artifacts/local/desktop-install-model-settings.json`,
`desktop-install-model-settings.log` and `desktop-install-model-settings-focused.log`.
No repository version or publication changed.

## Attributed custom-model test reports — 2026-10-07

Both model editors retained earlier test results while a new test ran, and those
results did not name their model. A pending request, connection failure or
terminal cancellation could therefore leave an earlier success visible. The
editors now clear the report when a test begins and render its returned stages
under `Test results: <model ID>`. A terminal report retained while navigating
between model editors continues to name the model actually tested. Existing
configuration/key edits still clear it.

Three new regressions failed before the fix. Desktop component tests check two
model IDs, hold the second request pending, verify disabled test controls and
absence of the first report, then reject the transport and check recovery.
Native Ink input tests move from one model to another, cancel the pending test,
retry through a connection exception and then display a returned failed probe
under the second model's name. These are component/terminal fixtures, not a new
macOS Electron interaction or live-model qualification.

The 32 focused checks passed. The full gate exited zero: 828 unit/component
tests, 81.03% measured line coverage, both terminal typechecks, native integration
and package checks, and 63 evaluator tests. Documentation, lint and whitespace
checks passed. The local Desktop package is
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-89ad430fe54d.tgz`,
SHA-256 `89ad430fe54d9c099b193a3d4c14caf0b3cd13c8550f7ffa803b44b68a2f42bb`.
Its settings source matches the worktree, and the combined client includes the
model label. Compared with `18a9ccc110e5`, the Desktop tarball changes only those
two client entries, the provider guide and Unreleased changelog. Terminal source
changes are covered by the terminal checks and normal package gate.

Evidence is `artifacts/local/custom-test-report-regression.json` and the
before-fix, focused and full-gate logs alongside it. No new Desktop installer
lifecycle, repository version change or publication was performed.

## Native Desktop model rediscovery — 2026-10-07

The official signed macOS arm64 Desktop 0.2.0-rc.2 ran the current combined
bundle against a disposable authenticated loopback model service. The model UI
fixture now accepts `DSCODE_UI_DISCOVERY_REFRESH=1`: its first three discoveries
report context/output pairs of 32768/4096, 65536/8192 and 98304/12288. It records
the returned catalogs separately from the original static-catalog fixture.

```bash
DSCODE_UI_DISCOVERY_REFRESH=1 node scripts/verify-desktop-model-ui.mjs \
  .research/desktop-official-runtime \
  '/Volumes/DeepSeek Harness 0.2.0-rc.2-arm64/DeepSeek Harness.app'
```

Native clicks created the provider, discovered its initial model, enabled images
and selected thinking On, then saved. A second discovery refreshed both limits
in the visible form while retaining those choices. Reading the disposable YAML
before Save confirmed that discovery had not persisted the draft. After saving
the refresh, native input set context to 48000, cleared the output budget and
saved again. Closing and reopening Settings, discovering the third catalog and
saving retained the manual context, blank output budget, thinking and images.
Final transport and YAML assertions passed: exactly three discovery requests,
the expected catalog sequence, saved synthetic key, user-source markers and no
numeric output budget. The launcher exited zero and removed its disposable home.

The staged configuration, custom settings client and combined client matched
their exact entries in package `18a9ccc110e5` (SHA-256
`18a9ccc110e5f711164d80c320d9794baed398ad301c89930a6d25c10d1f41e3`).
This verifies native interaction with those package-equivalent sources; it does
not repeat installation or upgrading of the tarball. No live model inference or
vision/thinking quality was tested. The 16 Desktop provider/composition checks,
documentation, lint and whitespace checks passed. Only the probe and this record
changed, so the preceding 825-test full gate remains the latest product gate.

Evidence: `artifacts/local/custom-discovery-native-regression.json`,
`custom-discovery-native.log`, `custom-discovery-native-focused.log`,
`custom-discovery-native.jpg` and the catalog/transport records under
`artifacts/local/desktop-model-discovery-ui/`. No repository version or
publication changed.

## Persisted default output-budget choice — 2026-10-07

Clearing a model's output budget already marked the draft as a user override,
but profile normalization discarded that marker when the numeric value was
absent. Saving and reopening either editor therefore let a later discovery
replace the calculated-default choice with the server's output limit. The store
round-trip and Desktop HTTP-discovery regressions both failed before the fix.
Normalization now preserves `outputSource: user` without a `maxTokens` value.
An unedited missing value, including a stale server-source marker without a
number, still remains eligible for discovery. The existing schema version and
default output-budget calculation are unchanged.

All 46 focused provider tests passed. The Desktop component uses authenticated
loopback HTTP discovery and a temporary real store across Save, Reload and
rediscovery. A terminal test drives actual Ink input to clear the field and save,
then mounts a fresh editor and service against the same file, rediscovers models
and verifies the saved default choice. A separate fresh-store test checks
normalization, replacing the blank with a number, and the adapter's calculated
default plus context reservation. Terminal discovery uses a scripted response;
no real model inference or native Electron interaction was performed.

The full gate exited zero with 825 unit/component tests, 81.06% measured line
coverage, native integration/package checks and 63 evaluator tests. Documentation,
lint and whitespace checks passed. The package is
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-18a9ccc110e5.tgz`,
SHA-256 `18a9ccc110e5f711164d80c320d9794baed398ad301c89930a6d25c10d1f41e3`.
Its configuration source matches the worktree bytes. Compared with
`b87ea2835f16`, only that source, the custom-provider guide and Unreleased
changelog changed. Evidence is `artifacts/local/custom-blank-output-regression.json`
and its before-fix, focused and full-gate logs. No new installed Desktop lifecycle
qualification, repository version change or publication was performed.

## Desktop model discovery refresh — 2026-10-07

Desktop discovery previously appended only new model IDs, leaving existing
server-reported context and output limits unchanged. Four component regressions
failed before the fix. The client now merges discoveries into the draft using
the terminal editor's rules: update reported limits, preserve each user override
independently (including an output budget cleared in the current draft), retain
thinking and image choices, and keep existing order and unlisted models.
Discovery does not save configuration or draft credentials.

The 27 focused provider and client-composition tests passed. A fifth new test
connects the rendered component through `customRequest` and `CustomProviders` to
an authenticated loopback HTTP model catalog and a real temporary `CustomStore`.
It checks unchanged storage before Save, refreshed limits after Save, and a
persisted context override surviving a later discovery while the output limit
refreshes. The test helper now awaits initial asynchronous list I/O and complete
button operations; its previous synchronous-dispatch assumption caused the first
HTTP test and first full gate attempt to fail. The corrected full gate exited
zero: 822 unit/component tests, 81.05% measured line coverage, native integration
and package checks, and 63 evaluator tests. Documentation and lint checks passed.
No new native Electron interaction, installed-package lifecycle or live inference
qualification was performed for this change.

The local package is `artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-b87ea2835f16.tgz`,
SHA-256 `b87ea2835f1633a4211c6f840a4d625bca5736321d37b78058442d08cd3d02fa`.
Its custom settings source matches the worktree bytes, and the combined Desktop
client includes the merge. Compared with `4f63dce61f3c`, only those two client
entries, the custom-provider guide and Unreleased changelog changed. Evidence is
`artifacts/local/custom-discovery-regression.json`, with before-fix, focused and
full-gate logs alongside it. No repository version or publication changed.

## Custom image-input documentation reconciliation — 2026-10-07

The browser guide still described all custom routes as text-only, and the
Unreleased changelog repeated that obsolete limit. Both now match the implemented
explicit image capability for Chat Completions, Responses and Anthropic Messages.
The provider guide also documents the native **Accepts images** checkbox and
**Save provider** action under **Settings → DSCODE models**. The guides retain the
text-only default, endpoint/model capability requirement and durable-offload
behavior: enabling images does not restore previously omitted occurrences.
Both README descriptions already reflected explicit image support and needed no
change. Published release entries were unchanged.

The image, Desktop provider and documentation-packaging suites passed 17 tests,
including actual durable screenshot bytes sent to local HTTP fixtures in all
three protocols, text-only projections and cancellation. Documentation, lint and
whitespace checks passed. This does not measure a real model's visual ability.
No new native renderer or installer lifecycle check was performed.

The resulting package is `artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-4f63dce61f3c.tgz`,
SHA-256 `4f63dce61f3cd92f1b3c5099e7016c0482fea71870689a1f3944ddbd29e89136`.
An entry-by-entry comparison with `772111bc7c37` found changes only in the bundled
browser guide, custom-provider guide and Unreleased changelog; runtime entries
are identical. Evidence is `artifacts/local/custom-image-docs-regression.json`
and `custom-image-docs-focused.log`. The full product gate was not repeated for
documentation-only changes; the preceding 817 unit/component tests,
integration/package probes and 63 evaluator tests remain the latest full result.
No repository version or publication changed.

## Browser file validation at queued dispatch — 2026-10-07

Browser tools previously validated file arguments before entering the serialized
connection queue. A symlink could be redirected outside the workspace while the
operation waited, leaving the earlier successful validation stale. Upload and
snapshot-export regressions reproduced this through the actual registered tool
callbacks: hold an earlier queued operation, wait until the file call is queued,
change the symlink, then release the queue. Both failed before the fix.

The agent's workspace and artifact roots now also reach BrowserConnection, which
rechecks file arguments immediately before forwarding the operation to MCP, after
its page and permission preflight. The initial admission check remains. Both
regressions now reject the changed paths without dispatching the file operation;
restoring a valid link permits a new request. All 53 focused browser/access tests
passed. This reduces the queue/preflight race; it does not make path validation
atomic with Chrome's subsequent filesystem access.

A real attached Chrome fixture repeated both cases. Rejected operations never
reached the native MCP file handlers and the external test file remained
unchanged. Restoring the link allowed a snapshot export and an upload whose
contents were read back through the page. Disconnect preserved the pre-existing
attached tab. The first fixture run omitted MCP's configured filesystem root and
therefore denied valid recovery; supplying the same root argument as production
made the complete check pass. The managed-browser, handoff, dialog, cookie and
ownership checks in that fixture also passed.

The full `npm run check` exited zero with 817 unit/component tests, native
integration/package probes and 63 evaluator tests; measured first-party line
coverage was 81.09%. Documentation, lint and whitespace checks passed. The new
local package is `artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-772111bc7c37.tgz`,
SHA-256 `772111bc7c37a66408ba8a256fb99c177c79e4adf98e7d7a8d8e551169464d7e`.
Its connection, plugin entry and file-boundary module match source byte-for-byte.
Installer lifecycle and rendered Desktop interaction were not rerun for this
package. No external upload, real model, repository version or publication was
involved.

Evidence: `artifacts/local/browser-file-queue-regression.json`, adjacent
`browser-file-queue-{before,focused,chrome,check}.log` files and the initial fixture
configuration failure in `browser-file-queue-chrome-fixture-before.log`.

## Extension background-worker scope qualification — 2026-10-07

The real unpacked MV3 extension passed an expanded Chrome for Testing
154.0.8037.92 fixture with a shared page and an unshared same-origin page. Both
used one named SharedWorker and the same Service Worker registration. Native
target inspection confirmed both background target types existed before the
checks and remained present when their target IDs were tested.

Page-facing controls invoked both workers through the shared page. Their replies
appeared in that page's MCP snapshot. Separate replies to the unshared page
remained absent, and background-worker console messages were not exposed through
the shared page's console tool. The production SharedTabs protocol rejected six
attachment, activation and closure requests using the live background target IDs.
After revocation, its session routes were empty and further commands were
rejected, while ordinary worker replies still reached the page. Direct background
worker debugging remains unsupported; this qualification covers page behavior
and target exclusion, not arbitrary background inspection.

The same run retained the existing main-frame, cross-site iframe process-swap,
dedicated/nested-worker, pairing, ownership, cleanup, revocation and delayed
attachment checks. It exited zero; all 12 extension/relay unit cases also passed.
No product runtime code changed. Documentation, syntax, lint and whitespace
checks passed. The full product gate was not repeated; the latest result remains
815 unit/component tests, integration/package probes and 63 evaluator tests.
All pages, worker scripts and replies were local fixtures, with no live model.

Evidence is `artifacts/local/browser-background-workers-regression.json`,
`browser-extension-workers.json`, `browser-background-workers-chrome.log` and
`browser-background-workers-focused.log`. The regenerated local package is
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-1bf8c9467e2b.tgz`,
SHA-256 `1bf8c9467e2b7ce7dce81c35ad7ba7858c93507ba1ec1d5cf2750c1b3faad6cc`.
Every archive entry was compared with the preceding `17955c1ada83` package; only
`package/docs/browser-use.md` changed. No installation lifecycle or native Desktop
renderer check was performed this turn. No repository version or publication
changed.

## Failed WebMCP discovery invalidation — 2026-10-07

A failed explicit discovery previously left the page's last successful tool
definitions available. A transport exception during execution-time rediscovery
also retained them. Discovery now clears its page's old record before refreshing,
and failed execution-time definition checks invalidate that record as well.
Execution then requires a new explicit discovery. Unrelated pages retain their
records. This does not replay actions or change the existing approval requirement.

Five regression cases cover error results, transport errors, unavailable
discovery data and recovery after explicit rediscovery. Four failed before the
fix; all five pass now. Error-result revalidation already invalidated discovery
before this change. The focused browser and access suites passed 51 tests.
The real Chrome fixture injected transport and error-result failures after actual
discovery responses, for both explicit discovery and execution-time revalidation.
All four fault cases refused direct execution retries, made zero writes and
recovered after explicit discovery. The broader fixture still counted exactly
two deliberate server-side writes and passed its navigation/revocation checks.

The full `npm run check` exited zero: 815 unit/component tests, native integration
and package probes, and 63 evaluator tests. First-party measured line coverage
was 81.08%. Documentation, lint and whitespace checks passed. The source and agent
guide were verified byte-for-byte inside the generated Desktop package:
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-17955c1ada83.tgz`,
SHA-256 `17955c1ada83f522a9010a617eca5cd9fc215fa973e9158f8bae863c96633fae`.
Its installer lifecycle was not rerun; the preceding keyboard package retains
the latest complete native installation qualification. No external website,
real model, repository version or publication was involved.

Evidence: `artifacts/local/browser-webmcp-discovery-regression.json` and adjacent
`browser-webmcp-discovery-{before,focused,chrome,check}.log` files. The injected
faults exercise the production connection boundary around actual Chrome results;
they do not represent an independently observed Chrome transport outage.

## Current preview package install qualification — 2026-10-07

The package containing preview expiry feedback and keyboard annotation completed
the official macOS arm64 Desktop 0.2.0-rc.2 lifecycle through its bundled CLI:
initialize, install, fixture upgrade, incompatible-update rejection, removal and
reinstallation. All six native boots passed and the verifier exited zero. The
upgrade changes only a disposable package version suffix; rollback to an older
implementation remains outside this qualification.

The native receipt's SHA-256 matches the retained package exactly:
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-9d420dff9f48.tgz`,
`9d420dff9f48c6c142cfabffe7f1f3df57849b77526976b654a0941ebb3975a8`.
The permission decisions, revocation markers and guard inode survived the
lifecycle. Cold boots enforced the persisted decisions. Provider settings and
credentials, email state, scheduled jobs, session histories, deferred messages,
and the existing child's worktree and pending question also passed the verifier's
preservation and resume checks. Removal withdrew the plugin's RPC routes;
reinstallation restored them without creating a second core runtime.

The combined client was extracted directly from this tarball and executed in the
existing React component suite. All 33 preview interaction cases passed against
that composed client, including keyboard coordinates, expiry, draft preservation,
permission races and session isolation. Its client SHA-256 is
`d6a11d9f3a9d9fa7d656902c91e45b8891c566c2961d36da295ce5babb56bc52`.
To repeat against an extracted client, set `DSCODE_TEST_BROWSER_CLIENT_FILE` to its
absolute path when running `node --test tests/browser-desktop-client.test.mjs`.
The default source renderer and composition suites also passed all 35 cases.

Evidence is `artifacts/local/desktop-install-keyboard.json` and
`desktop-install-keyboard{,-renderer,-source}.log`. The component checks use
React TestRenderer; they do not replace the earlier native keyboard interaction
check. This lifecycle run did not exercise installed rendered controls, real
model inference or email delivery. Documentation, lint and whitespace checks
passed. Only test infrastructure and this record changed, so the full product
gate was not rerun; its latest result remains 810 unit/component tests,
integration/package probes and 63 evaluator tests. No repository version,
publication or user installation changed.

## Native Desktop fixture startup isolation — 2026-10-07

The official-app browser verifier now requests loopback port zero, allowing the
OS to choose an unused port. Its fixture URL reports that actual port. The
launcher requires the browser or combined-preset readiness marker before a
zero-exit run can qualify startup, and stops an unready app after 120 seconds.
The timeout is a safeguard; this run directly exercised early interruption,
not the entire timeout interval.

The new native regression occupied port 19387 with a test-owned HTTP server.
The signed macOS 0.2.0-rc.2 app started on another port and completed authenticated
tab listing and a real Chrome screenshot. The occupied server received zero
requests. Closing the ready fixture returned zero and removed its temporary home.
A second fixture was interrupted as soon as its launcher handle was announced;
it returned a nonzero exit, reported missing readiness and removed its home.

The first interruption test exposed an additional cleanup race: the launch
marker preceded signal-handler registration. An immediate stop could terminate
the wrapper before cleanup. Moving that marker after handler registration made
the same regression pass. The failed run's inactive temporary directory was
removed separately. The passing verifier completed both cases and released its
test-owned default port.

Evidence: `artifacts/local/browser-electron-startup.json`,
`browser-electron-startup-before.log`, `browser-electron-startup-occupied-port.log`,
`browser-electron-startup-interrupted.log` and `browser-electron-startup-check.log`.
The two scripts passed syntax checks; documentation, lint and whitespace checks
passed. This change affects verification scripts only. The complete product gate
was not rerun; the preceding keyboard change's 810 unit/component tests,
integration/package probes and 63 evaluator tests remain its latest full result.
No model inference, rendered-control interaction, release or package change was
performed in this run. Combined-preset and extension startup use the same launcher
changes but were not rerun by this two-case regression.

## Desktop preview keyboard annotation — 2026-10-07

The screenshot is now a focusable button with keyboard instructions. Enter or
Space selects its center; arrows move one screenshot pixel and Shift plus arrows
move ten. Coordinates clamp to the image boundaries, including a one-pixel
dimension. Escape removes the point while retaining text. Visible coordinates
use the same pixel conversion as the Host's annotation message and carry a polite
live-region attribute. Keyboard and mouse selection share pending-operation and
expiry checks. Modifier combinations used by platform shortcuts are left alone.

Four new renderer cases failed before implementation. All 39 preview renderer
and Host tests passed afterward, covering exact emitted coordinates, boundary
clamping, draft retention, delayed expiry timers and replacement captures. The
full `npm run check` exited zero with 810 unit/component tests, integration and
package probes, and 63 evaluator tests. Measured first-party line coverage was
81.08%. Documentation, lint and whitespace checks also passed.

The official signed macOS Desktop 0.2.0-rc.2 window exposed the screenshot as a
focusable button. Tab navigation, Enter, Space, arrows, Shift plus arrows and
Escape were exercised with native keyboard input. A keyboard-triggered send
delivered exactly one image annotation at the displayed pixel `(601, 1024)` in
the `1200×2029` screenshot. No mouse click selected the annotation point. This
used a disposable loopback page and scripted model. Accessibility-tree semantics
were inspected; actual screen-reader speech was not qualified.

The first native launch encountered port contention with an extra default app
instance started by UI discovery. Both owned instances were stopped; the retry
waited for fixture readiness before UI binding and completed successfully. The
native check used the browser-only bundle. The combined package's browser client
matches source byte-for-byte; its installer lifecycle was not rerun this turn.

Package: `artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-9d420dff9f48.tgz`,
SHA-256 `9d420dff9f48c6c142cfabffe7f1f3df57849b77526976b654a0941ebb3975a8`.
Evidence: `artifacts/local/browser-preview-keyboard-regression.json`, adjacent
`browser-preview-keyboard-{before,focused,check,electron,native}.log` files and
`browser-preview-keyboard-native.jpg`. No repository version or publication changed.

## Desktop preview expiry feedback — 2026-10-07

The preview now marks a capture expired after 60 seconds, removes its annotation
point, stops automatic refresh and disables sending while retaining the typed
draft and site access display. A fresh capture retains that draft and requires a
new point. Submission rechecks the timestamp in case a background window delays
the expiry timer. Replacing a capture or hiding the pane cancels its timer; a
queued callback from an older capture cannot expire its replacement. The Host's
independent receipt-age check remains in place.

Four renderer regressions failed before the fix and passed afterward; all 35
preview renderer and Host tests passed. The full `npm run check` exited zero:
806 unit/component tests, native integration and package probes, and 63 evaluator
tests. First-party measured line coverage was 81.17%. Documentation, lint and
whitespace checks passed.

The official signed macOS Desktop 0.2.0-rc.2 window exercised a real Chrome capture
and natural one-minute expiry. The point disappeared, sending was disabled and
the draft and allowed site status remained. Refreshing retained the draft;
selecting a new point then delivered exactly one annotation with its screenshot.
This used a disposable loopback fixture and scripted model, without real model
inference. The native renderer used the browser-only bundle. The combined local
package's browser client was separately checked byte-for-byte against source;
its complete installer lifecycle was not rerun for this change.

The local package is `artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-cbcc38a6bd4e.tgz`,
SHA-256 `cbcc38a6bd4e2029038a51f142acab34114fcc5effd9f43a3b39234f0bc7e71b`.
Evidence is `artifacts/local/browser-preview-expiry-regression.json`, the adjacent
`browser-preview-expiry-{before,focused,check,electron}.log` files and
`browser-preview-expiry-native.jpg`. No repository version or publication changed.

## Installed Desktop permission persistence — 2026-10-07

The package identified below completed all six official macOS Desktop 0.2.0-rc.2
lifecycle phases through its bundled `dsh plugin` CLI: initialize, install,
replace with a fixture upgrade, reject an incompatible package, remove, and
reinstall. The upgrade changes the version of a disposable copy of the current
code; this does not qualify rollback to an older implementation that cannot read
revocation metadata. Repository and published versions were unchanged.

The installed plugin's actual `/browser` commands saved an ordinary allow, a
persistent block, and a block/forget sequence. The latter revoked an independently
held temporary grant through the installed BrowserAccess class. Every subsequent
cold boot checked that allowed access still worked, blocked access remained
blocked, and the forgotten origin required a new grant. Cold permission status
reported no temporary grants. Saved revocation markers matched their original values and
remained absent from displayed permission status.

The native CLI preserved both permission-file bytes and the permanent SQLite
guard inode across replacement, rejected replacement, removal and reinstallation.
Both files retained owner-only modes. The Browser preview RPC was registered on
installed boots and returned the expected start-browser requirement without
launching Chrome; removing the plugin withdrew that route. This run tests the
installed Host and CLI, not rendered preview interaction.

The broader lifecycle assertions also passed: model settings, credentials, email
inbox/contact state, scheduler preference and jobs, session histories, deferred
mailbox delivery, the original named child's worktree and its pending parent
question survived the relevant phases. Reinstallation admitted the deferred note
once, and the resumed child used its preserved worktree. No real model or email
service was called.

The tested package remains `artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-f74bf4722142.tgz`,
SHA-256 `f74bf4722142f34ab443fd0ae52f040c72743bb49dc3a68ab0095fa97ed160f8`. The retained package hash exactly matches the
native install receipt. Evidence is `artifacts/local/desktop-install-permissions.json`
and `desktop-install-permissions.log`. The verifier exited zero and removed its
disposable home after all owned application processes exited.

This change extends qualification scripts and records only. Production code is
unchanged from the preceding 802-unit, integration/package and 63-evaluation gate;
that full gate was not repeated. Documentation, lint and whitespace checks passed.
Windows, in-place upgrades of the official app and live-model quality remain
unqualified. No commit or publication was made.

## Temporary browser grants after cross-session revocation — 2026-10-07

A temporary grant was kept as an origin-only in-memory set. If another connection
blocked then forgot the origin between this connection's permission checks, its
old temporary grant became usable again. Three cases reproduced stale access
through forget, block/forget and allow/forget from another access instance.

Temporary grants now retain the origin's current revocation marker. Block and
forget atomically write a fresh marker with the saved policy under the existing
cross-process guard. Permission checks and status refreshes discard grants with
older markers, including a connection that never observed the intermediate block.
Other origins and Developer-only edits retain their grants. A new user-requested
temporary grant binds the new marker and works normally. Markers are internal
policy metadata and are omitted from the displayed permission status.

Existing permission files without markers continue to load. Once a block or
forget writes the optional `revocations` field, older strict readers reject that
file; every process sharing the home must be updated. Invalid marker structure,
origins and values fail closed. Manual policy rewrites remain outside the writer
protocol.

The full `caffeinate -is npm run check` gate exited zero with 802 unit/component
tests, the integration and package probes, and 63 evaluation tests. Runtime line
coverage was 81.23% (16,744 of 20,613 lines). The complete log is
`artifacts/local/browser-temporary-revoke-check.log`; the combined receipt is
`artifacts/local/browser-temporary-revoke-regression.json`.

The 28 focused access and multi-process cases passed, including malformed metadata
and preservation of an unrelated temporary grant. Six process cases passed with
the signed macOS Electron 0.2.0-rc.2 executable as the worker runtime. One holds an
ordinary Node reader's temporary grant while an Electron worker performs both
block and forget; the reader sees neither intermediate state and still rejects
its old grant. An explicit new grant then succeeds.

The real Chrome probe held an actual DOM snapshot response, changed block/forget
through another BrowserAccess instance, and verified that the pending output was
withheld for missing site permission without replay. A fresh explicit grant
admitted a new snapshot. The existing Developer, WebMCP and captured-source
revocation scenarios also passed, retaining exactly two deliberate fixture writes.

The local package is `artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-f74bf4722142.tgz`,
SHA-256 `f74bf4722142f34ab443fd0ae52f040c72743bb49dc3a68ab0095fa97ed160f8`. Its access module and agent skill match the checked
source. Focused receipts are `artifacts/local/browser-temporary-revoke-before.log`,
`browser-temporary-revoke-focused.log`, `browser-temporary-revoke-electron.log`,
and `browser-temporary-revoke-chrome.log`. All child processes and Chrome fixtures
exited. Windows, rendered Desktop UI, installer lifecycle and live-model quality
were not qualified in this run. No commit, version bump or publication was made.

## Browser permission writes across processes — 2026-10-07

The prior in-memory update queue serialized only one module instance. Two real
Node processes reproduced a lost revocation: a paused grant read the old policy,
another process committed a block, and the paused grant then overwrote that block
with the old allow rule. Atomic rename alone did not protect read-modify-write.

Permission updates now acquire an immediate SQLite transaction on the permanent
`permissions.guard.sqlite` inode before reading JSON. The JSON file remains the
canonical policy; the empty SQLite transaction only coordinates writers and
releases on close or process exit. Lock contention retries asynchronously for up
to three seconds, allowing ordinary reads and event-loop work to continue.
Malformed policy and timeout leave the committed file unchanged. Failed writes
clean up their temporary file; temporary ordinary grants are cleared only after
the corresponding persistent update succeeds.

A supplementary three-writer regression caught an implementation hazard: opening
and closing the guard through a raw filesystem descriptor released another
connection's POSIX process locks. SQLite now owns all guard descriptors; path
permissions use chmod without an extra descriptor. A second access instance
using an alias of the same directory cannot let another process enter the
critical section early.

The full `caffeinate -is npm run check` gate exited zero with 798 unit/component
tests, the integration and package probes, and 63 evaluation tests. Runtime line
coverage was 81.21% (16,724 of 20,593 lines). The log is
`artifacts/local/browser-permission-lock-check.log`; the combined receipt is
`artifacts/local/browser-permission-lock-regression.json`.

The 24 focused permission and concurrency cases passed. Five cross-process cases
also passed with worker processes launched through the official signed macOS
Electron 0.2.0-rc.2 executable in Node mode: concurrent edits, SIGKILL recovery,
malformed-file recovery, bounded contention with readable policy, and same-Host
path aliases. This qualification does not exercise the rendered Desktop window.
`DSCODE_TEST_PERMISSION_EXECUTABLE` selects that worker executable when running
`tests/browser-permission-concurrency.test.mjs`; the parent remains ordinary Node.

The real Chrome access probe passed site and Developer grants, navigation scripts,
WebMCP discovery/execution and changed-definition refusal, in-flight revocation,
and captured-source permission checks. Its two deliberate local fixture writes
were not replayed. All writer processes and Chrome fixtures exited.

The local package is `artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-6521b0bc9a5e.tgz`,
SHA-256 `6521b0bc9a5ea656a903e9c3b80feaccfb36c0d720384abede1bae85d26fba5b`. Its access and connection modules match checked
source. Retained focused evidence is in
`artifacts/local/browser-permission-lock-focused.log`,
`browser-permission-lock-electron.log`, `browser-permission-lock-chrome.log`,
`browser-permission-lock-before.log`, and `browser-permission-alias-before.log`.

All processes sharing the permission directory must use this updated writer;
older releases and manual file edits do not acquire its guard. The guard must
remain in place. Windows, network filesystems and installer lifecycle are outside
this qualification. No commit, version bump or publication was made.

## Preserve drafts edited during Desktop preview requests — 2026-10-07

An annotation acknowledgement unconditionally cleared the input, including text
entered while the send was pending. A tab refresh that discovered navigation
had the same problem. Five new renderer cases failed before the fix. The client
now tracks input edits and clears a draft only if its revision still matches the
revision when that request began. Editing and then returning to the same string
still counts as a new draft. Explicit tab changes and pane/session disposal keep
their existing clearing behavior. Completed sends consume their old image and
point even when newer text is retained; a subsequent send needs a fresh capture.

The 31 focused renderer and preview tests passed. The full
`caffeinate -is npm run check` gate exited zero: 793 unit/component tests, the
integration and package probes, and 63 evaluation tests. Runtime line coverage
was 81.18% (16,693 of 20,562 lines).

In the official signed macOS Electron 0.2.0-rc.2 window, the fixture held the first
annotation acknowledgement after actual admission to the scripted model. A new
draft typed while the send button was busy survived release of that response.
A fresh screenshot and point then admitted the retained draft as a second
image-bearing message. The unedited second draft cleared after its own successful
send. Receipts verified two distinct messages with their corresponding screenshots.
No real model request was made.

Reproduce the delayed acknowledgement with
`DSCODE_BROWSER_UI_HOLD_ANNOTATION=1` when launching
`scripts/verify-browser-electron.mjs`. After the first send, the disposable home
contains `annotation-held.json`; create `release-annotation` to resume its reply.
The hold is test-only, applies once and times out after 120 seconds. The capture
hold remains independently available for the preceding revocation scenario.

The local package is `artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-20f82d105eee.tgz`,
SHA-256 `20f82d105eeeecab0a004559866d37a3e77874dda52452682ddb66569ae63a82`. Its client bytes match checked source.
Evidence is in `artifacts/local/browser-draft-race-native.json`,
`browser-draft-race-native.jpg`, `browser-draft-electron.log`, and
`browser-draft-check.log`. The fixture exited and its disposable home was removed.
Windows rendering, installer lifecycle and live-model quality were not rerun.
No commit, version bump or publication was made.

## Revocation while Desktop preview requests are pending — 2026-10-07

The preview client shared one busy flag and request lock across captures, tab
refreshes, annotations and permission writes. A slow ordinary request disabled
**Block site** and prevented the Host from receiving revocation. Seven new
component cases failed before the fix. Permission writes now have an independent
serialized lane, and every permission attempt advances a client epoch. Earlier
successes and failures cannot restore pixels, overwrite grants or notices, or
clear the retained annotation draft. New ordinary work waits for permission
writes to settle. Already delivered agent messages cannot be recalled.

The 45 focused access, preview and component tests passed. The full
`caffeinate -is npm run check` gate exited zero: 788 unit/component tests, the
integration and package probes, and 63 evaluation tests. Runtime line coverage was
81.21% (16,693 of 20,556 lines); the VM-loaded renderer has component tests but is
not represented as executed source in that coverage denominator.

The signed macOS Electron 0.2.0-rc.2 application exercised a real Chrome PNG
capture whose response was held by the opt-in test fixture. While Refresh preview
remained busy, clicking Block site persisted the block before the held response
was released. After release, the native window still showed Blocked, no captured
image, and the original draft. Reauthorization followed by a fresh capture sent
exactly one image-bearing annotation to the scripted fixture model.

To reproduce, launch `scripts/verify-browser-electron.mjs` with
`DSCODE_BROWSER_UI_HOLD_CAPTURE=1`. The fixture writes `capture-held.json` beneath
its disposable home after a real capture. Create `release-capture` in that home
after blocking through the UI; `capture-released.json` records release. The
hold applies once, expires after 120 seconds, and is released on disposal. This
hook exists only in the qualification fixture.

The local package is `artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-f38a6e83fa82.tgz`,
SHA-256 `f38a6e83fa829bbf4c651d1627621503fc40e5deb47c2270006a41494597a1fc`. Packed browser modules match the checked source.
Evidence is retained in `artifacts/local/browser-revoke-race-native.json`,
`browser-revoke-race-native.jpg`, `browser-revoke-electron.log`, and
`browser-revoke-check.log`. The owned fixture exited and its disposable home was
removed. This run did not qualify Windows, installer lifecycle, or live model
quality. No commit, version bump or publication was made.

## Native Electron browser permission controls — 2026-10-07

The new permission controls were exercised in the actual signed macOS Desktop
0.2.0-rc.2 window at `dsh-app://app/`, using an isolated browser-only bundle and
disposable Host home. Onboarding used **Add API Key → Set up later**; no real
credentials were entered. The scripted fixture model and its loopback website
provided all task data.

Rendered interaction verified forget followed by temporary allow; global
Developer mode and the site grant; preservation of temporary access when the
Developer grant was added and revoked; ordinary screenshot capture with Developer
mode off; block denying capture; and retention of the typed annotation while
removing the old image and point. Reauthorization and a fresh capture admitted
one image-bearing annotation to the fixture model. Its receipt contains exactly
one annotation and the expected native-fixture draft.

The 1280×820 window and a 1012×782 window with an approximately 382-pixel sidebar
were visually inspected. Site and Developer buttons wrapped inside the narrow
sidebar without horizontal overflow. Screenshots:
`artifacts/local/browser-permissions-electron.jpg` and
`artifacts/local/browser-permissions-electron-narrow.jpg`. Native input testing
continued after a window-size change by reading fresh UI state before acting.
The owned fixture app was stopped after verification.

This turn changes qualification documentation only; browser implementation is
unchanged from the preceding 781-test gate. Documentation, lint and whitespace
checks were rerun. The refreshed local package is
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-3290e8a4b681.tgz`,
SHA-256 `3290e8a4b6816589b797e4b270beee430cf6d3f039a530627f8ef282d37309fe`.
Its browser modules match both source and the previous tested package. Receipt:
`artifacts/local/browser-permissions-electron.json`; the one-message native
annotation receipt is `artifacts/local/browser-permissions-electron-annotation.json`.
Windows UI, installer lifecycle and real model quality remain outside this run.
No commit or publication was made.

## Desktop browser permission controls — 2026-10-07

The Browser preview panel now shows the selected HTTP(S) origin and its loaded
site decision. Explicit buttons provide temporary allow, persistent allow,
block and forget. Developer controls separate the global mode from the per-site
grant. Selecting a tab performs no mutation; blank tabs have no site controls.
Changing permissions clears the captured preview, selected annotation point
and polling state, while retaining typed comment text. The Host invalidates its
capture receipt too, so restoring permission cannot revive an old send token.

Rendered interaction exposed an existing permission-state bug: editing a
Developer grant cleared the connection's temporary ordinary grant. A focused
regression reproduced it. Developer-only edits now preserve that grant, while
ordinary block/forget still clear it. Thirteen client tests include exact-origin
requests, independent mode/site controls, draft preservation, blank tabs and late
permission responses after switching sessions. All 38 focused client, access and
preview tests passed.

The signed macOS Desktop 0.2.0-rc.2 application ran the production Host in a
disposable home. `scripts/browser-permissions-rpc-probe.mjs` used its authenticated
Connection carrier: anonymous writes returned 401, a foreign Origin returned
403, and neither changed saved rules. The probe checked malformed origins,
unknown changes and missing sessions; temporary grant preservation; blocked
captures; and refusal of a stale annotation after block followed by allow.
It left the fixture with ordinary access and Developer mode off.

The shared Web client connected to that Host was exercised through rendered
controls: block prevented capture, forget and temporary allow restored access,
granting/revoking Developer access retained the temporary grant, and ordinary
preview remained available with Developer mode off. Blocking cleared the pixels
and preserved the draft; reauthorization plus a fresh capture sent exactly one
annotation with its image to the scripted fixture model. The screenshot is
`artifacts/local/browser-permissions-ui.jpg`; the native carrier receipt is
`artifacts/local/browser-permissions-rpc.json`. These new controls were not
separately rendered in the Electron window. The browser fixture was isolated,
used local pages and a scripted model, and the owned fixture app runs were stopped.

The full gate passed lint, both TypeScript checks, 781 unit/component tests,
nine integration probes, package verification and 63 evaluation tests.
First-party coverage was 81.27% (16,693 of 20,541 lines). Documentation and
whitespace checks were clean. Retained local package:
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-53702f08f41a.tgz`,
SHA-256 `53702f08f41a0bacd2b2145da059129467bdcef535a669e308703f93096744b7`.
The packed browser client, Host and access policy match tested source; the guide
matches after the expected link rewrite for this unbundled record. Receipt:
`artifacts/local/browser-permission-ui-regression.json`. Installer lifecycle
was not repeated; no commit, version bump or publication was performed.

## Navigation script Developer permissions — 2026-10-07

The pinned Chrome MCP exposes `navigate_page.initScript`, which executes
JavaScript before documents load during navigation. The name-only Developer
classification treated that operation as ordinary navigation. Both deterministic
regressions and a real Chrome run accepted the script while Developer mode was
off; the pre-fix native probe failed its expected-rejection assertion.

Developer classification now inspects the navigation arguments. A supplied
`initScript` requires Developer mode and grants for the current and requested
destination origins before execution, and the same classification is applied
when returning the result. Scripted reloads require the current origin's grant;
ordinary navigation retains ordinary site access. Action review remains separate.
The agent-facing browser skill and user guide describe the additional requirement.

Forty-two focused browser/access tests passed. The real Chrome fixture confirms
that global-mode denial and a missing destination Developer grant issue no
destination request. Once both grants exist, the injected script adds a marker
that an ordinary DOM snapshot observes. Ordinary navigation still succeeds after
Developer mode is switched off, while scripted reload is rejected. Revocation
during scripted navigation is covered by a deterministic unit regression; the
existing native in-flight Developer/WebMCP cases also remain passing.

The full gate passed lint, both TypeScript checks, 777 unit/component tests,
nine integration probes, package verification and 63 evaluation tests.
First-party coverage was 81.41% (16,693 of 20,504 lines); documentation and
whitespace checks were clean. Retained local package:
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-471a32f71b2a.tgz`,
SHA-256 `471a32f71b2a567586bfd0394397cd1d0b9d9d11da67e4da71018e0b3b795c95`.
Its connection, permission module and browser skill match source; the user guide
matches after its expected unbundled-record link rewrite. Receipt:
`artifacts/local/browser-init-script-regression.json`.

Testing used Chrome for Testing 154.0.8037.92, a disposable profile and loopback
servers. It did not exercise real-model judgment or rerun Desktop rendering and
installation. Top-level origin checks do not mediate every redirect or embedded
document, and cannot undo a script already executed. No commit or publication
was performed.

## Browser captured-result authorization — 2026-10-07

A result could contain data from an earlier document while the final page had
already moved to another granted origin. The final-page-only check then missed
revocation of the source's site or Developer grant. Closing the page before
delivery skipped that check entirely. A tool result reporting an ungranted
intermediate origin was likewise ignored if the final origin was granted.
All four deterministic cases failed before this fix; reading the original grant
directly confirmed that permission persistence was working.

The connection now checks the source, the tool result's target URL and the final
page, including the requested URL for a new tab. An unexpectedly unavailable
page withholds output; an explicitly requested close retains its valid completion
path and still rechecks the source grant. Forty focused browser/access tests
passed, including one successful close and all four result-boundary regressions.

The real Chrome probe holds an actual native MCP JavaScript read result after
it has captured the fixture title. Separate native MCP commands then navigate
to another permitted origin or close that tab, simulating concurrent external
changes. Revoking the source's site grant or its Developer grant after navigation
rejects the held result, as does tab closure. Each read executes once. This
uses Chrome for Testing 154.0.8037.92 with disposable profiles and local servers;
the intermediate-origin case is deterministic-unit evidence only. No live
inference, Desktop renderer/installer run, commit or publication was performed.
Observations do not capture every transient navigation or revoke website effects
already delivered; the boundary remains an agent-result check.

The full gate passed lint, both TypeScript checks, 775 unit/component tests,
nine integration probes, package verification and 63 evaluation tests.
First-party coverage was 81.41% (16,691 of 20,502 lines); documentation and
whitespace checks were clean. Retained local package:
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-d914ef0e2572.tgz`,
SHA-256 `d914ef0e2572cd80afd9aa922942fab225c385ef978588ff33fceb141094cee8`.
Its connection and permission modules match source; the guide matches after the
expected repository-link rewrite for this unbundled record. Receipt:
`artifacts/local/browser-captured-result-regression.json`.

## Browser permission revocation during execution — 2026-10-07

Developer permissions were checked before a browser operation, but the result
check only required ordinary site access. Disabling Developer mode or revoking
the site's Developer grant while an operation was running could still return
its result. Both deterministic regressions failed before the fix. The result
check now applies the same Developer classification as the execution check and
reports that withheld output can follow a permission change as well as navigation.

All ten browser-access unit tests passed. A real Chrome fixture holds an HTTP
response consumed by `evaluate_script`, disables Developer mode, then releases
the response: the operation rejects without returning the fixture result or
repeating its request. A second held response comes from a WebMCP write; blocking
the site withholds its result. The two deliberately executed writes remain
counted exactly once each. Ordinary DOM access still works after Developer-only
revocation; the fixture also retains changed-definition, direct-navigation and
redirect checks. Per-site Developer revocation has a deterministic unit case;
the native Developer case uses the global mode switch.

The full gate passed lint, both TypeScript checks, 769 unit/component tests,
nine integration probes, package verification and 63 evaluation tests.
First-party line coverage was 81.41% (16,685 of 20,496 lines). Documentation and
whitespace checks were clean. Retained package:
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-81336009f23c.tgz`,
SHA-256 `81336009f23cbeb79ddf62c56b42027d5e1af653c3fdc387a8dd765dca02a23c`.
The packed connection and permission modules match source; the guide matches
after its intentional link rewrite to the unbundled verification record.
Receipt: `artifacts/local/browser-permission-revoke-regression.json`.

These checks use disposable local servers and Chrome for Testing
154.0.8037.92. They do not undo effects already delivered to a website, establish
live-model quality, or exercise Desktop permission controls. Desktop rendering
and installation were not rerun for this connection-layer change.

## Extension cancellation during attachment — 2026-10-07

Stopping sharing while `Target.getTargetInfo` was pending could leave the native
debugger attached: the tab was not yet in the published tab map. Its late result
could then publish the cancelled target. A tab closed during the same lookup
could also reappear. Separate regressions reproduced both failures. The bridge
now tracks each successful native attachment before lookup, detaches those
connections during stop, and verifies that the attachment is still live before
publishing a target. Native tab closure removes that liveness marker too.

All twelve extension tests passed. The real Chrome probe imports the production
protocol in the extension popup and holds the return of an actual
`chrome.debugger` target lookup. Stopping sharing detaches the native connection
before that held response returns: another native command reports that the
debugger is not attached. Releasing the response rejects the cancelled share
without publishing a target or session. The complete MV3 interaction probe also
passed its iframe, worker, tab-ownership and revocation checks. The closed-tab
lookup race is covered by the deterministic unit regression.

The full gate passed lint, both TypeScript checks, 766 unit/component tests,
nine integration probes, package verification and 63 evaluation tests.
First-party line coverage was 81.41% (16,685 of 20,496 lines). Documentation and
whitespace checks were clean. Retained package:
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-88baf3205723.tgz`,
SHA-256 `88baf3205723d11856b2e707659646b2c7b9f91e440953e0a643f8ee7c7fc10d`.
The packed protocol matches the source. Receipt:
`artifacts/local/browser-extension-cancel-regression.json`. Desktop renderer and
installer checks were not repeated for this extension change. Testing used a
disposable headless Chrome for Testing 154.0.8037.92 profile, without a live model,
user-profile changes, commit or publication.

## Extension descendant connection cleanup — 2026-10-06

Detaching a parent iframe or worker previously removed only that session's
route, leaving nested routes in the extension. Explicit client detachment had
the same behavior, and tab removal notified clients about parents before their
children. The regression reproduces both stale routes and notification order
before the fix. One recursive detachment path now retires descendants before
their parent for native events, client requests and tab removal. Repeated
detachment and late descendant events are ignored, stale commands are rejected
before reaching Chrome, and unrelated tab or sibling routes remain usable.

All ten extension tests passed. The complete real MV3 probe also passed on
Chrome for Testing 154.0.8037.92, including cross-site iframe process swaps,
dedicated and nested worker restart, console isolation, tab cleanup and user
revocation. The full gate passed lint, both TypeScript checks, 764
unit/component tests, nine integration probes, package verification and 63
evaluation tests. First-party line coverage was 81.38% (16,673 of 20,488 lines).
Documentation and whitespace checks were clean.

Retained package:
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-8096e8f2cc37.tgz`,
SHA-256 `8096e8f2cc37493ef09255b79dbc0d2f3853a60943d6c27eab17267dcce86008`.
Its extension protocol was extracted and compared with the source. Receipt:
`artifacts/local/browser-extension-detach-regression.json`. The signed Desktop
renderer and installation lifecycle were not repeated for this extension
change. No live model, user Chrome profile, commit or publication was involved.

## Extension dedicated and nested workers — 2026-10-06

The real extension fixture now creates dedicated workers in both a shared tab
and an unshared same-origin tab before pairing. Each worker owns a nested
worker. Through DSCODE's snapshot and click tools, the shared page dispatches
work, displays the nested computation's response, terminates and recreates its
worker, then successfully dispatches a second job. With Developer grants in the
disposable test home, the console tool observes the shared workers' messages
from both runs and the nested worker. A separately confirmed job in the unshared
tab emits its own logs, which remain absent from DSCODE's console output.

The complete real extension probe passed on Chrome for Testing 154.0.8037.92,
including the existing iframe process swaps, tab ownership and revocation
checks. The six extension unit tests, lint, documentation and whitespace checks
passed. Receipt: `artifacts/local/browser-extension-workers.json`. This turn
changed the fixture and documentation, with no production runtime edits or
full-gate rerun. SharedWorker and Service Worker behavior remains unqualified.
The test uses a disposable headless profile and no live model; it does not modify
the user's browser or publish an extension.

## Extension cross-site iframe qualification — 2026-10-06

The real MV3 extension probe now includes an iframe served from `localhost`
inside a page served from `127.0.0.1`. Chrome for Testing 154.0.8037.92 runs with
site isolation, and native target inspection confirms a separate iframe target
before qualification. Through the production extension relay and pinned MCP,
the fixture takes snapshots, fills and submits the iframe form, navigates it,
then moves it to the parent's site and back. Forms work after both process
transitions; native target inspection verifies that the separate iframe target
disappears and returns. Direct inspection establishes the test conditions; all
form and navigation actions go through DSCODE's browser tools.

The complete extension probe passed, retaining selected-tab isolation, user-tab
ownership, screenshot, create/close, additional sharing and revocation checks.
The six extension unit tests, lint, documentation and whitespace checks passed.
The receipt is `artifacts/local/browser-extension-frames.json`. Only the probe
and documentation changed; the production gate was not repeated. Worker routing
still has unit coverage only. The run used a disposable headless test browser,
without a live model or changes to the user's Chrome profile. Embedded origins
still share the documented top-level permission boundary.

## Installed child continuation across package changes — 2026-10-06

The signed macOS 0.2.0-rc.2 installation probe now creates a real continuable
child in a Git worktree. The child writes a fixture file using the installed
native shell and sends its parent a question. After package upgrade, rejected
incompatible upgrade, and removal followed by reinstallation, the original
`/persist` alias resumes that same child. Its shell reports the original working
directory and reads the retained file. The board retains the question across
upgrade, clears waiting after the reply and rejects a duplicate child name
without waking the cold child. The coordinator is separate from the existing
deferred-mailbox fixture, preserving that fixture's no-wake assertions.

All six application boots and native CLI operations passed. The probe compares
profile patches immediately before and after each CLI mutation, so legitimate
native renderer preference writes during intervening boots do not cause false
uninstall failures. The five focused composition, Desktop board and bundled
documentation tests passed, as did lint, documentation and whitespace checks.
Only probe code and documentation changed; the preceding full production gate
was not repeated. The fixture uses scripted model responses and actual native
tools; it does not qualify live-model decisions or renderer interaction.

The tested package remains
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-372305d2ea6c.tgz`,
SHA-256 `372305d2ea6c37acebbbfafdb2d86e571c25582d9aa8fea487d9a3c07bfbd382`.
The retained receipt is `artifacts/local/desktop-child-install-regression.json`.
No existing user installation was modified and no commit or publication was made.

## Delegate board validation preserves task state — 2026-10-06

Rejected task updates previously could change the live priority before failing
dependency validation. Reopening a task with a missing or oversized reason
deleted its child identity, worktree and verification evidence before reporting
the error. A later successful save could persist those partial changes. The
unit regression reproduced this directly. Updates now validate a proposed task
and its dependency graph before applying it; reopening validates the name and
reason before deleting any launch fields. Reopening without an explicit new
name also checks whether another open task has claimed the old name.

The 35 focused tests passed, including unchanged live and saved state, no change
notification on validation failure, later successful saves and reload, and
implicit-name collisions. Both independent 0.2.1-alpha.1 and signed macOS
0.2.0-rc.2 Electron Hosts passed generation, fresh-process resume and RPC
unload/reload. Through the actual tool and Desktop status RPC, they rejected
invalid edits to pending, completed and waiting tasks, then saved and resumed
the original named child successfully. The full gate passed lint, both
TypeScript checks, 760 unit/component tests, nine integration probes, package
verification and 63 evaluation tests. First-party line coverage was 81.29%
(16,651 of 20,484 lines). Documentation and whitespace checks were clean.

Retained package:
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-372305d2ea6c.tgz`,
SHA-256 `372305d2ea6c37acebbbfafdb2d86e571c25582d9aa8fea487d9a3c07bfbd382`.
The combined receipt is `artifacts/local/desktop-board-validation-regression.json`.
These checks cover validation rejection, not filesystem write failures. The
renderer, installer and live-model behavior were not rerun for this shared
board change. No commit, version bump or publication was made.

## Durable child aliases and immutable control calls — 2026-10-06

Named-child routing now combines the live launch cache with the native parent's
durable child catalog. A continuable `/name` can resume the same child after a
Host restart, and remains reserved while that child is cold. Lookup does not
wake children; a disposed one-shot child cannot be resumed. The latest catalog
entry for an alias shadows older entries. Concurrent starts reserve names across
asynchronous catalog reads, releasing reservations after failed launches.

The native probe also reproduced a pre-existing failure: the policy attempted
to overwrite `agent_id` in frozen native tool arguments, breaking both named
child delivery and child-to-parent `/` replies. A thin control adapter now gives
the native tool body a copied argument object while keeping the original call,
presentation, output schema and non-enumerable messaging marker intact. Native
authorization, cold resume, delivery and interruption remain responsible for
their existing behavior. Call-token routing is cleared on success and failure.
Waiting indicators change only after a successful delivery, including a reply
that cold-resumes a child.

The 34 focused tests passed. Both the independent 0.2.1-alpha.1 Host and signed
macOS 0.2.0-rc.2 Electron Host passed generation, fresh-process resume and
unload/reload. They verified parent replies, reuse of the original child and
task, waiting-state clearance, cold-name reservation and unrelated-parent
rejection. The probe waits for native `subagent/end` before measuring read-only
RPC behavior: `whenIdle()` alone can precede the parent's settlement notice.
The full gate passed lint, both TypeScript checks, 759 unit/component tests,
nine integration probes, package verification and 63 evaluation tests.
First-party line coverage was 81.29% (16,649 of 20,482 lines).

Retained package:
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-469e8efabf0c.tgz`,
SHA-256 `469e8efabf0cf4c32c7a14d839ac95b1a4893f58f9bbe0503269691bcfed6228`.
The combined receipt is `artifacts/local/desktop-alias-regression.json`.
The renderer, installer and live-model behavior were not rerun for this shared
routing change. No commit, version bump or publication was made.

## Foreground delegation lifecycle — 2026-10-06

A foreground `subagent` invocation returned `kind: foreground` after disposing
its one-shot child. Tracking only the final `continuable` result left these tasks
Pending throughout execution and prevented their later verification. A focused
regression reproduced the missing Running state before the fix.

The policy now observes the runtime's accepted `subagent/start` event inside the
originating tool invocation's async context. It confirms the live child's parent,
records its identity and workspace in the existing board, and releases the
startup reservation so a running foreground child is not counted twice against
the concurrency limit. Unrelated lifecycle events cannot claim a task. The final
successful background result remains a compatibility fallback. Foreground
settlement clears an obsolete waiting-for-parent marker; stopping a child never
marks its task complete. The coordinator still records verification or explicitly
reopens or drops the task.

All 31 focused policy, board and Desktop component tests passed, including a
foreign-parent event, four active children admitting the fifth slot, and a
cancelled foreground child that had asked the parent a question. Both supported
Desktop runtimes passed generation, fresh-process resume and RPC unload/reload.
Each native fixture reads the board during the actual foreground child's
scripted model request, verifies Running, waits for the native one-shot disposal,
then verifies the retained worktree and Verifying task. A second foreground run
is cancelled during its model request and explicitly reopened. Both resulting
task records survive restart. This uses real local agent lifecycle and Git
worktrees with scripted responses, without external inference or child edits.

The full regression gate passed: lint, both TypeScript checks, 756 unit/component
tests, nine native integration probes, package verification and 63 evaluation
tests. First-party line coverage was 81.24% (16,591 of 20,422 lines).
Documentation and whitespace checks were also clean.

Retained package:
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-7eb2e875cde5.tgz`,
SHA-256 `7eb2e875cde504a078a0a7c6712be3ce51f696cdd208012f6ea8ecc1ad05d07c`.
The combined receipt is `artifacts/local/desktop-foreground-regression.json`.
The rendered UI and installer were not rerun for this shared lifecycle change;
their previous qualified package is recorded below. No commit or release was
made.

## Desktop delegation board — 2026-10-06

The combined package now exposes the coordinator's existing task board in a
read-only right sidebar. It projects priorities, dependencies, blocked and
waiting states, worktree paths and verification evidence from the owning policy's
live cache. Sources follow the native scope chain, including standing preset
scopes, so simultaneous sessions and unrelated disposal do not replace the
selected source. The authenticated, origin-checked RPC accepts only status reads
for open DSCODE main sessions; Standard, child and missing sessions are rejected.
The client polls only while visible, clears failed reads and discards replies
from a previous session. Desktop coordination instructions name the sidebar;
terminal instructions retain `/delegate-dashboard`.

The native probe exposed an existing launch-tracking bug: `tools/execute` returns
the canonical result envelope, with the child identity inside `result.value`.
Reading the outer object left planned tasks pending and lost named-child lookup
even after a successful background launch. The policy now reads successful
canonical results, retaining compatibility with bare results. The board unit
regression uses the actual envelope. Native fixtures launch a background child
in a disposable Git worktree, wait for its scripted completion, record evidence
and verify that its dependent becomes ready.

The 30 focused policy, board and Desktop component tests passed. Both supported
Desktop runtimes passed generation, fresh-process resume and RPC unload/reload,
including simultaneous-session isolation, authentication, origin checks,
mutation refusal and reads without new session events or inference. The final
full gate passed: lint, both TypeScript checks, 755 unit/component cases, nine
integration probes, package verification and 63 evaluation tests. First-party
line coverage was 81.22% (16,564 of 20,395 lines).

In the signed macOS 0.2.0-rc.2 application, manual interaction opened the actual
Delegation board tab, expanded the completed task's details and clicked Refresh
board. Dependencies, readiness, evidence and worktree text rendered; the chat
remained at two scripted turns and two steps. The screenshot and accessibility
record are `artifacts/local/desktop-delegation-board.png` and
`artifacts/local/desktop-delegation-board.ax.txt`. The UI fixture was closed and
its disposable home removed. This establishes rendering and local coordination,
not live-model planning quality, Windows behavior or edits and merges by a child.

The native installer also passed installation, upgrade, incompatible-update
rejection, removal and reinstallation with the same package. A pending task
survives upgrade and reinstallation; removing the package withdraws the board
RPC. Existing account, mailbox, email, schedule and usage lifecycle assertions
also passed. The retained package is
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-d14d063c9e8c.tgz`,
SHA-256 `d14d063c9e8cf666b110315951305166c2a97b7140ed9abdefbe3c9ec4498529`.
The combined receipt is `artifacts/local/desktop-delegation-regression.json`.
Documentation checks and whitespace checks passed. The package remains local and
unpublished; no version bump, commit, push or release was made.

## Review usage compatibility with Jev history — 2026-10-06

`/review-usage` previously read only canonical `inputTokens` and `outputTokens`.
Jev audit rows retain the Decisions API's `input_tokens` and `output_tokens`, so
the command displayed zero tokens even for a complete reported reading. The new
regression reproduced that error before the fix. The command now accepts either
shape without changing persisted rows. Only non-negative safe integers enter
token totals; missing or malformed fields count as incomplete even when an old
row claims complete usage. Valid tokens from explicitly partial readings still
contribute to the reported totals.

All 43 focused automatic-review and Jev tests passed. Both supported Desktop
runtime probes passed generate, restart/resume and unload/reload. Each phase
executes the actual `/review-usage` command, appends synthetic historical Jev
rows, and verifies that a valid 100-token reading increments the input total by
100 while a malformed reading increments only the incomplete-attempt count.
The retained audit history also survives the existing restart checks. The
change is confined to report aggregation; approval decisions and ledger writes
are unchanged. Documentation checks, lint and whitespace checks passed. The full
regression gate was not rerun for this command-reporting change.

Retained package:
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-b1ebda7806a7.tgz`,
SHA-256 `b1ebda7806a7115717626b767a3a8b1cbf518b4fcc6d479c7bfd7025d56d213e`.
The combined receipt is `artifacts/local/desktop-review-usage-regression.json`.
Rendered UI, installation and live inference were not rerun for this change.

## Jev Decisions cost accounting — 2026-10-06

Jev's separate HTTP transport bypasses `llm.stream`, so its reported billed costs
were previously absent from session totals. A regression confirmed that a
successful response produced no ledger rows. The service now records one start
and one end row for every configured, non-cancelled attempt with a session owner.
Both streamed calls and Jev share the same live child-to-parent recipient
calculation, preserving the original session ID and preventing duplicate ancestor
charges. These rows contain model, timestamps, purpose, usage and cost metadata;
they contain no action, user instruction or credential.

The collector uses a finite non-negative `usage.cost` directly, including zero;
missing, negative, non-numeric or non-finite values remain unknown. Snake-case
input/output token counts become canonical usage only when both are valid
non-negative integers. A response with an unusable verdict still records its
reported bill; a transport failure records an unknown settled attempt so the
session total remains partial. Disabled, unconfigured and already-aborted calls
do not send or record a request. No price is inferred from the chat model catalog.
This does not change Jev thresholds or automatic approval behavior.

The 65 focused Jev, automatic-review and metrics tests passed, including child
roll-up, missing/invalid costs, zero cost, failure settlement and no-request paths.
Both supported Desktop runtimes passed generate, resume and unload phases in
`verify-desktop-review.mjs`. In each phase the production Jev service calls a real
loopback HTTP fixture twice: once with a reported bill and once without a cost.
The probe verifies endpoint, authorization header, canonical usage, the projected
session total and its partial flag, while main-model speed and activity remain
unaffected. These checks use synthetic responses and do not establish current
live OpenRouter availability, pricing or model decision quality.

The full `caffeinate -is npm run check` also passed: 752 unit/component tests at
81.46% measured line coverage, nine native integration probes, package checks,
63 evaluations, both typechecks and lint. Documentation checks passed.

Retained package:
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-913d68d9e3f8.tgz`,
SHA-256 `913d68d9e3f85ed16e9800812b5fef4d20814f8fc0cf230d8a481eb2f4bc2f44`.
The combined receipt is `artifacts/local/desktop-jev-ledger-regression.json`.
No rendered interaction or installer rerun is claimed for this accounting change.

## Automatic review telemetry separation — 2026-10-06

The automatic permission reviewer previously passed its owner's `sessionId` to
`llm.stream` without an auxiliary purpose. The collector consequently classified
the call as `agent`, allowing reviewer output to change the main model's activity
indicator and smoothed speed. The wire session identity also exposed an
independent review request to session-only middleware. A new regression failed
against that implementation before the fix.

The reviewer now runs inside the existing `chargeTo(owner, 'review', ...)` async
context, declares `purpose: 'review'`, and omits the wire session identity. The
same model route, decision parsing, approval outcomes, cancellation and audit
remain in place. Both the terminal and Desktop use this shared implementation.
Model review attempts still enter the owning session's ledger, including aborted
attempts; this does not change the separate Jev HTTP service's accounting.

The 56 focused review/metrics tests passed. Both native Desktop review probes
passed all three lifecycle phases on 0.2.1-alpha.1 and the signed macOS
0.2.0-rc.2 Host. During each scripted review they assert no root request activity,
the expected async owner and no wire session ID. They compare the count of
review ledger starts with actual reviewer attempts and verify that auxiliary
output cannot supply a smoothed rate when the main calls have no usage sample.
The full `caffeinate -is npm run check` passed: 751 unit/component tests,
81.43% measured line coverage, nine native integration probes, package checks,
63 evaluations, both typechecks and lint. Documentation checks also passed.

Retained package:
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-0b7d39a6658d.tgz`,
SHA-256 `0b7d39a6658da293a1dc8a0a24250800ff71ba831df1a8a9a7be7cf40fa6a439`.
Compared with the preceding rendered-review package, only
`plugins/auto-review/index.mjs`, `docs/auto-review.md` and
`docs/session-metrics.md` changed inside the archive. The combined receipt is
`artifacts/local/desktop-review-attribution-regression.json`. The rendered
approval check below applies to its recorded earlier package; it was not rerun
for this internal attribution change. No live model judgement or new installer
qualification is claimed here.

## Desktop automatic review execution — 2026-10-06

The combined package's existing automatic reviewer is now exercised through
native Agent turns, tool dispatch and the approval service, separately from the
SMTP approval fixture. Run:

```bash
node scripts/verify-desktop-review.mjs .research/browser-desktop-runtime
node scripts/verify-desktop-review.mjs .research/desktop-official-runtime \
  '/Volumes/DeepSeek Harness 0.2.0-rc.2-arm64/DeepSeek Harness.app'
```

Both independent 0.2.1-alpha.1 and signed macOS 0.2.0-rc.2 Host probes passed
generate, restart/resume and unload/reload phases. The probe uses a scripted
custom model and a marker-writing tool confined to its disposable home. It
checks actual marker writes against allow, deny, human and malformed verdicts;
human fallback rejection and approval; cancellation while the reviewer waits;
`never` rejecting before any answerer; and ordinary workspace-write requests
reaching the human path without a reviewer model call. Repeated identical denials
reuse the prior rejection without another model request, and the third denial
stops the turn before a queued fourth call. A new direct user turn resets that
state. Native approval events and the separate audit survive process restart,
including reported reviewer usage. Unloading the reviewer restores the human
fallback; reloading restores automatic decisions.

To place a deterministic human substitute before the Web remote answerer, the
headless fixture remounts the unchanged packaged review plugin after installing
that substitute. These headless probes do not drive the rendered approval dialog. No external model,
Jev service, shell escalation, real website mutation or Computer Use permission
grant is exercised. These results establish execution and lifecycle behavior,
not model decision quality. The 30 existing automatic-review unit tests passed;
documentation checks and lint passed. The full regression gate was not rerun
for these probe and documentation changes.

The retained 0.2.0-rc.2 package is
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-d9b1c338c9cd.tgz`,
SHA-256 `d9b1c338c9cd00883598f2ee9b90f2df9a3ac39db1ee8052942994349140eb86`.
Its runtime modules match the preceding session-usage package; the bundled
automatic-review guide now documents Desktop behavior and distinguishes the
4096-token default from the example's 768-token override. Native receipts are
`artifacts/local/desktop-review-0.2.1-alpha.1.json` and
`artifacts/local/desktop-review-electron.json`.

### Rendered automatic-review fallback — 2026-10-06

The same signed macOS 0.2.0-rc.2 package passed the native application interaction
probe:

```bash
node scripts/verify-desktop-review.mjs .research/desktop-official-runtime \
  '/Volumes/DeepSeek Harness 0.2.0-rc.2-arm64/DeepSeek Harness.app' --ui
```

This mode keeps the original packaged reviewer and Web remote answerer in their
normal load order, with no replacement approval handler or plugin remount. A
scripted custom model returns `human` for two local marker operations. The real
**Reject** button produced native `rejected` and no marker write; the real
**Allow once** button produced `allowed-once` and exactly one marker write. The
probe checks both native decisions, both automatic-review audit rows and the
actual marker file before printing success. Trajectory showed the denied tool
as an error and the allowed tool as completed; the fixture's output renderer is
empty, so the successful tool displays `No output` rather than a marker value.

Screenshots and matching accessibility trees are retained under
`artifacts/local/desktop-review-pending.*` and `desktop-review-results.*`.
`desktop-review-electron-ui-host.json` records the Host assertions; the separate
`desktop-review-ui-regression.json` combines them with the observed renderer
interaction and `desktop-review-ui-actions.json`. The temporary application
profile was removed after the probe. No real provider login, external inference,
model decision quality, rendered cancellation path or Windows/Linux renderer
behavior is established by this check. Documentation checks, lint and both
headless runtime probes passed after adding the UI mode.

## Desktop session usage sidebar — 2026-10-06

The combined package now mounts Session usage in the right sidebar through the
sixth composed client component. Its authenticated, origin-checked RPC accepts
only an open DSCODE session and returns an explicit numeric projection of the
existing ledger and live metric source. It does not expose raw history, ledger
rows, prompts or credentials. The panel includes partial-cost markers, context,
cache share, request/session speed, cached account figures, an optional configured
budget, and the latest 50 turn-cost rows. Older turns remain in the total. It
does not add budget enforcement or refresh remote account data. Hidden/session
changes discard state; read errors clear stale figures. The shared summary now
retains the unknown flag for costs outside turn windows as well.

`scripts/verify-desktop-metrics.mjs` passed three separate Host boots on
independent `0.2.1-alpha.1` and signed macOS `0.2.0-rc.2`. It exercises native
scripted inference with reported usage plus one synthetic priced background
ledger entry. It checks partial totals, cache share, per-turn attribution,
session and preset exclusion, unauthenticated/wrong-origin rejection,
no prompt projection, restart persistence and RPC unload/reload. Repeated reads
leave the session event sequence and model-call count unchanged. These synthetic
figures establish projection behavior; they do not validate a provider invoice.

The signed macOS application rendered the partial `$0.0120+` cost, `80.0%` input
cache share, context and speed cards, and one turn row. Its scripted model-call
count stayed at one while the sidebar polled. Screenshot and accessibility
evidence are `artifacts/local/desktop-session-usage.png` and
`artifacts/local/desktop-session-usage.ax.txt`. The native installer lifecycle
also passed: fresh install, upgrade, incompatible-update rejection, removal and
reinstall. It checks that the usage endpoint is available after restoring the
session, has no message text, and is absent after removal.

All signed-Host, renderer and installer checks used
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-cbf20f7180e5.tgz`,
SHA-256 `cbf20f7180e5bf2eaf21aa710fde494ffbbf4be704e8196a657bd514f3811c86`.
The aggregate is `artifacts/local/desktop-metrics-regression.json`. The full gate
passed lint, both TypeScript checks, 750 unit/component tests at 81.43% measured
`.mjs` line coverage, nine native integration probes, package checks and 63
evaluations. The paired READMEs and existing usage guide were updated. No new
remote account queries, paid inference, Git commit or publication were made.
Windows/Linux rendering and live subscription figures were not exercised.

## Desktop Gmail client import lifecycle — 2026-10-06

Google client-file import now uses the same tracked operation as mailbox
connection and synchronization. Previously it awaited configure directly and
ignored the connector's busy result, so lock contention could appear successful
and disposal had no operation to drain. A busy store now reports a retryable
failure, concurrent connector actions are refused, and unload waits for an
already-started local import. Successful import explicitly asks the user to
authorize Gmail; it does not claim that an account is connected.

The packed native email probe passed on independent `0.2.1-alpha.1` and signed
macOS `0.2.0-rc.2`. It holds the actual Gmail store's filesystem lock while
requesting import through the authenticated RPC, checks that no client is
installed, releases the lock, then successfully imports a synthetic client.
The public result contains no client secret and reports configured but not
connected. The existing admission, restart and unload/reload checks also pass.
Seven focused Desktop email tests cover exclusion, busy status and disposal;
lint and the documentation checker passed. No Google authorization or network
request occurs in this import case, and this focused change did not rerun the
full gate recorded in the preceding setup-feedback work.

The current retained macOS package is
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-8d65b08ff355.tgz`,
SHA-256 `8d65b08ff355900e556ece7f25b46376bd330c16151fd91a47360b24d41b2aea`.
Its focused evidence is `artifacts/local/desktop-email-import-regression.json`.
This remains an unpublished local qualification package.

## Desktop email setup feedback — 2026-10-06

Desktop previously reported Sync complete when background polling had no
configured mailbox. It now shows the mailbox setup action; throttled polls
identify their wait instead of claiming a completed sync. The preference can
still be saved before a connection is configured. A component/service case
checks disconnected, throttled and successful outcomes in sequence.

The shared SMTP sender now accepts a surface-specific configuration hint.
Terminal's default still points to `/email`; Desktop directs the user to
Email inbox → Mailbox connection and explains that Gmail OAuth supports
receiving only. The native SMTP probe requests a send without credentials,
checks this Desktop hint and confirms there is no transport or receipt before
continuing through the existing approval, retry and unload cases. It passed on
independent `0.2.1-alpha.1` and signed macOS `0.2.0-rc.2` Hosts.

The signed application's real sidebar was opened in an isolated profile. Turning
on background sync without a mailbox displayed the setup hint and left the
conversation at two turns. The switch was reset, and a manually selected fixture
email then produced exactly one additional turn. Evidence is retained in
`artifacts/local/desktop-email-status.png`, `desktop-email-status.ax.txt` and
`desktop-email-status-regression.json` under that same artifact directory.

The updated local macOS package is
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-0a4e12d1cb0d.tgz`,
SHA-256 `0a4e12d1cb0d933f630bd215b96ad6ba7b2af181d8adccfc36d3ae8f7d4c2c92`.
The full gate passed lint, both TypeScript checks, 747 unit/component cases,
nine native integration probes, package checks and 63 evaluations. The two new
loopback server helpers were renamed to the existing probe-file convention so
they remain outside the production coverage inventory; they contain no runtime
implementation. Their imports were checked and coverage was regenerated.
This feedback change does not expand account or delivery qualification beyond
the local-fixture limits recorded below. It remains uncommitted and unpublished.

## Desktop email inbox — 2026-10-06

The experimental combined Desktop package now includes an Email inbox sidebar,
authenticated mailbox-management RPC and DSCODE-scoped sender/contact tools.
The terminal tools use the same registration function. Previewing a local
message does not wake an agent; explicit admission binds its revision and a
stable request ID to the selected DSCODE session. Durable inbox and user-message
events prevent a retry from admitting that request twice, including after a
Host restart. An admitted request may still be cancelled before model execution;
the UI and guide distinguish admission from successful completion.

`scripts/verify-desktop-email.mjs` passed in three separate Host processes on
both independent `0.2.1-alpha.1` and signed macOS `0.2.0-rc.2`. The packed-package
probe covers authentication and origin checks, metadata-only inbox listing,
preview without execution, stale-revision refusal, Standard-preset exclusion,
single context admission, restart deduplication and contact persistence. A
native pre-execute denial stops the send tool without an SMTP receipt. Unloading
removes the RPC, timer and scoped tools; reloading restores existing DSCODE
agents while retaining the admission record.

The actual signed application's sidebar was exercised separately with local
fixture mail and a scripted model. Opening the preview produced no delivery
record. Clicking Add email to this session produced exactly one context
admission, a new conversation turn and the disabled Added to this session
button. The screenshot and accessibility evidence are
`artifacts/local/desktop-email-inbox.png` and
`artifacts/local/desktop-email-inbox.ax.txt`; the native UI delivery receipt is
`artifacts/local/desktop-email-electron-ui-host.json`. Automated Host receipts
alone do not establish renderer behavior.

The package is retained at
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-e725229d7acb.tgz`,
SHA-256 `e725229d7acbdef12f0929b661996dda87f554abe6f842f0b676ecbe5ab5062e`.
The native installer lifecycle passed on the same package: fresh installation,
upgrade, incompatible-update rejection, removal and reinstallation. The probe
checks inbox contents, contact aliases, the disabled sync preference and durable
admission deduplication across those operations, hashes the preserved mail and
preference files, and checks that removal withdraws the email RPC.
The full `npm run check` passed lint, both TypeScript checks, 746 unit/component
tests at 81.71% measured `.mjs` line coverage, nine native integration probes,
package checks and 63 evaluations. New component cases exercise masked password
drafts, clearing after submission, hidden/session state reset and foreground
actions queued behind an inbox refresh.

Existing connector tests use local TLS IMAP/SMTP servers and mocked Google
endpoints. This Desktop probe does not complete real Gmail authorization,
connect a real mailbox, send mail, or run paid inference. The connection form
was not submitted to an external service. Windows/Linux Desktop rendering and
real Gmail/SMTP account operations remain unqualified. No Git commit
or remote publication was made.

The additional `--connector` mode subsequently qualified the production IMAP
connector through the authenticated Desktop RPC on both supported Hosts, using
the same package hashes as the inbox/UI probes. The wrapper creates two local
TLS servers and trusts only the fixture's designated certificate through the
child process's `NODE_EXTRA_CA_CERTS`; certificate verification remains enabled.
An untrusted certificate fails before LOGIN and leaves no saved credentials.
A successful connection writes owner-only settings and records the initial UID
without importing historical mail. Cancelling a held search preserves that UID.
A fresh Host restores the connection, imports one new plain-text message using
EXAMINE and BODY.PEEK, and does not fetch it again on repeat synchronization.
A third Host confirms persistence, then unloads the plugin during a held search;
the operation drains and the unfinished checkpoint remains unchanged. The
fixture rejects evidence of SELECT, STORE, APPEND or EXPUNGE commands. No agent
is created during connection, synchronization or preview.

Run from the source checkout with an independent matching runtime:

```bash
node scripts/verify-desktop-email.mjs /path/to/runtime --connector
node scripts/verify-desktop-email.mjs /path/to/runtime '/Applications/DeepSeek Harness.app' --connector
```

This mode requires `openssl` to generate temporary test certificates. It uses
the actual packaged ImapFlow dependency, not a replacement connector factory.
Receipts are `artifacts/local/desktop-email-0.2.1-alpha.1-connector.json` and
`artifacts/local/desktop-email-electron-connector.json`. This proves local TLS
protocol behavior through the Host; external mailbox-provider behavior and
real account authorization are still outside the probe.

The `--smtp` mode also passed on both Hosts with the same package hashes. It
drives send_email through real scripted-model tool calls inside native turns,
so the approval request and decision are durable session events. The fixture
answerer rejects one request and allows only the isolated fixture's subsequent
requests. Rejection produces no transport or receipt. Allowed requests use the
real Nodemailer dependency: a test-only transport shim first asserts the fixed
Gmail endpoint, synthetic credential identity, verified TLS and disabled file/
URL access, then substitutes the loopback TLS destination. Production endpoint
configuration is unchanged. The local SMTP peer checks authentication and the
probe parses the received MIME to verify sender, recipient, subject prefix and
plain-text body.

Repeating an accepted request does not reconnect. A peer that receives DATA but
disconnects before its final response yields an uncertain receipt; retrying that
key also does not reconnect. Both receipts and the native rejection audit survive
fresh Host boots. Reusing a key with different content fails. During a third
Host run, unloading the email plugin while the SMTP peer holds its final response
waits for the in-flight outcome, saves the accepted receipt and removes the tool.
No outgoing fixture reaches an external mail service or real recipient.

```bash
node scripts/verify-desktop-email.mjs /path/to/runtime --smtp
node scripts/verify-desktop-email.mjs /path/to/runtime '/Applications/DeepSeek Harness.app' --smtp
```

SMTP receipts are `artifacts/local/desktop-email-0.2.1-alpha.1-smtp.json` and
`artifacts/local/desktop-email-electron-smtp.json`. They qualify native tool
approval and local SMTP protocol/lifecycle behavior. The approval dialog itself
was not driven in the renderer, and live Gmail delivery remains unverified.

## Desktop diagnostics and bundled guides — 2026-10-06

The combined Desktop package now mounts four namespaced diagnostic commands and
carries its user guides. The agent prompt resolves those guides inside the
extracted package. Developer records are excluded; otherwise their package hash
receipts would become inputs to the next package hash. Relative links to those
records and other unbundled repository files become source-repository links.
The public repository may lag this unpublished package.

`scripts/verify-desktop-diagnostics.mjs` passed on independent `0.2.1-alpha.1`
and the signed macOS `0.2.0-rc.2` Electron Host. It unpacks the npm tarball, creates
DSCODE and Standard agents, executes status, local/preview/model doctor, skill
details/conflicts and MCP inventory through the real command service, and checks
the packed documentation prompt. A scripted adapter drives a real skill tool
call and its persisted native tool-result event; doctor pairs the result without
copying the user or assistant bodies. Another workspace is excluded. The model
analysis receives metadata without tools, uses low effort and no remote model.
The probe also checks redacted warning persistence, command and logger removal,
reload into existing agents, and preservation of native command descriptors.

Desktop MCP management uses only Host loader entries on both supported versions.
The older runtime's mutable standing preset entries are deliberately excluded;
the newer registry already supplies a separate read-only inventory. Terminal
commands retain their previous behavior. The unit cases cover strict workspace
collection with no stored match, prefix isolation, and packaged guide links.

The signed application's native composer discovered and executed
`/dscode-status`; expanding the result showed its session, route, permission,
usage and plugin inventory. The manual UI evidence is saved separately from
automated Host receipts. Host receipts alone do not qualify rendering or paid
model analysis. External MCP connectivity and platform-specific Windows/Linux
Desktop behavior are outside this diagnostic probe.

The retained macOS package is
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-f8e7bc0a8663.tgz`,
SHA-256 `f8e7bc0a86637b7ae4c1a3cd23a3f6d7ded79b1a69968123541428dc7caafcfb`.
The native installer lifecycle passed on that same package: fresh installation,
upgrade, incompatible-update rejection, removal and reinstallation. Its updated
probe checks diagnostic command execution and the local guide prompt after
installation, upgrade, rejection recovery and reinstallation, alongside the
existing configuration, credentials, session and scheduling preservation checks.
The final `npm run check` passed lint, both TypeScript checks, 741 unit/component
tests at 82.32% measured `.mjs` line coverage, nine native integration probes,
package checks and 63 evaluations. The subsequent documentation-only record and
probe updates passed the documentation checker and lint separately. No remote
publication or Git commit was made.

## Custom provider image input — 2026-10-06

`tests/custom-provider-images.test.mjs` exercises the installed Harness model registry,
provider persistence, native durable attachment store and a loopback HTTP server for
Chat Completions, Responses and Anthropic Messages. Synthetic preview pixels enter
through `BrowserPreview.annotate`; both the annotation and a subsequent tool screenshot
arrive as correctly typed image blocks with the expected bytes. The same checks cover
text-only route projection, preserving offloaded occurrences after re-enabling images,
missing stored-image failure before HTTP, aggregate image-budget errors, read deduplication
and cancellation releasing the provider queue. Terminal component tests exercise explicit
image selection, discovery preserving that choice, and endpoint/protocol/model changes
resetting it.

Using the real attachment backend also exposed an existing OpenRouter request-projection
failure: `readImageRequest` requires a width and height, while the adapter passed only a
pixel budget. The regression failed before the fix and passed after resolving the target
dimensions through the upstream projection helper. Custom providers use that same contract.
These checks validate serialization and runtime integration with scripted responses. They
do not qualify remote inference, visual understanding, or the rendered Desktop panel with
extension transport. The experimental Desktop-only bundle does not include custom providers;
these provider changes apply to the complete DSCODE runtime.

### Custom browser evaluation transport

The evaluator accepts a saved custom provider ID and explicit model. Route validation
and credential resolution happen before report creation; only the selected model is
snapshotted, and the credential reaches the child Host through its environment. Unit
checks cover missing credentials, invalid options, no-auth services, explicit environment
overrides, native reasoning replay through the evaluation alias and JSON-safe redaction.

`scripts/verify-browser-eval-custom.mjs` passed on 2026-10-06 with Chrome for Testing
154.0.8037.92. For each of Chat Completions, Responses and Anthropic Messages, the
native agent made 12 scripted HTTP model calls and 11 browser tool calls. A real Chrome
screenshot reached the endpoint, the digest form was submitted once, its dialog was
dismissed, the random receipt was read, and the result tab was retained. A deliberately
echoed synthetic credential was absent from every report and trace. The receipt at
`artifacts/local/browser-eval-custom.json` explicitly records no live model inference or
quality score; temporary per-protocol reports are removed by the verifier.

This full tool loop exposed a shared serializer defect that synthetic nested tool-result
blocks had missed: the installed Harness emits first-class `role: tool` messages.
Those messages had been serialized as ordinary user text, losing their call IDs. The
shared serializer now preserves the native role and IDs for Custom, OpenRouter and
other routes using it. Parallel-result tests keep all Chat tool messages before image
supplements; Anthropic results remain first in the merged user content and retain native
tool-error flags. The custom editor's test action and attachment tests now construct
native tool-result messages too.

## Experimental Desktop browser bundle — 2026-10-06

The official Desktop shell is available in [DeepSeek Harness 0.2.1-alpha.1](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.1-alpha.1/apps/desktop). DSCODE's terminal remains pinned to 0.1.7-alpha.2. Its full bundle carries terminal patches and removed upstream invariant exports, so it cannot be installed unchanged into the new Desktop runtime.

`node scripts/build-browser-desktop.mjs` produces a private, unpublished local bundle at `artifacts/desktop/browser`. It packages the shared browser and review plugins plus a sidebar preview client with exact peer dependencies for the selected runtime. The default is DSH 0.2.1-alpha.1; pass `0.2.0-rc.2` as the builder argument to target the verified official macOS download. It does not replace the terminal runtime or install into an existing Desktop application.

Prepare an independent runtime and verify the packed bundle:

```bash
npm install --prefix .research/browser-desktop-runtime --ignore-scripts --no-audit --no-fund --save-exact @deepseek-ai/dsh@0.2.1-alpha.1 @modelcontextprotocol/sdk@1.30.0 chrome-devtools-mcp@1.9.0 ws@8.21.3
node scripts/verify-browser-upstream.mjs .research/browser-desktop-runtime
```

The verifier packs and unpacks the bundle, removes the staging copy, creates a disposable profile and loads the package by name through the native bundle loader. Plugin imports resolve against the independent runtime. It exercises actual Chrome, lazy per-agent tools, action approvals, site denial, refused-close retention, image and text-only results, human handoff/resume, and annotation images reaching the model input with duplicate-send refusal. The fixture adapter emits scripted responses; no provider key or live inference is used. The probe's preset is empty because it verifies these plugins against the new Host services; it does not verify the complete DSCODE agent preset.

For manual testing of the shared Web/Desktop sidebar client, run:

```bash
node scripts/verify-browser-ui.mjs .research/browser-desktop-runtime
```

The launcher starts an isolated official Web UI, a loopback fixture page and a scripted image-capable model adapter. Open the printed URL, select its fixture session and open **Browser preview**. Select the fixture tab, refresh its image, click a point, enter an annotation and send it. The fixture writes `annotation-receipt.json` in its temporary home; stop the launcher to remove that home. No provider credentials or personal browser profile are used.

On 2026-10-06 this flow rendered the real Chrome screenshot, refreshed while visible, paused on point selection, and delivered exactly one annotation with an image to the scripted model input. Requests without authentication returned 401; requests with an untrusted Origin returned 403. Screenshot polling uses the Host's authenticated Connection carrier and does not create command-history entries. The annotation tests also cover expiry, replacement, navigation, reconnection, handoff, revoked permission and text-only image projection. React component regressions also delay tab lists, captures and annotation acknowledgements across session changes and hide/show cycles. They verify that late results cannot replace another session's preview, draft or error state, and that closed or navigated tabs lose their sendable annotation point. The shared Web UI was also checked by hiding a pane with an unsent draft, reopening it, and sending a fresh capture: the old draft and image cleared, tabs reloaded, and exactly one new annotation with an image reached the fixture adapter. These fixture results do not measure live-model visual understanding.

### Official macOS Electron application

On 2026-10-06, the [official macOS Apple Silicon download](https://download.deepseek.com/desktop/dsh-latest-macos-arm64.dmg) contained **0.2.0-rc.2**, even though the newest GitHub source/npm release was 0.2.1-alpha.1. The application's own updater also reported 0.2.0-rc.2 as current. Do not infer the binary version from the GitHub release tag.

After mounting the downloaded image, run:

```bash
node scripts/verify-browser-electron.mjs '/path/to/DeepSeek Harness.app' .research/browser-desktop-runtime
```

The launcher verifies the macOS code signature, checks the installed version, builds matching peers and places the bundle inside an isolated Desktop profile. Electron's bundled runtime resolves the core dependencies; the supplied npm directory provides only Chrome MCP and its SDK. The test uses separate browser data, disables product analytics and leaves account setup optional through **Add API Key → Set up later**. Open the fixture session under Ungrouped, then **Open right sidebar → Browser preview**. Stop the launcher with Ctrl+C after testing; it saves a successful annotation receipt under `artifacts/local/browser-electron-receipt.json` before removing its temporary home.

This run found and fixed an actual Desktop launch failure: the MCP subprocess inherited Electron's executable but lost `ELECTRON_RUN_AS_NODE=1` when the SDK built its minimal environment. It launched an application instead of the MCP server and timed out. The browser transport now sets Node mode when running under Electron, while retaining the minimal environment for ordinary Node. A unit regression checks both environments. The UI fixture now refuses to announce readiness unless the browser actually opened the target page.

The signed 0.2.0-rc.2 app subsequently opened Chrome, rendered the native `dsh-app://app/` sidebar and delivered exactly one point annotation with its image, URL and coordinates to the scripted model. The receipt reports one annotation and image admission. Persistent installation, updates, Windows, Electron 0.2.1-alpha.1 and live-model visual understanding remain unverified.

This added preview panel displays the Chrome instance controlled by DSCODE. The upstream Sidebar Browser's Electron webviews remain independent and register no model tools; their process-local cookies do not preserve the browser plugin's persistent profile semantics. Migration of the complete DSCODE agent preset remains pending.

### Browser extension transport — 2026-10-06

An unpacked MV3 extension now provides selected-tab transport through the existing
Chrome DevTools MCP. The loopback relay uses separate random capabilities for
the extension and MCP client, validates the extension Origin and Host, admits
one client, and closes both peers when sharing ends. Pairing is a user command
bound to the current session; agent status does not include pairing links. Relay
and extension state is transient, but the Host may retain the user command's
output in session history. A link admits one extension connection and becomes
unusable after revocation or expiry; do not treat command history as secret-free.

The real probe passed on macOS Apple Silicon with Chrome for Testing
154.0.8037.92: the popup paired a selected local page while excluding another
open page; MCP took snapshots, filled and submitted a form, captured an image,
created and closed a tab; the popup's Stop all sharing disconnected the transport
and subsequent page access failed. Unit tests cover scoped target/child-session
routing, browser-wide cookie refusal, pairing lifecycle and revocation races.

This was a headless disposable test browser, with no personal profile or live
model. Chrome Web Store distribution, ordinary Chrome's toolbar installation,
real cross-origin frame/worker behavior, long-running suspension recovery,
and Windows remain unverified. The combined rendered Desktop-preview/extension
qualification is recorded below.

### Extension-backed native preview carrier — 2026-10-06

The official macOS Electron 0.2.0-rc.2 Host also passed an extension-backed
preview probe with Chrome for Testing 154.0.8037.92. The actual user-command
service created the pairing; the real extension popup shared a fixture page;
the production authenticated Connection HTTP endpoint listed only that page,
returned a PNG, and admitted one annotation with its image into the native
session. Reusing the capture token failed. Revoking the extension then rejected
tab reads, captures and an annotation made from an earlier capture. The receipt
is `artifacts/local/browser-electron-extension-rpc.json`; it explicitly sets
`renderedUi: false` and `liveModelInference: false`.

To repeat, start `scripts/verify-browser-electron.mjs` as above with an additional
`--extension` argument and `DSCODE_TEST_CHROME` pointing to Chrome for Testing.
Keep its output in a local log. Once `BROWSER_UI_READY` appears, run
`node scripts/browser-preview-rpc-probe.mjs <log> <launcher-pid>`; use the PID from
`ELECTRON_FIXTURE`. The probe sends SIGUSR2 to that fixture launcher, which clicks
the disposable extension popup's Stop all sharing control. Ctrl+C stops both
fixture processes and removes their temporary home. No personal Chrome profile
or provider credentials are used.

Computer Use could not reliably locate the native window during that HTTP probe;
the later rendered qualification below covers the combined UI. The HTTP carrier
result alone does not establish rendered UI behavior. Real React component regressions
separately verify that failed tab/capture/annotation requests stop automatic
refresh and clear the image and selected point while preserving comment text.
Admission regressions verify that revocation during attachment storage, model
lookup or the final permission check prevents a late annotation from entering
the session. All six new regression cases failed before the corresponding fixes.

### Rendered Desktop panel with extension transport — 2026-10-06

A fresh isolated launch of the signed macOS 0.2.0-rc.2 application passed the
combined flow using Computer Use on its native `dsh-app://app/` window. The real
unpacked extension shared the local fixture through disposable Chrome for Testing
154.0.8037.92. The sidebar listed one shared tab and rendered its screenshot.
Enabling visible refresh advanced the capture timestamp. Selecting the orange
button disabled refresh and marked the point. Sending the comment delivered
exactly one annotation with an image, URL, capture time and pixel coordinates
to the scripted adapter; the chat displayed the attachment and acknowledgment,
and the consumed preview and draft cleared.

After a new capture, an unsent draft and visible refresh were enabled. Sending
SIGUSR2 to the fixture launcher activated the extension popup's Stop all sharing.
The next refresh cleared the screenshot, unchecked refresh and showed the
disconnection message while retaining the draft. Send remained disabled and the
adapter's annotation count remained one. The launcher exited successfully and
removed the isolated home and browser process.

Local evidence is recorded in
`artifacts/local/browser-electron-extension-ui.json`, including SHA-256 hashes of
the point-selection, sent-annotation and revoked-sharing screenshots. The
launcher's separate annotation receipt verifies model-input admission only;
visual acceptance comes from the recorded native UI interaction. To repeat the
visual flow, launch with `--extension` as above and use the rendered controls
instead of running the HTTP probe in that same fixture. No provider credentials
or personal browser profile were used. Live-model visual understanding, ordinary
Chrome toolbar installation, Windows, persistent installation, updates and the
complete DSCODE preset migration remain outside this qualification.

### Desktop preset migration audit — 2026-10-06

Importing the shared command plugin against 0.2.1-alpha.1 failed because the
runtime no longer exports `standingMountFor`. It now queries the registry's
`inspectCompositions(agent.ctx)` service for the exact retained Agent revision.
The new inventory exposes detached module references, without mutable Loader
entries or server configuration. Diagnostics label Host counts separately and
show preset modules and leaked services. `/mcp` reports the restriction when a
preset has MCP modules; its mutation commands continue to operate on actual Host
entries. Filesystem conflict checks explicitly report incomplete coverage when
the registry cannot expose preset skill-root configuration. The pinned terminal
retains its existing standing-tree inspection and mutation behavior.

The following real Host checks passed with independent temporary homes and no
provider credentials or inference:

```bash
node scripts/verify-desktop-commands.mjs .
node scripts/verify-desktop-commands.mjs .research/browser-desktop-runtime
```

They load the production command plugin on 0.1.7-alpha.2 and 0.2.1-alpha.1,
mount two different presets, verify Agent-scoped inventory, and execute
`/status`, `/mcp` and `/doctor local`. The focused command suite also checks the
read-only inventory boundary, leak reporting and incomplete skill-root coverage.
This does not install these commands into the browser-only Desktop bundle.

A separate temporary Host audit mounted the unchanged DSCODE agent composition
on 0.2.1-alpha.1. Initially it failed with a duplicate `bash` tool: the upstream
one-shot shell does not support DSCODE's `toolName: shell_retry` setting until
`patchBash` is applied. Applying that existing patch to a disposable copy of the
new runtime's shell module allowed the full agent composition to bind and expose
both `bash` and `shell_retry`, along with goals, planning, skills, review and
subagent tools. All eight existing runtime patch functions also accepted the new
source files; this is transformation compatibility, not behavioral qualification.
The audit did not execute shell or subagent tools, migrate the complete Host
plugin bundle, or qualify installation and updates. Those remain necessary
before advertising a complete DSCODE Desktop preset.

### Packed Desktop agent composition execution — 2026-10-06

`scripts/build-desktop-preset.mjs` now stages the complete agent composition and
nine shell, goal-command and subagent modules from an independently installed
0.2.1-alpha.1 runtime. It checks every copied module's version and applies the
existing DSCODE transforms only to those copies. The private migration fixture
includes original licenses, transformation notices and source-entry hashes; it
does not import the older terminal's invariant modules or its patched runtime.

```bash
node scripts/verify-desktop-preset.mjs .research/browser-desktop-runtime
```

This verifier packs and unpacks the staged bundle, removes the build copy, loads
the extracted package through the native bundle loader and mounts the full
DSCODE agent composition. On macOS Apple Silicon, its scripted model drove real
workspace-write shell execution: one persistent shell retained an exported
variable across calls and accepted a literal exclamation mark; `shell_retry`
started a fresh shell without that variable. Foreground spawn and fork children
each executed their own shell, inherited the model route, honored separate low
and high reasoning efforts and did not inherit the parent's shell variable.
The command plane also answered `/shell status`. All assertions passed after
the child executions had settled. Original runtime entry hashes remained equal
to the build inputs. The receipt is `artifacts/local/desktop-preset.json`.

The test performs no remote model inference and does not render Electron. At
this stage, other provider integrations, mailbox and trigger integration,
native Computer Use, tool-path bootstrap behavior, persistent installation and
updates still required migration. The later lifecycle and communication sections
below qualify installation and mailbox support. Goal execution, compaction,
worktree children, shell cancellation/reset and long-running jobs were not
qualified by this probe. The earlier terminal checks retain their own runtime
scope and do not establish those behaviors on Desktop.

### Concurrent Desktop workspace discovery — 2026-10-06

The Desktop migration fixture now mounts instruction, filesystem-skill and hook
plugins inside each DSCODE Agent's own scope after its preset is bound. It
derives paths from the session cwd instead of the Host startup directory and
does not change the terminal launcher's environment-based discovery. Ancestor
instructions use a session-specific generated directory while continuing to
read the shared user-global instruction file. Project and nested instruction
handling remains with the upstream provider. Disposing one Agent removes its
generated files and scoped providers.

Hooks use the same source-merging rules and native hook implementation as the
terminal. Each session gets its own merged file. Because the hook plugin mounts
during Agent creation, the bridge invokes only its newly registered SessionStart
callback; it does not emit another lifecycle event. The other native callbacks
register on that Agent's scope, with the native hook timeout and teardown rules.
Changes to ancestor roots, aggregated ancestor instructions or hook source files
require recreating the session's live Agent; this bridge does not watch and
rebuild those snapshots. The filesystem provider still watches the roots it was
given, and the native instruction provider retains its project-file behavior.

`verify-desktop-preset.mjs` additionally creates two independent workspaces under
a disposable home and runs their Agents concurrently. The model-input assertions
require the shared global instructions and each workspace's own ancestor and
project instructions, while rejecting the other workspace's text. Skill catalog
assertions likewise require only the owning ancestor skill. Actual hook commands
append local markers for SessionStart, UserPromptSubmit, PreToolUse, PostToolUse
and Stop. The marker sequence proves that each workspace runs its own project
hooks and its one global startup hook. Disposing the first Agent removes only
its generated directory; the second Agent retains its skill, executes another
turn and runs its hooks without repeating SessionStart. Both directories are
gone after disposal and the shared global instruction file is unchanged.

These assertions passed alongside the earlier real shell and child-agent checks.
The receipt records `workspaceInstructionIsolation`, `workspaceSkillIsolation`,
`workspaceHookIsolation`, `sessionStartOnce` and `workspaceDisposal`. The shared
instruction helper also has a focused regression for separate output directories.
This remains a native Host fixture, with scripted model responses and no rendered
Desktop or installation qualification for the complete preset.

After this migration change, `npm run check` passed: 686 unit/component tests,
63 evaluation tests, both typechecks, integration and package checks, and lint.
The complete first-party MJS inventory measured 84.09% line coverage; TypeScript
remains outside that coverage metric and is checked by the two typecheck gates.

### Desktop custom providers and credentials — 2026-10-06

The packed migration fixture now mounts DSCODE's production custom-provider and
shared-credential plugins. It explicitly disables the base credential entry and
inserts the replacement: changing an entry's `name` in a composition patch is
ignored by the upstream patcher. The initial probe detected this because keys
resolved successfully but had been written to the native profile store instead
of DSCODE's shared store.

`verify-desktop-preset.mjs` now boots the isolated Host twice. The first run saves
three synthetic provider profiles and keys through the production service. Full
DSCODE Agents send a durable PNG to local HTTP fixtures through Chat Completions,
Responses and Anthropic Messages. Assertions check native provider/model catalog
entries, the selected model and endpoint, authentication headers, exact stored
image bytes and the recorded assistant response. The provider catalog contains
no key; the shared credential file is owner-only, and unrelated native keys still
use the profile store.

The first Host exits before the second starts with the same disposable home.
Before changing the local fixture endpoints, the second run requires all saved
routes, image capabilities and credential status to be present. It then repeats
all three image requests without saving keys again. Both runs passed alongside
the shell, subagent and workspace-isolation checks. The receipt adds
`customImageProtocols`, `customCredentialStorage`, `nativeCredentialFallback`
and `customHostRestart`.

The 10 focused image/provider-tool-result regressions, documentation checker and
lint also passed. The full release gate was not repeated for this fixture change;
the earlier 686-test result above describes its own recorded revision.

This qualifies the native Host transport and storage with scripted local
responses. It does not test real model vision, browser capture, a Desktop
provider-editing form or installation into an existing user profile. The
subsequent settings-interface check below covers the shared rendered form.

### Desktop custom-model settings interface — 2026-10-06

The experimental preset bundle adds **Settings > DSCODE models** to the native
settings-section extension point. The shared Web/Desktop form creates and edits
provider profiles, discovers models, runs the existing text/tool probes, sets
context/output limits and thinking, and explicitly enables image input. Saving
clears the draft key; an empty key preserves the stored credential. Switching
the endpoint, API format or model ID clears image capability and server-reported
limits. User-entered limits remain. Editing a key clears previous test results.
Removal requires a second explicit click and deletes the saved provider key.

The form uses a dedicated `/api/dscode-custom` route inside the authenticated
Connection carrier. It never sends keys through Agent commands or messages.
Save and remove require the catalog revision; a conflicting editor cannot
overwrite a newer configuration or key. Probe/discovery requests are bounded by
30 seconds, and draft keys are redacted from transport errors. Native Host
qualification now saves the three protocol profiles through this endpoint,
rejects unauthenticated and foreign-origin requests, restarts the Host, and
repeats the model/image checks. `customSettingsRpc` and `customSettingsAuth`
record those results.

Run the interactive fixture with:

```bash
node scripts/verify-desktop-model-ui.mjs .research/browser-desktop-runtime
```

It starts the real upstream Web client and the DSCODE bundle in a disposable
home, with a loopback model server. In the rendered form, the check added a
provider, discovered `desktop-ui-vision`, enabled images, passed all three
text/tool probe stages and saved the profile. The key field cleared after save.
The new provider then appeared in the native session model picker and selecting
it updated the current model. The saved catalog retained the model's image
capability and contained no credential. The fixture recorded discovery followed
by text, tool-call and tool-result requests, with the synthetic key saved in the
credential store. Its process and browser tab were closed after the check.

Artifacts: `artifacts/local/desktop-model-settings.png` shows the rendered form;
`artifacts/local/desktop-model-ui/transport.json` records the fixture requests;
`artifacts/local/desktop-model-ui/ui.json` describes the manual UI assertions.
Eight focused regressions cover conflict handling, key-error redaction,
capability resets, clearing test results and explicit removal. This check uses
the Web client shared with Desktop; it does not qualify the new settings form
inside Electron, Windows, installation into an existing profile or real-model
vision. The probe UI explicitly marks images, thinking and long context as
untested.

After adding this settings surface, `npm run check` passed: 694 unit/component
tests, 63 evaluation tests, both typechecks, integration, package checks and
lint. Complete first-party MJS line coverage was 83.67%; TypeScript remains
outside that metric and is covered by the separate typecheck gates.

### Combined Desktop preset, browser and model transport — 2026-10-06

The private preset migration package now includes the browser/review plugins,
extension files and preview endpoint beside custom-model settings. Its generated
client entry composes the two existing component factories under one native
module registration, retaining their separate slot identities and disposers.
The independently buildable browser-only bundle remains available; install one
or the other in a profile, because both declare the same browser services.

The permission patch carries the ordinary modes as well as `auto-review`.
The upstream patcher replaces the whole preset map, and permission inference
chooses the first matching sandbox/approval pair. Keeping the ordinary modes
first therefore preserves `workspace-write` as the default instead of silently
selecting the review alias. The real Host probe asserts both the default and the
initial mode of a newly created Agent.

```bash
DSCODE_TEST_CHROME='/path/to/test/Chrome' node scripts/verify-desktop-preset.mjs .research/browser-desktop-runtime --browser
```

This optional qualification checks the browser dependency versions against the
packed manifest, unpacks the package, removes the build copy, and runs the full
DSCODE composition on the independent 0.2.1-alpha.1 Host. A production custom
Chat Completions route drives real Chrome to a local page, takes a screenshot,
explicitly retains the result tab and receives the image in its next request.
The authenticated preview endpoint captures that tab and submits a point
annotation to the same Agent. The assertion compares the annotation image bytes
at the HTTP endpoint against the admitted durable attachment, and requires one
recorded user annotation and the scripted assistant acknowledgment. It also
rejects receipt reuse, blocks capture after site revocation, prevents browser
tools from appearing in another full-preset Agent, and verifies tool withdrawal
after browser stop. Auxiliary summary calls do not advance the scripted browser
turn. All assertions passed, alongside the earlier shell, subagent, workspace,
three-protocol image and Host-restart checks.

The receipt adds `combinedDesktopBrowser`, `customBrowserScreenshot`,
`customBrowserAnnotation`, `combinedBrowserScope` and
`combinedBrowserRevocation`. It still declares `liveModelInference: false`:
the local endpoint returns scripted tool calls and replies.

The shared rendered Web client was also opened with this single package. Model
discovery, the text/tool probe, save, cleared key field and model-picker selection
passed again. The same client then displayed Browser preview and its expected
not-started state. `artifacts/local/desktop-combined-ui.png` and
`artifacts/local/desktop-combined-ui.json` record that UI composition check; the
automated Host check above covers actual capture and annotation. This Web check
does not establish Electron support; the later native qualification below covers
the combined package on the official macOS application. Persistent installation,
upgrades and real-model visual understanding remain unverified.

The complete regression gate passed after this integration: 696 unit/component
tests, 63 evaluation tests, both typechecks, integration and package checks, and
lint. Complete first-party MJS line coverage was 83.57%; TypeScript is checked
separately. A read-only inspection of the saved official macOS DMG again reported
`CFBundleShortVersionString` and `CFBundleVersion` as `0.2.0-rc.2`; the image was
detached immediately afterward. At this stage the combined preset was qualified
only on the independent 0.2.1-alpha.1 runtime.

### Combined preset on the official macOS runtime — 2026-10-06

The builder now accepts both 0.2.0-rc.2 and 0.2.1-alpha.1, while still requiring
all nine staged native modules to match the selected runtime exactly. The
terminal runtime pin is unchanged. The complete packed-preset qualification,
including real Chrome, also passed on the independent 0.2.0-rc.2 runtime:
shell persistence, fresh shells, spawn/fork isolation, workspace instructions,
skills and hooks, three custom image protocols, credentials across Host restart,
and preview annotation, reuse rejection and site revocation. Version-specific
receipts use `artifacts/local/desktop-preset-<version>-browser.json`; the generic
`desktop-preset.json` remains the most recent successful run.

The Electron launcher has a separate combined-preset mode:

```bash
DSCODE_TEST_CHROME='/path/to/test/Chrome' node scripts/verify-browser-electron.mjs '/path/to/DeepSeek Harness.app' .research/desktop-official-runtime --preset
```

This mode requires the staged runtime to match the signed application's version.
Plugins live inside the disposable Desktop profile so native core imports resolve
through Electron's bundled runtime. Only MCP dependencies are linked from the
external npm directory. Both `HOME` and `DSH_HOME` are temporary, including custom
provider credentials, and Electron uses a separate user-data directory. The
fixture route is a local scripted Chat Completions service; it does not contact a
real model or require an account.

In the signed macOS 0.2.0-rc.2 application, the full DSCODE preset opened a real
Chrome page, captured it and retained its tab. Through the native `dsh-app://app/`
interface, Browser preview rendered that page; selecting a point and sending an
annotation produced exactly one user image attachment and the scripted assistant
acknowledgment. The fixture compared the image bytes received by the custom HTTP
endpoint with the admitted durable attachment. In the same application, Settings
→ DSCODE models loaded the saved provider, displayed its image capability and
saved a renamed provider while retaining the blank password field and stored key.
The changed provider name was also verified in the isolated configuration file.

`artifacts/local/browser-electron-preset-receipt.json` records image transport;
`desktop-electron-preset-ui.json` and the `desktop-electron-preset-*.png` captures
record native rendering and settings checks. The launcher exited successfully,
removed the temporary profile and stopped its owned browser. This qualifies the
combined UI and custom-model image transport on that official app, not a complete
Desktop distribution. Persistent installation/upgrades, Windows, the remaining
DSCODE Host services and live-model visual understanding still need qualification.

After adding the interactive native fixture, the packed-preset browser probes
passed again on both runtime versions. The ten custom-settings/client-composition
tests, documentation checker, lint and whitespace check also passed. The full
release gate was not rerun for this fixture-only adaptation; its preceding result
is recorded above.

### Native Desktop package lifecycle — 2026-10-06

`scripts/pack-desktop-preset.mjs` builds in a disposable directory and produces a
local tarball whose filename includes the target runtime and content hash. The
adjacent receipt records full SHA-256, npm integrity and staged core-module
versions/hashes. It never installs or publishes the package. Identical bytes can
reuse an existing content-addressed filename; different bytes cannot overwrite it.

```bash
node scripts/verify-desktop-install.mjs '/path/to/DeepSeek Harness.app' .research/desktop-official-runtime
```

The signed macOS 0.2.0-rc.2 application creates its own reserved Desktop profile
under disposable `HOME`, `DSH_HOME` and Electron user data. The verifier invokes
the application's actual bundled `runtime/cli/bin/dsh plugin --profile desktop`
carrier and bundled pnpm. It installs the packed artifact, boots the official
Host, upgrades to a fixture package revision, rejects a tarball with incompatible
DSH peers, boots the retained version, removes the package and boots the base
Host again, then reinstalls the original package and resumes the saved session.
It does not call a replacement installer or allow a second core
runtime in the profile.

Every stage passed. The installed full preset created a real persisted session
with a scripted response; the upgraded and restored Hosts resumed that session
and found its original assistant message. Provider configuration, credential
storage and browser permissions retained their bytes through upgrade/removal.
Removal also preserved the stored session generations, including the official
Desktop's compressed `.jsonl.zstd` format, and the user profile patch. The rejected
update restored both the manifest and lockfile before the previous version booted.
The removed package supplied neither the custom-model service nor a usable DSCODE
preset, while the base Host started normally. Reinstallation restored the saved
custom route and resumed the original session without resaving its model key.
`artifacts/local/desktop-install.json` records the result and the exact qualified
tarball's SHA-256 and npm integrity. All application processes and temporary configuration were
cleaned up after the run.

The bundled pnpm accepts `--ignore-scripts` for `add`; `remove` requires the
configuration form `--config.ignore-scripts=true`. User instructions use those
observed commands. The package remains private and experimental. This qualifies
the plugin lifecycle on one official macOS runtime, not an in-place Desktop app
upgrade, Windows, all remaining DSCODE Host services or live model quality.

The complete regression gate passed with `caffeinate -is npm run check`: 696
unit/component tests, 63 evaluation tests, both typechecks, all integration and
package checks, and lint. Complete first-party MJS line coverage was 83.41%.
Two earlier attempts exceeded the check runner's 180-second wall-clock deadline
while macOS entered maintenance sleep for 942 and 925 seconds. An isolated trigger
replay passed, and the final run held both idle and system sleep assertions only
for the check process lifetime. No trigger implementation change was needed.
The documentation checker and whitespace check also passed.

### Desktop session communication — 2026-10-06

The combined package now mounts production session metrics, session cards and
the session bridge. `scripts/verify-desktop-messaging.mjs` qualifies the actual
packed artifact in isolated native Hosts on both 0.2.0-rc.2 and 0.2.1-alpha.1.
The shared card probe verifies user-only topics, independent low-effort generation,
cost attribution, cached resume and socket list/read. The shared two-Host probe
verifies registered tools, deferred no-wake behavior, crash/resume admission
recovery, a scripted model's final reply, single delivery, cancellation and mailbox
watching. A separate scope probe runs the native Standard preset successfully but
excludes it from DSCODE discovery and communication execution; DSCODE children
inherit their parent's task chains without appearing as independent root targets.
Disposal withdraws the owners. All three scenarios passed on both runtimes.

The official signed macOS 0.2.0-rc.2 installation lifecycle also passed with these
services mounted. One full DSCODE session sends another a deferred note through
the registered `send_session` tool. The same message ID remains accepted and
unconsumed after a package upgrade, rejected incompatible update, removal and
reinstallation. Retrying the same key returns the existing message. Resume and
mailbox inspection do not wake the target; its next human turn consumes the note
exactly once. `/session`, `/mailbox` and `/tasks` answer through the native command
service. Removal withdraws both communication and cards while the base Host
continues to boot. An initial fixture attempt correctly rejected a sender with
no human task context; the fixture now establishes that context through a real
user turn before sending, preserving production authorization rules.

Desktop's `/session` CLI examples now carry the current state directory in a
shell-quoted `--home`. A separately installed terminal launcher can otherwise
look in its own default home and fail to find Desktop sessions. Probe cleanup
resolves the home-derived private socket directory before removing temporary
homes, including on failure.

The full packed-preset browser checks also passed on both runtimes after adding
the services: workspace and shell/subagent isolation, custom-provider image
transport, preview annotation, revocation and restart remained functional.
Receipts are `artifacts/local/desktop-messaging-<runtime>.json`,
`desktop-preset-<runtime>-browser.json` and `desktop-install.json`.
The tests use scripted models. They do not establish live model quality, Windows
support, the terminal's activity-line UI inside Desktop, or the remaining provider,
trigger and native Computer Use migrations.

After this integration, `caffeinate -is npm run check` passed: 696 unit/component
tests, 63 evaluations, both typechecks, all native integration and package checks,
and lint. Complete first-party MJS line coverage was 83.39%. The documentation
checker and whitespace check also passed. The locally retained 0.2.0-rc.2 tarball
has the same SHA-256 as both its official Desktop lifecycle receipt and the
independent messaging receipt.

### Desktop provider accounts — 2026-10-06

The combined package mounts the production OpenRouter, Grok and OpenCode Go
adapters and Jev review service. Native pi-ai reserves OpenRouter and OpenCode Go
directory names even when they are unconfigured. The DSCODE variants therefore
use `dscode-openrouter` and `dscode-opencode-go`, displayed as **DSCODE OpenRouter**
and **DSCODE OpenCode Go**, without disabling native pi-ai or replacing its
provider configuration. Terminal route IDs are unchanged. Pricing and counterpart
selection understand the aliases; reasoning replay retains the exact original
route and model identity to prevent history crossing between providers.

**Settings → DSCODE accounts** manages the shared OpenRouter credential, shows
read-only Grok CLI login status and uses the production OpenCode login state
machine for sign-in, cancellation and local sign-out. The authenticated native
Connection endpoint accepts a fixed set of account operations. It returns status
without secrets, refuses edits to environment-owned keys, redacts a submitted
key from errors and disables response caching. Saving clears the password draft;
removal and sign-out require a second click. Mounting the settings page performs
only a status read. Completed device login clears the obsolete consent notice.
DeepSeek configuration remains in native settings. The native default web-search
provider is preserved; registering DSCODE routed search does not select it.

`scripts/verify-desktop-providers.mjs` passed against separately installed
0.2.0-rc.2 and 0.2.1-alpha.1 runtimes using the extracted npm tarball. Each of two
Host boots completed full DSCODE Agent turns through native OpenRouter, an
existing native custom provider, DSCODE OpenRouter, Grok and DSCODE OpenCode Go.
The loopback service checked authorization headers, the Go organisation header,
and OpenRouter Ultra request configuration. Credentials survived the restart;
Grok's file stayed byte-identical. Go sign-out removed the grant and a subsequent
request reported the login requirement. Unauthenticated and cross-origin account
requests were rejected. An early network guard allowed only loopback fetches.
Receipts are `artifacts/local/desktop-providers-<runtime>.json`.

The official signed macOS 0.2.0-rc.2 application and bundled CLI also passed the
full installation lifecycle with these providers mounted. Saving the synthetic
OpenRouter key through the native account RPC survived package upgrade, a
rejected incompatible update, removal and reinstallation. Removal withdrew the
account endpoint and login service. The existing custom-model, browser-permission,
session and deferred-mailbox preservation checks remained green. The retained
package hash matches both the provider and installation receipts. Both packed
preset/browser checks passed again with the provider services present.

Account component and transport tests cover fixed credential writes, read-only
credentials, rejected login, secret redaction, same-route reasoning replay,
password clearing, explicit removal and stale device-code clearing. The current
rendered-page check is incomplete: the account form rendered in the shared Web
client, but the browser connection was unavailable when resuming save/remove
interaction. The native UI fixture also booted successfully, but macOS was locked
and Computer Use could not unlock it. Component tests do not substitute for
native Electron visual QA. `scripts/verify-desktop-model-ui.mjs` accepts an
optional matching official `.app` path for continuing that check in an isolated
native Desktop home; its Host blocks external fetches before account interaction.
The provider probes use scripted model responses and synthetic account grants;
they do not verify real model quality or a live OpenCode consent flow. Mounting
Jev here does not establish an independent Desktop review-service qualification.
Windows, background triggers and native Computer Use remain unqualified.

After the provider integration, `caffeinate -is npm run check` passed with 702
unit/component tests, 63 evaluations, both typechecks, native integration probes,
package checks and lint. Complete first-party MJS line coverage was 83.18%.
The documentation checker and whitespace check passed. Native UI fixture support
was added after the full gate and booted the official app successfully; it does
not change the packed production code. A final lint pass covers that verifier.

### Owned trigger sessions for Desktop — 2026-10-06

The terminal trigger Host previously coupled one task to process exit. That
lifetime cannot be used inside a shared Desktop Host. The execution path now
lives in `plugins/triggers/session-run.mjs`: it owns one Agent, goal, listeners,
permission boundary and deadline, and returns a completion promise after
cancelling queued continuations, draining the Agent, flushing its session and
releasing its handle. The CLI Host remains a small process adapter that writes
the same result file and exits with the run's status. A failed initial flush
also releases its Agent before leaving the persistent binding unpublished.

Unattended schedule authority is tracked per Agent. Other interactive Agents in
the same Host keep their existing schedule permissions. Approval requests from
the run and its descendants are rejected; unrelated interactive requests continue
through the normal pipeline. Cancellation and deadline cleanup remove the run's
listeners and timer. Existing CLI process-level unattended guards remain in place.

`scripts/verify-desktop-trigger-sessions.mjs` qualifies the execution primitive
from an extracted combined-package tarball in an independent native Host. It
runs two model turns per goal, restores one persistent session across two Host
boots, creates distinct fresh sessions, and runs a completing task concurrently
with a stalled task that reaches its deadline. The model's abort signal is
observed before completion is reported. Explicit cancellation drains its Agent;
the original interactive session still completes a subsequent model turn, and
its schedule authority remains unchanged. The probe verifies no trigger Agents
remain registered. Component tests additionally cover approval inheritance,
listener cleanup and failure during goal setup. Receipts are
`artifacts/local/desktop-trigger-sessions-<runtime>.json`.

This is preparation for Desktop scheduling, not an enabled Desktop scheduler.
The combined package still does not register trigger management or start a
scheduler. The first broad import probe exposed a missing `cron-parser`
dependency in the independent Desktop runtime. Schedule authority is now a small
shared module independent of storage and scheduling, allowing the run lifetime
to be qualified without loading unused management services. The scheduler still
needs its declared dependencies, Desktop lifecycle integration and script-worker
launch qualification. App-quit recovery, due-job delivery, source supervision
and the scheduling UI are not established by this probe. Its models are scripted;
the official Electron carrier and Windows have not run this new execution path.

The two-boot probe passed on both 0.2.0-rc.2 and 0.2.1-alpha.1. The final
`caffeinate -is npm run check` passed with 706 unit/component tests, 63 evaluations,
both typechecks, all native integration probes, package checks and lint.
Complete first-party MJS line coverage was 83.27%. The terminal integration probe
still completed delayed, recurring and script-emitted jobs through real worker
processes and preserved persistent history across runs. Documentation and
whitespace checks passed. The existing user-facing Desktop installation package
is unchanged; these execution probes do not establish native installation or UI
qualification for an enabled scheduler.

### Desktop durable scheduler and Host lifecycle — 2026-10-06

`plugins/triggers/desktop-scheduler.mjs` adds an explicitly started queue owner
around the existing trigger definitions, SQLite jobs, kernel leases and source
supervisor. Its workers use owned in-process Agents instead of launching a
terminal Host. A second owner cannot steal the state directory's scheduler
lease. Loading or constructing the coordinator does not start it. Disposing its
Host binding stops admission, cancels owned runs, drains script producers and
releases the lease; a disposed binding cannot be restarted. Unclaimed work stays
pending. A run interrupted by a killed Host is recorded as failed when the next
owner recovers it, without automatically repeating its side effects.

The coordinator registers an unowned native background job before dispatching
work. Desktop's existing quit and update task inspection can therefore see the
queue owner even between Agent runs. While enabled, the scheduler counts as
active work even with an empty queue. Native job cancellation uses the same
drain path; an admission rejection leaves no scheduler lease or worker. The
native job remains stopping until the producer finishes releasing resources.
This does not add an independent update lock: the registered owner remains
visible throughout update inspection, and Host shutdown performs the drain.

`scripts/verify-desktop-scheduler.mjs <runtime-directory>` extracts the combined
package and runs four real Host phases: initial delivery, forced process death
after a durable claim, recovery, and graceful shutdown with running work. Both
0.2.0-rc.2 and 0.2.1-alpha.1 passed. Cases cover persistent model history across
Host boots, event idempotency, coalesced missed intervals, cancellation before
delivery, pending work retained across stop/start, duplicate events emitted by
a real sandboxed daemon script, native job cancellation and process cleanup.
The parent checks SQLite results, process death and lease availability after
graceful shutdown rather than treating a pre-exit marker as cleanup evidence.
Receipts are `artifacts/local/desktop-scheduler-<runtime>.json`.

The optional `Harness.app` argument runs the signed application's bundled Host
entry in Electron Node mode. It uses the application's core runtime and private
quit/update/shutdown IPC, with external dependencies supplied only for declared
package imports. The first such run exposed a missing file-lock dependency in
script guardians: a fork does not inherit the Host's runtime resolution hooks.
The package now declares `@deepseek-ai/node-addon-system`, `yaml` and
`cron-parser` explicitly for that independent process. This path does not open
or operate the Electron renderer. After that fix, all four phases passed in the
signed macOS 0.2.0-rc.2 Host, including its actual quit/update inspection while
the queue is idle, inspection after stopping, and shutdown over native IPC.
The receipt is `artifacts/local/desktop-scheduler-0.2.0-rc.2-electron.json`.

The coordinator is still not mounted in the user-facing package. Trigger
management, explicit activation, its scheduling interface, and native package
installation with scheduling enabled remain to be integrated and qualified.
The probes use scripted model responses, not live inference. Windows source
launch and native UI interactions remain unverified. The previously retained
installation tarball has not been replaced by this qualification build.

The final `caffeinate -is npm run check` passed: 713 unit/component tests, 63
evaluations, both typechecks, native integration probes, package checks and
lint. Complete first-party MJS line coverage was 83.33%. The two independent
Host receipts and the signed Electron Host receipt use the final dependency
declarations; the 0.2.0-rc.2 package hash matches across both carriers.

### Desktop scheduling management and persisted activation — 2026-10-06

The combined private package now mounts the scheduling service described above.
Delivery defaults to disabled. Explicit activation persists in
`<state>/config/desktop-scheduler.json` and resumes after the Host loader is
ready; explicit stop disables that preference and drains the current owner.
Quitting or unloading only drains this process and retains the preference.
The shared queue lease prevents two owners from delivering the same queue.

The Settings component provides workspace-bound definitions, script-source
controls, pending-job cancellation and global delivery controls. Agent tools
and slash commands use the same management service. Mutations require an
eligible DSCODE session; unattended runs cannot bypass those checks by killing
the shared scheduler's native job. Authenticated RPC resolves workspaces from
live sessions and rejects client-supplied workspace authority. Unloading the
plugin removes its tools from existing Agents and withdraws the RPC route.

`verify-desktop-scheduler.mjs <runtime-directory> --management` passed three
real Host boots on independent 0.2.0-rc.2 and 0.2.1-alpha.1 runtimes. The signed
macOS 0.2.0-rc.2 application's Host also passed through the optional application
argument. These runs exercise approval inside a real Agent turn, cross-workspace
denial, persisted activation, queued work and persistent session recovery,
disabled startup, plugin unload and continued interactive conversation.
Receipts are `artifacts/local/desktop-scheduler-management-<runtime>.json`, with
an additional `-electron` receipt for the signed Host.

The signed Host's four-phase coordinator probe was repeated with the mounted
package and passed, including forced process death, durable recovery, script
process cleanup, native quit/update inspection and shutdown IPC. Its package
SHA-256 matches the management probe:
`200c3d1513da2415fbde1acb4b21a4b9375b2a63b229c9da98099d867b2cf85e`.
These Host probes use scripted model responses and do not operate the renderer.

The complete `caffeinate -is npm run check` passed with 720 unit/component
tests, 63 evaluations, both typechecks, native integration probes, package
checks and lint. Complete first-party MJS line coverage was 82.69%; unloaded
source files count as zero. Component interaction tests cover task creation,
editing, queuing, cancellation and delivery controls. Rendered scheduling and
account-settings interaction remain unqualified: the in-app test browser could
not attach a webview. Windows execution and live-model scheduling quality are
also outside these results.

The expanded native installation probe checks the saved activation preference,
task definition and pending job through upgrade, removal and reinstallation.
Two attempts passed initial installation and activation, then timed out
after 180 seconds during the bundled CLI's upgrade command. pnpm reported the
package replacement complete but did not exit; the observed child still had
network connections. The cause is unresolved, so this attempt does not qualify
the upgraded package's installation lifecycle. The earlier installation receipt
and retained tarball remain evidence for the preceding preset/account package.

### Bundled native dependencies resolve the Desktop upgrade hang — 2026-10-06

The installation timeout above reproduced with a minimal package whose only
dependency was `@deepseek-ai/node-addon-system@0.1.2`. The signed application's
pnpm 11.7.0, with `nodeLinker: hoisted`, installed the first version but failed to
exit after upgrading it. Instrumented requests showed downloads of the three
foreign optional platform archives after pnpm printed completion; after the
requests finished, a worker `MessagePort` still held the process open. A plain
package without that dependency exited normally. Retrying with populated caches
also exited, so a warm-cache install would have missed this regression.

The Desktop package now bundles the unmodified file-lock library and all four
published macOS/Linux ARM64/x64 prebuilds as npm bundled dependencies.
`scripts/desktop-native-bundle.mjs` verifies each archive's SHA-512 against the
repository lockfile before extraction, preserves its license and records its
identity in `runtime-sources.json`. The first build downloads the pinned
archives; the content-addressed local cache makes later builds independent of
the registry. Missing platform entries, version drift and corrupted cache or
download bytes fail the build. `pack-desktop-preset.mjs` also rejects a tarball
that omits any of the five packages. The native install command remains
unchanged, and the signed application is not modified.

The minimal bundled package installed and upgraded successfully, with the
upgrade exiting in approximately 0.35 seconds. Its comparison receipt is
`artifacts/local/desktop-native-packaging-repro.json`. More importantly, the
full signed macOS application's native installation probe passed all six boots:
initialize, installed, upgraded, rejected incompatible update, removed and
reinstalled. All bundled native package identities were present after install.
Saved scheduling activation, the task definition and pending job survived;
enabled delivery resumed after upgrade and reinstallation. The existing
credential, browser-permission, session and deferred-mailbox preservation checks
also passed. Removal withdrew scheduling and account RPCs. The receipt is
`artifacts/local/desktop-install.json`.

The same package passed the signed Desktop Host's four-phase scheduler probe,
including killed-process recovery, script-source cleanup and native
quit/update/shutdown IPC. The new package for independent 0.2.1-alpha.1 passed
all three management boots, including persisted activation and plugin unload.
The 0.2.0-rc.2 installation and coordinator receipts share SHA-256
`8ccf0fcdc1c721b1501eef908a4008881a524082ec0190903e02e0b66ace296b`.
These checks use scripted model responses. Bundling the other architectures
does not qualify their native runtime behavior, and rendered account/scheduling
interaction remains outstanding.

The final `caffeinate -is npm run check` passed with 722 unit/component tests,
63 evaluations, both typechecks, all native integration probes, package checks
and lint. Complete first-party MJS line coverage was 82.69%. Documentation and
whitespace checks also passed. The retained local package
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-8ccf0fcdc1c7.tgz`
matches the successful installation receipt; it remains unpublished.

### Memory attribution across Desktop sessions — 2026-10-06

The memory worker previously read mutable `lastSession` separately for each
model call. Starting B during A's extraction moved A's consolidation charge to
B's ledger. Manual `/memories run` and `note` also omitted the invoking session
ID, leaving a fresh command uncharged or inheriting an unrelated session. A unit
regression reproduced both failures, and a packed native Host probe reproduced
the split charge in persisted cost ledgers before the fix.

A run now captures its owner and a copy of the model route when it starts.
All stages reuse that owner, including stages that begin after the owner closes.
Manual commands pass their caller explicitly. This does not put a session ID
on auxiliary model requests or alter foreground execution.

```bash
node scripts/verify-desktop-memory.mjs .research/browser-desktop-runtime --attribution
node scripts/verify-desktop-memory.mjs .research/desktop-official-runtime '/Volumes/DeepSeek Harness 0.2.0-rc.2-arm64/DeepSeek Harness.app' --attribution
```

Both `0.2.1-alpha.1` and signed Electron `0.2.0-rc.2` Host probes passed. Each
uses real agents, native JSONL history, the packed production memory and metrics
plugins, and a suspended local adapter to interleave two foreground sessions.
The probe reads settled on-disk start/end records, verifies all six memory
calls' usage and recipients, manual run before a foreground request, manual
note after an unrelated session, and consolidation beginning after its owner
was disposed during extraction. Receipts are
`artifacts/local/desktop-memory-attribution-*.json`. No remote model cost,
30-minute timer firing or rendered cost display is qualified by these probes.

The existing three-phase memory lifecycle probe passed on both runtimes. The
full `npm run check` passed with 738 unit/component tests, 63 evaluations, both
typechecks, all nine native integration probes, package checks and lint. Complete
first-party MJS line coverage was 82.28%. The retained package
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-cd4bdc45329d.tgz`
has SHA-256 `cd4bdc45329dbf591ea5af6cb677116cf79a03ee8c5f55ef206e267205f2953d`.
That exact package passed both memory probes and signed Desktop installation,
upgrade, incompatible-update rejection, removal and reinstallation.
`artifacts/local/desktop-memory-attribution-regression.json` joins the receipts,
source fingerprints and verification limits. No package was published.

### Desktop time context — 2026-10-06

The combined package mounts time marks only for DSCODE agents. A step marks
inbox messages that survive downstream admission, excluding injected skill
catalogs and runtime context. Unload also fences callbacks already awaiting
admission. Pending turn endings recover from the native event log after resume
or plugin reload; explicit reported-turn metadata distinguishes arrival-only
bursts from marks that actually consumed an ending. Legacy clock lines remain
readable. Each step and restored ending queue is bounded to eight.

The packed `verify-desktop-time-marks.mjs` probe exercises initial delivery,
relay wait metadata, previous turn duration, process restart, native JSONL
resume, live unload/reload and Standard exclusion. It checks original content
and clock placement in the actual model request. The Host can append runtime
context after the input, so the assertion does not assume the input is the
request's final message. The relay uses a composition timestamp five seconds
in the past; this is not an actual delayed scheduler execution. Inference uses
a deterministic local adapter, not a remote model.

```bash
node scripts/verify-desktop-time-marks.mjs .research/browser-desktop-runtime
node scripts/verify-desktop-time-marks.mjs .research/desktop-official-runtime '/Volumes/DeepSeek Harness 0.2.0-rc.2-arm64/DeepSeek Harness.app'
node scripts/verify-desktop-time-marks.mjs .research/desktop-official-runtime '/Volumes/DeepSeek Harness 0.2.0-rc.2-arm64/DeepSeek Harness.app' --ui
```

The UI fixture uses a disposable profile, no real account credentials and a
loopback-only Host fetch guard. It leaves the signed application's updater
unchanged. Close the fixture with SIGINT or SIGTERM after inspecting it.
Receipts distinguish Host execution from manual renderer interaction. Screenshots
and accessibility captures under `artifacts/local/desktop-time-marks-*` record
normal chat, an expanded relay, and time context in Trajectory. These cover
macOS Desktop 0.2.0-rc.2; Windows rendering and live model interpretation are
not qualified.

Both independent `0.2.1-alpha.1` and signed Electron `0.2.0-rc.2` Host probes
passed all three phases. The final full `npm run check` passed: 737
unit/component tests, 63 evaluations, both typechecks, all nine native
integration probes, package checks and lint. Complete first-party MJS line
coverage was 82.24%. The retained local package is
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-ee8bd54b911f.tgz`
(SHA-256 `ee8bd54b911f249cec5aaace56279ea58358c2d727dd91078cdbee2f865ad297`).
The Host and manual renderer checks used that same package. Signed Desktop
installation, upgrade, incompatible-update rejection, removal and reinstallation
also passed with the exact hash. `artifacts/local/desktop-time-marks-regression.json`
joins these results and source fingerprints. The package remains unpublished.

### Desktop native Computer Use adapter — 2026-10-06

The combined package now vendors `@anionex/dsh-computer-use` 0.3.3's backend,
license, universal macOS 14+ helper and integrity manifest. Build-time staging
verifies the helper SHA-256 and rejects unreviewed versions. Upstream 0.3.3 supplies native Config-derived Settings support, exact-window
screenshot selection and improved multi-display pointer routing. Its provider is
reused directly; the terminal's pinned 0.3.2 integration remains separate. DSCODE owns scoped skill activation and
restores it from the current native `tool/result` format; Standard receives no
Computer Use skill or tools. Screenshot instructions use the Host's `read_image`
capability instead of requiring the unrelated Vision Toolkit.

`verify-desktop-computer-use.mjs` passed two process boots on both independent
`0.2.1-alpha.1` and signed macOS `0.2.0-rc.2` Electron Hosts. It verified the
packaged helper hash and version, app discovery, skill loading through the real
Agent loop, durable native resume, Standard exclusion, app permission denial
when prompts are disabled, live unload and reload into existing agents.

Both tested carriers reported Accessibility **denied** and Screen Recording
**granted**. No application content was observed and no input or screenshot was
performed. This evidence establishes adapter initialization and lifecycle only;
window observation, native input, screenshot-to-model delivery, rendered slash
commands and non-macOS behavior remain unqualified. OS grants were not changed.
The broader Desktop migration remains in progress.

```bash
node scripts/verify-desktop-computer-use.mjs .research/browser-desktop-runtime
node scripts/verify-desktop-computer-use.mjs .research/desktop-official-runtime '/Volumes/DeepSeek Harness 0.2.0-rc.2-arm64/DeepSeek Harness.app'
```

Receipts under `artifacts/local/desktop-computer-use-*.json` record both boot
results, exact package hashes, permission state and the untested action paths.
Unit checks reject mismatched, failed or substituted skill evidence and tampered
native helpers, and verify the packaged screenshot handoff.

The final `caffeinate -is npm run check` passed with 733 unit/component tests,
63 evaluations, both typechecks, all nine native integration probes, package
checks and lint. Complete first-party MJS line coverage was 82.22%. The retained
macOS package is
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-5ba269cf5eb9.tgz`
(SHA-256 `5ba269cf5eb9143a1724b8b8aa29dea7c5c40c6adf8fdb1fa10167c0d22b4d7f`).
That exact package passed the Computer Use Host probe and signed application's
installation, upgrade, incompatible-update rejection, removal and reinstallation
checks. `artifacts/local/desktop-computer-use-regression.json` joins the receipts,
source hashes and outstanding permission/interaction limits.

### Desktop cross-session memory — 2026-10-06

The combined preset now mounts the production memory service. Its Desktop
adapter registers the summary and retrieval tool in each DSCODE agent, including
agents already open when the plugin loads. Native Standard sessions receive
neither and cannot invoke memory mutations through `/memories`.

`verify-desktop-memory.mjs` packs the source and boots three independent Host
processes against one temporary home. It passed on `0.2.1-alpha.1` and the signed
macOS `0.2.0-rc.2` application's Electron Host in Node mode:

- Actual persisted JSONL history produces extraction at low effort and
  consolidation at high effort, with tool-free deterministic inference.
  Standard and child-agent history are excluded.
- Retrieval carries source session IDs and message sequence numbers. Turning
  off the parent also disables its child's memory reading.
- A fresh process resumes the original session, retaining global and session
  switches and previously generated source evidence.
- Disposing the mounted plugin during a blocked model stream aborts the request,
  releases every lease and withdraws prompt/tool registrations from live agents.
  Reloading mounts those existing agents again without exposing Standard.

Run from a normal terminal with Node 24:

```bash
node scripts/verify-desktop-memory.mjs .research/browser-desktop-runtime
node scripts/verify-desktop-memory.mjs .research/desktop-official-runtime '/Volumes/DeepSeek Harness 0.2.0-rc.2-arm64/DeepSeek Harness.app'
```

Receipts under `artifacts/local/desktop-memory-*.json` identify the exact packed
artifact and checks. Inference uses a local fixture provider and the memory
probe does not drive the renderer; this is Host compatibility and lifecycle
qualification, not an assessment of live-model recall quality. Windows and
Linux Desktop application behavior remain unqualified. Unit regression checks
also cover existing/new-agent mounting, rejected Standard mutations, duplicate
creation events and stale references after unload.

The final `caffeinate -is npm run check` passed: 730 unit/component tests,
63 evaluations, both typechecks, all nine native integration probes, package
checks and lint. Complete first-party MJS line coverage was 82.52%. The retained
macOS package is
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-0e3dd70a615b.tgz`
(SHA-256 `0e3dd70a615baa75d108c5210cf4aaf25decac380445cb75cae6ab30d9b78d76`).
That exact artifact passed the memory Host probe and signed application's native
installation, upgrade, incompatible-update rejection, removal and reinstallation
checks. `artifacts/local/desktop-memory-regression.json` joins those receipts.
These checks do not complete migration of the remaining Host services.

### Desktop settings polling and manual-run retries — 2026-10-06

Component tests reproduced three scheduling failures: background polling hid
form validation errors, selecting another session retained the previous source
log, and interleaving manual runs discarded the first task's retry identity.
The account form had the same error-clearing behavior while polling a pending
OpenCode login.

Both forms now retain action errors during background polling and report refresh
failures separately. Scheduling clears source output on explicit session changes
and fallback after a session closes. Manual runs keep a distinct request key per
workspace and task until both queuing and the follow-up refresh succeed. An
unconfirmed attempt shows a Retry button. The key survives interleaved tasks and
workspace/session changes while the component is mounted; reopening settings
does not retain it.

The 20 targeted account, scheduling and composition tests passed. Lost queue
responses and failed post-queue refreshes are separate regression cases, driven
through the real management RPC and SQLite queue. They check that retries from
another session in the same workspace return the existing job, while a task of
the same name in another workspace gets its own job. Polling cases cover outage
and recovery without losing action errors or drafts. These component tests do
not establish rendered application behavior.

Subsequent browser interaction exercised the real shared Web client on
0.2.1-alpha.1. In a disposable profile it saved a synthetic OpenRouter key,
refreshed its status, checked that the input was empty, and removed the key
through the confirmation control. Scheduling interaction created and edited a
task, queued and cancelled a manual job, paused the task, and enabled then
disabled delivery. An invalid interval's error and draft survived background
polling before a valid save. The fixture blocks provider requests outside
loopback; its initial chat turn deliberately had no model credential and failed
before inference. No live-model result is implied by the settings checks.

This exposed a layout defect at a 774-pixel viewport: the long workspace path
made the selector 1184 pixels wide and the 485-pixel section scroll to 1204 pixels.
The form now constrains grid tracks, controls and fieldsets to their available
width. After reloading the changed client, the section's client and scroll widths
both measured 485 pixels and the screenshot showed readable controls without
horizontal clipping. Screenshots and the rendered scheduling snapshot are in
`artifacts/local/desktop-settings-ui/`.

The UI fixture now explicitly overrides `workspace-controller.documentsDirectory`
inside its temporary home. On macOS, setting HOME alone does not isolate the OS
Documents lookup. The first attempt reached the ordinary default workspace but
created no schedule there; the subsequent attempt verified the temporary path
in the selector before creating the task. Native Electron settings interaction,
real account login and visual checks of failure/retry paths remain outside this
browser run.

The final layout package passed the six-boot signed macOS installation lifecycle
again, including upgrade, incompatible-update rejection, removal and
reinstallation with persisted scheduling state. Its retained tarball is
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-70a92cfe4d6e.tgz`,
SHA-256 `70a92cfe4d6e3c7efac573c0ffae599149cf569fc54484bf1c7067988069449d`.
The native installation receipt matches these exact bytes. Native installation
and Host checks remain separate from the shared Web-client interaction above.

After the layout and fixture-isolation changes, `caffeinate -is npm run check`
passed with 727 unit/component tests, 63 evaluations, both typechecks, native
integration probes, package checks and lint. Complete first-party MJS line
coverage was 82.61%, including unloaded files as zero. The shared Web interaction
receipt is `artifacts/local/desktop-settings-ui/verification.json`.

### Native settings interaction and uninterrupted editing — 2026-10-06

The signed macOS Electron application on 0.2.0-rc.2 was driven through its actual
window in a disposable profile. The fixture's Documents override kept the task
definition in its temporary workspace. This run exercised interval validation,
task creation and editing, manual queuing and cancellation, task pausing, delivery
enable/disable, and synthetic OpenRouter key save, status refresh and confirmed
removal. Screenshots and accessibility snapshots are retained under
`artifacts/local/desktop-settings-native-ui/`.

Two interaction failures were reproduced. A failed submit left its error above
the scrolled viewport, and the next background refresh disabled the form and
moved focus out of the user's input. Foreground failures now focus their alert.
Background polling keeps editing enabled and uses the same serialized operation
chain as user actions. A user action arriving during polling waits and runs once
after it settles, including after a refresh failure; further background polls
skip the occupied chain. Only foreground actions disable their controls.

The final native run showed the validation error in the viewport and then kept
the task-instructions input focused for 14 seconds across polling cycles. The
22 focused component/RPC tests passed, including delayed successful and failed
schedule refreshes with an intervening save, an account save during login
polling, and alert focus occurring once rather than on each refresh. The full
`caffeinate -is npm run check` passed with 729 unit/component tests, 63 evaluations,
both typechecks, native integration probes, package checks and lint. Complete
first-party MJS line coverage was 82.52%, counting unloaded files as zero.

The account key was synthetic and removed after testing; provider networking was
restricted to loopback. The fixture chat failed for missing model credentials
before inference. Real account login, visual lost-response retry testing,
Windows interaction and live-model scheduling quality remain unqualified.
The test launcher was stopped after delivery was disabled, and its temporary
home was removed. These results do not complete the remaining Host migration,
including native Computer Use; cross-session memory is qualified separately below.

The resulting package passed native installation, upgrade, incompatible-update
rejection, removal and reinstallation through the signed application's bundled
CLI. The retained package is
`artifacts/desktop/packages/dscode-desktop-0.7.32-dsh-0.2.0-rc.2-529fcd2defd8.tgz`,
SHA-256 `529fcd2defd894685434360b7b1c548eaac95fa95a288cf7ac4236a4abccac70`.
`artifacts/local/desktop-native-settings-regression.json` ties that exact hash to
the installation receipt, full check and native UI source digests. No package was
published and no source changes were committed.

## What cannot run inside a dscode session — 2026-09-17

`verify:hub` (and therefore `make verify`, `make release` and `make publish`), `npm run doctor`, and any other check that boots a real dsh profile and lets it confine a command cannot complete **inside** a running dscode session on macOS. The nested harness applies its own Seatbelt profile, and `sandbox-exec: sandbox_apply` is refused to a process that is already confined, so the probe fails with `sandbox mode "workspace-write" is requested but no sandbox backend is usable on this host`. A companion symptom is that a command allocating a new PTY fails with `posix_openpt: Operation not permitted`: the workspace-write profile grants file writes only to `/dev/null`, the workspace and the platform temp areas, and `/dev/ptmx` is not among them.

Asking for a wider sandbox does not lift this. `danger-full-access` widens the DSH *file policy*, while the OS-level profile that refuses the nested `sandbox_apply` remains in force, and a backgrounded command does not inherit the wider mode at all. Run these from a normal terminal instead: `make verify`, `make release`, `make publish` and `npm run doctor` all complete there, and the release workflow covers the same ground on CI.

These commands can be made to work from a session by configuring DSCODE's own sandbox runner (`plugins/tui-tools/sandbox-runner.mjs`, enabled by copying `config/harness.local.example.yml` to `config/harness.local.yml`). The provider appends a bwrap-compatible profile plus `--` and the command; the runner translates the writable grants into a Seatbelt profile, adds `(allow file-write* (literal "/dev/ptmx"))`, and — inside an already-confined process, where the kernel refuses to apply another profile — inherits the enclosing profile instead of nesting a second one. That addresses both symptoms above: a PTY can be allocated under the session's own shell, and a nested harness starts at all.

The apply path cannot be exercised from inside a session, because applying a profile is exactly what is refused there, so `tests/sandbox-runner.test.mjs` drives it through a shim that records the profile and execs the command, and asserts the PTY grant and the workspace subpath are present. On a normal host, verify the real path with:

```bash
node plugins/tui-tools/sandbox-runner.mjs --ro-bind / / --dev /dev --unshare-pid --proc /proc \
  --die-with-parent --tmpfs /tmp --bind "$PWD" "$PWD" -- /bin/sh -c \
  'node -e "require(\"fs\").openSync(\"/dev/ptmx\",\"r+\")"; echo PTY_OK; touch ~/dscode-should-fail'
```

which must print `PTY_OK` and refuse the home write. The runner is an operator assertion — configuring it skips the provider's functional probes — so its profile stays the built-in one plus the single PTY grant, with no other relaxation. A non-zero exit whose stderr matches the configured signature is reported as a sandbox failure rather than a failed command, so the signature names only the runner fatal: lines and the inheriting notice deliberately cannot match it.

Everything that does not spawn a nested confined harness still runs inside a session: `npm run check` (lint, coverage, integration probes, package checks and eval), `npm run test:unit`, `npm run test:coverage`, `npm run test:integration`, `npm run test:package` and `npm run test:eval`. To publish from here, push the `v<version>` tag — the release workflow carries the npm and Hub credentials (for 0.7.15 it built, verified and published from `v0.7.15`).

## The Linux container

`npm run test:e2e` builds `docker/e2e.Dockerfile` and runs seven steps inside it: the
provisioned runtime, the unit suite, the native Harness probes, the packaged tarballs, the
publishable bundle, the Hub release metadata, and `verify:hub` (install the bundle into a
profile, boot it, fail an upgrade, roll back). The `Linux e2e` workflow runs the same image on every
pull request and on pushes to `main`, with a weekly run as a backstop; `main` is protected
with that job required alongside `Checks`. The first Linux run found four real things: the
unit suite read `/private/tmp` and assumed a Seatbelt runner (both fixed to be
platform-correct), the installed profile asserted a Computer Use consumer that only macOS
mounts, and the exec probe — whose terminal-blocking branch is skipped inside a session —
settles a command that only terminal input could finish in about 93 s on Linux, because the
stdin inspector that settles it immediately is macOS-only. The probe records that
difference as `EXEC_PROBE_NOTE` instead of asserting the macOS text, while it still fails
if the turn never ends.

It exists because two things the macOS gate cannot reach matter. `verify:hub` needs a
nested sandbox the session refuses, so it only ever ran on a developer machine or the
macOS CI runner; and nothing exercised Linux at all. The first Linux run found four real
things: the unit suite read `/private/tmp` and assumed a Seatbelt runner (both fixed to be
platform-correct), and the exec probe — whose terminal-blocking branch is skipped inside a
session — settles a command that only terminal input could finish in about 93 s on Linux,
because the stdin inspector that settles it immediately is macOS-only. The probe now
records that difference as `EXEC_PROBE_NOTE` instead of asserting the macOS text, while it
still fails if the turn never ends. Computer Use and the Seatbelt runner stay
macOS-only by construction and the probes say so rather than failing.

## Upstream 0.1.7-alpha.2 (2026-09-22)

The runtime pin moved from `0.1.5-rc.2` to `0.1.7-alpha.2`. What was verified on the new
tree, on macOS: `npm run lint`, both typechecks, `npm run test:coverage` (543 unit tests,
83.34% measured `.mjs` line coverage), `npm run test:integration` (all nine probes),
`npm run test:package` and `npm run test:eval` (51 evaluations). The nine pinned runtime
patches were additionally applied twice each and the results parsed, which is how the three
anchors that drifted were found. The upgrade's own regressions were all caught by those
probes rather than by reading upstream diffs: the reserved `auto` preset name, the retired
`agent/session-start` event, session format v4 refusing the shared `plugin` source kind,
the absent shipped preset rows, and `@anionex/dsh-computer-use` calling a settings method
that no longer exists.

`npm run doctor` was also run from a normal terminal on the upgraded tree and passed: a real
profile boot composing both the shipped `standard` preset and DSCODE's own, 51 tools with
scoped Chrome MCP discovery, skill activation, file editing, shell execution, the compaction
provider, a nonempty session resume, the auto-review allow/deny/human path with its audit,
child worktrees and effort selection, manual compaction, and the native Computer Use helper
reporting `ready: true`. It also recorded one limitation as a probe note: the pinned
`@anionex/dsh-computer-use` 0.3.2 reads the pre-0.1.7 tool-result shape when restoring its
execution tools on resume, so a resumed session needs the skill loaded again; live activation
is unaffected.

`npm run verify:hub` passed as well, and found one more instance of the same preset gap: the
installed profile declares only DSCODE's preset, so the agent probe's `standard` mount failed
until the verification overlay declared it from the `dsh-web-app` copy the installation
carries. It then covered the native locked install, launcher first start, Hub doctor, the
installed bundle's agent loop, messaging, cards and memory probes, and a failed upgrade with
rollback. Both `npm run doctor` and `npm run verify:hub` completed inside this Claude Code
session on macOS; the nested-sandbox refusal above applies to a dscode session, not to every
agent session.

Not covered here: no interactive TUI session was driven by hand; no live provider request was
made, so the DeepSeek Messages changes rest on fixture streams; and no desktop action was
driven through Computer Use.

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
- Agent-scoped compaction service and `/compact` command mounted; the policy is DSCODE's `plugins/compaction/engine.mjs`, a `BasicCompactionEngine` subclass, with the durable surface transaction left upstream.
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
- No custom agent engine or replacement compaction transaction is introduced; DSCODE subclasses the upstream compaction engine for trigger policy, prefetch and overflow recovery only. The later browser extension transport is covered separately above.
# Auto review incremental verification

A separate reviewer plugin was added; a real agent integration test covers an allow, a denial, an invalid model output turning into a hand-to-human, usage and session resume. The test registers one extra MCP tool for testing only, so doctor shows 58 tools while a normal installation still has 57. The detailed boundaries are in [auto-review.md](auto-review.md). A remote review model has not been measured.

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
