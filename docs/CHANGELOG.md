# Changelog

All notable changes to DSCODE, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions match the npm launcher and the Hub profile.

Per-release notes in Chinese live in [`docs/releases/`](releases/); the entries below summarise them.

<!-- Add upcoming changes under Unreleased. -->

## [Unreleased]

<!-- Add upcoming changes here. -->

### Changed

- The review guidance and the `review` tool work outside a Git repository. Before a task's first tool call, dscode snapshots the workspace as a tree in a shadow bare repository under `DSH_HOME/review-baselines` (the workspace is never touched), and review diffs that baseline against a fresh snapshot; `path` narrows it, while `staged`, `base` and `commit` still need Git. Snapshots skip `.git`, `node_modules`, virtualenv and cache directories, the same sensitive files review already skips and files over 4 MiB, and a workspace with more than 20,000 files or 256 MiB returns `no_baseline` instead. The baseline is a ref per session, so it survives a resume, and a new task replaces it. Without a git executable there is no guidance and review still returns `no_repository`.

## [0.7.4] - 2026-09-14

### Fixed

- MCP calls work under `danger-full-access` again. Auto review turned every MCP call other than the Chrome read methods into an ask whatever the preset, and under the `never` approval policy the approval service rejects an ask before any `approval/request` handler runs, so the TUI rejected MCP silently and `dscode exec --approve-all` never got to allow it. The gate now stands down under `never`; presets on the `ask` policy still review or ask for MCP calls.

## [0.7.3] - 2026-09-14

### Added

- `/provider [deepseek|openrouter]` switches the session between DeepSeek's official API and OpenRouter; without an argument it opens a picker with each provider's key status. The first OpenRouter switch declares the pi-ai `openrouter` route in the settings document with DeepSeek V4 Flash, V4 Pro and V4 Flash Vision Exp (a profile the user already has is left alone), asks for a missing key and resumes, then lands on the counterpart of the current model with the same effort when the target offers it. The provider catalog ships beside the TUI as `lib/dscode-providers`, so the repository install and the vendored bundle load it the same way.
- Ultra works on OpenRouter. The pi-ai adapter is patched like the DeepSeek one (`dscode-pi-ai-ultra-v1`) and vendored into the bundle: a model that offers max also offers Ultra, which sends max (`xhigh` on OpenRouter) with the collaboration policy, and delegation tools are withheld below Ultra. The OpenRouter route offers the official off/low/high/max detents, sending `low` as `high` the way DeepSeek answers it, so session cards and delegated children that ask for low keep working, and `/effort` keeps the detent bar.

### Changed

- `/login [deepseek|openrouter]` stores either key; without an argument it targets the current provider. `OPENROUTER_API_KEY` joins `DEEPSEEK_API_KEY` in the shared `~/.dscode/credentials.yaml`, with the same environment precedence. An argument that is not a provider name is refused without being echoed.
- The footer follows the active provider: its balance is that provider's (OpenRouter: credits minus usage from `/api/v1/credits`), OpenRouter calls are estimated from the pinned pi-ai catalog's list prices (ledger `priceVersion` `openrouter-pi-ai-0.85.1`), and the 🔥/❄️ peak marker shows only for DeepSeek. `/status` names the wire effort Ultra sends on each route, and a missing-credential error now points at `/login`.

- `dscode exec` ships in the npm launcher. It runs the installed profile's exec runner with the same options, stdin prompt and exit codes as the source checkout; the argument parser and overlay moved to `plugins/exec/cli.mjs` so both entry points share them.

### Fixed

- The session cost ledger now times every model call. The `end` row kept the start `time`, so a call's duration always read as zero; it now also carries `endTime` and `firstTokenTime` (first text, reasoning or tool-argument delta), while `time` stays the start that prices the call.
- Model calls made for a session without a request `sessionId` — the review tool and `/review`, memory extraction and consolidation, session cards and `/doctor` — now reach that session's ledger with their own `purpose`. They are charged through an async context instead of a wire `sessionId`, which would also trigger session-log delivery, provider cache affinity and agent-only prompt shaping. Compaction and session titles already carried one.
- The review tool no longer skips work that was committed or merged. With nothing uncommitted, the default scope reviews the commits made since the latest user task started (HEAD from the reflog), and a `commit` review of a merge commit diffs against its first parent instead of printing an empty combined diff.
- `/effort` found no catalog row for a model id that carries its own vendor segment (`openrouter/deepseek/deepseek-v4-flash`): the TUI split the label at every slash. It now splits at the first.

