# Descriptive session cards

Supported since DSCODE 0.2.0, session cards appear in `dscode sessions`, `dscode read SESSION_ID` and the TUI `/session`. A card has just three fields:

```json
{
  "project": { "name": "dscode", "id": "github.com/qiz029/dscode" },
  "workspace": "/work/dscode-feature",
  "topics": [
    { "text": "add project, workspace and recent-request topics to a session", "sourceSeqs": [125, 129] },
    { "text": "cancel the whale animation plan", "sourceSeqs": [98, 112] }
  ]
}
```

The project comes from local Git information: the credential-free origin repository identity when one is recognisable, otherwise the path of the Git common directory. Worktrees of one repository therefore share a project, while the workspace keeps the session's original cwd. A non-Git directory has a `null` project, so the model is never asked to guess one. Reading Git information does not touch the network.

A topic describes what the user asked for: at most 5 by default, ordered by most recent mention, each citing the event sequence numbers of the original user messages. The extraction prompt requires consecutive follow-ups to be merged, an explicit cancellation or replacement to be described, and a bare acknowledgement to be ignored; it forbids conclusions, results, completion states and inferred agent plans. Structural validation rejects extra fields and message references that do not exist, while the meaning of the text still depends on how well the model follows the prompt.

## Background updates

Project and workspace are available immediately (Git detection completes asynchronously). Topic extraction starts after 3 non-empty user text inputs by default; new input waits 1.5 seconds to be merged, and two extractions for one session are at least 60 seconds apart. Only user text in raw `user/message` events is scanned: assistant output, tool results and external plugin relays are not read. That is why `dscode send` never becomes "a topic the user asked for".

Each extraction reads at most the latest 32 user texts, 16000 characters in total and 4000 characters per message; earlier topics may no longer be retained. This is an index of recent requests, not a summary of the whole session. Common credential patterns are redacted, but no guarantee is made that every sensitive string is recognised.

The extraction uses the session's provider/model, at a fixed, independent `low` effort that does not inherit the main agent's ultra; a provider/model can be configured separately. Each Host runs at most one extraction at a time, with a 30-second timeout; it creates no second Agent, uses no tools and writes nothing into the session context. New user input invalidates an older version still being generated; a failure keeps the previous version and retries with backoff. This background call costs extra model usage: its call count and token usage are recorded in the card cache and are not currently part of the TUI's session cost figures.

`cardState` sits outside `card` and provides `status`, `updatedAt`, `coveredUserSeq` and `latestUserSeq`. The status can be `empty`, `insufficient`, `pending`, `updating`, `ready`, `error` or `disabled`, which lets a consumer recognise a stale card. A background card update is not a persisted session event, so `watch` does not push it; call `sessions` or `read` again when you need it.

The derived cache is written atomically under `session-cards/` in the state directory and holds only cards and generation metadata, never a second copy of the user's text. A resumed session can reuse an unchanged card, and a corrupt cache can be rebuilt. `sessions` still lists running root sessions only; no offline session directory and no automatic cross-session sending were added.

## Configuration

Configure the existing plugin in the Harness profile overlay:

```yaml
- id: dscode-session-cards
  config:
    enabled: true
    topicCount: 5
    minMessages: 3
    debounceMs: 1500
    cooldownMs: 60000
    timeoutMs: 30000
    maxMessages: 32
    maxInputChars: 16000
    # provider: your-provider
    # model: your-model
```

`enabled: false` stops model extraction while local project, workspace and cached topics remain readable. provider/model must be configured as a pair. `minMessages` cannot exceed `maxMessages`.

Verification: `node --test tests/session-cards.test.mjs` and `node scripts/verify-session-cards.mjs`. The latter uses a real Harness, native sessions, a Unix socket and a deterministic local model to cover the independent effort, input isolation, reads and recovery; it does not mean topic text quality from a real remote model has been accepted.
