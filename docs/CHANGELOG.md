# Changelog

All notable changes to DSCODE, newest first. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions match the npm launcher and the Hub profile.

Per-release notes in Chinese live in [`docs/releases/`](releases/); the entries below summarise them.

<!-- Add upcoming changes under Unreleased. -->

## [Unreleased]

## [0.7.25] - 2026-09-21

### Added

- A Homebrew formula installs the launcher: `brew tap qiz029/tap && brew trust qiz029/tap && brew install dscode` (Homebrew 7 refuses an untrusted third-party tap) takes the published launcher tarball into the formula's `libexec`, links `dscode`, and writes `.dscode-brew` beside `cli.mjs`. `brewManaged()` reads that marker, so on a formula installation `dscode update` moves only the Hub profile and an explicit version is refused with a pointer to `brew upgrade dscode`, which owns the launcher. The tap's own workflow follows `npm view @toddzheng024/dscode version` daily, recomputes the tarball's sha256 and commits the formula; it is deliberately not wired to this repository's tag push, because the launcher is the publish job's last stage.

### Changed

- Re-running the installer keeps a tar installation current instead of refusing: it reads the installed version, reports and changes nothing when that version is equal or newer, and hands an older one to the installation's own `dscode update`, which migrates the state and leaves `.dscode-backup-<version>` beside it. Anything the installer did not create — a foreign directory, or a `dscode` command belonging to another installation such as a source checkout — is still refused with the path it found, and that check now runs before the download rather than after it. [Distribution](distribution.md)

## [0.7.24] - 2026-09-21

### Added

- `/goal[20]` sets the goal's round cap from the command plane: `/goal[20] <objective>` creates the goal with that cap and `/goal[20]` re-caps the current goal, so an unattended task stops after the rounds the human allowed. A cap with no goal, or a control word after a cap, is refused with the usage. Upstream's `/goal` remains the surface; a runtime patch (`dsh-command-goal`) adds the shorthand.
- Triggers start a fresh session from an event: definitions live in `<state>/triggers/` and `<workspace>/.dsh/triggers/` (a project file wins on the same id) with `interval`, `calendar`, `watch`, `poll` and `external` sources, an absolute workspace, a goal objective with a round cap, and run limits; `ask` is refused, because an unattended run can never answer an approval. An event may carry only data (`source`, `title`, `text` and scalar `fields`) under a required `eventId`, so nothing can smuggle a permission or a session into a run, and the spool consumes it when a run starts. `dscode trigger run <id>` takes a single-flight lock, refuses a disabled definition, a missing workspace, a repeated event (a scheduled firing is identified by its cadence window), a spent daily cap and a too-recent run, and records the outcome, reason, exit code, session, cost and rounds in `triggers/runs.jsonl`; `fire` posts its own event first, `emit` only posts, and `list`/`show`/`log`/`log --failed`/`events` and the terminal's `/triggers` read the definitions, the records and the spool. [Triggers](triggers.md)
- Triggers run unattended and can be scheduled: the spawned Host replaces the terminal with the trigger overlay, creates its goal through the goal service (the model-facing tool requires a human turn), delivers the prompt with the event's values, and stops on the goal's own end, a round or cost cap, a pause, the timeout, or a needed approval — fail closed, marked `approval_required`. `dscode trigger install <id>` writes and loads a launchd LaunchAgent (`interval`/`poll` → `StartInterval`, a five-field `calendar` → `StartCalendarInterval`, `watch` → `WatchPaths`), refuses any cron shape launchd cannot express instead of approximating it and prints the crontab equivalent, while `poll` runs its `check` in the workspace and starts a session only on exit 0. `new`, `enable` and `disable` complete the CLI, which the published launcher routes like `exec` (shipping the portable half as `trigger/` plus `yaml`), and the vendored goal command carries the `/goal[N]` patch into the bundle. Nothing notifies on a failed run yet: the run log is the pipe a notifier will read.
- MiMo V2.6 drives the OpenRouter route: `xiaomi/mimo-v2.6-pro`, `-flash` and `-pro-ultraspeed` join DeepSeek V4 and Kimi K2.6 in replaying `reasoning_content` on an assistant turn, because Xiaomi's API answers 400 Invalid Format when a thinking-mode multi-turn request does not pass the field back, and the whole `xiaomi/mimo-v2.6` line is matched so a new size arrives covered. The live listing already supplies their context, prices and reasoning bands (`off`/`low`/`medium`/`high`, default `high`); a probe with a real key is still owed, so the family is not yet claimed as tuned and tested.

### Changed

- OpenRouter's `/model` lists a curated set instead of the catalogue: `plugins/openrouter/adapter.mjs` keeps a hand-written `LISTED_MODELS` of the current DeepSeek, GLM, Kimi, Qwen and MiMo models plus the flagship line of Anthropic, OpenAI, Google and xAI (28 ids, each verified to exist and to call tools against the live listing), where that listing carries 373 tool-calling models and an alphabetical wall of them is not a picker. Only the picker narrows — `resolveModel` still serves every id the listing knows, so a session already on a trimmed model, `dscode exec --model` and a provider switch keep working; an id OpenRouter retires drops out until the list is edited by hand. [TUI commands](tui-commands.md)

## [0.7.23] - 2026-09-20

### Added

- The last completed turn's cost rides the footer's money figure (`$1.23 / $9.86 · #12 $0.04`), and `/usage` gains a `cost` column that prices every turn from the same ledger, `+` marking a turn whose settled calls were not all priceable. Attribution charges a call to the turn that was running when it started, by binary search over the turn windows, so the once-a-second footer read stays O(calls × log turns); a call in the gap between two turns is reported rather than charged to a neighbour.
- `/tasks` lists this session's cross-session messages on demand — direction, peer, kind/mode, delivery state and a bounded body — folded from the same log the activity line reads.
- Cross-session communication is visible in the terminal: while a `send_session`/`reply_session` call is in flight the activity line reads `⇄ sending to <peer>`, a request awaiting its answer reads `⇄ waiting for <peer>`, and a settled send or an inbound relay prints one notice line. Both the activity line and the notice paint with the `steered` violet and the `⇄`/`←`/`→` glyph family instead of the brand blue and `•` every other local notice uses, so another session's traffic never reads as this session's own shell or model output. The feed is folded from the root log (`tool/call`, `tool/result`, bridge relays), so a restarted session rebuilds its history and only new traffic is announced.
- The status bar carries the loaded skill count by default: a `skills` figure reads the live session catalog, so it follows a skill added mid-session or a session switched to another workspace, and `/statusline` toggles and reorders it. The number is the effective catalog (model- and user-invocable entries alike) and stays `--` until the first catalog read settles.

### Changed

- The footer is laid out as two balanced rows instead of an empty identity row above a right-pinned metrics stretch. Row 1 now names the session and the model with its effort (`○ title · deepseek-flash @ ultra`), row 2 carries the status figures and closes with the live metrics as one left-hand cluster, and every separator is the lighter `·` (the metrics cluster used `|` and the clusters `｜` before). The figures read value first with a short qualifier — `~24.6 tps · 18.2 tps avg · 13% ctx · $0.42 · 87.3% cache` — so the labels no longer take half the cluster, and a balance the provider cannot report is dropped instead of parked as `$--`. `footer.current` is gone from the interface catalog and `footer.context` is the untranslated `ctx` abbreviation, like `tps`.
- Ancestor skill discovery is on by default: `.dsh/skills`, `.agents/skills` and `.claude/skills` from every directory between the working directory and home register at rank 300 with no configuration, nearest first, so a shared `~/Workspace/.dsh/skills` is visible to every project below it. `DSCODE_SKILL_ANCESTORS=0` (also `off`, `false`, `no`, `none`, `disable`) turns it off; an unrecognised value now keeps the default on instead of reading as off, while the `DSCODE_PROJECT_HOOKS` switch keeps its fail-closed enable spellings.