## [0.7.2] - 2026-09-14

### Added

- GitHub Actions releases the verified packages. `.github/workflows/release.yml` builds the candidates on every `v*` tag (checks, `build:packages`, `release:hub`, `verify:hub`), uploads them, and publishes through a `release` environment gate in the documented order — bundle, Hub profile, launcher — using the `NPM_PUBLISH_TOKEN` and `DSH_HUB_TOKEN` secrets. A manual dispatch without the publish flag is a dry run, a dispatch with `verify_credentials` checks both tokens read-only (npm identity, Hub profile read, and whether the version is still free on npm) and stops, and a tag that disagrees with `package.json` fails before anything is published.

### Changed

- The TUI hands the terminal back its own scrolling, selection and copy. The 0.7.x in-place viewport drew a full-screen frame, wiped the terminal scrollback and had to capture the mouse to make the wheel work; now the settled transcript is printed once through Ink's Static output, so it lands in the terminal's scrollback and the wheel, drag-selection and copy stay native. `PageUp`/`PageDown` in-app scrolling and the `/mouse` command are gone with it. The welcome box is now the first scrollback row and scrolls away with the session; the per-turn rule rides each finished entry. Installs still carrying the in-place generation must refresh their dependencies (`npm ci`) — the launcher refuses to patch that text in place.

### Fixed

- The CI checks stopped flaking. The session-messaging fixture allowed three seconds for a whole second-Host handshake (and killed its child after twenty), which a loaded runner can miss, so its poll now runs for fifteen seconds under a sixty-second guard and names the wait that expired; the launcher lifecycle fixture reported its stub runtime ready before the stub could take `SIGTERM`, so a signal that arrived in between made the launcher report a failed stop. The login runtime fixture now accepts Node's unsettled-top-level-await exit code (13) when its marker is present: a one-shot Host whose work finishes fast can drain its event loop before `dsh`'s dispose settles, which Node reports as 13 even though the plugin asked for 0.

- On macOS a command that waits for terminal input no longer freezes the turn until the 300 second deadline. The pinned inspector reports "input waiting" by reading the process table (`ps`) on a throttle — the foreground group of the shell's terminal must be asleep with its CPU time frozen and hold no socket — and the persistent shell interrupts such a command after five seconds of silence, reporting the exit status and why. Linux keeps its precise `/proc` syscall probe; macOS has no wait channel to read (`ps -o wchan` prints `-`), so a silent command that is only sleeping in a timer or disk wait can be interrupted too. This patch reaches the repository install; the npm/Hub bundle still installs the registry copy of the inspector, because a published package cannot depend on a path inside its own tarball (pnpm resolves `file:` against the profile root, which broke every Hub install in testing). Bundle users therefore keep the "not waiting" answer until the probe moves into a package the bundle already vendors — the follow-up is to do the process-table check in `dsh-terminal-bash`, which DSCODE already vendors and patches.

### Changed

- The transcript breathes: every finished turn draws one blank line above and below its separator rule, and each user message is followed by one blank line. A turn's rule and its blanks land together, so a viewport with no room for the three rows still shows the answer instead of the rule.
- The footer is two rows: row 1 is `● <session title> ｜ <permission>` (falling back to `model ｜ effort` until the session has a title) with the cycle hint still pinned right, and row 2 leads with `provider: model @ effort` followed by the telemetry — `current | average | context | $spend / $balance 🔥 | cache hit`. A row that runs out of width sheds its quietest figures first (average, cache hit, current), then falls back to the bare `model @ effort` header, then drops context, and only then the header itself: the running cost is the last thing standing. The footer now follows the interface language (`/language`) as well; it was pinned to English before.

- Verbose streams the live thinking text again. While the model reasons, the reasoning tail types out in the live area (taking the rows the streaming answer uses, and handing them over as soon as the answer starts); before this the tail was disabled, so thinking only arrived as one finished block per step.

