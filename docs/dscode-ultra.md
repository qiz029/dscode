# DSCODE preset and Ultra

Restart `dscode` and create a new session. The default preset is now `dscode`; `dscode --mode dscode` explicitly selects it. Existing conversations retain their old preset on resume. `/mode` changes only an empty session; use `/new dscode` for a new conversation.

## Execution through a persistent shell

The preset combines the pinned minimal preset's owner-scoped persistent shell with project instructions, runtime context, Skills, plan/Todo/Goal, compaction and subagents from standard. It does not copy minimal's fixed complete system prompt or its lack of compaction. Host MCP, Computer Use, hooks and auto review remain mounted.

The preset also registers a `review` tool and `/review` command backed by one independent, read-only model request over the selected Git diff. The main agent is guided to call it after code changes and focused checks, before its final reply. This is a diff-only review, not a tool-using subagent or a substitute for tests; it does not change Ultra delegation policy. See [TUI review usage](tui-commands.md).

The model uses `bash` for file reads, searches and edits instead of separate `read`, `write`, `edit`, `glob` and `grep` tools. `cd`, exports, functions and background jobs persist across calls for the same agent. Each child gets a separate shell. By default children share workspace files; the parent can explicitly set `worktree: true` on `subagent` or `subagent_fork` to give a child an isolated Git checkout.

`apply_patch` is available in the harness shell PATH and wraps `git apply`. Feed it a **standard unified diff**, not the Codex `*** Begin Patch` format. Git is required. `apply_patch --check` checks hunks without writing. This works outside a Git repository too.

```sh
apply_patch <<'PATCH'
diff --git a/example.txt b/example.txt
--- a/example.txt
+++ b/example.txt
@@ -1 +1 @@
-before
+after
PATCH
```

`/shell` lists the current session's terminals. `/shell reset` closes them while the agent is idle. Timeout, cancellation, `exit`, reset and host restart discard shell state; the next call starts at the session workspace. Conversation resume restores messages and files, **not** an OS process or its exports. Interactive foreground programs that require stdin are not supported by this tool. Background work can use shell job control; `shell_retry` also exposes the existing tracked background-job mechanism.

Normal persistent commands keep the active OS sandbox and do not each incur an LLM review. After a genuine sandbox denial, the model may use `shell_retry` for a single fresh-shell retry, with explicit `workdir`, wider `sandbox_permissions` and justification. This uses the original escalation approval seam and auto reviewer. Reviewer input resolves relative workdir against the session workspace and explicitly identifies the environment as fresh. It cannot see or rely on the persistent shell's exports/functions. Rejected approval prevents execution. Sandbox mode changes while persistent terminals exist are rejected upstream; close them with `/shell reset` first when changing permission modes that also change sandbox policy.

Hooks which should cover both execution paths should match `^(bash|shell_retry)$`.

## Ultra effort

In the DeepSeek native route, `/effort` replaces the bottom composer with a Low → High → Max → Ultra bar (arrow keys to move, Enter to apply, Esc to cancel, `o` for Off). Focusing Ultra triggers a blue wave that spreads from the center before confirmation. After applying Ultra, the composer briefly shows a second center-out text-and-border ripple. Both effects are skipped when animations are disabled. Ultra is a harness policy, not a new DeepSeek API value:

