# DSCODE global memory

Global cross-session memory was added in DSCODE 0.2.0.

Memory is stored across projects and sessions and shared within one DSCODE state directory. The workspace path and the source session are kept; project experience is not automatically promoted to other projects. It works separately from resume (restoring a full session), compaction (compressing the current context) and project instruction files.

## Usage

Reading and background generation are on by default. A new root session schedules history consolidation when it first produces a model request configuration, and from then on it tries once every 30 minutes; it never holds the user's reply back waiting for consolidation. Exiting the process cancels the background task and the next run continues it. Having no history memory on first use is normal.

| Command | Behaviour |
|---|---|
| `/memories` or `/memories status` | Path, switches, background state, entry count, memory model calls and token usage |
| `/memories off` / `on` | Disables / enables reading and further contribution for the current session; survives a session resume |
| `/memories global-off` / `global-on` | Persistently turns global reading and generation off / on; a disable in the configuration file still wins |
| `/memories run` | Schedules one background consolidation immediately, still under the idle, count and age limits |
| `/memories note answer in Chinese` | Adds an explicit preference or correction for the next consolidation; text is added, never executed |
| `/memories clear` | Clears the global generated results and the input memory; sessions created before the clear are no longer used for regeneration |

`off` does not erase experience that was already consolidated; use `clear` to delete all old memory. Toggling a switch does not delete what is already in the current conversation either, so complete isolation needs a new session. `/clear` still clears the conversation, which is not the same as clearing global memory.

The model automatically receives only a summary of at most 6000 characters. When historical experience is needed, use `memory_search` to find entries, procedures and source-session summaries; it returns session IDs, workspaces and original message sequence numbers. Simple tasks skip retrieval. Memory is not proof of the current code state.

## Two-stage implementation

1. Read the historical JSONL from the existing `sessionPersistence` service. Child agents, non-dscode sessions, active sessions, sessions with contribution switched off and oversized logs are skipped. Only original user messages and visible assistant text are extracted: thinking, tool payloads and injected system information are not read.
2. An independent model request extracts `raw_memory`, `rollout_summary` and evidence message sequence numbers. JSON, field lengths and source ranges are validated, and common secret formats in the input and output are redacted. With no usable experience it may return an empty result. A failure records exponential backoff; a success records the matching source version.
3. Retained experience is selected by use count and recency, explicit user notes are added, and a second independent model request merges entries and reusable procedures. The model call is skipped when no input changed.
4. After the source IDs referenced by the output are validated, a SQLite snapshot is published and a readable Markdown file is generated. Retrieval and summarisation use the database snapshot; an interrupted file generation can be repaired by the next consolidation.

A SQLite lease coordinates multiple processes and the background holds a heartbeat; a source session under recovery, an expired lease and a clear operation all stop an old result from committing. The consolidation model has no shell, MCP, file-write or delegation tools, and file paths are determined by the plugin.

Directory resolution order: plugin `root` → `DSCODE_MEMORY_HOME` → `$DSCODE_HOME/memories` → `$DSH_HOME/memories` → `~/.local/share/dscode-hub/memories`. A source launch normally uses the project's `.runtime/memories`, and an npm launch uses the launcher's state directory. To share memory between installations, set the same `DSCODE_MEMORY_HOME` explicitly.

```text
memories/
  state.sqlite             # job version, lease, switches, notes, authoritative snapshot and usage
  memory_summary.md        # condensed summary
  MEMORY.md                # experience handbook with sources
  raw_memories.md           # currently retained per-session extraction results
  rollout_summaries/*.md    # session summaries, with message sequence numbers
  skills/*/SKILL.md         # consolidated reusable procedures, retrieved on demand
```

These Markdown files are generated artifacts and manual edits are overwritten; submit corrections through `/memories note`. The generation flow returns to the agent as text and is never installed automatically as a skill with execution permission.

## Configuration and cost

A source install overrides the existing plugin configuration in `config/harness.local.yml`; a released package can override the same entry ID through a DSH profile overlay:

```yaml
- id: dscode-memory
  config:
    generate: true
    use: true
    minIdleHours: 6
    maxAgeDays: 30
    maxPerRun: 16
    maxCandidates: 32
    maxUnusedDays: 30
    extractEffort: low
    consolidationEffort: high
    timeoutMs: 90000
    # optional, and both are required together; otherwise the triggering session's provider/model is used.
    # provider: deepseek-official
    # model: deepseek-flash
```

Extraction and consolidation efforts are set independently, and neither inherits ultra. Each run does at most 16 per-session requests and 1 consolidation request, executed in order; input and output are both length-bounded, and a single model request has a 90-second default timeout. The background model causes extra API usage that is counted separately in `/memories` and not charged to any one foreground session. A missing usable provider, an unsupported configured effort or a network failure never affects the foreground; the background keeps the failure state and retries.

This is DSCODE's implementation of the two-stage architecture borrowed from Codex, not a line-by-line port: an input fingerprint replaces the Git diff, and a tool-free structured model request replaces the consolidation agent that can edit a directory. There is currently no Codex-style provider remaining-quota gate, and redaction covers only common secret formats; what reaches the model is filtered historical session content. Generation can be switched off globally while reading existing memory is kept.

## Verification

```sh
node --test tests/memory.test.mjs
node scripts/verify-memory.mjs
```

The first covers source filtering, evidence validation, the lease, backoff, clear races and the reading switch. The second loads a real Harness in a temporary profile and uses real JSONL storage plus the local deterministic LLM adapter to check the full two-stage flow and prompt injection. It does not reach a remote model and is not an acceptance of real-model extraction quality or billing.
