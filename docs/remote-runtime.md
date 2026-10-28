# Remote runtime

Run the agent runtime on a server and the terminal on your own machine. Sessions, models, credentials, tools and files live on the server; the terminal only draws and sends input. The connection uses the same protocol as the local [background host](host.md), carried over TCP with a token.

> **Traffic is not encrypted.** The token, your prompts and the agent's output cross the network in plain text. Use a trusted network: a VPN such as Tailscale or WireGuard, a private LAN, or an SSH tunnel. Do not expose the port on the public internet.

## On the server

Install DSCODE on the server as usual, sign in to your model providers there (credentials stay on the server), then start the server in the folder you want sessions to default to:

```bash
cd ~/projects/app
dscode server --port 8080
```

It prints the command to run on your machine:

```
DSCODE server on 0.0.0.0:8080 (default folder /home/me/projects/app)
Traffic is NOT encrypted: use it on a trusted network (VPN, Tailscale, LAN) or through an SSH tunnel.
Connect a client with:
  dscode config --runtime 10.0.0.5:8080 --token dsk_… --alias devbox --set-default
```

`dscode server` runs in the foreground and never exits by idling. It prints its connection command only after the authenticated TCP listener answers. Stop it with Ctrl+C. Turns that are running stop with it, and sessions can be resumed after a restart. For unattended use, install a user service as below.

| Option | Meaning |
|---|---|
| `--port PORT` | TCP port (required) |
| `--bind ADDRESS` | Address to listen on; default `0.0.0.0` (every interface). Use the VPN interface's address, or `127.0.0.1` with an SSH tunnel |
| `--cwd DIR` | Default folder for new sessions; default the folder you start it in |
| `--yolo` | Full access and automatic approval for every session on this server, including local attachments and delegated agents |
| `--token TOKEN` | Use this token (at least 16 characters) instead of the stored one |
| `--new-token` | Replace the stored token; clients configured with the old one are refused |

The token is stored in `run/server-token` in the server's state directory (`~/.local/share/dscode-state/run/` for a self-contained installation), readable only by you, and reused on the next start.

For IPv6, pass an unbracketed bind address (`--bind ::` for every IPv6 interface or `--bind ::1` for loopback). Client runtime addresses need brackets, for example `dscode config --runtime '[::1]:8080' --token dsk_… --alias devbox`. The startup readiness check uses IPv6 loopback when binding to `::`.

A terminal on the server itself still works: plain `dscode` there attaches to the same runtime through its local socket, so you can share a session between the server and your machine. If a background host is already running when you start the server, it is stopped first when it has no attached terminal and no running turn; otherwise the server refuses to start until you exit those terminals.

## Unattended YOLO server