### Fixed

- The Ink repaint ledger reserved the whole previous frame height after a static flush, so the live region a settled step freed stayed on screen as a band of blank rows above the composer that the next stream had to refill (28 rows in a model of one turn on a 40-row terminal). The ledger now reserves only the rows the flush did not consume — the rule its own comment stated — which drops that band to what the flush left over (2 rows in the same model) while the composer still never rides up. `scripts/patch-ink.mjs` upgrades an already v2-patched `node_modules/ink` on the next `npm run setup` or launch.

## [0.7.22] - 2026-09-19

### Changed

- The Hub client moves to `@dsh-plugin-hub/cli` 0.5.0 (`@dsh-plugin-hub/schemas` 0.5.0 too). The pinned DSH runtime is now prepared and verified by the Hub CLI itself - an exact-version `npm install` into `$DSCODE_HOME/.hub/runtimes/<version>`, identity-checked and then launched with the current Node - instead of the launcher's per-bundle `npm exec`/`npx` wrapper, so an install no longer pays a registry round trip per bundle. The launcher still supplies its pinned `pnpm` 10.15.1 for the profile install and keeps its `npx` shim as the PATH guard. imapflow 2.0.5, mailparser 3.9.28, nodemailer 10.0.10, fflate 0.8.3, `@modelcontextprotocol/sdk` 1.30.0, yaml 2.9.1 and eslint 10.11.0.

### Fixed

- A failed launcher command printed only the last message, so a network failure under a managed network read as a bare `fetch failed`; it now prints the whole chain (`reason <- cause (CODE)`), once, truncated with `…` beyond five links and reported as `Unknown error` when no link carries a message.
- A Hub, update or install step that fails now names the causes to check on a managed network: the Hub call does not use `HTTP(S)_PROXY`, an internal mirror goes in `DSH_HUB_API_URL`, a TLS-inspecting proxy needs `NODE_EXTRA_CA_CERTS`, and the prebuilt GitHub release installs without the Hub. The proxy value itself is never echoed. First launch also states that the step downloads the pinned runtime and plugins with npm, which can take several minutes on a slow registry.
- An existing but unmanaged `dscode` profile no longer dead-ends in `inspect <path>`: the error names the directory, says that every command refuses while it is there, and prints a shell-quoted `mv` that unblocks the launcher.

## [0.7.21] - 2026-09-19

### Added

- `/btw <question>` runs a side question immediately in a child session seeded from the main log, read-only and on the cheapest supported effort, and renders the answer in its own panel. Beyond 400 seeded events (or before the first turn completes) the child runs unseeded with a bounded brief instead; either way the exchange never enters the main transcript, its model context, or the session cards.
- `dscode-time-marks`: every message a step admits and every turn that closes adds one hidden, plugin-sourced reading of the host clock to the model's context. The terminal renders nothing for it, and no message body is rewritten. Relay sources now carry `label`/`mode`/`composedAt`, so a queued message's wait is reported.

### Changed

- The status footer's geometry now follows terminal width alone. The permission badge anchors the first row's right edge, the cycle hint keeps its columns whether or not it is painted, and every live figure (counters, wall times, rates, tokens, cache share, context readout) is right-aligned inside fixed columns with `--` placeholders instead of groups that appear and vanish on a threshold. The telemetry string pads its live figures the same way and its slot reserves those columns; the money pair stays unpadded, because reserving those columns evicts a per-second figure at the widths the footer runs at.

## [0.7.20] - 2026-09-19

### Fixed

- Jev judged every escalation without ever seeing the user's instruction. `contextFor` hands the retained instructions over as `{ seq, text }`, but `approvalState` read `message.content[].text`, so `userInstructions` was always empty and `authorized` never rose above 0.07 - a user-authorized release then read as unauthorized and asked the human every time. The state now accepts `{ text }`, a string `content` and a content-block array, and a string `content` no longer throws a `TypeError` that silently disabled Jev.

### Changed

- Jev scores `authorized` on the instruction alone, separately from how risky the action is: an action the instruction asks for scores high even when it is dangerous, and a risky action nobody asked for scores low. The instruction almost never names the exact command, so the question is about the task it asks for, with explicit disjoint bands (>=0.9 directly asks for the step, [0.6,0.9) a necessary step of a stated task, [0.2,0.6) plausibly part of it but optional or unclear, <0.2 not covered). This score is what lets the allow-direction guards defer to the reviewer model, so the overlap that could flip a decision either way is gone. `verdict.deny` narrows "publish something" to a publication the instruction did not ask for.


## [0.7.19] - 2026-09-19

### Changed

- Jev's allow-direction guards (credential risk, hard-to-undo work, a non-`allow` choice, low confidence) no longer ask the human on their own when the retained instruction authorizes the exact action: they return `defer`, and the reviewer model - which sees the pending arguments and the instruction - decides. Jev's scores are coarse and this deployment already allows ordinary network access and a CLI's own stored credentials, so treating every such guard as a hard stop turned user-authorized work (a release that must leave the sandbox) into a manual approval every time. The deny direction is unchanged, `defer` is never read as approval, and a reviewer `human` verdict still reaches the user.

### Added

- The launcher copies a Hub login found in `~/.dsh/.hub/auth.json` into the state directory it hands the session as `DSH_HOME`, once, when no copy exists. A login made outside DSCODE previously left the CLI reporting "Not signed in" from inside a session whose `DSH_HOME` pointed elsewhere, which sent the agent looking for tokens it should never handle; the copy also lets the CLI refresh its own session under the state directory. An existing copy always wins, the directory is normalized to `0700` and the file to `0600`, and any read or write failure is ignored so the copy can never stop a launch.

## [0.7.18] - 2026-09-19

### Added

- Prebuilt release tarballs, `dscode-<version>-darwin-arm64.tar.gz` and `-darwin-x64.tar.gz`: the source tree with the locked `node_modules` already installed for that platform. The `curl | sh` installer and `dscode update` prefer the one for this machine, so installing and upgrading reach GitHub only and need neither npm nor an npm registry - a corporate registry proxy no longer ends the install at `npm ci`. The source tarball stays as the fallback for a platform without a prebuilt package, and `DSCODE_INSTALL_SOURCE=1` selects it. `npm run dist` builds all three (`DSCODE_PREBUILT_ARCHS` narrows or skips the prebuilt ones) and the release workflow and `make attach` upload them.
- The compaction eval can now pick discriminating samples and measure context fidelity without extra model calls. `--baseline <run> [--baseline-policy full]` keeps only the cases an earlier run answered in full (every repeat, no infrastructure error) and writes the filtered dataset next to the new run so the breakdown tool can re-verify its hash. `retention` in `scores.jsonl` - the `Evidence kept` columns in `report.md` - compares each probe's verbatim source quote against the exact context its answer came from, on token boundaries and with no judge call. Policies may carry a `summaryInstruction` that the eval inserts before the upstream summarization instruction, so summary-content A/B comparisons need no product change; `eval/experiments/` records the first one, where a keep-the-quotes instruction changed neither fidelity nor accuracy.