## [0.7.1] - 2026-09-14

### Added

- `docs/CHANGELOG.md` records every release from 0.1.0 on, and the repository README is now English with `README.zh-CN.md` as its Chinese counterpart.

### Fixed

- Wheel scrolling works out of the box again. 0.7.0 turned mouse capture off by default, but the pinned viewport renders in place and clears the terminal scrollback, so with capture off the wheel produced no events anywhere and did nothing until `/mouse` enabled it. Capture now defaults to on, and `/mouse` still releases it for direct selection.

### Changed

- A wheel notch scrolls one row instead of three, and the notches that arrive in the same 16 ms frame are merged into a single render, so trackpad scrolling is smoother without dropping events.
- The `/mouse` hint names Shift first, alongside Option (iTerm2) and Fn (Terminal.app).

## [0.7.0] - 2026-09-13

Interface languages, copyable text, a verbose view, accurate TPS figures, and steadier review.

### Added

- `/language` switches the interface between English, Simplified Chinese, Traditional Chinese, Japanese, Korean and Spanish. The choice is stored in `~/.dsh/dsh-code/language.json`, with `DSCODE_LANGUAGE` as a temporary override. The activity line, agents line, welcome box labels, footer telemetry labels, input placeholders, hints and the doctor report are all translated.
- `/verbose` (Ctrl/Alt+R) shows each step's `· Thinking:`, `· Tool Call:` and `Output:` in a dim style, with up to 8 lines of thinking and a pointer to Ctrl+O for the full history. The toggle is persisted.
- npm publish tokens can be kept in the macOS keychain via `pbpaste | npm run publish:token store`.

### Changed

- Mouse capture is off by default, so terminal text selection works out of the box; PageUp/PageDown scroll the conversation and `/mouse` restores wheel scrolling. The setting is stored locally.
- The conversation area no longer reserves a third of the screen for history while the agent works: live content takes only the lines it needs. The busy line is a two-dot comet orbiting a breathing snowflake, and the welcome box snowflakes ripple outward, following `/animation`.
- The footer's `current` TPS is measured over the generation time the window actually covers and calibrated with settled `outputTokens`, so the first second after a tool call is already accurate; `average` is output tokens ÷ total LLM call time, excluding tool execution and idle time. TPS colouring recognises labels in any language.
- Review requests no longer count toward live TPS.
- The dsh-hub CLI is upgraded to 0.3.0, and profile publishing calls the Hub sync endpoint so npm packages sync immediately.

### Fixed

- The `review` tool returns `no_repository` outside a Git workspace and no longer injects review guidance; a model turn ending for a non-stop reason is retried once and then reports the provider's reason; hitting the output limit returns partial instead of failing, with the limit raised to 8192.

## [0.6.0] - 2026-09-13

Unattended runs, readable sub-agent identities, and release ergonomics.

### Added

- `dscode exec` runs one full dscode agent turn without the TUI, using the same preset, tools, skills, MCP and memory: the reply streams to stdout, tool activity and the session id go to stderr, and the exit code reflects the turn's outcome. It supports stdin prompts, `--json`, `--resume`, `--effort`, `--model`, `--permission`, `--approve-all` and `--timeout`. Approval requests that fall back to a human are denied by default when nobody is present.
- Parent agents must name every child (1–10 characters, letters, digits or underscores, starting and ending with a letter). Children appear as `/name · description` in the agents line and `/agents`; `send_message` and `interrupt_agent` accept `/name`; children refer to the parent as `/`; live children of one parent cannot share a name.

### Changed

- The welcome box uses three colour bands of pixel snowflakes (24×24 on terminals of 26+ rows, 22×22 on 24–25 rows), the activity line is a snowflake orbit while the agent works, and turn dividers span the full width.
- Prompt tuning: persona guidance now covers reply language, judgement and question boundaries, complete delivery and honest reporting; the shell policy keeps only the delegation summary while details stay in the Ultra request policy; email guidance no longer embeds real contacts.
- Release scripts read a granular npm token from the macOS keychain and pass it through a one-off temporary config, avoiding login and captcha; `npm run publish:token store|check|remove` manages the token.

## [0.5.0] - 2026-09-13