- Session selection and request headers retain `ultra`; the native adapter serializes it as `thinking.type: enabled` and `reasoning_effort: max`.
- Normal tool-capable requests get collaboration guidance appended to the effective system message at the adapter boundary. The immutable logged request is not mutated. This extra text is reflected in provider usage; preflight local token estimates do not include the adapter-added text.
- The guidance actively seeks independent useful subtasks, disjoint file ownership and independent review, while avoiding delegation for trivial work. The main agent integrates and verifies results.
- Children inherit the effort when no model/effort override is selected. Ultra stays in the persisted request header across compaction and the TUI's standard restore path; switching effort to Max removes the extra guidance on subsequent requests. Switching to a different provider uses that provider's own effort catalog.
- In dscode, at most three direct children can run concurrently in Ultra; admission reservations prevent concurrent launches from racing past the cap. Idle-child wake requests also count. The preset allows one delegation level, including non-Ultra sessions. Parent/child messaging remains available; direct sibling messaging is not added.
- Every child gets a parent-chosen `name`: 1 to 10 characters, letters, digits and underscores only, starting and ending with a letter, unique among the parent's live children. The child appears as `/name · description` in the TUI agents line and `/agents`, and the parent addresses it as `/name` in `send_message` and `interrupt_agent`; a child addresses its parent as `/`. Names resolve to durable session ids inside the running process; the ids keep working as before.
- Prefer `subagent_fork` when completed conversation history helps the child; use fresh `subagent` for self-contained work that gains nothing from that history. Fork excludes the unfinished turn, so the child's assignment must still state its objective and constraints. Both child paths hide delegation tools, and runtime checks reject a child that tries to delegate again.
- Worktree choice is independent of conversation forking. `worktree: true` creates a detached checkout under `.dscode-worktrees/<id>/` at the parent repository root, starting from `HEAD`. It requires the parent session cwd to be that Git root and the parent worktree to be clean, including untracked files. A dirty parent is rejected before creating a child, so a child never silently misses uncommitted parent changes. Omit the flag for read-only tasks or when the child needs those changes; choose it for independent parallel edits. The child session persists its own cwd; the parent receives the path in the tool result and must inspect and integrate the diff. The checkout remains available for later messages to an idle child; remove it with `git worktree remove PATH` only when no child follow-up or resume is expected. Removing it earlier makes that child's future file work fail. Worktrees with edits are retained on child failure, while an empty checkout is removed if child startup fails. The directory is added to local `.git/info/exclude` so it does not appear as an untracked parent change.
- Only Ultra can start or wake child agents. Low, High and Max do not advertise delegation tools to the DeepSeek model, and runtime checks reject direct child launches even on other model routes. Messages to children already running remain available. `workflow` and `ralph` are unavailable in this preset because they can start children outside Ultra's admission cap.
- Compaction/title requests do not get the collaboration instruction. Auto review does not inherit the main agent's Ultra selection. Permissions are unchanged.

Use Ultra for complex changes with independent investigation/implementation/review opportunities. It is not the default and can cost more tokens because children make additional model requests. `/agents` shows their activity; `/status` and `/review-usage` expose the existing recorded usage surfaces. The native root token totals are not a complete bill for child sessions. The session footer separately aggregates recorded descendant calls; see [session metrics](session-metrics.md).

Normal `deepseek-flash` agent requests also receive a short task-proportional instruction: answer simple questions directly; for bounded code changes, make the focused change, run the relevant check, and stop when it passes. This is guidance rather than a hard reasoning-token limit. Internal compaction and other non-agent calls do not receive it.

## Implementation and checks

`presets/dscode/agent.cordis.yml` is the checked-in composition template. Setup materializes its plugin path under `.runtime/agent-presets/dscode`. The launcher performs idempotent, version-checked patches to the pinned native DeepSeek adapter (Ultra), bash tool (separate name for retry), persistent shell (reset cache invalidation), and DSH-Code TUI (existing `/clear`/command discovery fixes). Unsupported upstream package versions or source shapes fail setup. These changes are included in the full tar distribution; the Hub-only configuration export does not include them.

Tests cover real serialized DeepSeek requests with mocked HTTP, concurrent admission reservations, persistent cwd/exports, unified-diff file editing, fresh retry isolation, approval denial, cancellation/reset, actual child shell isolation, deterministic manual compaction and TUI-equivalent Ultra restoration. The actual terminal picker was also checked for Ultra and the default dscode mode. These are local deterministic checks, not a paid DeepSeek quality or multi-agent performance benchmark.

### Task-proportional execution

Ultra keeps native `max` reasoning but now explicitly routes bounded work (such as one unit test) through direct implementation and focused verification. It avoids unnecessary planning, child agents, broad repository scans and repeated review. Expand scope only for a concrete uncertainty or failure; stop when acceptance criteria and required checks pass. This is prompt guidance, not a runtime deadline or adaptive reasoning-effort switch. It has not yet been benchmarked against the reported slow session, and cannot guarantee shorter model deliberation.

### Per-child reasoning effort

The parent can pass `reasoning_effort` to `subagent` or `subagent_fork`, independently of the model-selection opt-in. For example: `{"name":"unit_tests","description":"Add focused unit tests","prompt":"...","reasoning_effort":"low"}`. Omission keeps existing inheritance. The selected child model validates the effort before child creation; unsupported values fail instead of silently falling back. Effort-only selection does not change provider/model or the parent's effort. Explicit provider/model overrides still require the existing model-selection policy. Ultra guidance asks parents to choose low for bounded work, high for difficult work and max only when justified. This configures newly created children, not existing children sent another message.
