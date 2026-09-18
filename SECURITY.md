# Security Policy

## Supported versions

Only the latest released `0.7.x` version receives security fixes. Update with `dscode update` before reporting.

## Reporting a vulnerability

Use GitHub's private [Report a vulnerability](https://github.com/qiz029/dscode/security/advisories/new) form. Please do not open a public issue, and never paste credentials, session IDs or session contents into a public issue or discussion.

Include the DSCODE version (the TUI header, or `npm view @toddzheng024/dscode version`), your macOS version, `node -v`, and the smallest reproduction you can manage.

## What runs where

DSCODE is a local harness: the agent loop, shell execution, file access, approvals and credentials all run on your machine.

- Sessions, review records and cost data live in the local data directory (`~/.local/share/dscode-hub`, overridable with `DSCODE_HOME`). They are not uploaded.
- Credentials live in owner-only local files (`~/.dscode/credentials.yaml`, and the DSH home's `.credentials.yaml`), or in the macOS Keychain for publishing tokens.
- Cross-session messaging uses a local Unix socket and a local SQLite mailbox with owner-only permissions, reachable only by processes on the same machine.
- The Hub client sends optional aggregate telemetry. Payloads contain no account, machine ID, IP-address field, local path, profile contents, configuration value, environment value or secret. `dsh-hub telemetry off`, `DSH_HUB_TELEMETRY=0` or `DO_NOT_TRACK=1` disable it, and `DSH_HUB_TELEMETRY_DEBUG=1` prints the exact next event without sending it. See the [privacy notice](https://dshpluginhub.ai/privacy).

## In scope

- Sandbox or approval bypasses: an action that executes outside the configured policy.
- Credential exposure: secrets written to logs, session events, telemetry, or files another user can read.
- Local IPC weaknesses in the session bridge: authentication, path permissions, mailbox isolation.
- Skill, hook or MCP handling that lets untrusted content escalate permissions.

## Out of scope

- Prompt injection and model output quality.
- A machine that is already compromised, or a malicious browser extension.
- Third-party MCP servers, skills or hooks you install.
- The upstream DSH packages' own behaviour.

## Hardening notes

- Automatic review is a convenience, not a security boundary. Keep the approval policy at `ask` for work you do not trust.
- Skills, hooks and MCP servers run with your user's privileges. Review what you install.
