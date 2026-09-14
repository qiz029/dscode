# Changelog

All notable changes to DSCODE, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions match the npm launcher and the Hub profile.

Per-release notes in Chinese live in [`docs/releases/`](releases/); the entries below summarise them.

<!-- Add upcoming changes under Unreleased. -->

## [Unreleased]

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

[Unreleased]: https://github.com/qiz029/dscode/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/qiz029/dscode/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/qiz029/dscode/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/qiz029/dscode/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/qiz029/dscode/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/qiz029/dscode/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/qiz029/dscode/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/qiz029/dscode/releases/tag/v0.1.0
