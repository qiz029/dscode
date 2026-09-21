# dscode TUI commands

Restart `dscode` to load these commands. Most commands run locally; `/doctor` makes one bounded call to the selected model for analysis. At startup the TUI reads the npm registry once, within eight seconds, and shows a notice when a newer release exists; set `DSCODE_UPDATE_CHECK=off` to skip that check.

| Command | Behavior |
| --- | --- |
| `/email` | `i`: connect IMAP with a masked application password; `r`: sync. Browse, preview, and press Enter to steer email directly into this session. [Email interface](email.md). |
| `/status` | Session ID, workspace, model route, permission mode, recorded token totals/context pressure, tool/plugin counts. Unknown usage stays unknown. `/review-usage` reports the independent reviewer separately. |
| `/provider [deepseek\|openrouter]` | Switch the session between DeepSeek's official API and OpenRouter. Without an argument, open a picker (↑↓ choose, Enter switch, Esc close) that shows each provider's key status. OpenRouter is DSCODE's own adapter over OpenRouter's live model listing (cached for a day in `$DSH_HOME/openrouter-models.json`, settings in the `llm-openrouter` section); a switch asks for the key when none is stored, then moves to the counterpart of the current model and keeps the effort when the target offers it. When the new model would compact the current context, the switch asks first. Ultra works on both routes: on OpenRouter it sends `xhigh` plus the collaboration policy, and `low` is sent as `high`, which is how DeepSeek itself answers low. The footer shows the active provider's remaining balance (for OpenRouter, the account's remaining credits, or the key's own remaining limit when OpenRouter refuses the key those) and records the cost OpenRouter reports for each call (estimated from list prices only when it reports none); the 🔥/❄️ peak marker appears only for DeepSeek, because OpenRouter bills no peak window. Stop a running turn first. |
| `/model` | Picker for the session's current provider only, listed alphabetically by the displayed model name (digits compare naturally, so GLM 5.2 precedes GLM 5.3). Typing searches as you type (BM25 over model name, id and provider; the word being typed matches prefixes) and narrows the list without re-ranking it; Enter focuses the first match, a second Enter selects it, Esc clears the search then closes, Tab opens the provider picker. |
| `/openrouter` | OpenRouter account panel: the account balance, this key's limit and its spend today, this week and this month; with a management key, also every API key's usage and the last 30 days of spend by model and serving provider. `r` refreshes, `m` sets the management key (checked against OpenRouter, stored in `~/.dscode/credentials.yaml`, read-only use; `OPENROUTER_MANAGEMENT_KEY` also works). Saving the OpenRouter API key through `/provider openrouter` or `/login openrouter` offers the management key as an optional step. |
| `/review` | Independent review of the current changes. `DSCODE_REVIEW_MODEL=provider/model` pins the reviewer to its own model and `DSCODE_REVIEW_EFFORT=<level>` sets its reasoning level, so a small session model cannot cap the review; the budget leaves room for reasoning plus the report. |
| `/update [exact-version]` | Upgrade DSCODE after this session exits: the TUI starts a detached helper that waits for the session to end and then runs the same `dscode update` entry (npm/Hub launcher, or tar/source self-update). Progress and the outcome are written to `$DSH_HOME/update.log` and `$DSH_HOME/update-result.json`. |
| `/login [deepseek\|openrouter]` | Paste an API key into the private input; it is saved to `~/.dscode/credentials.yaml` (`0600`, shared across projects and installed versions). Without an argument it targets the current provider. `DEEPSEEK_API_KEY` or `OPENROUTER_API_KEY` in the environment takes precedence and makes that key read-only here. |
| `/memories [status\|on\|off\|global-on\|global-off\|run\|note <text>\|clear]` | Global cross-session memory controls and background model usage. [Behavior and configuration](memory.md). |
| `/session` | Current session ID, local socket, and external send/read/watch commands. [Multi-source sessions](session-bridge.md). |
| `/mailbox [cancel MESSAGE_ID]` | Read messages and deferred notes, or cancel a request/message. [Session communication](session-communication.md). |
| `/session-new-task` | Explicitly start a fresh communication budget while idle; ordinary continuation and resume retain their existing budgets. |
| `/goal [<objective>\|clear\|edit <objective>\|pause\|resume]` | Show or control this session's goal: one objective plus the round cap that bounds automatic continuation. `/goal[20] <objective>` creates the goal with a 20-round cap, and `/goal[20]` re-caps the current goal — so an unattended task stops after the rounds you allowed instead of running indefinitely. A cap with no goal, or a control word after a cap, is refused with the usage. |
| `/triggers [list\|show <id>\|runs <id>\|events <id>]` | List the trigger definitions this machine and the current project carry — `<state>/triggers/*.yml` and `<workspace>/.dsh/triggers/*.yml`, where a project file wins on the same id — with each one's last outcome, or print one definition, its recent run records, or the events waiting in its spool. Definitions, posted events and recorded outcomes only; runs are started from the command line — `dscode trigger run <id>`, `fire <id> --text "..."`, `install <id>` to schedule it, `log --failed` for what did not complete. [Trigger design](triggers-design.md). |
| `/doctor [local\|preview]` | Read-only runtime health plus self-diagnosis from recent warning/error logs and session event traces for this workspace. By default, sends bounded, redacted event metadata to the selected model. `local` skips the model; `preview` shows the exact evidence payload. Does not read conversation text, tool arguments, or tool output. Falls back to local findings if model analysis fails. |
| `/mcp` | List MCP entry IDs, loader state and transport; credentials, headers and environment values are not printed. |
| `/mcp tools <id>` | List registered tools for a server. |
| `/mcp enable|disable|reconnect <id>` | Change a server for this process. All agents must be idle. Reconnect disposes and remounts the server. Host servers are configured in `config/mcp.local.yml`; the dscode preset mounts none. IDs may be full loader IDs or an unambiguous short ID. |
| `/skills` | Effective skill catalog, source, provider and invocation permissions. |
| `/skills <name>` | Description and effective file path, without injecting its instructions into the model. |
| `/skills conflicts` | Duplicate names in the configured filesystem roots, with the runtime's effective source. Hidden candidates from runtime/remote providers are not enumerable. |
| `/hooks` | Hook configuration location, the merged layer list and supported events. It also reports a layer whose file changed — or disappeared — after the merge, because only a restart re-reads the layers. |
| `/hooks reload|enable|disable` | Reload installation-owned hook configuration, or switch hooks for this process while all agents are idle. |
| `/review [--staged\|--base REF\|--commit REF] [--path RELATIVE_PATH]` | Independently review the selected Git diff in a read-only, tool-free model request. Default includes tracked and untracked uncommitted changes, and when there are none it reviews the commits made since the latest user task started (read from the HEAD reflog), so work that was committed or merged is still reviewed; `--commit` reviews a merge commit against its first parent; empty scopes do not call the model. Narrow large or unrelated diffs with `--path`. |
| `/verbose` | Toggle verbose chat: thinking and tool calls appear dimmed as `· Thinking: …`, `· Tool Call: name args` and `  Output: …` (thinking capped at eight lines), with a blank line between blocks. The setting is saved per machine in `~/.dsh/dsh-code/verbose.json`. Ctrl/Alt+R toggles the same setting; Ctrl+O still opens the full history inspector. |
| `/mouse` | Toggle mouse capture. On (default) makes the wheel scroll the chat one row per notch, merging the notches that arrive in the same frame; off hands the mouse back to the terminal for drag-select and copy, leaving PageUp/PageDown to scroll the chat. While capture is on, hold Shift (Option in iTerm2, Fn in Terminal.app) to select text. The choice is saved per machine in `~/.dsh/dsh-code/mouse.json`. |
| `/language [code]` | Without an argument, open a picker (↑↓ choose, enter apply, esc close) for the interface language for DSCODE's own labels, notices, the status-line telemetry labels and the composer placeholder: `en` (default), `zh-CN`, `zh-TW`, `ja`, `ko`, `es`. Names and common aliases work too (`简体中文`, `jp`). The choice is saved per machine in `~/.dsh/dsh-code/language.json`; `DSCODE_LANGUAGE` overrides it for one process. |
| `/clear` | Start a fresh session and clear the screen after successful activation; the previous session remains available through `/resume`. Stop a running turn first. |
| Ctrl+L | Clear the screen only, keeping the conversation context. |
| Ctrl+C | While an agent runs, cancel it immediately; a second press exits the TUI without waiting for the busy display to settle. With an idle draft, the first press clears it and the second exits. |

