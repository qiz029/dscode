# DSCODE preset and Ultra

Restart `dscode` and create a new session. The default preset is now `dscode`; `dscode --mode dscode` explicitly selects it. Existing conversations retain their old preset on resume. `/mode` changes only an empty session; use `/new dscode` for a new conversation.

## Execution through a persistent shell

The preset combines the pinned minimal preset's owner-scoped persistent shell with project instructions, runtime context, Skills, plan/Todo/Goal, compaction, subagents and workflows from standard. It does not copy minimal's fixed complete system prompt or its lack of compaction. Host MCP, Computer Use, hooks and auto review remain mounted.

The model uses `bash` for file reads, searches and edits instead of separate `read`, `write`, `edit`, `glob` and `grep` tools. `cd`, exports, functions and background jobs persist across calls for the same agent. Each child gets a separate shell, but all agents still share the workspace files; there is no automatic Git worktree allocation.

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

In the DeepSeek native route, `/effort` now offers `Ultra` alongside Off, Low, High and Max. It is a harness policy, not a new DeepSeek API value:

- Session selection and request headers retain `ultra`; the native adapter serializes it as `thinking.type: enabled` and `reasoning_effort: max`.
- Normal tool-capable requests get collaboration guidance appended to the effective system message at the adapter boundary. The immutable logged request is not mutated. This extra text is reflected in provider usage; preflight local token estimates do not include the adapter-added text.
- The guidance actively seeks independent useful subtasks, disjoint file ownership and independent review, while avoiding delegation for trivial work. The main agent integrates and verifies results.
- Children inherit the effort when no model/effort override is selected. Ultra stays in the persisted request header across compaction and the TUI's standard restore path; switching effort to Max removes the extra guidance on subsequent requests. Switching to a different provider uses that provider's own effort catalog.
- In dscode, at most three direct children can run concurrently in Ultra; admission reservations prevent concurrent launches from racing past the cap. Idle-child wake requests also count. The preset allows one delegation level, including non-Ultra sessions. Parent/child messaging remains available; direct sibling messaging is not added.
- In Ultra, `workflow` and `ralph` are rejected with instructions to use capped subagent delegation, preventing an alternate delegation path around the cap. They remain available at other efforts.
- Compaction/title requests do not get the collaboration instruction. Auto review does not inherit the main agent's Ultra selection. Permissions are unchanged.

Use Ultra for complex changes with independent investigation/implementation/review opportunities. It is not the default and can cost more tokens because children make additional model requests. `/agents` shows their activity; `/status` and `/review-usage` expose the existing recorded usage surfaces. The native root token totals are not a complete bill for child sessions. The session footer separately aggregates recorded descendant calls; see [session metrics](session-metrics.md).

## Implementation and checks

`presets/dscode/agent.cordis.yml` is the checked-in composition template. Setup materializes its plugin path under `.runtime/agent-presets/dscode`. The launcher performs idempotent, version-checked patches to the pinned native DeepSeek adapter (Ultra), bash tool (separate name for retry), persistent shell (reset cache invalidation), and DSH-Code TUI (existing `/clear`/command discovery fixes). Unsupported upstream package versions or source shapes fail setup. These changes are included in the full tar distribution; the Hub-only configuration export does not include them.

Tests cover real serialized DeepSeek requests with mocked HTTP, concurrent admission reservations, persistent cwd/exports, unified-diff file editing, fresh retry isolation, approval denial, cancellation/reset, actual child shell isolation, deterministic manual compaction and TUI-equivalent Ultra restoration. The actual terminal picker was also checked for Ultra and the default dscode mode. These are local deterministic checks, not a paid DeepSeek quality or multi-agent performance benchmark.