On Linux, add `--desktop` to run in a supervised private Xvfb session. The same
option is supported by `server install`. Launch applications with
`dscode desktop exec -- COMMAND`; see [Linux desktop control](computer-use.md#desktop-control-and-recovery)
for dependencies, recovery and shutdown behavior.


Start an explicitly unrestricted server with:

```bash
dscode server --port 8080 --bind 127.0.0.1 --cwd /absolute/project/path --yolo
```

YOLO applies to new, resumed, spawned and forked sessions on this Host. File and shell tools run without DSCODE sandbox confinement under the server's OS account. Tool approvals are automatically allowed and still recorded in session history. Browser access and developer tools are enabled for every HTTP(S) origin, overriding stored site blocks, and browser uploads/downloads can use absolute paths across the server filesystem. Native Computer Use grants access to all applications; `computer_confirm` automatically returns its normal single-use, action-bound token.

The startup banner, `dscode server status` and its JSON `runtime.yolo` field identify this mode. `/permission` reports `server-yolo` for an active session; `/browser status` identifies the override and marks saved site rules inactive. YOLO is a server launch setting, not a client-side toggle. The bearer token remains required; anyone attached to this server shares these permissions. Use a trusted connection as described above.

OS permissions and account authentication still apply. On macOS, Accessibility and Screen Recording must already be granted to the relevant runtime/helper; unattended desktop control also requires an available GUI session. YOLO does not bypass website login, CAPTCHA, application availability or file ownership. Cancellation, browser handoff, live page identity, fresh desktop observations and file-version conflict checks still apply.

Stop the foreground server and restart without `--yolo` to restore ordinary session and browser policies. YOLO does not write elevated session permissions or change saved browser grants. To keep YOLO across service restarts, include it at installation:

```bash
dscode server install --port 8080 --bind 127.0.0.1 --cwd /absolute/project/path --yolo
dscode server start
```

Changing an installed service's YOLO setting requires stopping and uninstalling that service, then reinstalling with or without `--yolo`. Sessions and credentials are retained. This mode belongs to the terminal/server runtime; it does not configure the separately packaged experimental Desktop Host.

## Run as a user service

On macOS, DSCODE uses a LaunchAgent in your GUI login session. On Linux it uses your systemd user manager. Run these commands on the server, with the same state directory and user account used for provider login:

```bash
dscode server install --port 8080 --bind 127.0.0.1 --cwd /absolute/project/path
dscode server start
dscode server connect
```

This example uses loopback for an SSH tunnel. Choose your VPN address for direct VPN access. Installation enables startup at user login; it does not start the server immediately. This is a user service, not a system-wide boot service. A Linux machine needs a running systemd user manager; keeping that manager alive after logout requires system configuration outside these commands. A macOS account without a GUI login session cannot start this LaunchAgent.

| Command | Result |
|---|---|
| `dscode server start` | Start the installed service and wait for both the local Host and authenticated TCP listener |
| `dscode server status [--json]` | Report installation, manager state and authenticated readiness; exit 0 when ready, 3 when stopped, 1 on a manager or readiness error |
| `dscode server logs --lines 100 --follow` | Follow the service log; omit `--follow` for a snapshot |
| `dscode server connect` | Explicitly print the client configuration command, including its token; replace `<server-address>` when listening on all interfaces |
| `dscode server stop` | Stop the service; it remains configured for the next login |
| `dscode server restart` | Stop it, start it and wait for readiness |
| `dscode server uninstall` | Stop it and remove its service registration, retaining sessions, credentials and logs |

Stop, restart and uninstall refuse while a terminal is attached or a turn is running. `--force` interrupts that work. These commands never stop an unrelated manually started Host; stop that Host before starting the service. Use `server stop` for a managed server instead of `host stop`. Reinstalling identical settings is harmless; to change the port, address, folder or YOLO mode, stop and uninstall before installing again.

The service definition contains paths and a small environment (`HOME`, `PATH` and DSCODE state/service identifiers). It does not copy API keys from the installing shell or contain the bearer token. Sign in on the server or put environment settings in its local `config/.env`; foreground and managed servers both read that file. Service logs omit the token-bearing connection command. macOS logs live in `run/server.log`; Linux logs use the user journal. The saved installation metadata is `run/server-service.json` in the state directory.

A standalone `dscode update` refuses attached terminals and running turns, pauses an idle managed server, then restarts it after either a successful update or a failed update attempt. A stopped service stays stopped. Source checkouts and Homebrew upgrades do not use this update lifecycle: stop the service before changing the installation and start it afterward. If the executable path changes (including a Homebrew Cellar path), uninstall and reinstall the service from the new installation.

## On your machine

Run the command the server printed:

```bash
dscode config --runtime 10.0.0.5:8080 --token dsk_… --alias devbox --set-default
```

It saves the runtime and reports whether it answers. Then:

| Command | Result |
|---|---|
| `dscode` | Start the terminal on the default runtime |
| `dscode runtime devbox` | Start the terminal on `devbox`, whatever the default is |
| `dscode runtime local` | Start the terminal on this machine |
| `dscode runtime` | List the configured runtimes; `*` marks the default |
| `dscode runtime devbox --resume <id>` | Every terminal option works after the alias |
| `dscode runtime devbox --cwd /srv/other` | Start the new session in another folder **on the server** |
| `dscode runtime status devbox` | Check the connection, version, server PID, session activity and effective default folder |
| `dscode runtime doctor devbox` | Also inspect the server-side folder and mounted model, tool and persistence services, without executing a model or tool |

Both inspection commands accept `--json` and exit with status 1 if a check fails. They do not start a local Host or change the default runtime. `doctor` checks registered provider adapters and mounted services; it does not validate provider credentials, execute tools, or prove that every MCP server is usable. An incompatible protocol is reported before additional diagnostic calls; servers without the diagnostic capability report that limitation. For this machine, use `dscode server status`, `dscode host status` or `dscode doctor --local`.

The terminal footer always identifies the remote runtime and its connection state, followed by the session's server-side path when space permits. These facts remain visible when other `/statusline` items are disabled. Narrow terminals truncate the path and session details after the connection identity.

Managing the list:

| Command | Result |
|---|---|
| `dscode config --list` | Same listing as `dscode runtime` (tokens are never shown) |
| `dscode config --default devbox` | Make `devbox` the default; `--default local` goes back to this machine |
| `dscode config --remove devbox` | Forget it; if it was the default, the default becomes `local` |
| `dscode config --alias devbox --cwd /srv/app` | Update the alias's default folder without re-entering its address or token |
| `dscode config --alias devbox --token …` | Update the token, retaining the address and folder; restart attached terminals to use it |
| `dscode config --alias devbox --runtime host:8080` | Update the address, retaining the token and folder |
| `dscode config --alias devbox --clear-cwd` | Remove the alias's folder override and use the server's default |

Updates preserve every unspecified field. Adding a new alias still requires both `--runtime` and `--token`. `--cwd` and `--clear-cwd` are mutually exclusive. Saving configuration does not require the server to be online; the command reports separately whether it can connect.

The list is stored in `runtimes.json` in your state directory, readable only by you, because it holds the tokens.

The folder for a new session is, in order: `--cwd` on the command line, the alias's `--cwd`, then the server's default folder. It is a path on the server. `--continue` picks the newest session of that folder.

## What runs where

| On the server | On your machine |
|---|---|
| Models, provider credentials and logins | Drawing the terminal, keyboard and clipboard |
| Tools: shell commands, file reads and edits | Input history, theme and language |
| The session's `AGENTS.md`, skills and hooks | Your external editor |
| `@` file completion, `/diff`, `/review`, the status-line branch | |
| `/export` (writes into the session's folder on the server) | |

Configuration lives on the server too: after editing `config/mcp.local.yml` there, adding a skill folder or changing an `AGENTS.md`, run `/reload` from your terminal and the server re-reads its own files ([details](host.md#picking-up-configuration-changes)).

Pasted screenshots and dropped files are read on your machine and uploaded with the message. A path that does not exist on your machine is passed to the server, which resolves it in the session's folder.

## When the connection drops

The terminal says `lost the connection to runtime devbox; reconnecting…` and keeps trying, then `reconnected to runtime devbox`. Work on the server continues meanwhile. After reconnecting, the transcript is filled in with everything committed while you were away; text that was streaming at that moment appears once its message is committed. An approval or question that was still open closes when the connection drops; the server offers it again after reconnecting, and you answer it there.

Only connection failures retry automatically. A refused token stops retries and marks the footer `token refused`; update the alias's token and restart the terminal. After a server restart, the terminal checks compatibility before announcing recovery or replaying approvals. An incompatible protocol marks the footer `version mismatch`, stops the client's streams and prevents further requests through that client. Update the incompatible side and restart the terminal. Neither failure stops the server or its running tasks.

New servers advertise a protocol revision and the exact Harness version they use. Matching contracts allow different DSCODE application versions to connect, including after a compatible server upgrade. An older server without this declaration still requires the same application version as the terminal. This does not promise compatibility between different Harness versions or migrate session data between them.

## Session recovery and safe mutations

After a server restart, reading a session shows persisted history; the first message or queue edit restores its Agent through the same owner used by native session commands. Concurrent requests share that recovery. The terminal identifies each submission with a request ID so retransmitting that request does not enqueue it twice. Typing the text again is a new submission. A failed send is not automatically replayed; API clients should preserve their request ID when retrying an uncertain result.

Interrupts target the turn the terminal observed and refuse if a newer turn has started. Deleting a session locks the observed subtree against writers and restores before removing logs, and refuses if any member is already owned. Disk errors can still cause partial deletion and are reported with progress. Invalid history pages stop the affected follow stream with an error instead of silently truncating history or paging forever. See the [session mutation contract](runtime-protocol.md#session-mutation-guarantees) for API details and persistence limits.

## Refusals

DSCODE never falls back to this machine when you asked for a remote runtime:

| Message | Fix |
|---|---|
| `runtime devbox refused the token` | The server's token changed (`--new-token`); copy the new `dscode config` line from the server's output |
| `runtime devbox (…) did not answer` | The server is not running, the address or port is wrong, or a firewall blocks it |
| `runtime devbox: incompatible runtime: …` | Match the required protocol and Harness versions; an older server requires equal DSCODE versions |
| `no runtime named devbox` | `dscode config --list` shows the configured names |

## Limits

- No encryption and no user accounts: anyone holding the token has full control of the server's runtime, including its tools and credentials.
- One server per state directory, and every terminal acts as the same user.
- `dscode exec`, `dscode acp`, `dscode trigger` and `dscode host` act on this machine only.
- An editor or file link opened from the terminal opens on your machine, where the server's paths may not exist.
- A provider login whose browser step redirects to `localhost` must be completed on the server; start it from a terminal on the server.
