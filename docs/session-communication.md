# Agent-to-agent tasks

Supported since DSCODE 0.2.0. An agent can read session cards and use built-in tools to send messages to a loaded dscode root session in the same state directory. This is how one running session reaches another; to start an unattended run in a fresh or trigger-owned persistent session from an event — a schedule, a file change, a poll, a CI job — see [Triggers](triggers.md). The receiver keeps using the single native runtime; the TUI, the CLI and the agent tools share the session bridge. An offline session is never opened automatically.

## Delivery modes

| mode | Target idle | Target running |
| --- | --- | --- |
| queue | wakes a new turn | queued behind the current turn |
| steer | wakes a new turn | joins the current execution at the next safe step, without cancelling tools |
| defer | leaves a note, does not wake | claimed when the next turn starts, never in the current turn |

defer is a one-shot note. Reading the mailbox or resuming the session does not wake it on its own. Notes beyond the current turn's batch size keep waiting for a naturally occurring turn; they never start extra turns.

Message meaning is independent of delivery: `request` asks for work, `notify` passes information without requiring a reply, and `reply` is the single final answer tied to an original request. A notify may wake the target with queue or steer, or it may defer; the protocol never auto-replies "acknowledged".

## CLI and TUI

```sh
dscode sessions
dscode send SESSION_ID --kind request "check the parser's edge cases"
dscode send SESSION_ID --steer --kind notify "also: only check UTF-8 input"
dscode send SESSION_ID --defer --kind notify "watch this compatibility issue next time"
dscode send SESSION_ID --defer --title "Parser compatibility" "check UTF-8 later"
dscode mailbox SESSION_ID
dscode mailbox SESSION_ID --after 12 --limit 50
dscode watch-mailbox SESSION_ID --after 0
dscode cancel SESSION_ID MESSAGE_ID
dscode new-task SESSION_ID
```

`--steer` and `--defer` are mutually exclusive, and queue is the default. An explicit `--title` sets the title immediately instead of waiting for a defer to be claimed; a repeated send does not overwrite a title that was changed later. Before sending, the client prints the requestId to stderr; when the receipt is lost, retry with the same `--request-id`, target, kind, mode, body and title.

The TUI `/session` shows the mailbox counts; `/mailbox` lists messages and `/mailbox cancel MESSAGE_ID` cancels a request or an unclaimed message.

## Seeing the traffic in the terminal

Cross-session traffic is visible as it happens, without expanding a tool card:

- While a `send_session` or `reply_session` call is running, the activity line reads `⇄ sending to <peer>`; once the call settles and the message was a `request` with no answer yet, it reads `⇄ waiting for <peer>` until a relay from that peer arrives. A `notify` never shows as waiting, and a failed send stops waiting immediately.
- A settled send prints one notice line (`→ <peer> <kind>`, plus `— failed` when the result was an error), and an inbound relay prints `← <peer> · <bounded text>`.
- `/tasks` lists the same history on demand as one text block, newest last, with the delivery mode and whether each send is still `awaiting reply`; it reads the session's own log, so it shows what this session sent and received and nothing about other pairs.

Both surfaces use the `steered` violet and the `⇄`/`→`/`←` glyph family, never the brand blue and `•` of ordinary local notices or the plain text of a tool result, so a line about another session is recognisable at a glance. The view is folded from the root session's own log — `tool/call` and `tool/result` for the outbound side, the bridge's relayed `user/message` for the inbound side — so a resumed session rebuilds the same history and a restart announces only traffic that happened in that session, not the whole past.
 Stopping natively also cancels pending native inbox messages; a standalone defer note has to be cancelled explicitly in the mailbox. A message that is received and enters the context still shows as a relay with its source.

`/session-new-task` or `dscode new-task SESSION_ID` explicitly starts a fresh communication budget while the session is idle. Ordinary follow-ups, automatic continuation and a resume do not reset the budget. When an older request returns later or an older note is claimed, it still carries its original chain and may therefore be limited by it again.

The CLI can answer, on behalf of the current session, a cross-session request that was genuinely addressed to it:

```sh
dscode reply RECEIVING_SESSION_ID --reply-to REQUEST_MESSAGE_ID "final answer"
```

