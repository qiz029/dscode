<div align="center">

<img src="assets/banner.svg" alt="DSCODE" width="880">

# ❄ DSCODE

**Write code in your terminal. Plug scripts into a live session. Hand tasks between agents.**

![Watch the 90-second DSCODE demo](assets/demo.gif)

![macOS 14+](https://img.shields.io/badge/macOS-14%2B-111827?logo=apple&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-22.19%2B%20%7C%2024%2B-43853D?logo=node.js&logoColor=white)
![DSH](https://img.shields.io/badge/DSH-0.1.5--rc.2-2563EB)
![License](https://img.shields.io/badge/license-MIT-green)
[![npm](https://img.shields.io/npm/v/@toddzheng024/dscode)](https://www.npmjs.com/package/@toddzheng024/dscode)
[![Release](https://img.shields.io/github/v/release/qiz029/dscode?color=111827&label=release)](https://github.com/qiz029/dscode/releases)
[![Stars](https://img.shields.io/github/stars/qiz029/dscode?color=111827)](https://github.com/qiz029/dscode/stargazers)
[![Discussions](https://img.shields.io/github/discussions/qiz029/dscode?color=111827&label=discussions)](https://github.com/qiz029/dscode/discussions)

[English](README.md) · [简体中文](README.zh-CN.md)

[Core features](#-core-features) · [What's new](#-whats-new) · [Quick start](#-quick-start) · [Commands](#-commands) · [Changelog](docs/CHANGELOG.md) · [Docs](#-documentation)

</div>

DSCODE is a terminal coding agent for macOS, built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). A persistent shell reads and writes code and runs tests; the TUI, the CLI and your scripts all share one session runtime instead of each starting their own. It installs as a pinned, reproducible harness—DSH dependencies, TUI and plugins are versioned and verified together.

Most coding agents work alone. DSCODE is built on the opposite assumption: sessions on your machine are **visible to each other**, so one can hand a task over, another can review the diff, and an independent reviewer decides approvals from **your instruction** rather than from a rule table.

**See it in 60 seconds.** Three things most coding agents cannot do, and where to look:

| In one terminal | What it shows |
|---|---|
| `/btw why is the cache cold on the first turn?` | A side question runs in its own read-only child session and answers in a panel; the exchange never enters the main conversation. |
| `dscode send <session-id> --steer "review the change in parser.ts and reply"` | Work handed to another session on this machine; it can read your transcript, answer, and hand the result back. |
| `/permission auto` · `/review-usage` | Approvals decided by an independent reviewer from your instruction, with what it allowed and what it cost. |

The [90-second demo script](docs/demo.md) has the shot list, the exact commands, and how to record it.

## 🧭 Core features

| Feature | What you get |
|---|---|
| **[Agentic coding loop](docs/dscode-ultra.md)** | A persistent shell that keeps cwd, environment and background jobs, plus file edits, search, patch application and tests. Project instructions, skills, plan, goal and hooks are wired in. |
| **[Session bridge](docs/session-bridge.md)** | Start a task in the TUI, then add requirements, read output or subscribe to progress from another terminal (`dscode sessions`, `send`, `read`, `watch`). Every source enters the same runtime and context, and readers never take the session write lock. |
| **[Agent-to-agent tasks](docs/session-communication.md)** | The agent finds, reads and messages other sessions with `list_sessions`, `read_session`, `send_session` and `reply_session`, choosing `queue`, `steer` or `defer`. A persisted mailbox, retry de-duplication and a finite budget bound message loss, double processing and wake-up loops. |
| **[Session cards](docs/session-cards.md)** | Each session advertises its project, workspace and the topics of its last five user requests—enough to pick the right collaborator without reading its transcript. Cards describe what the user asked for, not conclusions. |
| **[Cross-session memory](docs/memory.md)** | Reusable experience is extracted in the background and retrieved together with its workspace and source messages. Memory can be disabled per session or globally, and its model usage is tracked separately. |
| **[Effort and sub-agents](docs/dscode-ultra.md)** | Ultra uses the model's `max` reasoning and decides how far to investigate, delegate and verify; below Ultra the agent can still delegate, but only when a task clearly warrants it. Parents pick a separate effort per child, and children that edit can work in isolated Git worktrees created from a clean `HEAD`. |
| **[Independent review](docs/tui-commands.md)** | After a code change passes its relevant checks, the agent sends the Git diff—or, outside a repository, the changes since a snapshot taken when the task began—to a separate read-only model and fixes concrete findings before ending the turn. `/review` runs the same reviewer by hand, scoped to the staging area, a base branch, a commit or a path. |
| **[Non-interactive runs](docs/exec.md)** | `dscode exec "prompt"`, or `git diff \| dscode exec "review this"`, runs a full turn in scripts and CI: the reply streams to stdout, tool activity and the session id go to stderr, and the exit code reflects the turn. `--json` and `--resume` are supported. |
| **[Terminal UX](docs/session-metrics.md)** | Six interface languages, select-and-copy text, scrollback through history, a verbose view of thinking and tool calls, an input area pinned to the bottom, a sub-agent overview, and footer TPS / context / cost / cache figures. |
| **[Guardrails](docs/auto-review.md)** | A `workspace-write` sandbox by default and Auto permission review by an independent model, switchable to human approval. Ultra grants no extra permissions and Computer Use keeps human authorisation. |
| **[Agent email](docs/email.md)** | A local `[ToAgent]` inbox shared by all sessions: Enter steers a message into the live session as user-selected context, and with Gmail configured the agent can send mail through the same approval flow. |

## 🆕 What's new

**0.7.21** — The TUI footer's geometry now follows terminal width alone: the permission badge anchors the row's right edge, the cycle hint keeps its columns, and every live figure is right-aligned inside fixed columns instead of moving with its own digits. `dscode-time-marks` adds hidden clock readings for arriving messages and closed turns (context the terminal never renders), and `/btw <question>` answers a side question in a seeded, read-only child session without touching the main conversation.

Every release is listed in the **[changelog](docs/CHANGELOG.md)**; the [0.7.21 notes](docs/releases/0.7.21.md) have the long version.

## 🚀 Quick start

Requires **macOS 14+, Node 22.19+ (22.x) or 24+, npm, Git and Google Chrome**.

```sh
npm install -g @toddzheng024/dscode
cd /path/to/project
dscode
```

Every other install path reaches the same pinned harness:

| Method | How |
|---|---|
| npm / Hub | the command above; the launcher installs the pinned profile from [DSH Plugin Hub](https://dshpluginhub.ai) |
| GitHub release, one line | `curl -fsSL https://raw.githubusercontent.com/qiz029/dscode/main/install.sh \| sh` |
| Release tarball | download `dscode-<version>-darwin-arm64.tar.gz` (or `-darwin-x64`) from [Releases](https://github.com/qiz029/dscode/releases), unpack it and run `sh dscode-install/install.sh` |
| Source checkout | `git clone https://github.com/qiz029/dscode.git && cd dscode && npm ci --ignore-scripts && npm run setup` |

The one-line installer resolves the newest release, verifies the sha256 digest GitHub publishes for its tarball and then runs the installation the tarball carries; `sh -s -- <version>` pins an exact release instead of tracking the latest. Every path needs Node and Git. The GitHub release paths need nothing else: the prebuilt tarball (`dscode-<version>-darwin-arm64.tar.gz` or `-darwin-x64`) already carries the locked `node_modules`, so it installs without npm and without reaching an npm registry—the one to use behind a corporate registry proxy. The plain `dscode-<version>.tar.gz` is the source tarball, which installs its lockfile with `npm ci`; the installer falls back to it on a platform without a prebuilt package, and `DSCODE_INSTALL_SOURCE=1` asks for it. The npm path installs the pinned profile from the Hub.

The first launch installs the pinned complete preset from [DSH Plugin Hub](https://dshpluginhub.ai)—no manual plugin assembly, no global pnpm. Then enter `/login` and paste your DeepSeek API key into the hidden input: it is stored locally in `~/.dscode/credentials.yaml` with `0600` permissions, shared across projects and installed versions, and never sent to the agent. A `DEEPSEEK_API_KEY` environment variable takes precedence. To use OpenRouter, enter `/provider openrouter`: DSCODE asks for your OpenRouter key (stored the same way, or taken from `OPENROUTER_API_KEY`) and switches the session to the DeepSeek model you were on; every model in OpenRouter's live listing that can call tools is then listed in `/model`, where typing searches. DeepSeek, GLM, Kimi and Qwen models are tuned and tested; other models work on a best-effort basis. `/provider deepseek` switches back, and `/login openrouter` replaces the key. Use `/model` to pick a model or another provider, and `/effort` to adjust reasoning effort; the default route is `deepseek-official/deepseek-flash`. The TUI checks npm for a newer release at startup and `/update` upgrades the whole installation after you exit.

**Six interface languages, English by default.** `/language` opens the picker and `/language ja` switches straight to a locale; 中文, 日本語 and 한국어 are accepted as names too. The set is English, 简体中文, 繁體中文, 日本語, 한국어 and Español. The choice is stored per machine in `~/.dsh/dsh-code/language.json`, and `DSCODE_LANGUAGE=es` overrides it for one run.

```sh
dscode --continue                 # continue the last session
dscode --resume SESSION_ID        # resume a specific session
dscode --cwd /another/project     # work in another directory
dscode doctor                     # analyse recent logs and session traces
dscode --version                  # print the DSCODE version
```

The launcher checks installed bundles and Harness dependencies against the recommended combination; on a mismatch it prints one consolidated warning and keeps running, without editing dependencies or downgrading. No MCP server is mounted by default. Desktop tools load progressively through a skill, screenshot understanding needs a model that accepts images, the MCP bridge provides tools rather than resources or prompts, and Computer Use permissions are granted separately in macOS. Add your own MCP servers — Chrome DevTools MCP among them — in `config/mcp.local.yml`.

<details>
<summary><b>Other install paths, upgrades and rollback</b></summary>

**From source**

```sh
git clone https://github.com/qiz029/dscode.git
cd dscode
npm ci --ignore-scripts
npm run setup
npm start

# Work on another project
npm start -- --cwd /path/to/project
```

**One-line install** — the installer runs straight from the repository and fetches the release itself; name an exact version after `--` to pin one instead of tracking the latest:

```sh
curl -fsSL https://raw.githubusercontent.com/qiz029/dscode/main/install.sh | sh
curl -fsSL https://raw.githubusercontent.com/qiz029/dscode/main/install.sh | sh -s -- 0.7.21
```

**From a tar package** — download the prebuilt `dscode-<version>-darwin-arm64.tar.gz` (Apple silicon) or `dscode-<version>-darwin-x64.tar.gz` (Intel) from [GitHub Releases](https://github.com/qiz029/dscode/releases/latest), then:

```sh
mkdir dscode-install
tar -xzf dscode-<version>-darwin-arm64.tar.gz -C dscode-install
sh dscode-install/install.sh
```

The command lands in `~/.local/bin/dscode` by default—make sure that directory is on your PATH. The installer never overwrites an existing command or installation.

**If the npm name lookup returns 404**, install the same version straight from the official registry tarball:

```sh
npm install -g https://registry.npmjs.org/@toddzheng024/dscode/-/dscode-0.7.21.tgz
```

**Upgrade** — `dscode update [exact-version]` updates the whole installation in one step, and requires no running DSCODE sessions. On the npm/Hub install it replaces the launcher binary with npm and then upgrades the installed profile to the same version. On a tar install it downloads the release tarball (the prebuilt one for this platform when the release has it, so the update needs no npm either), verifies it against the release's sha256 digest, swaps the installation directory in place and migrates `.runtime`, `.env` and local `config/`; the previous installation is kept as a sibling backup directory. A source checkout updates itself the same way: `git pull --ff-only` on the branch it tracks, then `npm ci --ignore-scripts` and `npm run setup`; uncommitted changes in tracked files refuse before anything runs, so a failed update never half-applies.

```sh
dscode update                  # latest release
dscode update 0.7.21           # an exact version
```

`dscode history` lists retained versions and `dscode rollback` returns to the previous preset revision (npm/Hub install). Tar installs older than the first release with `dscode update` upgrade by installing the new tarball into a fresh directory and migrating the state once. Source, tar and npm/Hub installs use different data directories, and sessions and credentials are not migrated between them. See the [tar distribution notes](docs/distribution.md) and the [npm + Hub guide](docs/hub-distribution.md).

</details>

## ⌨️ Commands

| Command | What it does |
|---|---|
| `/login` | Paste the DeepSeek API key into a hidden input; saved under `~/.dscode/` and loaded at startup |
| `/model`, `/effort` | Choose a model (type to search) or configure other credentials; models with four levels use a horizontal effort bar |
| `/mode` | Select an Agent Preset; new sessions default to `dscode` |
| `/status`, `/doctor` | Session state and runtime diagnostics |
| `/memories` | Global memory state, background usage, switches and cleanup |
| `/session` | Current session id, its card, and the external access entry point |
| `/permission auto`, `/permission ask` | Switch between automatic review and human approval |
| `/review-usage` | Extra tokens and time spent on automatic review |
| `/shell`, `/shell reset` | Inspect or reset the persistent terminal |
| `/mcp`, `/skills`, `/hooks` | Manage MCP, inspect skill sources, view or reload hooks |
| `/plan`, `/goal` | Plans and long-running objectives |
| `/agents` | Sub-agent tasks, status and current activity |
| `/btw` | Ask a side question in a child session; the answer shows in its own panel and never enters the main conversation |
| `/mailbox` | Session messages and deferred notes |
| `/email` | Press `i` to configure IMAP and an app password; browse `[ToAgent]` mail and press Enter to steer it into the session |
| `/compact` | Compact the conversation context |
| `/diff`, `/review` | Inspect edits; `/review` asks an independent, read-only model to review a Git diff |
| `/clear` | Start a new session with empty context; the old session stays resumable |
| `/resume`, `/fork` | Resume or fork a session |

`Shift+Enter` inserts a newline, `!command` runs a local shell command, `Ctrl+L` clears only the screen, and `Esc` interrupts the current operation. The TUI's `/help` is the authoritative list, and [commands and hooks](docs/tui-commands.md) covers the rest.

## 🔧 Permissions & configuration

The default is a `workspace-write` sandbox with **Auto** permission review, where applicable approval requests go to an independent model; `/permission ask` hands them back to you. Ultra adds no permissions. [Scope, cost and limits of auto review →](docs/auto-review.md)

| Install method | Sessions, credentials and stats | Local configuration |
|---|---|---|
| npm / Hub | `~/.local/share/dscode-hub`, overridable with `DSCODE_HOME` | `.env` and `config/` in the data directory |
| Source | repository `.runtime/` | repository `.env` and `config/` |
| tar | `.runtime/` inside the install directory | `.env` and `config/` in the install directory |

`config/hooks.local.json`, `config/mcp.local.yml` and `config/harness.local.yml` are supported. Local configs, secrets and sessions never enter a release package. Skills are discovered in the target project's `.agents/skills` and `.dsh/skills`, plus an isolated user skill directory; `/skills conflicts` diagnoses same-name overrides. A project's `.codex/hooks.json`, `.dsh/hooks.json` and `.claude/settings.json` are layered on top of `config/hooks.local.json` by default; set `DSCODE_PROJECT_HOOKS=0` to load the installation file alone. Skills come from the project's `.dsh/skills` and `.agents/skills` plus the user roots, and `DSCODE_SKILL_ANCESTORS=1` also reads `.dsh/skills`, `.agents/skills` and `.claude/skills` from every directory between the project root and home; `AGENTS.md`/`CLAUDE.md` in those ancestor directories is folded into the workspace instructions.

## 🧩 Development

```sh
npm test                    # unit and contract tests (upstream dependencies isolated)
npm run check               # coverage, integration, TUI and packaging checks
npm run doctor              # deterministic local agent integration check
npm run build:packages      # build the launcher and complete bundle npm tgz
npm run release:hub         # build the Hub release and .dshprofile
npm run verify:hub          # temp install, agent check, failed upgrade and rollback
npm run dist                # build the fallback tar installer
```

`make release` runs the whole build job in that order—version check, `npm run check`, the three build steps, `verify:hub`, then `release-candidates.tar.gz`—and `make publish` runs the publish job's phases in order. `make help` lists every target; the workflow itself does not call make.

| Distribution component | Contents |
|---|---|
| `@toddzheng024/dscode` | The `dscode` command, first-install bootstrap and Hub version management |
| `@toddzheng024/dscode-bundle` | Base layer, Computer Use, custom plugins and the modified TUI/runtime |
| Hub profile `dscode` | Pinned bundle and runtime versions with integrity hashes |

The bundle generates its modified modules at build time and never rewrites third-party sources on a user's machine. DSH dependencies are pinned to `0.1.5-rc.2`; the TUI is based on `dsh-code@1.0.6` and Computer Use on `0.3.2`. The full pipeline—bundle, then Hub release, then launcher—is in the [distribution guide](docs/hub-distribution.md). Context-compaction evaluation lives under [`eval/`](eval/README.md) and runs with `npm run eval:compaction`.

## 📚 Documentation

| Document | Contents |
|---|---|
| [Changelog](docs/CHANGELOG.md) | Every release, newest first |
| [Non-interactive runs](docs/exec.md) | `dscode exec`, JSON output, resume and effort/model/permission flags |
| [Session bridge](docs/session-bridge.md) | `dscode sessions`, `send`, `read`, `watch` against a live session |
| [Session communication](docs/session-communication.md) | Agent-side messaging, delivery modes, budgets and de-duplication |
| [Session cards](docs/session-cards.md) | Project, workspace and topic fields, and how they are derived |
| [Memory](docs/memory.md) | Global cross-session memory, background usage and switches |
| [Persistent shell and Ultra](docs/dscode-ultra.md) | Presets, reasoning effort, per-child effort and worktree isolation |
| [Auto review](docs/auto-review.md) | Scope, cost and limits of independent permission review |
| [Email](docs/email.md) | IMAP setup, the inbox panel, `send_email` and aliases |
| [Skills and workspace instructions](docs/skills.md) | Discovery scopes, the ancestor mode and instruction files |
| [TUI commands](docs/tui-commands.md) | Command reference and hooks |
| [Session metrics](docs/session-metrics.md) | Definition of the footer TPS, context, cost and cache figures |
| [Demo script](docs/demo.md) | The 90-second demo: shot list, exact commands, how to record it |
| [npm + Hub distribution](docs/hub-distribution.md) | Bundle, Hub release and launcher pipeline |
| [tar distribution](docs/distribution.md) | The standalone tar installer |
| [Verification](docs/verification.md) | What the maintained checks cover |

Design records do not repeat the guides above:

| Document | Contents |
|---|---|
| [Session messaging design](docs/session-messaging-design.md) | Rationale, boundaries and fixed limits behind agent-to-agent tasks |
| [Cloud web app host](docs/cloud-webapp-host.md) | Design baseline and trust model for browser access; not implemented |
| [Verification](docs/verification.md) | What the maintained checks cover, and what cannot run inside a session |
| [Releases](docs/releases/) | Long-form notes for every release, newest first |
| [Context handoff](docs/CONTEXT-HANDOFF.md) | Development checkpoint for a fresh session; not user documentation |

## 🤝 Contributing

Issues and pull requests are welcome. Run `npm run check` before sending a change, and keep the release flow intact: bundle first, then Hub release, then launcher.

## 📄 License

[MIT](LICENSE) © 2026 Todd Zheng

---

Built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), [DSH-Code](https://github.com/unlinearity/dsh-code) and [DSH Plugin Hub](https://dshpluginhub.ai). An independent community project, not an official DeepSeek product.