Command results use the standard collapsible TUI result presentation.

Normal mode shows the agent's ordinary text, including progress updates. The agent is instructed to explain its first step, report significant findings or blockers, and give brief updates roughly every minute during sustained work when it has control. This is model guidance, not a timer: a blocking tool call may delay an update until it returns. `/verbose` additionally shows reasoning and tool details; it is not required for progress updates.

The agent also has a `review` tool backed by the same service. Automatic review allows **two passes per direct user task**, including failed passes; a changed path or scope does not reset the allowance. The first pass follows code changes and relevant checks. A second pass verifies confirmed findings and direct regressions from their fixes, rather than opening another audit. Recorded results preserve the allowance when resuming a session; unchanged diff+task+provider+model requests reuse cached reports. Concurrent calls do not start additional reviews. Each pass asks for thinking off (a model without that level keeps its own default), at most **32,768 output tokens per model attempt** (65,536 on the one retry that spent its whole budget without writing anything), and a **90-second deadline** including that retry. An explicit idle `/review` command can request an additional manual pass without resetting the automatic allowance.

The reviewer sees the latest direct user task and at most 160 KiB of selected diff, with common secret formats redacted; it cannot inspect surrounding files, run tests or edit code. It reports at most five concrete defects affecting the task. Findings must be checked against the actual code before edits. Timeouts, truncated output, omitted files and exhausted budgets are incomplete reviews, never clean results. The agent should complete necessary fixes and affected checks, then report remaining gaps instead of repeatedly calling review.