A request sent by an external script has no other agent session as a reply address; read its progress and output through read/watch.

## Built-in agent tools

- `list_sessions`: reads cards and run status, with exact project/workspace filtering and pagination.
- `read_session`: reads the named session's native event page and the head of its mailbox, without waking it or claiming anything.
- `send_session`: sends request/notify; the full session ID, mode, body and a stable `idempotency_key` are required.
- `reply_session`: replies against the original request ID; the runtime determines the target, and queue is the default.

A progress notify may carry `in_reply_to` back to the original requester; the target ID must match the original sender. Each request allows at most one final reply. A tool returns only the reception receipt, so a model should end its turn and wait for the answer rather than polling read in a loop.

The sender's session identity is bound by a runtime credential; a model cannot supply its own chainId, budget, sender or new-task authorisation. A child agent inherits its parent's task chain, but in this first version cross-session send/reply is performed by root sessions only, and a child agent should hand back to its parent through the native collaboration entry points; a child agent is not an independent recipient address either. A session card still describes only the original user requests, and a relay never enters the card topics.

## Choosing a target and a delivery mode

Routing has two steps: pick a session from its card, then pick the delivery mode from the target's current status and the nature of this message. Where the fields come from and when they are produced is covered in [Session cards](session-cards.md); this section only covers how to use them.

### 1. List targets

With no filter, `list_sessions` returns every active root session in the same state directory; `project` and `workspace` are exact filters for when you already know whom you want:

```json
list_sessions({})
list_sessions({ "workspace": "/abs/path/to/project" })
list_sessions({ "project": "github.com/owner/repo" })
```

The result is ordered by session ID, not by activity or recency; `limit` defaults to 20 and caps at 100, so pass `limit: 100` to list everything and page with `nextCursor`. Cross-project collaboration needs no extra argument.

### 2. Which fields to judge by

| Field | Meaning |
| --- | --- |
| `card.project` | Normalised from the local Git origin into `name` and `id`; worktrees of one repository share a project, and a non-Git directory is `null`. |
| `cwd` / `card.workspace` | The exact workspace path, and the basis of the `workspace` filter. |
| `title` | A human-readable title, possibly unset (`null`). |
| `card.topics[].text` | Recent user-request topics, the main semantic routing signal, though only an index of recent requests. |
| `status` | `idle` or `running`, which decides the mode. |
| `mailbox` | Current `queue`/`steer`/`defer` pending counts; a large number means the target already has a backlog. |
| `cardState` | `status` is the card's update state; a gap between `coveredUserSeq` and `latestUserSeq` says whether new user input arrived after the card was built. |

`card.project`, `card.workspace`, `card.topics` and `cardState` may all be absent; treat them as absent rather than assuming they exist.

### 3. Pick a target

Lock the project with `card.project.id` or `cwd` first; when several sessions share a project, use `title` and `card.topics` to tell which one is working on the relevant task.

When `cardState.status` is `empty`, `insufficient`, `pending`, `updating` or `error`, the topics may be empty, not yet updated or stale: judge only by project, workspace and title, and do not read the target's current work from an old topic. `disabled` means card extraction is switched off, while project and workspace remain available.

### 4. Pick a mode

| Target status and intent | Choice |
| --- | --- |
| Idle, should start work, and you expect an answer | `queue` + `request` |
| Running, adding a constraint or a correction you want inside this turn | `steer` + `request` |
| Running, not urgent, let it pick the note up on its next natural turn | `defer` + `request` |
| Only informing, no reply needed | set `kind: "notify"` and choose the mode from the timing rules above |

kind and mode are independent. Use `request` when you want an answer and `notify` to pass information; a final `reply` must be tied to the original `request_message_id` and cannot answer another reply. `status` is only a snapshot: the target may have changed after you chose the mode, and the runtime's delivery semantics keep the message from being lost because of it.

### 5. Common mistakes

- Judging how far the target has got from a topic. A topic only describes what the user asked for, never a conclusion, a result or a completion state; use `read_session` on the event page for progress.
- Forgetting pagination. Without `limit` you see 20 entries, which easily hides the target in cross-project work.
- Confusing `status` with `cardState.status`. The first is the session's busy state, the second the card's update state.
- Reading the `mailbox` counts as history. They count only unexpired accepted or admitted messages, not consumed ones.
- Sending as soon as a target is picked. Read a page or two with `read_session` first (defaults `after: -1`, `limit: 50`, returning `cursor`/`head`) to confirm where it is, and avoid a duplicate ask or an interruption.

