# dscode exec

`dscode exec` runs one prompt through the full dscode agent without the TUI, streams the reply to stdout and exits with the turn's outcome. It is the non-interactive counterpart of the TUI, in the spirit of `claude -p`.

```sh
dscode exec "summarize the failing tests in this repo"
git diff | dscode exec "review this diff for bugs"
dscode exec --json --effort low "list the top-level directories" | jq -r 'select(.type=="result").text'
```

Both the source checkout (`bin/dscode.mjs`) and the npm launcher (`@toddzheng024/dscode`) provide the command; the launcher runs it against its installed Hub profile, installing it first when needed with the installer's output on stderr.

The prompt is taken from the arguments, or from stdin when it is omitted or given as `-`. The agent runs in the current directory (or `--cwd DIR`) with the same preset, tools, skills, MCP servers and memory as the TUI, so it can read and edit files and run commands.

## Output

- stdout receives only the assistant's text, streamed as it is produced.
- stderr receives tool activity (`→ bash …`), approval notices, errors and finally `session <id>`. `--quiet` drops the activity and the session line.
- `--json` switches stdout to JSON lines: `{"type":"session",…}` first, then `text`, `tool` and a final `result` object with `sessionId`, `reason` and the last assistant `text`.

Exit codes: 0 completed, 1 model or runtime error, 2 output-token ceiling, 3 blocked, 124 timeout, 130 aborted.

## Options

| Option | Meaning |
|---|---|
| `--cwd DIR` | Workspace for the agent. Default: current directory. |
| `--model PROVIDER/ID` | Model route. Default: the saved default model. |
| `--effort LEVEL` | `low`, `high`, `max` or `ultra`. Default: the saved default effort. |
| `--permission PRESET` | `auto`, `ask`, `workspace-write`, `read-only` or `danger-full-access`. Default: the profile default. |
| `--approve-all` | Answer every approval request with allow. Without it a request that reaches the human fallback is rejected, since nobody is watching. |
| `--resume SESSION_ID` | Continue an existing session; the id is printed at the end of every run. The session stays bound to the folder it was created in: a resume from another directory still writes the session's log there and reports it there, while this run's own working directory remains the one it was launched in, so run it from the session's folder (or pass `--cwd DIRECTORY`) when the turn must touch that folder. |
| `--timeout SECONDS` | Give up and exit 124. |
| `--patch FILE` | Extra dsh composition overlay, repeatable. |

## How it works

The CLI half (argument parsing and the overlay in `plugins/exec/cli.mjs`, driven by `scripts/exec.mjs` in a checkout or `packages/launcher/manager.mjs` in the launcher) provisions the runtime like `dscode` does, then starts the same dsh Host with an overlay that disables the TUI rows and session cards and inserts `plugins/exec/index.mjs`. That plugin composes a `dscode` agent, applies the permission preset, forwards live text chunks and session events to stdout/stderr, answers approval requests, and asks the Host to exit when the turn ends. Sessions are ordinary dscode sessions: they appear in `/resume` and can be continued in the TUI.

`scripts/verify-exec.mjs` exercises the command end to end against a fixture model (`npm run test:integration`).