Task completion guidance keeps scope and acceptance checks stable. Once requested behavior and required checks pass, the agent proceeds to delivery; optional refactors and optimizations are separate follow-ups. Changes invalidate only the checks they affect unless evidence requires broader verification. This guidance reduces unnecessary work, but does not mechanically prove that arbitrary shell commands or agent decisions satisfy the task.

`dscode doctor` runs the same diagnostic collector and model analysis without opening the TUI. It checks the current working directory's recent sessions, including subagents, and reads the owner-only `diagnostics/runtime.jsonl` warning/error journal under `DSH_HOME`. `--local` skips the model; `--preview` shows the exact evidence payload. A model call is limited to 45 seconds; missing credentials or model failure leave a local trace summary. These commands diagnose existing evidence and do not execute tools or repair state. `npm run doctor` remains the separate deterministic integration fixture.

## Hooks

`npm run setup` creates `config/hooks.local.json` containing `{"hooks":{}}`. No hook commands run by default. This file is local to the installation, ignored by git, and excluded from distributable archives. Project `.codex/hooks.json`, `.dsh/hooks.json` and `.claude/settings.json` are layered on top by default; set `DSCODE_PROJECT_HOOKS=0` to load `config/hooks.local.json` alone.

The pinned bridge reads one file for the whole process, so the layers are merged — installation, then `.codex/hooks.json`, `.dsh/hooks.json` and `.claude/settings.json` (its top-level `hooks`) — into `$DSH_HOME/hooks.resolved.json` (mode 0600), and a sibling `hooks.resolved.report.json` report records the layers and any event this bridge cannot run; `/hooks` prints both. A project file is report-only: an event this bridge cannot run, or a gate it cannot load, is skipped and listed with its reason, while `config/hooks.local.json` still fails startup on anything it cannot run. The merged file is rewritten at startup, so an edit to any layer needs a restart rather than `/hooks reload`. Matchers stay regular expressions, so a Claude Code matcher such as `Bash` does not match dscode's `bash` tool — write `^bash$`. These layers run as your OS user outside tool approval, so set `DSCODE_PROJECT_HOOKS=0` on a repository you do not trust.

