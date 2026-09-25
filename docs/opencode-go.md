# OpenCode Go

DSCODE can run a session on an [OpenCode Go](https://opencode.ai/docs/go/) subscription: $10 a month for open coding models. You sign in with your OpenCode account; there is no API key to paste. The route is `opencode-go`, next to DeepSeek, OpenRouter and Grok.

## Setting it up

1. Enter `/opencode login`. DSCODE shows a code and opens the OpenCode console in your browser.
2. Approve the code there. The page names the **OpenCode CLI**: DSCODE signs in through the OpenCode CLI's login client, so this is expected. The command answers at once and keeps waiting in the background for up to ten minutes; `/opencode` shows how it ended.
3. Enter `/provider opencode-go`. `/model` picks among the Go models and `/effort` sets their reasoning.

`/provider opencode-go` (or `/provider opencode`) before signing in, and `/login opencode-go`, point you to `/opencode login` instead of asking for a key.

**Upgrading from 0.7.31**, which used a console API key: that key is no longer read. Run `/opencode login` once. The stored `OPENCODE_API_KEY` stays in `~/.dscode/credentials.yaml` unused until you remove it.

## The account login

```
/opencode           status: who is signed in, or how the last attempt ended
/opencode login     show a code, open the browser, and sign in in the background
/opencode cancel    stop waiting for the current code
/opencode logout    remove the login from this machine
```

- DSCODE keeps its own login, stored as `OPENCODE_OAUTH` in `~/.dscode/credentials.yaml`. It is separate from any `opencode auth login` on the same machine, and signing in or out of one does not affect the other.
- The login picks the first organisation (by name) with a Go subscription. Requests go to the inference endpoint the OpenCode console names for that organisation. The public `zen/go/v1` endpoint accepts only console API keys, not the login.
- The access token lasts 30 days and renews itself before it expires. Each renewal replaces the refresh token, and the new one is written back at once. Several DSCODE sessions share the login: when one has renewed first, the others pick up its token instead of failing.
- If the login is revoked or cannot be renewed, requests fail with a message asking for `/opencode login` again.
- `/opencode logout` only removes the local copy. The token stays valid on OpenCode until it expires; revoke it in the OpenCode console to end it immediately.
- The login client belongs to OpenCode, not DSCODE, so OpenCode can restrict it at any time. If it does, this route stops working until DSCODE supports another way in.

## The models

Go serves each model over the protocol of the lab that made it. This release speaks the OpenAI chat-completions protocol, which covers these models:

| Family | Models | Reasoning efforts | Images |
|---|---|---|---|
| DeepSeek | `deepseek-v4-pro`, `deepseek-v4-flash`, `deepseek-v4.1-flash`, `deepseek-v4-flash-vision-exp` | high, max, Ultra | V4.1 Flash and Vision Exp |
| GLM | `glm-5.3`, `glm-5.3-flash`, `glm-5.2`, `glm-5.1` | low, high, max, Ultra (thinking cannot be switched off) | `glm-5.3-flash` |
| Kimi | `kimi-k3`, `kimi-k2.6` | off, low, high, max, Ultra | yes |
| Kimi | `kimi-k2.7-code` | low, high, max, Ultra | yes |
| MiMo | `mimo-v2.6-pro`, `mimo-v2.6-flash` | off, low, high | yes |
| MiMo | `mimo-v2.5-pro`, `mimo-v2.5` | off, low, high, max, Ultra | `mimo-v2.5` |
| LongCat | `longcat-2.0` | low, high, max, Ultra | no |
| Hy | `hy4-preview`, `hy3` | off, low, high, max, Ultra | no |
| Space Bunny | `space-bunny-free` | low, high, max, Ultra | yes |

The default is `kimi-k3` at high effort. Switching from DeepSeek or OpenRouter lands on the same model when Go serves it, and keeps the effort when that model offers it.

**Not yet available**: Qwen and MiniMax (Go serves them over the Anthropic messages protocol) and Grok, GPT Luna and Muse Spark (the OpenAI responses protocol). Naming one of them, for example with `dscode exec --model`, fails before any request with a message saying so.

## What to know

- **DeepSeek needs the Global region.** Go serves its DeepSeek models only to workspaces set to Global. Until then a request fails with "This Go model requires Global regions"; change it under your workspace's Privacy settings in the OpenCode console.
- **Usage in the footer.** Go caps the subscription per rolling five hours, per week and per month. On this route the footer's money slot shows how much of each is used, read from the account's usage endpoint once a minute: `Go · 5h 12% · 7d 3% · 30d 1%`. An exhausted window is marked `!`, and the slot then says when requests work again (`limited until 09-25 14:45`). Before the first read, or if the usage cannot be read, it shows `Go` alone. There is no dollar cost: a subscription has no per-call price for DSCODE to add up.
- **Limits are Go's.** A request past a cap fails with Go's own error.
- **Web search** goes through [Exa](https://exa.ai)'s hosted search, as OpenCode's own client does, because Go has no search endpoint. It needs no key. Set `EXA_API_KEY` (in the environment or the credential store) to run the searches on your own Exa account. The keyless tier is Exa's free offer with no published limits, so a busy session can be rate-limited. Only Go sessions use Exa; the other routes search as before.
- **Session identity.** Each request carries the session id in `x-opencode-session` and a `dscode/<version>` user agent, as Go asks of third-party clients.

## Configuration

The route's settings live in the `dscode-opencode-go` profile entry: `streamIdleTimeoutMs`, `maxRequestImageBytes` and `retryPolicy`. The endpoint is not a setting: the login names it.
