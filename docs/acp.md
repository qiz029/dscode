# ACP clients

Run `dscode acp` to expose the DSCODE agent preset through Agent Client Protocol over newline-delimited JSON-RPC on stdin/stdout. The terminal interface is disabled. The ACP client supplies an absolute workspace directory when creating a session; tools run on the computer running DSCODE.

## Connect a client

Configure your client's custom ACP agent with executable `dscode` and arguments `["acp"]`. If the editor cannot find `dscode` on its PATH, use the absolute path printed by `command -v dscode`. Keep stdin open for the lifetime of the connection.

To select an initial model explicitly, use:

```sh
dscode acp --model custom-your-provider-id/your-model-id
```

Without `--model`, the bridge uses DSCODE's saved default provider and model. Set up credentials and custom services in the normal TUI first with `/login` or `/provider custom`. The stable custom provider ID is recorded in `$DSCODE_HOME/providers.yaml`; it is not the service's display name. API keys stay in the existing credential store. Clients supporting ACP configuration options can select an advertised model and reasoning effort after creating a session.

The ACP model picker lists models from providers with configured credentials or account login, plus saved custom services using no authentication. Credential checks follow each provider's configured reference, including environment variables and saved keys. DeepSeek Account and DeepSeek API-key routes are checked separately. Providers with no recognized configuration metadata are omitted.

The current model remains listed even when its credentials are missing, so an explicit selection or resumed session is never silently switched to another model. This exception retains only the current model, not that provider's entire catalog. Configured credentials do not prove that a key is valid, credits remain, the endpoint is reachable, or every advertised model is permitted; filtering makes no inference requests. After changing credentials, reconnect the ACP client to refresh its picker. Saved custom service changes also refresh options in connected sessions.

## Current credential balance

Send `/status` as a standalone text message. The command is advertised to clients and returns the selected provider, model, balance information and query time without a model turn. It also works after switching models or resuming a session. Attachments and ordinary text mentioning `/status` remain normal model input. Arguments are rejected with usage guidance.

DeepSeek API keys show the official account balance and currency; DeepSeek account login shows recharge and bonus wallets separately. OpenRouter shows account credits and the current key's remaining spending limit separately, plus the effective budget when provided. A key without a spending cap does **not** mean unlimited account funds. If OpenRouter denies account-credit access but permits key inspection, the key information remains available. Only the active inference credential is used, never a separate management key.

Each invocation makes a fresh query using the selected route's configured credential reference. Keys and raw provider errors are not printed. Missing credentials, failed queries and timeouts are reported explicitly; they are not shown as zero. The lookup waits at most eight seconds and supports cancellation. Other providers, including custom API endpoints and subscription routes, currently report that balance lookup is unsupported. An overridden DeepSeek/OpenRouter endpoint is not queried through the official billing API. The result is sent to the client without adding a model-history turn; replay of that display depends on the client.

For a source checkout, the equivalent executable is `node` with arguments `["/absolute/path/to/dscode/bin/dscode.mjs", "acp"]`. Source checkouts and packaged installations keep their existing state directories. `--patch FILE` adds a trusted composition overlay and can be repeated. `dscode acp --help` prints usage without starting the runtime or installing a profile.

## Behavior and limits

- A failed model turn sends a clearly labeled `DSCODE — Request failed` text update before returning JSON-RPC error `-32603`. Error data includes the session ID, a bounded failure code and explanation, and HTTP status when available. The update is a transport diagnostic, not a model-generated answer or a successful completion. Clients that persist text updates can retain it in their history. User cancellation keeps the native `cancelled` result and does not emit a failure notice.
- DeepSeek transport failures retain recognized low-level network error codes and request elapsed time in their summary. Raw error chains, credentials and response bodies are not added to ACP failure output. A repeated duration alone does not identify the network cause. This is bounded diagnostic feedback, not a complete network trace.
- New and resumed ACP agents mount the `dscode` preset, including its tools and provider adapters. The bridge reuses DSH's native ACP implementation rather than translating terminal output.
- ACP sessions use the `ask` permission preset. Tool requests requiring approval are sent to the ACP client; the client can allow once, reject, or cancel. Normal sandbox rules still apply. The terminal's automatic model review is not the approval decision maker for these sessions.
- Standard session creation, prompts, cancellation, model configuration, listing, resume, close and MCP attachment are inherited from the pinned DSH bridge. Resume reconnects a session without replaying its transcript.
- The inherited bridge identifies itself as `deepseek-harness-acp`. It advertises `/status`; other terminal slash commands are not exposed. It does not advertise `session/load`, modes, terminal delegation, client filesystem operations or interactive question forms. Clients requiring those features need additional integration; a successful protocol handshake does not establish full editor compatibility.
- The first ordinary user message starts automatic session naming in the message's language. A deterministic title from the message's opening text appears first; an asynchronous request to the session's selected model can replace it with a concise title (about five words or ten CJK characters). Later messages and resume retain the title without another naming request. `/status` does not trigger naming. The additional request uses the configured model API and can incur usage; failure or timeout leaves the fallback title and does not fail the main turn.
- Titles are saved with the session, included in `session/list`, and sent through standard `session_info_update` notifications when they change and when a session resumes. Display depends on the client's support for these fields and updates. Session-card generation and memory generation remain disabled in this transport. Configured providers, tools and other integrations remain available; ACP is not an offline mode.
- Stdout is reserved for protocol frames. First-install progress and launcher diagnostics go to stderr. Trusted custom patches must also respect this rule.
- Closing stdin shuts down the runtime. SIGTERM is forwarded by the launcher. Sessions persist in the same installation's state directory, and a running ACP process holds the normal installation lock against upgrades.

## Verification

`node scripts/verify-acp.mjs` exercises the source CLI with a fixture model and custom API, without paid model requests. It checks automatic naming on the first ordinary message, fallback after an empty model title, live title updates, persisted titles in listing and resume, and no naming request for `/status` or later messages. It checks configured model filtering on creation, selection and resume, rejects unadvertised model selections, and verifies current-model retention after a custom service starts requiring credentials. It also checks that a failure after a tool call sends exactly one diagnostic before the structured prompt error, and that cancellation does not emit a failure notice. Unit tests also cover credential references, account and login records, lookup failures, argument validation, preset composition, title forwarding, source routing and legacy npm launcher compatibility, cleanup and signal forwarding. Client-specific UI behavior must be verified in the intended editor.
