<div align="center">

<img src="assets/banner.svg" alt="DSCODE" width="880">

# ❄ DSCODE

**Write code in your terminal. Plug scripts into a live session. Hand tasks between agents.**

![macOS 14+](https://img.shields.io/badge/macOS-14%2B-111827?logo=apple&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-22.19%2B%20%7C%2024%2B-43853D?logo=node.js&logoColor=white)
![DSH](https://img.shields.io/badge/DSH-0.1.5--rc.1-2563EB)
![License](https://img.shields.io/badge/license-MIT-green)
[![npm](https://img.shields.io/npm/v/@toddzheng024/dscode)](https://www.npmjs.com/package/@toddzheng024/dscode)
[![Release](https://img.shields.io/github/v/release/qiz029/dscode?color=111827&label=release)](https://github.com/qiz029/dscode/releases)
[![Stars](https://img.shields.io/github/stars/qiz029/dscode?color=111827)](https://github.com/qiz029/dscode/stargazers)

[English](README.md) · [简体中文](README.zh-CN.md)

[Core features](#-core-features) · [What's new](#-whats-new) · [Quick start](#-quick-start) · [Commands](#-commands) · [Changelog](docs/CHANGELOG.md) · [Docs](#-documentation)

</div>

DSCODE is a terminal coding agent for macOS, built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). A persistent shell reads and writes code and runs tests; the TUI, the CLI and your scripts all share one session runtime instead of each starting their own. It installs as a pinned, reproducible harness—DSH dependencies, TUI and plugins are versioned and verified together.

## 🧭 Core features

| Feature | What you get |
|---|---|
| **[Agentic coding loop](docs/dscode-ultra.md)** | A persistent shell that keeps cwd, environment and background jobs, plus file edits, search, patch application and tests. Project instructions, skills, plan, goal and hooks are wired in. |
| **[Session bridge](docs/session-bridge.md)** | Start a task in the TUI, then add requirements, read output or subscribe to progress from another terminal (`dscode sessions`, `send`, `read`, `watch`). Every source enters the same runtime and context, and readers never take the session write lock. |
| **[Agent-to-agent tasks](docs/session-communication.md)** | The agent finds, reads and messages other sessions with `list_sessions`, `read_session`, `send_session` and `reply_session`, choosing `queue`, `steer` or `defer`. A persisted mailbox, retry de-duplication and a finite budget bound message loss, double processing and wake-up loops. |
| **[Session cards](docs/session-cards.md)** | Each session advertises its project, workspace and the topics of its last five user requests—enough to pick the right collaborator without reading its transcript. Cards describe what the user asked for, not conclusions. |
| **[Cross-session memory](docs/memory.md)** | Reusable experience is extracted in the background and retrieved together with its workspace and source messages. Memory can be disabled per session or globally, and its model usage is tracked separately. |
| **[Effort and sub-agents](docs/dscode-ultra.md)** | Ultra uses DeepSeek's native `max` reasoning and decides how far to investigate, delegate and verify. Parents pick a separate effort per child, and children that edit can work in isolated Git worktrees created from a clean `HEAD`. |
| **[Independent review](docs/tui-commands.md)** | After a code change passes its relevant checks, the agent sends the Git diff—or, outside a repository, the changes since a snapshot taken when the task began—to a separate read-only model and fixes concrete findings before ending the turn. `/review` runs the same reviewer by hand, scoped to the staging area, a base branch, a commit or a path. |
| **[Non-interactive runs](docs/exec.md)** | `dscode exec "prompt"`, or `git diff \| dscode exec "review this"`, runs a full turn in scripts and CI: the reply streams to stdout, tool activity and the session id go to stderr, and the exit code reflects the turn. `--json` and `--resume` are supported. |
| **[Terminal UX](docs/session-metrics.md)** | Six interface languages, select-and-copy text, scrollback through history, a verbose view of thinking and tool calls, an input area pinned to the bottom, a sub-agent overview, and footer TPS / context / cost / cache figures. |
| **[Guardrails](docs/auto-review.md)** | A `workspace-write` sandbox by default and Auto permission review by an independent model, switchable to human approval. Ultra grants no extra permissions and Computer Use keeps human authorisation. |
| **[Agent email](docs/email.md)** | A local `[ToAgent]` inbox shared by all sessions: Enter steers a message into the live session as user-selected context, and with Gmail configured the agent can send mail through the same approval flow. |

## 🆕 What's new

**0.7.5** — independent review works outside Git. In a workspace that is not a repository, DSCODE snapshots the files before the task's first tool call and reviews what changed since, so the agent gets the review guidance there too; the snapshot lives under the data directory and never touches the workspace. 0.7.4 made MCP calls work under `danger-full-access` again, where they were silently rejected and `dscode exec --approve-all` could not allow them.

Every release is listed in the **[changelog](docs/CHANGELOG.md)**; the [0.7.5 notes](docs/releases/0.7.5.md) have the long version.

## 🚀 Quick start

Requires **macOS 14+, Node 22.19+ (22.x) or 24+, npm, Git and Google Chrome**.

```sh
npm install -g @toddzheng024/dscode
cd /path/to/project
dscode
```

The first launch installs the pinned complete preset from [DSH Plugin Hub](https://dshpluginhub.ai)—no manual plugin assembly, no global pnpm. Then enter `/login` and paste your DeepSeek API key into the hidden input: it is stored locally in `~/.dscode/credentials.yaml` with `0600` permissions, shared across projects and installed versions, and never sent to the agent. A `DEEPSEEK_API_KEY` environment variable takes precedence. To reach the same DeepSeek models through OpenRouter, enter `/provider openrouter`: DSCODE declares the OpenRouter route, asks for your OpenRouter key (stored the same way, or taken from `OPENROUTER_API_KEY`) and switches the session; `/provider deepseek` switches back, and `/login openrouter` replaces the key. Use `/model` to pick a model or another provider, and `/effort` to adjust reasoning effort; the default route is `deepseek-official/deepseek-flash`.

```sh
dscode --continue                 # continue the last session
dscode --resume SESSION_ID        # resume a specific session
dscode --cwd /another/project     # work in another directory
dscode doctor                     # analyse recent logs and session traces
```

The launcher checks installed bundles and Harness dependencies against the recommended combination; on a mismatch it prints one consolidated warning and keeps running, without editing dependencies or downgrading. Access to the browser and desktop tools is granted on demand: Chrome starts with a separate temporary profile and does not take over your everyday browser logins, desktop tools load progressively through a skill, screenshot understanding needs a model that accepts images, the MCP bridge provides tools rather than resources or prompts, and Computer Use permissions are granted separately in macOS.

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

**From a tar package** — download `dscode-0.7.5.tar.gz` from [GitHub Releases](https://github.com/qiz029/dscode/releases/latest), then:

```sh
mkdir dscode-install
tar -xzf dscode-0.7.5.tar.gz -C dscode-install
sh dscode-install/install.sh
```

The command lands in `~/.local/bin/dscode` by default—make sure that directory is on your PATH. The tar installer never overwrites an existing command or installation.

**If the npm name lookup returns 404**, install the same version straight from the official registry tarball:

```sh
npm install -g https://registry.npmjs.org/@toddzheng024/dscode/-/dscode-0.7.5.tgz
```

**Upgrade** — update the launcher first, then the installed profile:

```sh
npm install -g @toddzheng024/dscode@0.7.5
dscode update 0.7.5
```

`dscode history` lists retained versions and `dscode rollback` returns to the previous preset revision. Source, tar and npm/Hub installs use different data directories, and sessions and credentials are not migrated between them. See the [tar distribution notes](docs/distribution.md) and the [npm + Hub guide](docs/hub-distribution.md).

</details>

## ⌨️ Commands

| Command | What it does |
|---|---|
| `/login` | Paste the DeepSeek API key into a hidden input; saved under `~/.dscode/` and loaded at startup |
| `/model`, `/effort` | Choose a model or configure other credentials; models with four levels use a horizontal effort bar |
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

`config/hooks.local.json`, `config/mcp.local.yml` and `config/harness.local.yml` are supported. Local configs, secrets and sessions never enter a release package. Skills are discovered in the target project's `.agents/skills` and `.dsh/skills`, plus an isolated user skill directory; `/skills conflicts` diagnoses same-name overrides.

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

| Distribution component | Contents |
|---|---|
| `@toddzheng024/dscode` | The `dscode` command, first-install bootstrap and Hub version management |
| `@toddzheng024/dscode-bundle` | Base layer, Computer Use, custom plugins and the modified TUI/runtime |
| Hub profile `dscode` | Pinned bundle and runtime versions with integrity hashes |

The bundle generates its modified modules at build time and never rewrites third-party sources on a user's machine. DSH dependencies are pinned to `0.1.5-rc.1`; the TUI is based on `dsh-code@1.0.6`, Chrome MCP on `1.9.0` and Computer Use on `0.3.2`. The full pipeline—bundle, then Hub release, then launcher—is in the [distribution guide](docs/hub-distribution.md). Context-compaction evaluation lives under [`eval/`](eval/README.md) and runs with `npm run eval:compaction`.

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
| [TUI commands](docs/tui-commands.md) | Command reference and hooks |
| [Session metrics](docs/session-metrics.md) | Definition of the footer TPS, context, cost and cache figures |
| [npm + Hub distribution](docs/hub-distribution.md) | Bundle, Hub release and launcher pipeline |
| [tar distribution](docs/distribution.md) | The standalone tar installer |
| [Verification](docs/verification.md) | What the maintained checks cover |

## 🤝 Contributing

Issues and pull requests are welcome. Run `npm run check` before sending a change, and keep the release flow intact: bundle first, then Hub release, then launcher.

## 📄 License

[MIT](LICENSE) © 2026 Todd Zheng

---

Built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), [DSH-Code](https://github.com/unlinearity/dsh-code), [Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) and [DSH Plugin Hub](https://dshpluginhub.ai). An independent community project, not an official DeepSeek product.