### Fixed

- A `.env` in the directory DSCODE was started from no longer affects the launch. Upstream read it as a project layer, so a workspace file injected its variables into the agent process, and one bootstrap-only name in it (any `DSH_*`, `NODE_OPTIONS`, a CA path) aborted the start with "only the launching environment may set". A pinned `dsh-app-boot` patch drops that layer on repository and tar installs; the installation's own `.env` is still loaded by the launcher.
- Compaction eval probe replies that are not a single JSON object, or that are cut off before the JSON completes, now get one protocol retry carrying a correction hint and counted in `answerRetries`; the rejected reply never enters the session, so a retry cannot affect later checkpoints. LongMemEval evidence quotes are cut on word boundaries instead of mid-word, so token-boundary fidelity matching no longer reports a false loss on an uncompressed history; the corrected dataset is written to `eval/private/longmemeval/tier1-wordboundary.json` without overwriting the original.

## [0.7.17] - 2026-09-18

### Changed

- Automatic compaction is now DSCODE's own `plugins/compaction/engine.mjs` - a `BasicCompactionEngine` subclass overriding `compactIfNeeded` and `summarize` - instead of four build-time rewrites of the upstream package. The priced threshold, completion reserve, background prefetch and overflow prune-first policy are unchanged; the durable surface transaction, marker pair and stability checks stay upstream, and `@deepseek-ai/dsh-compaction-basic` is no longer patched or vendored.
- `/language` offers every language the DSCODE message tables carry (`en`, `zh-CN`, `zh-TW`, `ja`, `ko`, `es`) instead of English and Chinese only: the picker, argument parsing and `language.json` persistence now follow `plugins/i18n`, so `zh`, `jp` and `繁體中文` resolve through its alias table and a saved `zh` upgrades to `zh-CN`. The terminal's own shell strings still translate English and Simplified Chinese alone; every other choice paints the shell in English and DSCODE's labels in the chosen language.

### Fixed

- The compaction evaluation harness mounted the unpatched upstream engine, so it stopped measuring the shipped policy after the subclass migration; it mounts `DscodeCompactionEngine` again, records the engine source hash, and lets the judge model differ from the tested model.
- `OpenRouterAdapter` reported the route's live 1M window during evaluation, which priced the threshold far above every replayed history; a windowed wrapper now reports the window the harness enforces.
- A semantic judge that wrapped its verdict object in a sentence or a fence silently ungraded whole batches, which made calibration fail (10/14, 6/14 and 4/14 across three models). The parser extracts the outermost object instead; calibration passes 14/14.
- A prefetch committed through the upstream transaction now opens its compaction marker before waiting for the background summary, so a threshold that arrives mid-prefetch still shows the compaction indicator.

## [0.7.16] - 2026-09-17

### Added

- A custom sandbox runner (`plugins/tui-tools/sandbox-runner.mjs`, enabled by copying `config/harness.local.example.yml` to `config/harness.local.yml`) applies the built-in write policy plus the one grant the stock macOS profile lacks — `/dev/ptmx` — so a confined command can allocate a PTY again, and it inherits the enclosing profile instead of nesting a second one. With it configured, `npm run doctor`, `make verify`, `make release` and a nested dscode run from inside a dscode session instead of only from a normal terminal.

### Fixed

- Automatic compaction now prices its threshold against the room the messages actually have. An adapter that reserves its completion budget inside the context window (the DeepSeek adapter defaults to 256k, exposed as `defaultMaxTokens`) rejects a request once messages plus completion exceed the window, so 90% of the full 1M window (943,718 tokens) sat above the real message ceiling of 792,576: the pressure path could never come due, and every compaction arrived through overflow recovery, which prunes and then summarizes synchronously. The v0.7.15 event log shows what that costs: `compaction/summary` arrived 26.8 s after `compaction/start`, and prefetch compaction - which is only ever planned inside the pressure path - never ran in any of the five sessions that compacted on this machine. `effectiveContextWindow` subtracts the reserve, in both the engine patch and the `/model` switch preview, so the priced threshold (713,318) and the prefetch mark (634,061) land below the ceiling the provider enforces.

- Overflow recovery no longer summarizes when the prune it already performs returned the request under the window. The caller retries whenever that prune replaced the surface, so the engine compares the post-prune measurement plus the reserved completion budget against the window (`fitsInWindow`) and returns null when it fits, turning the v0.7.15 case - 125 tokens over, 87,018 freed by pruning - from a 26.8 s summary into a prune plus retry. Compaction still runs whenever the pruned session cannot fit, and the skip requires an actual surface replacement, because one the caller cannot retry from would surface the original error instead.

## [0.7.15] - 2026-09-17

### Added

- Automatic permission review can be answered by TypeSafe Jev through OpenRouter's alpha Decisions endpoint instead of spending a reviewer model call. `dscode-jev` sends one request carrying four typed questions — a `choice` (allow/ask/deny) with per-option probabilities, whether the retained instruction authorizes this exact action, how hard the action is to undo, and whether it touches credentials — and decides in code with asymmetric gates: a decisive deny (confidence and `P(deny)` both high, or a slightly lower confidence corroborated by a crossed risk ceiling) is honoured, while allowing still needs a confident allow with no credential or hard-to-undo signal. An instruction Jev reads as authorizing the exact action vetoes a silent rejection. An unconfigured, unsure or failing Jev returns no verdict, so the reviewer model still answers and behaviour degrades to the previous one. The plugin is inert without a resolvable `OPENROUTER_API_KEY`, and `enabled: false` or removing the row disables it.

- Skills and workspace instructions can come from directories above the project: `DSCODE_SKILL_ANCESTORS=1` registers `.dsh/skills`, `.agents/skills` and `.claude/skills` from every directory between the project root and home at provider rank 300, so only headers enter the catalog while bodies stay lazy; the project's own roots are not registered twice, nothing above home is read, and a working directory outside home contributes nothing. Independently, `AGENTS.md`/`CLAUDE.md` from directories strictly above the project root up to home are folded into `$DSH_HOME/workspace-instructions/AGENTS.md` behind the user-global file, farthest ancestor first, and the preset now passes that directory as `dshHome`; with no ancestor file nothing is written and `$DSH_HOME/AGENTS.md` is read exactly as before. Both are resolved by the launcher from the session directory in the source checkout and from the bundle's bootstrap, and the preset reads them from the environment.

- Hooks layer a project on top of the installation by default: the launch directory's `.codex/hooks.json`, `.dsh/hooks.json` and `.claude/settings.json` (its top-level `hooks`) are merged, in that order, over `config/hooks.local.json` into `$DSH_HOME/hooks.resolved.json` (0600), and that one path reaches the pinned bridge in both the source checkout and the bundle. `DSCODE_PROJECT_HOOKS=0` loads the installation file alone, `.claude/settings.json` without a `hooks` key is skipped, and an event this bridge cannot run in a project file is skipped and listed for `/hooks` in `hooks.resolved.report.json` instead of failing startup, while the same event in `config/hooks.local.json` still fails it. A layer edit needs a restart, and a stale merge is removed once the layers are gone.