Edit this file with trusted commands, then `/hooks reload` (or restart). Example:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "^bash$",
      "hooks": [{
        "type": "command",
        "command": "/absolute/path/to/your-tool-gate",
        "timeout": 5
      }]
    }]
  }
}
```

Hook stdin is a JSON event payload; for shell tools it includes `tool_input.command`. Exit code 2 with a stderr reason blocks the tool. Successful hooks may return the upstream Codex-compatible JSON output. These are host shell commands, running in the session workspace as the OS user, outside the model's tool-approval flow. They can use local CLI credentials; configure them with the same care as local shell scripts. This is not a security sandbox for untrusted project hooks.

The pinned official `@deepseek-ai/dsh-hooks-codex` bridge supports:

- `SessionStart`: attach context; asynchronous delivery may miss the first request.
- `UserPromptSubmit`: block a prompt or add context.
- `PreToolUse`: deny a tool; cannot grant approval or rewrite arguments.
- `PostToolUse`: add context or feedback.
- `Stop`: request continuation. The hook must self-limit to avoid a continuation loop.

`PermissionRequest`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, async hooks and non-command hooks are not supported. dscode validates these at startup/reload so unsupported gates do not silently load. The default timeout is 10 seconds; explicit hook timeouts may be up to 600 seconds. Hook execution failures otherwise follow the upstream bridge's fail-open behavior. Non-shell tool inputs are reduced to `{command: ""}` by this bridge. Model and permission-mode fields are upstream static placeholders, not authoritative runtime status. Native `hook/invoked` and `hook/result` events remain resumable.

## Skills and workspace instructions

Skills come from the runtime's filesystem provider: the project's `.dsh/skills` and `.agents/skills` (project root is the nearest ancestor containing `.git`), then custom roots, then the user roots under `$DSH_HOME` and `$DSH_AGENTS_HOME`. Ancestor discovery is on by default: `.dsh/skills`, `.agents/skills` and `.claude/skills` from every directory between the working directory and home register at rank 300, nearest first; `DSCODE_SKILL_ANCESTORS=0` (also `off`/`false`/`no`) turns that off, and it belongs in the environment (the installation's `.env`) rather than `config/harness.local.yml`. `AGENTS.md` and `CLAUDE.md` from directories above the project root are folded into the workspace instructions without a switch. [Skills](skills.md) covers the scopes and ranks, the ordering rules, how to verify the mode, and the instruction-file chain.

## Distribution and verification

The launcher applies an idempotent, version-checked patch to the pinned `dsh-code@1.0.6` bundle for `/clear` and startup command discovery. An unsupported upstream version/shape fails setup instead of patching blindly. All other command behavior lives in `plugins/tui-tools` and hooks use the official runtime plugin. `npm ci` followed by setup reinstalls the patch, including on distributed installs.

`npm test` covers hook validation, MCP idle gating/reconnect, skill conflicts and patch drift. `npm run doctor` boots the real profile, calls the command registry, tests MCP unregister/remount, and uses a real hook subprocess to block a deterministic model's shell tool. No paid model call is used.

## Input and session resume

- `!command`: runs the user's command in the current session directory through `$SHELL` (`/bin/sh` by default), showing stdout, stderr and the exit code without starting a model turn. Multi-line commands are supported; each run is its own shell, so `cd` and environment variables do not persist between commands. It runs non-interactively with a 120-second timeout and shows at most 64 KiB of output; exiting or switching session cancels an unfinished command.
- `Shift+Enter`: newline; `Enter`: send. The CSI-u and xterm modifyOtherKeys Shift+Enter sequences are supported. A terminal that cannot send the modifier can use `Ctrl+J` for a newline.
- Pasting more than 200 characters shows `[Pasted Content N chars]` in the composer as a placeholder while the surrounding text stays editable; after sending, the transcript expands to the full content and the model receives that same full content. The placeholder can be deleted as one unit. Command text starting with `/` or `!` stays visible.
- Pasting or dropping an image file path shows `[Image 1]`, `[Image 2]` and so on in the composer; the image is sent as an attachment. On macOS, `Ctrl+V` attaches a screenshot or a copied image straight from the system clipboard; in a terminal that pastes an image as a temporary path, `Cmd+V` goes through the file-path entry point too. The first `Ctrl+V` compiles a local image-reading helper and needs Xcode Command Line Tools.
- `dscode resume`: continues the most recent session; `dscode resume SESSION_ID`: resumes the named session. `--cwd DIRECTORY` may be appended. After a successful exit and save it prints the resume command for the current session.
- A session's folder is chosen when it is created and never changes: resuming one, through `--resume`, `/resume`, `/search` or a queued switch, works in the folder the session is bound to, and the window's workspace, shell and durable log all follow that folder. A resume that leaves the folder `dscode` was launched in prints one warning notice naming both folders, so a window that silently changed project is visible. To reach another project's context from here, have an agent read that session or use `dscode send` across sessions instead of resuming it.
- The main chat area hides thinking, tool arguments, tool results and completed tool calls; the dynamic area shows only the name of the tool currently running. User messages, agent prose, user shell command results and the necessary error/approval prompts are still shown. The complete record stays in the session and can be seen through the history detail or an export.
- When a turn ends, the chat area draws a light separator line after that turn's last visible record; the next turn starts on a new line. Turn separators are kept when a session is resumed, and an export contains none.
- A sent user message uses its own light-grey background block in the main chat area; the background stays continuous when a long message wraps, and the dark and light themes adapt separately. A session export is still plain text.
- CJK input-method positioning: after each frame the terminal's real cursor is synchronised to the composer's current character position (including CJK width, line wrapping and the composer's internal scroll), and the render position is restored before the redraw. A change here needs the TUI restarted; how the macOS candidate window appears still has to be verified in the terminal actually in use.
- The screen is cleared on startup; the interface shows the most recent session content according to the terminal height, with the composer and status bar pinned to the bottom. The mouse wheel or PageUp/PageDown browses earlier messages in the main chat area, and following new messages resumes after scrolling back to the bottom; Ctrl+O shows the complete session record and `/export` exports it. The terminal scrollback no longer keeps appending completed messages.
- The effort step of `/effort` and `/model` replaces the composer at the bottom. A model with four bands shows a horizontal `low → high → max → ultra` bar; arrow keys move, Enter applies, Esc cancels and restores the composer, and `o` switches straight to off. As the cursor reaches ultra a blue effect spreads from the centre outwards; after Enter applies, the composer plays a short central ripple. Nothing plays while animations are off. Other models still show the band list they provide.

## DSCODE interface layout

The startup header is a compact welcome box: on the left a ten-line snowflake mark built from blue branches and a solid core of the same colour, and on the right a bold DSCODE wordmark with a thin divider that brands the box and lists the current model, effort, local version and project path. A narrow window or a short terminal compresses it to a three-line layout with ❄, keeping the last directory of a long path. A session title that changes while running still shows at the bottom. The body keeps the user and agent output, while thinking and tool-call history stay hidden.

Above the composer, thinking, the reply or the current tool and its description are shown uniformly, timed as the total for the turn. Only the running marker animates; the composer plays no wave. The sub-agent overview separates running / idle / done, and `/agents` shows the tasks and current activity.

The footer leads row 1 with the session name and the model with its effort, then the working directory, the permission badge and any task state; row 2 carries the loaded skill count and closes with the live figures (request rate, context share, running cost, cache rate) as one cluster rather than a right-pinned stretch. Every cluster and figure is joined by `·`, a narrow window sheds the quietest figure first, and below 48 columns the figures are hidden. `/statusline` still customises every original item, and an existing custom configuration keeps working.
