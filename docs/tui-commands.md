# dscode TUI commands

Restart `dscode` to load these commands. Commands run locally and do not call the model.

| Command | Behavior |
| --- | --- |
| `/status` | Session ID, workspace, model route, permission mode, recorded token totals/context pressure, tool/plugin counts. Unknown usage stays unknown. `/review-usage` reports the independent reviewer separately. |
| `/doctor` | Read-only plugin, skill, MCP tool-discovery and Computer Use health. Does not test remote credentials or execute tools. |
| `/mcp` | List MCP entry IDs, loader state and transport; credentials, headers and environment values are not printed. |
| `/mcp tools <id>` | List registered tools for a server. |
| `/mcp enable|disable|reconnect <id>` | Change a server for this process. All agents must be idle. Reconnect disposes and remounts the server. Persist desired startup configuration in `config/mcp.local.yml`. IDs may be full loader IDs or an unambiguous short ID such as `mcp-chrome`. |
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