- The release sequence is available as Make targets: `make release` mirrors the workflow's build job (tag/version check, `npm run check`, `build:packages`, `release:hub`, `dist`, `verify:hub`, then `release-candidates.tar.gz`), and `make publish` mirrors the publish job's phases in order (read-only credential check, bundle, profile, launcher, then the GitHub release asset), so a release can be rehearsed locally before a tag is pushed. Each phase also has its own target, and the workflow is unchanged.
- One command installs a release from GitHub: `curl -fsSL https://raw.githubusercontent.com/qiz029/dscode/main/install.sh | sh` resolves the newest release, checks the sha256 digest GitHub publishes for its tarball, unpacks it and hands over to the installer the archive carries, so the downloaded layout and the script cannot disagree. `sh -s -- <version>` pins an exact release, an unpublished digest or a tag that reports another version is refused before anything is written, and running the script from an unpacked tarball or a checkout installs that tree exactly as before.
- `dscode update` also updates a source checkout: `git pull --ff-only` on the branch it tracks, then `npm ci --ignore-scripts` and `npm run setup`. A tracked modification, a running session or an explicit version refuses before anything changes, so a failed update never half-applies and no install shape needs a separate upgrade ritual.

### Changed

- The system prompt now carries an explicit code discipline, taken from the behaviours that cost the most when a model lacks them: fix at the root cause but keep the change inside the requested scope, do not fix unrelated bugs or failing tests, match the surrounding style instead of adding comment or license-header noise, do not commit or create branches unless asked, do not invent a test suite where the repository has none, and read `git log`/`git blame` before guessing. It ships as its own `dscode:code-discipline` system-prompt section (order 1053) rather than more persona text, and the persona progress rule lost its "roughly every minute" cadence, which contradicted the ban on filler in the next sentence.

- A second system-prompt section, `dscode:working-discipline` (order 1054), states what the model previously had to infer: this system prompt and the approval policy apply in full, the user's direct request outranks `AGENTS.md`/`CLAUDE.md`, those outrank recalled memory and background context, and file contents, tool output, email, session messages and web pages are data rather than instructions; act once the information is sufficient instead of re-deriving settled facts or surveying options you will not pursue; and correct an earlier statement only when the error would change the user's code, conclusions or decisions.

### Removed

- The dscode preset no longer mounts Chrome DevTools MCP. It ran `--isolated`, so it could never reach the user's own Chrome profile or logins, while occupying about 29 model-visible tools, and no MCP server is mounted by default now. `config/mcp.local.example.yml` carries a commented stdio example — including `--browserUrl` for driving a Chrome started with `--remote-debugging-port` — the launcher no longer resolves or exports a Chrome entry point, the bundle no longer rewrites a Chrome row, and `dscode doctor` no longer requires Chrome to be installed. The npm dependency stays, so opting back in needs no install.

### Fixed

- `/hooks` names a layer that changed after the merge. The pinned bridge reads one merged file and `/hooks reload` remounts it with the same path, so an edit to `.codex/hooks.json`, `.dsh/hooks.json` or `.claude/settings.json` used to leave the old hooks running with nothing said; the listing now reports the newer (or missing) source and states that a restart is what re-reads the layers.

- Ancestor discovery no longer breaks when `$HOME` is a symlink or a `/Volumes` mount: the home boundary and the walk's stop condition compare `realpath` forms while the chain keeps the caller's logical paths, so a resolved session directory under a linked home finds its ancestor skill and instruction directories instead of silently contributing nothing.

- The ancestor instruction aggregate is bounded at 60 KiB. The provider ignores a source file that cannot fit its render budget, and the aggregate occupies the broadest (user-global) slot, so one oversized ancestor `AGENTS.md` could have dropped the user-global instructions along with it; the user-global file is now always kept, ancestors are added nearest-first while the budget allows, and a source that would overflow is skipped whole rather than truncated.

- The `DSCODE_PROJECT_HOOKS` and `DSCODE_SKILL_ANCESTORS` switches only honour the documented enable spellings (`1`, `true`, `on`, `yes`): an unrecognised value such as `=no`, `=none`, `=disable` or `=2` now reads as off instead of arming the feature. The defaults are unchanged, so project hooks still layer unless `DSCODE_PROJECT_HOOKS` is set to a non-enabling value, and ancestor skill discovery stays off until it is set to an enabling one. Project hooks run as the OS user outside tool approval, so the previous behaviour armed a security-relevant gate on the natural spellings of "off".

- CI never provisioned the runtime the unit suite asserts. `npm run check` runs `tests/ink-frame.test.mjs`, which checks the patched `node_modules/ink/build/log-update.js` that only `npm run setup` (patchInkFrame) writes, so both Checks and the Release build job failed on every commit since 0.7.14 with "the composer rode up: 6 -> 2" — and no release could be cut from CI. Both workflows now run `npm run setup` before `npm run check`.
- Nothing retried the Hub: a single `Hub API 503` in the read-only credential check aborted a whole release before its bundle, profile, launcher and GitHub release steps, which is where v0.7.13's publish job stopped. Every Hub call now goes through a bounded retry (`scripts/hub-retry.mjs`, five attempts three seconds apart by default): a 5xx response or a transport failure is tried again, the last error is still rethrown so an outage fails a release instead of publishing blind, and a 4xx — bad token, missing package, immutable version — is never retried. `DSCODE_HUB_RETRY_ATTEMPTS` and `DSCODE_HUB_RETRY_MS` tune the two defaults.
- The npm registry version check asked for abbreviated metadata (`application/vnd.npm.install-v1+json`) on the `/latest` dist-tag endpoint, which the registry answers with 406. The launcher's own self-update, the TUI's `/update` lookup and the startup update notice all failed silently, so an npm/Hub installation could never move itself to a newer release.
- `dscode update latest` — the form the TUI's `/update` schedules when the user names no version — was rejected as "not an exact version" by the launcher and by the source/tar entry alike. It now means the newest release.

## [0.7.14] - 2026-09-17

### Added

- Automatic compaction prefetches. One lead below the priced threshold (70% for the default 80%) the engine summarizes the oldest compactable span in the background without appending anything, and reaching the threshold commits that summary instead of summarizing again, so the threshold wait is a wait for work already under way. Everything appended past the prefetched span stays verbatim behind the checkpoint; a prefetch invalidated by a manual compaction or a rewritten surface is dropped silently and the step summarizes afresh.
- Grok joins as a subscription provider. The adapter reads the `grok` CLI login (`~/.grok/auth.json`, never written back), streams from `api.x.ai/v1` with structured tool calls and reasoning, and takes its model list — context window, completion budget and the `low/medium/high/xhigh` effort detents — from the CLI proxy's `/v1/models`. The footer shows the quota the subscription reports instead of a cost: the weekly window from `/v1/billing?format=credits` as used percentage plus local reset time, falling back to "no usage reported" rather than inventing a number.
- Agent rows carry a local `HH:MM:SS` stamp: the tool card, the folded thinking block and the reply each lead with the row own event time, dimmed, and every block wraps to the width the stamp leaves over.

### Fixed