Collaboration boundaries, code review, and terminal interaction.

### Added

- Ultra's main agent can pass `worktree: true` to `subagent` or `subagent_fork`, giving children that need to edit their own checkout created from a clean Git `HEAD`. Sharing the directory stays the default, isolation is refused when the main workspace has uncommitted changes, and children can no longer delegate further.
- `/review` and the agent's `review` tool ask an independent, read-only model to review a chosen Git diff. After a code change passes its relevant checks, the agent reviews once before ending the turn and fixes concrete findings first. Scopes cover the staging area, a base branch, a single commit and a path; the same diff reuses its previous review.

### Changed

- TUI: scroll back through history; the first Ctrl+C interrupts the agent immediately and a second one exits; a long paste collapses to a marker in the input and expands in full after submitting; pasted images show `[Image 1]`-style markers and multiple images are supported; user messages get their own background and turn dividers separate rounds.
- DeepSeek Flash's ordinary agent requests get short, task-proportional guidance: answer simple questions directly, and finish a bounded code change with its relevant checks. The low, high and max levels do not start sub-agents; only Ultra can start or wake them.

## [0.4.0] - 2026-09-12

An agent email system that feeds extra context into the running coding task.

### Added

- `/email` shows a local inbox shared by all sessions, sorted by update time, with Chinese preview support and a narrow-window layout.
- Gmail app-password connections receive new mail whose subject starts with `[ToAgent]` after the first successful connection; an optional OAuth interface is retained.
- Pressing Enter on a selected message injects it into the current session, whether idle or running. The JSON shape marks it as chosen by the user and as supplementary context only.
- `send_email` sends plain text over Gmail SMTP, adds `[ToAgent]` automatically, reuses the existing approval flow and local credentials, and records send results to prevent duplicate delivery.
- Contact aliases are shared across sessions and can be managed by the agent or by `dscode email alias`; approval shows the real address behind an alias.

## [0.3.0] - 2026-09-12

Login, terminal interaction and runtime improvements.

### Added

- `/login` saves a local DeepSeek key through a hidden input, loading it at startup and reloading it for the current session; environment variables take precedence.
- An effort horizontal bar with Ultra animation, and a welcome box showing version, model and project path.

### Changed

- The input area is pinned to the bottom of the terminal with an in-screen viewport for long conversations; the full content stays viewable or exportable.
- A blank launch shows the input box first, and Chrome MCP connects when the agent session is created.
- Startup and version-management locks and session message handling are strengthened; the compaction evaluation tooling and an isolated test flow are added.

### Fixed

- `apply_patch` path handling inside Git subdirectories.

## [0.2.0] - 2026-09-11

One session runtime shared by the TUI, the CLI, scripts and other agents.

### Added

- Session communication: built-in `list_sessions`, `read_session`, `send_session` and `reply_session`, with queue / steer / defer delivery, a persisted mailbox, retry de-duplication, cancellation and a finite communication budget. Only loaded root sessions in the same state directory are reachable; offline sessions are never started automatically.
- Descriptive session cards: project, workspace and recent user topics, with no task conclusions.
- Global memory: background extraction, organisation, retrieval and source tracing, with global and per-session switches. Extraction spends extra model calls.
- Input and resume: `!` shell commands, Shift+Enter for a newline, `dscode resume`, an exit resume hint, and Chinese IME cursor placement.
- TUI: compact header, unified run state, sub-agent activity overview, and dimmed cost, context and cache metrics; thinking and tool-call history are hidden by default.
- Ultra keeps native `max` reasoning and delegates as the task needs, and the parent agent can choose a separate effort for each child.
- Compatibility: the recommended Harness combination is pinned, and the npm launcher warns (then continues) on other combinations.

## [0.1.0] - 2026-09-11

Initial public release: the npm launcher and Hub profile installation for the DSCODE harness.

[Unreleased]: https://github.com/qiz029/dscode/compare/v0.7.1...HEAD
[0.7.1]: https://github.com/qiz029/dscode/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/qiz029/dscode/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/qiz029/dscode/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/qiz029/dscode/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/qiz029/dscode/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/qiz029/dscode/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/qiz029/dscode/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/qiz029/dscode/releases/tag/v0.1.0
