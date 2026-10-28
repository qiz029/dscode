# MiniMax

DSCODE calls the MiniMax Messages API directly with your API key.

## Connect

1. Run `/login minimax` and paste the key into the hidden input, or set `MINIMAX_API_KEY` in the environment that launches DSCODE.
2. Run `/provider minimax`. The default model is MiniMax M3.1 Flash.
3. Use `/model` to select a model. MiniMax M3.1 Flash also supports `/effort`.

The terminal stores a pasted key in the shared, owner-only credentials file, normally `~/.local/share/dscode-state/credentials.yaml`. An environment key takes precedence and is read-only. Keys are not included in agent messages.

## Models

| Model | API ID | Context window | Recommended output | Maximum output | Input |
| --- | --- | --- | --- | --- | --- |
| MiniMax M3.1 Flash | `MiniMax-M3.1-Flash` | 1,000,000 | 131,072 | 524,288 | text, image, video |
| MiniMax M3 | `MiniMax-M3` | 1,000,000 | 131,072 | 524,288 | text, image, video |

The built-in list is available before login and does not imply that an account can access every model. MiniMax controls availability, quotas and billing. The model IDs and limits follow the [official Messages API reference](https://platform.minimax.io/docs/api-reference/text-chat-anthropic.md).

MiniMax M3.1 Flash always uses adaptive thinking. It offers `low`, `medium`, `high`, `xhigh` and `max` effort and defaults to `max`. MiniMax M3 does not expose effort controls; its default request leaves thinking disabled. Both models stream responses and support DSCODE tools.

MiniMax M3 uses the `standard` service tier by default. Set the plugin's `serviceTier` option to `priority` to request priority admission. MiniMax M3.1 Flash does not send this field.

## Endpoint and continuity

The default global endpoint is `https://api.minimax.io/anthropic/v1/messages`. Set the plugin's `baseURL` to `https://api.minimaxi.com/anthropic` for the China endpoint. Requests use bearer authentication.

DSCODE retains native thinking and tool-call content for the next request. It drops retained thinking when the model, API key, system prompt, tools or preceding messages change, while preserving text and tool calls. Incomplete streams fail without committing a partial assistant turn. HTTP failures retain status and retry delay without echoing credentials or response bodies.