- Code review asks for thinking off instead of the lightest reasoning level. A DeepSeek reviewer spent its whole 90-second deadline reasoning at `low` (24k-56k reasoning tokens per call) and never wrote a verdict, so reviews of a real diff came back incomplete; with thinking off the reviewer so the deadline is spent on the report instead of tokens that never reach it; a model without an `off` level keeps its own default. `DSCODE_REVIEW_EFFORT` still overrides the level.
- DSCODE's credentials provider mounts again in a source checkout. A patch can only override a row's config keys and is skipped when its `name` differs from the row it targets, so the overlay that pointed the upstream `credentials` row at DSCODE's provider had mounted nothing outside the npm bundle (which rewrites that name at build time). The upstream row is disabled and DSCODE's provider inserted in its place: the shared `~/.dscode/credentials.yaml` store, the read-only Grok CLI login and the per-provider credential facts now agree on both surfaces, and a key saved before this change still resolves through the profile store.
- The composer no longer rides up on a static flush. Ink clears its repaint ledger every time `<Static>` history is written, so the rows a shrinking frame freed are now kept reserved across that clear (ink.js reports how many rows the static write consumed). The only-ever-pushed-down guarantee covered frames between flushes before this.
- A running shell command keeps its own output window: every sanitized chunk feeds a per-command buffer, the tool reads that buffer instead of re-reading the shared scrollback on every poll, and a poll without new output no longer replaces the accumulated text with the current viewport. A chatty neighbour on the same terminal — a background job, a release publisher, another session — can no longer make the shell report a dropped beginning for output that was never the command.

## [0.7.13] - 2026-09-16

### Changed

- The terminal is vendored as source: `packages/tui` carries the `dsh-code` 1.2.0 TypeScript sources with every DSCODE change written as code, and the text-patch pass over the published bundle is retired. The 27 patch scripts, the 6 UI verify scripts and the TUI probe go with it, so `scripts/patch-*.mjs` drops from 32 files to 6.
- Publishing compiles the vendored terminal: `scripts/build-tui.mjs` transpiles `packages/tui/src` into `packages/tui/lib`, because Node refuses type stripping for files under `node_modules`. A checkout still runs the sources directly, so ordinary edits need no build.
- The developer-runtime integrity guard now watches `packages/tui/src/index.ts`, and the full-inventory coverage baseline excludes the compiled terminal: it is build output, not first-party source.

### Fixed

- The composer hides the shell-mode bang. A `!cmd` draft is framed and carries its hint row, so the editor renders the draft without the routing prefix and moves the caret with it; routing, submission, paste markers and the row budget still read the real draft.
- `displayWidth` no longer counts zero-width marks as columns: `❄️` is U+2744 plus the U+FE0F variation selector, and counting that selector made the footer provider budget swing a column with the DeepSeek peak and off-peak window.
- Every DSH child the harness starts receives `--disable-warning=ExperimentalWarning`, so booting no longer prints the `node:sqlite` experimental notice. The flag is prepended to any caller-supplied node arguments, and the `exec` path no longer repeats it.

## [0.7.11] - 2026-09-16

### Changed

- The vendored TUI is upgraded to `dsh-code` 1.2.0 with every DSCODE patch re-anchored: the local command catalog moved to i18n description keys (DSCODE injects its own fallback instead of editing upstream tables), the header was rewritten upstream, and `/language` and `/review` became upstream features that DSCODE deliberately takes over. The runtime stays pinned to DSH `0.1.5-rc.2`.

### Added

- The TUI checks the npm registry once at startup and offers `/update` when a newer release exists; `/update` starts a detached helper that upgrades the whole installation (launcher binary plus profile, or the tar/source self-update) after the session exits, logging to `$DSH_HOME/update.log`. Set `DSCODE_UPDATE_CHECK=off` to skip the startup check.

### Changed

- DSH is pinned to `0.1.5-rc.2` across the dependency graph and the runtime patch gates; all nine runtime patches (including the macOS stdin inspector) were re-validated against the release, and the launcher's Hub CLI follows the version this repository verifies against.
- The `/model` picker lists only the session provider's models and presents them in alphabetical order of the displayed name (digits compare naturally); a search narrows the rows without re-ranking the remaining ones.
- Code review keeps a 32,768-token output budget (reasoning tokens count against it) and retries an attempt that spent the whole budget without writing anything at double the room, up to 65,536; the reviewer starts at the lightest reasoning level the model offers, and `DSCODE_REVIEW_MODEL=provider/model` with `DSCODE_REVIEW_EFFORT=<level>` pin its route the way Codex's `review_model` does. A review that still cannot finish reports what each attempt was allowed and how the model spent it.
- Update texts (`update.available`, `update.scheduled`, `update.usage`, `update.newest`) exist in all seven interface languages; the startup notice resolves through the TUI language runtime and `/update` follows the saved language.

### Fixed

- A turn that stopped for a reason the user did not ask for — an aborted hook, a blocked turn or a restart — now renders in the error color instead of the dim turn marker; user cancels and the model's output ceiling stay quiet.

## [0.7.10] - 2026-09-16

### Fixed

- `dscode --version` (and `-v`) on the tar and source entry prints the DSCODE version; previously it fell through to the DSH CLI and reported the runtime version (`0.1.5-rc.1`).

## [0.7.9] - 2026-09-15

### Added

- `dscode update` for tar installs: downloads the release tarball, verifies it against the release's sha256 digest, swaps the installation directory in place and migrates `.runtime`, `.env` and local `config/`; the previous installation stays as a sibling backup and source checkouts are refused.
- npm/Hub `dscode update` replaces the launcher binary with npm before upgrading the profile to the same version; without an argument it checks npm for a newer launcher and falls back to the recommended version when the registry cannot be read.
- `npm run lint` with an ESLint 10 flat config, included in `npm run check`.

### Fixed

- The escalation allowlist no longer auto-grants state-changing diagnostics (`sysctl -w`, assignment-like sysctl keys, argument forms of `hostname` and `date`).
- Code review omits untracked files that vanish or turn unreadable during collection instead of failing the review; audit reads skip torn or corrupt lines instead of breaking every later approval.
- A failed session-bridge recovery fails closed once and is retried by the next step instead of failing every later step.
- Email stores and verification scripts no longer throw from `finally` blocks, so cleanup cannot mask a success or the original error; the checks script reports both the runtime-integrity violation and the suite failure; six catch sites attach error causes.

## [0.7.8] - 2026-09-14

### Changed

- Bound automatic code review to two passes per task, 90 seconds per pass and 8,192 output tokens per attempt; follow-up review focuses on fixes and direct regressions.
- Add ordinary-text progress guidance and stable acceptance/closeout rules to the default agent.
- Cache session metrics incrementally, memoize footer and card calculations, and throttle invalid OpenRouter cache reads.

### Fixed

- Preserve incomplete ledger tails without dropping or duplicating rows.
- Prune settled mailbox history and recipient events; use small independent retention limits in tests.
- Validate bundle import rewrites, remove patch-module import cycles, and upgrade existing macOS stdin probes to backoff behavior.

## [0.7.7] - 2026-09-14

### Added

