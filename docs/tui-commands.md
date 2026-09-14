# dscode TUI commands

Restart `dscode` to load these commands. Most commands run locally; `/doctor` makes one bounded call to the selected model for analysis.

| Command | Behavior |
| --- | --- |
| `/email` | `i`: connect IMAP with a masked application password; `r`: sync. Browse, preview, and press Enter to steer email directly into this session. [Email interface](email.md). |
| `/status` | Session ID, workspace, model route, permission mode, recorded token totals/context pressure, tool/plugin counts. Unknown usage stays unknown. `/review-usage` reports the independent reviewer separately. |
| `/memories [status\|on\|off\|global-on\|global-off\|run\|note <text>\|clear]` | Global cross-session memory controls and background model usage. [Behavior and configuration](memory.md). |
| `/session` | Current session ID, local socket, and external send/read/watch commands. [Multi-source sessions](session-bridge.md). |
| `/mailbox [cancel MESSAGE_ID]` | Read messages and deferred notes, or cancel a request/message. [Session communication](session-communication.md). |
| `/session-new-task` | Explicitly start a fresh communication budget while idle; ordinary continuation and resume retain their existing budgets. |
| `/doctor [local\|preview]` | Read-only runtime health plus self-diagnosis from recent warning/error logs and session event traces for this workspace. By default, sends bounded, redacted event metadata to the selected model. `local` skips the model; `preview` shows the exact evidence payload. Does not read conversation text, tool arguments, or tool output. Falls back to local findings if model analysis fails. |
| `/mcp` | List MCP entry IDs, loader state and transport; credentials, headers and environment values are not printed. |
| `/mcp tools <id>` | List registered tools for a server. |
| `/mcp enable|disable|reconnect <id>` | Change a server for this process. All agents must be idle. Reconnect disposes and remounts the server. Host servers are configured in `config/mcp.local.yml`; preset servers, including DSCODE's Chrome, are configured in that preset's composition. IDs may be full loader IDs or an unambiguous short ID such as `mcp-chrome`. |
| `/skills` | Effective skill catalog, source, provider and invocation permissions. |
| `/skills <name>` | Description and effective file path, without injecting its instructions into the model. |
| `/skills conflicts` | Duplicate names in the configured filesystem roots, with the runtime's effective source. Hidden candidates from runtime/remote providers are not enumerable. |
| `/hooks` | Hook configuration location and supported events. |
| `/hooks reload|enable|disable` | Reload installation-owned hook configuration, or switch hooks for this process while all agents are idle. |
| `/review [--staged\|--base REF\|--commit REF] [--path RELATIVE_PATH]` | Independently review the selected Git diff in a read-only, tool-free model request. Default includes tracked and untracked uncommitted changes; empty scopes do not call the model. Narrow large or unrelated diffs with `--path`. |
| `/verbose` | Toggle verbose chat: thinking and tool calls appear dimmed as `· Thinking: …`, `· Tool Call: name args` and `  Output: …` (thinking capped at eight lines). Ctrl/Alt+R toggles the same setting; Ctrl+O still opens the full history inspector. |
| `/mouse` | Toggle mouse capture. On (default) the wheel scrolls the chat but the terminal cannot select text; off lets you drag-select and copy normally while PageUp/PageDown still scroll. With capture on, hold Option (iTerm2) or Fn (Terminal.app) while dragging to select. |
| `/language [code]` | Without an argument, open a picker (↑↓ choose, enter apply, esc close) for the interface language for DSCODE's own labels and notices: `en` (default), `zh-CN`, `zh-TW`, `ja`, `ko`, `es`. Names and common aliases work too (`简体中文`, `jp`). The choice is saved per machine in `~/.dsh/dsh-code/language.json`; `DSCODE_LANGUAGE` overrides it for one process. |
| `/clear` | Start a fresh session and clear the screen after successful activation; the previous session remains available through `/resume`. Stop a running turn first. |
| Ctrl+L | Clear the screen only, keeping the conversation context. |
| Ctrl+C | While an agent runs, cancel it immediately; a second press exits the TUI without waiting for the busy display to settle. With an idle draft, the first press clears it and the second exits. |

Command results use the standard collapsible TUI result presentation.

The agent also has a `review` tool backed by the same service. Its prompt asks for one review after code changes and relevant checks, before the final response; a material fix can be reviewed again. It skips read-only turns, and unchanged diff+task+model requests reuse the previous report. The reviewer sees the latest direct user task and at most 160 KiB of selected diff, with common secret formats redacted; it cannot inspect surrounding files, run tests or edit code. Treat a timeout, oversized diff, or missing model route as an incomplete review, never as a clean result. `/review` requires an idle agent turn.

`dscode doctor` runs the same diagnostic collector and model analysis without opening the TUI. It checks the current working directory's recent sessions, including subagents, and reads the owner-only `diagnostics/runtime.jsonl` warning/error journal under `DSH_HOME`. `--local` skips the model; `--preview` shows the exact evidence payload. A model call is limited to 45 seconds; missing credentials or model failure leave a local trace summary. These commands diagnose existing evidence and do not execute tools or repair state. `npm run doctor` remains the separate deterministic integration fixture.

## Hooks