## Anti-loop budgets and persistence

This first version fixes these limits: 3 delegation levels per task chain, 8 request/notify messages, 1 reserved final reply per request, and a 1-hour validity window. An external send that creates a root request also counts towards the 8. Queue, steer and defer all count; once the new-message ceiling is reached, the reserved final reply can still return.

Sending a new task to yourself or to an ancestor in the current delegation path is forbidden; a legitimate reply tied to the original request and a progress report are allowed to return. After several chains merge, all their constraints apply and you cannot choose the one with more remaining budget. An ordinary continuation, a reply and a notification keep their current causal relationship; when a new turn is started purely by communication requests, it adopts the chains those requests already have, so unrelated finished work is not mixed in. This creates no new budget. At most 32 distinct causal paths are retained; beyond that the request is explicitly refused rather than silently dropping the relationship, and the user has to draw the boundary of the new task.

Each session's unclaimed mailbox holds at most 100 notes with 1 MiB of bodies in total; a single body is at most 64000 bytes, and a full envelope with metadata and headroom is at most 96000 bytes. A single defer batch is under the same full-size limit. An expired note keeps a readable record but is no longer claimed automatically.

All Hosts share the state directory's `session-communication/mailbox.sqlite`. Admission, idempotency, budget and reply slots commit in short SQLite transactions. The ledger owns communication only; model execution keeps using the native inbox, and a session's write exclusivity is still guaranteed by the native JSONL kernel lock. The owner generation rejects stale runtime credentials, and a missing heartbeat times out and seizes the lock.

Receipts and records are distinct:

| delivery | Meaning |
| --- | --- |
| accepted | Persisted in the mailbox; a defer may stay here |
| admitted | Entered the native inbox or the claiming flow |
| consumed | Matched against a native user/message and flushed; does not mean the task is done |
| cancelled / expired | No longer delivered automatically |
| late | A final reply that arrived late; recorded only, no wake-up |

A successful queue/steer receipt waits for the native inbox flush; defer waits for the mailbox commit. The gap where the ledger commits before the inbox write is recovered by re-delivering a stable messageId, and a message already in the native log is never added twice. Native-exit inbox cleanup and an explicit user cancellation are handled separately: the first allows unconsumed communication to be recovered from the ledger, the second never revives a cancelled message.

**The cancellation boundary is the claim.** An unclaimed message with `alreadyClaimed: false` can be stopped from being claimed later; an already claimed input cannot be guaranteed recalled, and the receipt marks it true. A cancel request closes the reply relationship, so a late reply does not wake the target; it does not kill the target's other work or roll back tool side effects. A defer note's batch record and its native consumption acknowledgement are stored separately, so they can be checked again after an interruption.

`watch-mailbox` uses its own monotonic event cursor and reads the shared ledger every 250ms; only a subscribed connection polls, and it drives no agent. It covers reception, admission, consumption, cancellation and refusal. `watch` keeps using the native session seq, and the two cursors cannot be mixed. read/list claims nothing, and a WAL snapshot acquires no session write lock.

Under one OS user, a program that can read the state and credentials can still call the external entry points; these limits stop accidental loops in normal tool use and are not a security boundary against a program with arbitrary shell access. Tool loops and model usage inside a single agent still need its execution budget.

## Verification

`node --test tests/*.test.mjs` covers protocol validation, idempotency, loops/depth, budget, concurrent-process admission, expiry, cancellation and post-encoding size limits.

`node scripts/verify-session-messaging.mjs` uses two real Harness Hosts and a local deterministic model to check sending through the registered tools, a model-invoked reply, the defer deadline boundary and its lack of a wake-up, recovery after a forced exit, recovery with a pre-existing native inbox, de-duplication, cancellation and mailbox subscription. `node scripts/verify-runtime-foundations.mjs` checks the kernel lock and the native input hooks. No claim is made that remote-model collaboration quality, human UI acceptance or side-effect exactly-once has been verified.