- `/model` searches as you type, with no `/` first, and ranks with BM25 on every keystroke: the model name counts most, then the model id, then the provider. The word being typed matches as a prefix (`kim` finds Kimi, `glm5` finds GLM 5.x); rows matching every word come first, and rows matching some words show only when none matches them all. A changed search focuses no row: Enter or an arrow focuses the first match, and Enter on a focused row selects it. Esc clears the search, then closes; Tab still opens providers and retry moves to Ctrl+R, since letters now always search.
- Pressing Enter on `/provider`, `/login` or `/openrouter` in the slash-command menu opens its picker straight away, instead of leaving the command in the input for another Enter or a typed argument.
- `/openrouter` shows the OpenRouter account: the balance, this key's limit and its spend today, this week and this month, and, with a management key, every API key's usage and the last 30 days of spend by model and the providers that served it (`r` refreshes, `m` sets the management key). After the OpenRouter API key is saved in `/provider openrouter` or `/login openrouter`, DSCODE offers an optional management key; it is checked against OpenRouter (an inference key is refused account activity), stored beside the other keys in `~/.dscode/credentials.yaml` (or taken from `OPENROUTER_MANAGEMENT_KEY`), and only read from.
- A running compaction, automatic or `/compact`, replaces the activity line with a small Tetris bot clearing rows and the message "Compacting context, please wait" (translated with `/language`), plus its elapsed time. A short terminal shows one board row.
- Picking a model in `/model` (or through `/provider`) whose route would compact the current context asks first: it shows the context size, the new model's threshold and window, and whether the next request overflows. `y` switches, `n`/Esc goes back.

### Fixed

- When OpenRouter refuses a key its account credits, the footer balance shows that key's remaining credit limit instead of `$--`.

### Changed

- OpenRouter runs through DSCODE's own adapter instead of pi-ai. Models come from OpenRouter's live listing, cached for a day, so new models appear without a DSCODE release; the first lookup waits up to 10 seconds for the listing. DeepSeek, GLM, Kimi and Qwen are tuned and tested; every other model with tool support is listed on a best-effort basis. Each model offers its own reasoning levels (DeepSeek V4 keeps the official detents, and Ultra is offered on models with `max`). Every request sends the session id, so a session stays on one upstream endpoint and keeps its prompt cache; Qwen gets explicit cache breakpoints. OpenRouter still chooses the upstream endpoint, but only among endpoints that support every request parameter and do not serve fp4-quantized weights (native INT4 models such as Kimi stay routable). The inert pi-ai profile earlier builds wrote is removed from the settings.
- OpenRouter errors route on their typed codes: failures reported inside a streaming response (such as an upstream 502) are retried, `Retry-After` is honoured, 402 means out of credits, and a context-length error starts compaction recovery.
- OpenRouter calls are charged at the cost OpenRouter reports, which covers BYOK fees and per-provider prices; list prices estimate only a call that reports none.
- `web_search` follows the session's route: an OpenRouter session searches through OpenRouter's web plugin (Exa), a DeepSeek session through DeepSeek. An OpenRouter-only user no longer needs a DeepSeek key to search.
- Session titles no longer run reasoning at the route's default effort on OpenRouter models, and their output cap is 1,024 tokens instead of 64. Automatic approval review asks for low effort and allows 4,096 output tokens instead of 768, so a reasoning reviewer can finish its verdict.
- The auto-compaction threshold follows the routed model's cache-read price over its input price: below 0.1 it compacts at 90% of the window, below 0.5 at 80%, otherwise at 60%. Unpriced routes keep 80%, and a `thresholdRatio` configured for compaction-basic, globally or per model, still wins.

## [0.7.6] - 2026-09-14

### Added

- `/provider openrouter` serves pi-ai's whole OpenRouter catalog (366 models, including Anthropic, OpenAI, Google, Qwen, Kimi and GLM) instead of three DeepSeek models, so no model has to be added by hand. The DeepSeek models keep the official detents through `modelOverrides`; every other model uses its own reasoning levels. Opening `/model` replaces the narrow profile 0.7.3 to 0.7.5 wrote, and a profile the user edited is left alone.
- `/model` has a search: `/` or Ctrl+F starts it, typed words filter by provider and model name, Esc leaves it and clears the filter, and ↑↓ and Enter keep working while typing.
- OpenRouter calls are priced from OpenRouter's live model listing (read without a key once an OpenRouter key is configured, cached for a day in the data directory), including cache-write prices and long-prompt tiers. The pinned DeepSeek prices remain the fallback.

### Changed

- Delegation (`subagent`, `subagent_fork`) is offered at every effort, not only Ultra. Below Ultra the shell policy makes it the exception: the agent works itself by default and delegates only substantial independent parts or a broad read-only investigation, one child at a time. Ultra keeps its collaboration policy, `workflow` and `ralph` stay unavailable, and the three-child cap applies at every effort. Models without a `max` level, which never offer Ultra, can now delegate.
- The review tool no longer caps its reviewer at 8,192 output tokens: the model's route default applies (256k on DeepSeek, the catalog limit on OpenRouter). Its deadline rises from 90 seconds to 10 minutes so a reasoning reviewer can finish a long report, and the report returned to the agent keeps up to 64,000 characters instead of 16,000.

### Fixed

- Reasoning effort follows the model instead of DeepSeek's detents. A route default the model does not support, such as the OpenRouter profile's `high` on a model without reasoning, now falls back to the model default instead of failing every call. Session cards, `/doctor`, memory, and the review tool under Ultra ask for the nearest level the model offers, or none. Memory accepts any standard level name; `dscode exec --effort` accepts `minimal`, `medium` and `xhigh` and is checked against the model before the turn starts. The child-effort guidance no longer names levels a model may lack, and `/status` no longer reports an xhigh wire effort for non-DeepSeek OpenRouter models.
- The footer's cache hit no longer reads `--` for every OpenRouter session. pi-ai reports cache reads only when there are some, and a call without the field made the whole session's figure unknown; a missing count now counts as zero.

## [0.7.5] - 2026-09-14

### Changed

- The review guidance and the `review` tool work outside a Git repository. Before a task's first tool call, dscode snapshots the workspace as a tree in a shadow bare repository under `DSH_HOME/review-baselines` (the workspace is never touched), and review diffs that baseline against a fresh snapshot; `path` narrows it, while `staged`, `base` and `commit` still need Git. Snapshots skip `.git`, `node_modules`, virtualenv and cache directories, the same sensitive files review already skips and files over 4 MiB, and a workspace with more than 20,000 files or 256 MiB returns `no_baseline` instead. The baseline is a ref per session, so it survives a resume, and a new task replaces it. Without a git executable there is no guidance and review still returns `no_repository`.

## [0.7.4] - 2026-09-14

### Fixed

- MCP calls work under `danger-full-access` again. Auto review turned every MCP call other than the Chrome read methods into an ask whatever the preset, and under the `never` approval policy the approval service rejects an ask before any `approval/request` handler runs, so the TUI rejected MCP silently and `dscode exec --approve-all` never got to allow it. The gate now stands down under `never`; presets on the `ask` policy still review or ask for MCP calls.

## [0.7.3] - 2026-09-14

### Added

- `/provider [deepseek|openrouter]` switches the session between DeepSeek's official API and OpenRouter; without an argument it opens a picker with each provider's key status. The first OpenRouter switch declares the pi-ai `openrouter` route in the settings document with DeepSeek V4 Flash, V4 Pro and V4 Flash Vision Exp (a profile the user already has is left alone), asks for a missing key and resumes, then lands on the counterpart of the current model with the same effort when the target offers it. The provider catalog ships beside the TUI as `lib/dscode-providers`, so the repository install and the vendored bundle load it the same way.
- Ultra works on OpenRouter. The pi-ai adapter is patched like the DeepSeek one (`dscode-pi-ai-ultra-v1`) and vendored into the bundle: a model that offers max also offers Ultra, which sends max (`xhigh` on OpenRouter) with the collaboration policy, and delegation tools are withheld below Ultra. The OpenRouter route offers the official off/low/high/max detents, sending `low` as `high` the way DeepSeek answers it, so session cards and delegated children that ask for low keep working, and `/effort` keeps the detent bar.

