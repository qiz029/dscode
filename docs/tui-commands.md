# dscode TUI commands

Restart `dscode` to load these commands. Commands run locally and do not call the model.

| Command | Behavior |
| --- | --- |
| `/email` | `i`: connect IMAP with a masked application password; `r`: sync. Browse, preview, and press Enter to steer email directly into this session. [Email interface](email.md). |
| `/status` | Session ID, workspace, model route, permission mode, recorded token totals/context pressure, tool/plugin counts. Unknown usage stays unknown. `/review-usage` reports the independent reviewer separately. |
| `/memories [status\|on\|off\|global-on\|global-off\|run\|note <text>\|clear]` | Global cross-session memory controls and background model usage. [Behavior and configuration](memory.md). |
| `/session` | Current session ID, local socket, and external send/read/watch commands. [Multi-source sessions](session-bridge.md). |
| `/mailbox [cancel MESSAGE_ID]` | Read messages and deferred notes, or cancel a request/message. [Session communication](session-communication.md). |
| `/session-new-task` | Explicitly start a fresh communication budget while idle; ordinary continuation and resume retain their existing budgets. |
| `/doctor` | Read-only plugin, skill, MCP tool-discovery and Computer Use health. Does not test remote credentials or execute tools. |
| `/mcp` | List MCP entry IDs, loader state and transport; credentials, headers and environment values are not printed. |
| `/mcp tools <id>` | List registered tools for a server. |
| `/mcp enable|disable|reconnect <id>` | Change a server for this process. All agents must be idle. Reconnect disposes and remounts the server. Host servers are configured in `config/mcp.local.yml`; preset servers, including DSCODE's Chrome, are configured in that preset's composition. IDs may be full loader IDs or an unambiguous short ID such as `mcp-chrome`. |
| `/skills` | Effective skill catalog, source, provider and invocation permissions. |
| `/skills <name>` | Description and effective file path, without injecting its instructions into the model. |
| `/skills conflicts` | Duplicate names in the configured filesystem roots, with the runtime's effective source. Hidden candidates from runtime/remote providers are not enumerable. |
| `/hooks` | Hook configuration location and supported events. |
| `/hooks reload|enable|disable` | Reload installation-owned hook configuration, or switch hooks for this process while all agents are idle. |
| `/clear` | Start a fresh session and clear the screen after successful activation; the previous session remains available through `/resume`. Stop a running turn first. |
| Ctrl+L | Clear the screen only, keeping the conversation context. |

Command results use the standard collapsible TUI result presentation.

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
- `dscode resume`：继续最近会话；`dscode resume SESSION_ID`：恢复指定会话。可追加 `--cwd DIRECTORY`。退出并成功保存后会打印当前会话的恢复命令。
- 主聊天区隐藏 thinking、工具参数、工具结果和已完成的工具调用；动态区域只显示正在执行的工具名。用户消息、agent 正文、用户 shell 命令结果和必要的错误/审批提示仍显示。完整记录保留在会话中，可通过历史详情或导出查看。
- 中文输入法定位：每帧渲染后将终端真实光标同步到输入框的当前字符位置（包含中文宽度、换行和输入框内部滚动），重绘前恢复渲染位置。修改后需要重启 TUI；macOS 候选框显示仍需在实际使用的终端中验证。
- 启动时清屏；界面按终端高度显示最近的会话内容，输入栏和状态栏固定在底部。Ctrl+O 可查看完整会话记录，`/export` 可导出；终端滚屏区不再持续追加已完成消息。
- `/effort` 和 `/model` 的 effort 步骤会在底部替代输入框。支持四档的模型显示横向 `low → high → max → ultra` bar；方向键移动，Enter 应用，Esc 取消并恢复输入框，`o` 可直接切到 off。光标移到 ultra 时，蓝色光效从中央向两侧展开；按 Enter 应用后，输入框播放短暂的中央扩散涟漪。关闭动画时不播放光效。其他模型仍显示各自提供的档位列表。
## DSCODE 界面布局

启动头部是紧凑欢迎框，左侧十行雪花标识用蓝色冰枝和同色实心晶核构成；右侧以加粗 DSCODE 字样和细分隔线标示品牌，并列出当前模型、effort、本地版本和项目路径。窄窗口或矮终端压缩为带 ❄ 的三行布局，较长路径保留末尾目录。运行中变化的 session 标题仍显示在底部。正文保留用户和 agent 输出，thinking 与工具调用历史仍隐藏。

输入区上方统一显示思考、回复或当前工具及其描述，计时为本轮总耗时。只有运行标记动画，输入区不播放波浪。子 agent 概览区分 running / idle / done，输入 `/agents` 查看任务和当前活动。

底栏默认保留模型、effort、权限、标题和必要的任务状态；ctx、费用、cache 使用弱对比色，窄窗口优先省略 cache，低于 64 列隐藏指标。`/statusline` 仍可自定义所有原有项目，已有自定义配置保持有效。
