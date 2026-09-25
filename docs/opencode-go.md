# OpenCode Go

DSCODE can run a session on an [OpenCode Go](https://opencode.ai/docs/go/) subscription: $10 a month for open coding models behind one API key. The route is `opencode-go`, next to DeepSeek, OpenRouter and Grok.

## Setting it up

1. Subscribe to Go in the OpenCode console and copy its API key.
2. Enter `/provider opencode-go` (or `/provider opencode`). DSCODE asks for the key, stores it in `~/.dscode/credentials.yaml` with `0600` permissions like every other provider key, and switches the session to a Go model.
3. `/model` picks among the Go models and `/effort` sets their reasoning.

An `OPENCODE_API_KEY` environment variable takes precedence over the stored key. `/login opencode-go` replaces the key.

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
- **Limits are Go's.** The subscription is capped per five hours, per week and per month. A request past a cap fails with Go's own error; DSCODE does not read the remaining allowance.
- **No cost figure.** The footer's money slot shows `--` on this route: a subscription has no per-call price for DSCODE to add up.
- **Web search** goes through [Exa](https://exa.ai)'s hosted search, as OpenCode's own client does, because Go has no search endpoint. It needs no key. Set `EXA_API_KEY` (in the environment or the credential store) to run the searches on your own Exa account. The keyless tier is Exa's free offer with no published limits, so a busy session can be rate-limited. Only Go sessions use Exa; the other routes search as before.
- **Session identity.** Each request carries the session id in `x-opencode-session` and a `dscode/<version>` user agent, as Go asks of third-party clients.

## Configuration

The route's settings live in the `dscode-opencode-go` profile entry: `apiKeyEnv` (default `OPENCODE_API_KEY`), `baseURL` (default `https://opencode.ai/zen/go/v1`), `streamIdleTimeoutMs`, `maxRequestImageBytes` and `retryPolicy`.