### Changed

- `/login [deepseek|openrouter]` stores either key; without an argument it targets the current provider. `OPENROUTER_API_KEY` joins `DEEPSEEK_API_KEY` in the shared `~/.dscode/credentials.yaml`, with the same environment precedence. An argument that is not a provider name is refused without being echoed.
- The footer follows the active provider: its balance is that provider's (OpenRouter: credits minus usage from `/api/v1/credits`), OpenRouter calls are estimated from the pinned pi-ai catalog's list prices (ledger `priceVersion` `openrouter-pi-ai-0.85.1`), and the 🔥/❄️ peak marker shows only for DeepSeek. `/status` names the wire effort Ultra sends on each route, and a missing-credential error now points at `/login`.

- `dscode exec` ships in the npm launcher. It runs the installed profile's exec runner with the same options, stdin prompt and exit codes as the source checkout; the argument parser and overlay moved to `plugins/exec/cli.mjs` so both entry points share them.

### Fixed

- The session cost ledger now times every model call. The `end` row kept the start `time`, so a call's duration always read as zero; it now also carries `endTime` and `firstTokenTime` (first text, reasoning or tool-argument delta), while `time` stays the start that prices the call.
- Model calls made for a session without a request `sessionId` — the review tool and `/review`, memory extraction and consolidation, session cards and `/doctor` — now reach that session's ledger with their own `purpose`. They are charged through an async context instead of a wire `sessionId`, which would also trigger session-log delivery, provider cache affinity and agent-only prompt shaping. Compaction and session titles already carried one.
- The review tool no longer skips work that was committed or merged. With nothing uncommitted, the default scope reviews the commits made since the latest user task started (HEAD from the reflog), and a `commit` review of a merge commit diffs against its first parent instead of printing an empty combined diff.
- `/effort` found no catalog row for a model id that carries its own vendor segment (`openrouter/deepseek/deepseek-v4-flash`): the TUI split the label at every slash. It now splits at the first.

## [0.7.2] - 2026-09-14

### Added

- GitHub Actions releases the verified packages. `.github/workflows/release.yml` builds the candidates on every `v*` tag (checks, `build:packages`, `release:hub`, `verify:hub`), uploads them, and publishes through a `release` environment gate in the documented order — bundle, Hub profile, launcher — using the `NPM_PUBLISH_TOKEN` and `DSH_HUB_TOKEN` secrets. A manual dispatch without the publish flag is a dry run, a dispatch with `verify_credentials` checks both tokens read-only (npm identity, Hub profile read, and whether the version is still free on npm) and stops, and a tag that disagrees with `package.json` fails before anything is published.

### Changed

- The TUI hands the terminal back its own scrolling, selection and copy. The 0.7.x in-place viewport drew a full-screen frame, wiped the terminal scrollback and had to capture the mouse to make the wheel work; now the settled transcript is printed once through Ink's Static output, so it lands in the terminal's scrollback and the wheel, drag-selection and copy stay native. `PageUp`/`PageDown` in-app scrolling and the `/mouse` command are gone with it. The welcome box is now the first scrollback row and scrolls away with the session; the per-turn rule rides each finished entry. Installs still carrying the in-place generation must refresh their dependencies (`npm ci`) — the launcher refuses to patch that text in place.

### Fixed

- The CI checks stopped flaking. The session-messaging fixture allowed three seconds for a whole second-Host handshake (and killed its child after twenty), which a loaded runner can miss, so its poll now runs for fifteen seconds under a sixty-second guard and names the wait that expired; the launcher lifecycle fixture reported its stub runtime ready before the stub could take `SIGTERM`, so a signal that arrived in between made the launcher report a failed stop. The login runtime fixture now accepts Node's unsettled-top-level-await exit code (13) when its marker is present: a one-shot Host whose work finishes fast can drain its event loop before `dsh`'s dispose settles, which Node reports as 13 even though the plugin asked for 0.

- On macOS a command that waits for terminal input no longer freezes the turn until the 300 second deadline. The pinned inspector reports "input waiting" by reading the process table (`ps`) on a throttle — the foreground group of the shell's terminal must be asleep with its CPU time frozen and hold no socket — and the persistent shell interrupts such a command after five seconds of silence, reporting the exit status and why. Linux keeps its precise `/proc` syscall probe; macOS has no wait channel to read (`ps -o wchan` prints `-`), so a silent command that is only sleeping in a timer or disk wait can be interrupted too. This patch reaches the repository install; the npm/Hub bundle still installs the registry copy of the inspector, because a published package cannot depend on a path inside its own tarball (pnpm resolves `file:` against the profile root, which broke every Hub install in testing). Bundle users therefore keep the "not waiting" answer until the probe moves into a package the bundle already vendors — the follow-up is to do the process-table check in `dsh-terminal-bash`, which DSCODE already vendors and patches.

### Changed

- The transcript breathes: every finished turn draws one blank line above and below its separator rule, and each user message is followed by one blank line. A turn's rule and its blanks land together, so a viewport with no room for the three rows still shows the answer instead of the rule.
- The footer is two rows: row 1 is `● <session title> ｜ <permission>` (falling back to `model ｜ effort` until the session has a title) with the cycle hint still pinned right, and row 2 leads with `provider: model @ effort` followed by the telemetry — `current | average | context | $spend / $balance 🔥 | cache hit`. A row that runs out of width sheds its quietest figures first (average, cache hit, current), then falls back to the bare `model @ effort` header, then drops context, and only then the header itself: the running cost is the last thing standing. The footer now follows the interface language (`/language`) as well; it was pinned to English before.

- Verbose streams the live thinking text again. While the model reasons, the reasoning tail types out in the live area (taking the rows the streaming answer uses, and handing them over as soon as the answer starts); before this the tail was disabled, so thinking only arrived as one finished block per step.

## [0.7.1] - 2026-09-14

### Added

- `docs/CHANGELOG.md` records every release from 0.1.0 on, and the repository README is now English with `README.zh-CN.md` as its Chinese counterpart.

### Fixed

- Wheel scrolling works out of the box again. 0.7.0 turned mouse capture off by default, but the pinned viewport renders in place and clears the terminal scrollback, so with capture off the wheel produced no events anywhere and did nothing until `/mouse` enabled it. Capture now defaults to on, and `/mouse` still releases it for direct selection.

### Changed

- A wheel notch scrolls one row instead of three, and the notches that arrive in the same 16 ms frame are merged into a single render, so trackpad scrolling is smoother without dropping events.
- The `/mouse` hint names Shift first, alongside Option (iTerm2) and Fn (Terminal.app).

## [0.7.0] - 2026-09-13

Interface languages, copyable text, a verbose view, accurate TPS figures, and steadier review.

### Added