`npm run setup` creates `config/hooks.local.json` containing `{"hooks":{}}`. No hook commands run by default. This file is local to the installation, ignored by git, and excluded from distributable archives. Project `.codex/hooks.json` and `.claude` configurations are **not automatically loaded**.

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

## Distribution and verification

The launcher applies an idempotent, version-checked patch to the pinned `dsh-code@1.0.6` bundle for `/clear` and startup command discovery. An unsupported upstream version/shape fails setup instead of patching blindly. All other command behavior lives in `plugins/tui-tools` and hooks use the official runtime plugin. `npm ci` followed by setup reinstalls the patch, including on distributed installs.

`npm test` covers hook validation, MCP idle gating/reconnect, skill conflicts and patch drift. `npm run doctor` boots the real profile, calls the command registry, tests MCP unregister/remount, and uses a real hook subprocess to block a deterministic model's shell tool. No paid model call is used.

## 输入与会话恢复

- `!命令`：在当前会话目录用 `$SHELL`（默认 `/bin/sh`）执行用户输入的命令，展示 stdout、stderr 和退出码，不启动模型回合。支持多行命令；每次启动独立 shell，`cd` 和环境变量不跨命令保留。非交互执行，120 秒超时，显示最多 64 KiB 输出；退出或切换会话会取消未完成命令。
- `Shift+Enter`：换行；`Enter`：发送。支持 CSI-u 和 xterm modifyOtherKeys 的 Shift+Enter 序列。不发送修饰键的终端可使用 `Ctrl+J` 换行。
- 粘贴超过 200 字符的文本时，输入框暂以 `[Pasted Content N chars]` 占位，便于继续编辑前后的文字；发送后聊天记录展开显示完整内容，模型收到的也是完整内容。占位符可作为整体删除。以 `/` 或 `!` 开头的命令文本保持可见。
- 粘贴或拖入图片文件路径时，输入框以 `[Image 1]`、`[Image 2]` 等占位；图片作为附件发送。macOS 上按 `Ctrl+V` 可直接从系统剪贴板附加截图或复制的图片；在能将图片粘贴成临时路径的终端中，`Cmd+V` 也走文件路径入口。首次使用 `Ctrl+V` 会编译本机的图片读取小工具，需要 Xcode Command Line Tools。
- `dscode resume`：继续最近会话；`dscode resume SESSION_ID`：恢复指定会话。可追加 `--cwd DIRECTORY`。退出并成功保存后会打印当前会话的恢复命令。
- 主聊天区隐藏 thinking、工具参数、工具结果和已完成的工具调用；动态区域只显示正在执行的工具名。用户消息、agent 正文、用户 shell 命令结果和必要的错误/审批提示仍显示。完整记录保留在会话中，可通过历史详情或导出查看。
- 每轮 agent 结束时，聊天区在该轮最后一条可见记录后显示一行浅色分割线；下一轮从新行开始。恢复会话时也保留轮次分隔，导出内容不包含分割线。
- 已发送的用户消息在主聊天区使用独立的浅灰背景块；长消息换行后背景连续，深色和浅色主题分别适配。会话导出仍是纯文本。
- 中文输入法定位：每帧渲染后将终端真实光标同步到输入框的当前字符位置（包含中文宽度、换行和输入框内部滚动），重绘前恢复渲染位置。修改后需要重启 TUI；macOS 候选框显示仍需在实际使用的终端中验证。
- 启动时清屏；界面按终端高度显示最近的会话内容，输入栏和状态栏固定在底部。鼠标滚轮或 PageUp/PageDown 可在主聊天区浏览较早消息，滚回底部后继续自动跟随新消息；Ctrl+O 可查看完整会话记录，`/export` 可导出。终端滚屏区不再持续追加已完成消息。
- `/effort` 和 `/model` 的 effort 步骤会在底部替代输入框。支持四档的模型显示横向 `low → high → max → ultra` bar；方向键移动，Enter 应用，Esc 取消并恢复输入框，`o` 可直接切到 off。光标移到 ultra 时，蓝色光效从中央向两侧展开；按 Enter 应用后，输入框播放短暂的中央扩散涟漪。关闭动画时不播放光效。其他模型仍显示各自提供的档位列表。
## DSCODE 界面布局

启动头部是紧凑欢迎框，左侧十行雪花标识用蓝色冰枝和同色实心晶核构成；右侧以加粗 DSCODE 字样和细分隔线标示品牌，并列出当前模型、effort、本地版本和项目路径。窄窗口或矮终端压缩为带 ❄ 的三行布局，较长路径保留末尾目录。运行中变化的 session 标题仍显示在底部。正文保留用户和 agent 输出，thinking 与工具调用历史仍隐藏。

输入区上方统一显示思考、回复或当前工具及其描述，计时为本轮总耗时。只有运行标记动画，输入区不播放波浪。子 agent 概览区分 running / idle / done，输入 `/agents` 查看任务和当前活动。

底栏默认保留模型、effort、权限、标题和必要的任务状态；ctx、费用、cache 使用弱对比色，窄窗口优先省略 cache，低于 64 列隐藏指标。`/statusline` 仍可自定义所有原有项目，已有自定义配置保持有效。
