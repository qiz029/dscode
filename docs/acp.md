# ACP clients

Run `dscode acp` to expose the DSCODE agent preset through Agent Client Protocol over newline-delimited JSON-RPC on stdin/stdout. The terminal interface is disabled. The ACP client supplies an absolute workspace directory when creating a session; tools run on the computer running DSCODE.

## Connect a client

Configure your client's custom ACP agent with executable `dscode` and arguments `["acp"]`. If the editor cannot find commands installed through nvm, use the absolute path printed by `command -v dscode`. Keep stdin open for the lifetime of the connection.

To select an initial model explicitly, use:

```sh
dscode acp --model custom-your-provider-id/your-model-id
```

Without `--model`, the bridge uses DSCODE's saved default provider and model. Set up credentials and custom services in the normal TUI first with `/login` or `/provider custom`. The stable custom provider ID is recorded in `~/.dscode/providers.yaml`; it is not the service's display name. API keys stay in the existing credential store. Clients supporting ACP configuration options can select an advertised model and reasoning effort after creating a session.

For a source checkout, the equivalent executable is `node` with arguments `["/absolute/path/to/dscode/bin/dscode.mjs", "acp"]`. Source and npm installations use their existing, separate state directories. `--patch FILE` adds a trusted composition overlay and can be repeated. `dscode acp --help` prints usage without starting the runtime or installing a profile.

## Behavior and limits

- New and resumed ACP agents mount the `dscode` preset, including its tools and provider adapters. The bridge reuses DSH's native ACP implementation rather than translating terminal output.
- ACP sessions use the `ask` permission preset. Tool requests requiring approval are sent to the ACP client; the client can allow once, reject, or cancel. Normal sandbox rules still apply. The terminal's automatic model review is not the approval decision maker for these sessions.
- Standard session creation, prompts, cancellation, model configuration, listing, resume, close and MCP attachment are inherited from the pinned DSH bridge. Resume reconnects a session without replaying its transcript.
- The inherited bridge identifies itself as `deepseek-harness-acp`. It does not advertise `session/load`, modes, slash commands, terminal delegation, client filesystem operations or interactive question forms. Clients requiring those features need additional integration; a successful protocol handshake does not establish full editor compatibility.
- Title generation, session-card generation and memory generation are disabled in this transport. Configured providers, tools and other integrations remain available; ACP is not an offline mode.
- Stdout is reserved for protocol frames. First-install progress and launcher diagnostics go to stderr. Trusted custom patches must also respect this rule.
- Closing stdin shuts down the runtime. SIGTERM is forwarded by the launcher. Sessions persist in the same installation's state directory, and a running ACP process holds the normal installation lock against upgrades.

## Verification

`node scripts/verify-acp.mjs` exercises the source CLI with a fixture model and custom API, without paid model requests. Unit tests cover argument validation, preset composition, source and npm launcher routing, cleanup and signal forwarding. Client-specific UI behavior must be verified in the intended editor.