- `/language` switches the interface between English, Simplified Chinese, Traditional Chinese, Japanese, Korean and Spanish. The choice is stored in `~/.dsh/dsh-code/language.json`, with `DSCODE_LANGUAGE` as a temporary override. The activity line, agents line, welcome box labels, footer telemetry labels, input placeholders, hints and the doctor report are all translated.
- `/verbose` (Ctrl/Alt+R) shows each step's `· Thinking:`, `· Tool Call:` and `Output:` in a dim style, with up to 8 lines of thinking and a pointer to Ctrl+O for the full history. The toggle is persisted.
- npm publish tokens can be kept in the macOS keychain via `pbpaste | npm run publish:token store`.

### Changed

- Mouse capture is off by default, so terminal text selection works out of the box; PageUp/PageDown scroll the conversation and `/mouse` restores wheel scrolling. The setting is stored locally.
- The conversation area no longer reserves a third of the screen for history while the agent works: live content takes only the lines it needs. The busy line is a two-dot comet orbiting a breathing snowflake, and the welcome box snowflakes ripple outward, following `/animation`.
- The footer's `current` TPS is measured over the generation time the window actually covers and calibrated with settled `outputTokens`, so the first second after a tool call is already accurate; `average` is output tokens ÷ total LLM call time, excluding tool execution and idle time. TPS colouring recognises labels in any language.
- Review requests no longer count toward live TPS.
- The dsh-hub CLI is upgraded to 0.3.0, and profile publishing calls the Hub sync endpoint so npm packages sync immediately.

### Fixed

- The `review` tool returns `no_repository` outside a Git workspace and no longer injects review guidance; a model turn ending for a non-stop reason is retried once and then reports the provider's reason; hitting the output limit returns partial instead of failing, with the limit raised to 8192.

## [0.6.0] - 2026-09-13

Unattended runs, readable sub-agent identities, and release ergonomics.

### Added

- `dscode exec` runs one full dscode agent turn without the TUI, using the same preset, tools, skills, MCP and memory: the reply streams to stdout, tool activity and the session id go to stderr, and the exit code reflects the turn's outcome. It supports stdin prompts, `--json`, `--resume`, `--effort`, `--model`, `--permission`, `--approve-all` and `--timeout`. Approval requests that fall back to a human are denied by default when nobody is present.
- Parent agents must name every child (1–10 characters, letters, digits or underscores, starting and ending with a letter). Children appear as `/name · description` in the agents line and `/agents`; `send_message` and `interrupt_agent` accept `/name`; children refer to the parent as `/`; live children of one parent cannot share a name.

### Changed

- The welcome box uses three colour bands of pixel snowflakes (24×24 on terminals of 26+ rows, 22×22 on 24–25 rows), the activity line is a snowflake orbit while the agent works, and turn dividers span the full width.
- Prompt tuning: persona guidance now covers reply language, judgement and question boundaries, complete delivery and honest reporting; the shell policy keeps only the delegation summary while details stay in the Ultra request policy; email guidance no longer embeds real contacts.
- Release scripts read a granular npm token from the macOS keychain and pass it through a one-off temporary config, avoiding login and captcha; `npm run publish:token store|check|remove` manages the token.

## [0.5.0] - 2026-09-13

Collaboration boundaries, code review, and terminal interaction.

### Added

- Ultra's main agent can pass `worktree: true` to `subagent` or `subagent_fork`, giving children that need to edit their own checkout created from a clean Git `HEAD`. Sharing the directory stays the default, isolation is refused when the main workspace has uncommitted changes, and children can no longer delegate further.
- `/review` and the agent's `review` tool ask an independent, read-only model to review a chosen Git diff. After a code change passes its relevant checks, the agent reviews once before ending the turn and fixes concrete findings first. Scopes cover the staging area, a base branch, a single commit and a path; the same diff reuses its previous review.

### Changed

- TUI: scroll back through history; the first Ctrl+C interrupts the agent immediately and a second one exits; a long paste collapses to a marker in the input and expands in full after submitting; pasted images show `[Image 1]`-style markers and multiple images are supported; user messages get their own background and turn dividers separate rounds.
- DeepSeek Flash's ordinary agent requests get short, task-proportional guidance: answer simple questions directly, and finish a bounded code change with its relevant checks. The low, high and max levels do not start sub-agents; only Ultra can start or wake them.

## [0.4.0] - 2026-09-12

An agent email system that feeds extra context into the running coding task.

### Added

- `/email` shows a local inbox shared by all sessions, sorted by update time, with Chinese preview support and a narrow-window layout.
- Gmail app-password connections receive new mail whose subject starts with `[ToAgent]` after the first successful connection; an optional OAuth interface is retained.
- Pressing Enter on a selected message injects it into the current session, whether idle or running. The JSON shape marks it as chosen by the user and as supplementary context only.
- `send_email` sends plain text over Gmail SMTP, adds `[ToAgent]` automatically, reuses the existing approval flow and local credentials, and records send results to prevent duplicate delivery.
- Contact aliases are shared across sessions and can be managed by the agent or by `dscode email alias`; approval shows the real address behind an alias.

## [0.3.0] - 2026-09-12

Login, terminal interaction and runtime improvements.

### Added

- `/login` saves a local DeepSeek key through a hidden input, loading it at startup and reloading it for the current session; environment variables take precedence.
- An effort horizontal bar with Ultra animation, and a welcome box showing version, model and project path.

### Changed

- The input area is pinned to the bottom of the terminal with an in-screen viewport for long conversations; the full content stays viewable or exportable.
- A blank launch shows the input box first, and Chrome MCP connects when the agent session is created.
- Startup and version-management locks and session message handling are strengthened; the compaction evaluation tooling and an isolated test flow are added.

### Fixed

- `apply_patch` path handling inside Git subdirectories.

## [0.2.0] - 2026-09-11

One session runtime shared by the TUI, the CLI, scripts and other agents.

### Added

- Session communication: built-in `list_sessions`, `read_session`, `send_session` and `reply_session`, with queue / steer / defer delivery, a persisted mailbox, retry de-duplication, cancellation and a finite communication budget. Only loaded root sessions in the same state directory are reachable; offline sessions are never started automatically.
- Descriptive session cards: project, workspace and recent user topics, with no task conclusions.
- Global memory: background extraction, organisation, retrieval and source tracing, with global and per-session switches. Extraction spends extra model calls.
- Input and resume: `!` shell commands, Shift+Enter for a newline, `dscode resume`, an exit resume hint, and Chinese IME cursor placement.
- TUI: compact header, unified run state, sub-agent activity overview, and dimmed cost, context and cache metrics; thinking and tool-call history are hidden by default.
- Ultra keeps native `max` reasoning and delegates as the task needs, and the parent agent can choose a separate effort for each child.
- Compatibility: the recommended Harness combination is pinned, and the npm launcher warns (then continues) on other combinations.

## [0.1.0] - 2026-09-11

Initial public release: the npm launcher and Hub profile installation for the DSCODE harness.

[Unreleased]: https://github.com/qiz029/dscode/compare/v0.7.1...HEAD
[0.7.1]: https://github.com/qiz029/dscode/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/qiz029/dscode/compare/v0.6.0...v0.7.0
[0.6.0]: https://github.com/qiz029/dscode/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/qiz029/dscode/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/qiz029/dscode/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/qiz029/dscode/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/qiz029/dscode/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/qiz029/dscode/releases/tag/v0.1.0
