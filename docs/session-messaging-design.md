# Agent-to-agent messaging design

> **Design record, not a usage guide.** The user-facing instructions are in [Agent-to-agent tasks](session-communication.md) and where the fields come from is in [Session cards](session-cards.md); this page keeps only the design rationale of the time, and behaviour follows the code and those documents.

Status: the main body is implemented in the local source version; the operating instructions and verification are in [Agent-to-agent tasks](session-communication.md). The text below keeps the design rationale; the first version uses fixed limits, refuses outright when the causal paths exceed them and asks for a new task to be drawn, and has no automatic splitting yet. The strict cancellation boundary is "before the claim": an already claimed input is marked by an `alreadyClaimed` receipt and cannot be guaranteed recalled. It builds on the existing session bridge, descriptive cards and the native Agent inbox.

## Goal and scope

Let an agent read session cards, read events, and deliver a task, a reply or a notification to a chosen session. The receiver still executes on the single native runtime; the TUI, the CLI, scripts and the agent tools use one entry point.

The first version is limited to the same machine, the same state directory and a currently loaded dscode root session. It keeps the Unix socket and introduces no ACP, no resident background scheduler and no automatic recovery of an offline session. A note already received stays persisted after the target exits and can be claimed on resume; sending a new message to an unloaded session returns `target_unavailable` for now.

Discovering and choosing a target is the caller's job; the receiver never scans cards looking for work. A card still carries only project, workspace and recent user-request topics, with no conclusions. External communication never mixes into "user-request topics".

## Message meaning and delivery strategy

Message meaning and execution timing are two independent fields.

| kind | Meaning | Reply constraint |
| --- | --- | --- |
| request | ask the target to do something | creates a trackable request that allows one final reply |
| reply | the final answer to an existing request | must be tied to the original request; cannot answer another reply |
| notify | pass information, no reply required | creates no waiting relationship; progress updates also use notify |

| mode | Loaded but idle | Running |
| --- | --- | --- |
| queue | wakes and starts a new turn | enters the native nextTurn inbox, executed after the current turn |
| steer | wakes and starts a new turn | enters the native nextStep inbox, joining the current execution at a safe input boundary |
| defer | persists a note, does not wake | left for the next turn, cannot enter the current turn |

`steer` does not cancel a running tool and does not bypass a permission check. The native inbox claims one nextTurn message at the first step of a turn and all nextStep messages at once; queue therefore opens turns one at a time, while the same turn may still contain steer and defer input.

The "next" in `defer` means strictly the input-collection boundary of the next turn. A note that arrives after a turn has started is not added to that turn even when the model request has not been sent yet. defer schedules no timed wake-up, is not claimed by a read, and does not start a model on its own because the TUI was opened or resumed.

All three kinds can use all three modes. `request + defer` is "handle it when there is time"; the caller cannot assume the target runs soon. `notify + steer` is information that needs to be seen as soon as possible. A normal reply defaults to queue and may explicitly choose another mode.

## Agent tools

```ts
list_sessions({ project?, workspace?, cursor?, limit? })
read_session({ session_id, after?, limit? })
send_session({
  session_id,
  kind: "request" | "notify",
  mode: "queue" | "steer" | "defer",
  text,
  in_reply_to?, // used when a notify reports progress back; not valid for request
  idempotency_key
})
reply_session({
  request_message_id,
  text,
  mode?: "queue" | "steer" | "defer", // queue by default
  idempotency_key
})
```

list/read return the existing card, run status, paged events and the bounded message reception state. list may support exact local filtering; the first version adds neither model-driven target selection nor semantic search. The tools require a full session ID; the CLI may keep supporting a unique prefix. read is read-only: it claims no defer message and wakes nobody.

A reply's recipient is derived from the original request, and the caller must be that request's recipient. A separate reply tool reduces the chance of filling in the wrong correlation ID, answering the wrong session, or turning a reply into a new task. Underneath it is still the same message envelope.

Sending is asynchronous and returns a persisted receipt without waiting for the target to finish. The first version offers no blocking `wait_session`: the agent can end its turn and be woken again by the queue/steer reply. If a wait is added later it must suspend the waiting side rather than occupy a tool call waiting, or a reply may be unable to enter a turn that is already waiting.

The CLI keeps the current default queue and `--steer`, adds `--defer` (mutually exclusive with `--steer`) and `--kind`, and provides a matching reply subcommand. The existing `--title` remains the CLI's explicit rename capability and is not opened to the agent message tools by default.

## Message envelope and identity

The runtime generates and validates the following envelope; a model can only fill in the public tool parameters:

```ts
type SessionMessage = {
  version: 1;
  messageId: string;
  idempotencyKey: string;
  from: { kind: "session"; sessionId: string }
      | { kind: "external"; source: string };
  toSessionId: string;
  kind: "request" | "reply" | "notify";
  mode: "queue" | "steer" | "defer";
  text: string;
  chainIds: string[];
  parentMessageIds: string[];
  inReplyTo?: string;
  createdAt: number;
  expiresAt: number;
};
```

A model cannot choose the sender, create a new task chain, reduce the depth, extend the deadline or reset a budget. The source label used for display is not authentication. An agent send across Hosts needs a credential bound to the sender's runtime; a plain CLI cannot gain a session identity just by passing `source=agent`.

These constraints stop accidental loops in a normal tool chain; they do not treat the same OS user as a security isolation boundary. An agent with arbitrary shell, state-directory and credential access can still bypass the entry point; resisting deliberate bypass needs additional sandbox permission isolation, which the first version does not promise.

## Anti-loop rules

### The runtime continues the task chain

Only a trusted human input entry point or an authorised external task entry point can create a root task chain. A received message, its later turns, tool retries, automatic continuation, child agents and a resume all inherit the original chain. An ordinary user follow-up cannot automatically top up the budget of communication in flight; only explicitly starting a new task or continuing a stopped one establishes a new authorisation boundary.

When one turn processes several chains in a batch, the conservative rule applies: an outbound message is tied to the set of chains of the input claimed in that turn and is constrained by all of their budgets at once, and the model may not pick the one with the most remaining room. A chain brought in by steer takes effect for later outbound calls; a call already authorised before that is not changed retroactively. When the chain set exceeds its limit, later input batches are split rather than dropping the association.

A claimed defer note still carries its old chain. "Leave a note and deal with it later" cannot wash away a budget; mixing a human task and an old note towards one target may cause a conservative refusal, a trade the first version accepts. The user can explicitly re-authorise and continue.

### Bounded delegation and bounded communication

The proposed initial defaults (configurable, all enforced by the runtime):

| Limit | Default | How it counts |
| --- | --- | --- |
| Delegation depth | 3 cross-session edges | A → B → C → D reaches the limit |
| New-message budget | 8 request/notify per chain | defer counts too; a new follow-up question counts too |
| Final reply | 1 per received request | a reply slot is reserved when a request is received, allowing at most 8 more replies |
| Chain validity | 1 hour | a derived message cannot extend it; after expiry nothing wakes automatically |
| Body | at most 64000 bytes each | keeps the bridge limit |
| Unclaimed mailbox | at most 100 notes per session with 1 MiB of bodies in total | a new message is refused when full, never silently overwritten |

A new request/notify may not be sent to oneself or to an ancestor in the current delegation path, which blocks A → B → A and A → B → C → A directly. A reply may return along the original request; when A then asks B a follow-up it spends a new message budget. The path is computed from delegation relationships, and a legitimate reply returning is not counted as a new delegation.

When a progress notify has to reach the requester it should be explicitly tied to the original request and handled as a report-back: the target is derived from the original request and checked against session_id, returning to an ancestor is allowed, and it still spends a new message budget. An optional `in_reply_to` only lets the original recipient notify the original sender, and it can neither change identity nor create a chain.

Retrying the same idempotency key does not count twice and does not wake twice; the same key with a different body, target, kind or mode returns a conflict. Counters, reply slots and idempotency records are persisted, and concurrent admission across Hosts must be atomic. A failed transfer can keep retrying the same message; the quota is never bypassed by "refund and create a new ID".

When a chain's new-message budget is exhausted, an already reserved final reply can still return, so B does not finish its work and then fail to answer A. A reply creates no new reply slot; an automatic "acknowledged" is not part of the protocol.

### Expiry, cancellation and failure

A request's business state is `open → replied | cancelled | expired`. Only the original sender or the user may cancel. A normal final reply closes the request atomically; a successful send does not mean the answer is right or that the user has accepted the task.

A cancelled or expired request no longer accepts a new reply that would wake anyone; the first late reply may be stored as a readable record and answered with `late_reply`, but nothing is scheduled. A repeated late reply is still de-duplicated. An existing request relationship stays, and a reply slot cannot be regained by deleting the UI entry.

Cancelling a message that has not been consumed stops its consumption; content that has already entered the model context cannot be recalled. Cancelling a request is not the same as killing a tool or rolling back a side effect, and it does not cancel other tasks the target is working on.

An exhausted budget, an expired chain and a path cycle each return a structured error and write one observable event; no "rejection notice" is sent automatically to another session, so an error notification cannot become a cycle by itself. An expired defer note is still readable by hand but does not enter the next turn automatically.

## Persistence and runtime integration

It reuses the current Host/socket and the native `Agent.followup()` / `Agent.steer()`. A new CommunicationService owns message admission, persistence, causal chains, reply correlation and defer claiming; it executes no model and builds no second agent scheduler.

One state directory uses one SQLite communication ledger recording chains, messages, request state, delivery receipts and runtime owner information. It is a bounded communication mailbox and de-duplication ledger; the execution queue is still the native inbox. A write transaction covers only metadata admission and counters, never spanning a model request, a tool call, a socket wait or a session flush.

Each Host hands a message to the target owner through the existing socket; a successful delivery is ordered by the target's admission order, and the wall-clock send order of different sources is not guaranteed. The ledger never polls a session awake; an unfinished admission is only re-delivered on a same-key retry, an owner recovery, or when existing runtime recovery handles it.

Reading uses a WAL snapshot and acquires no session write lock; no claim is made that SQLite or the whole system is lock-free in the algorithmic sense. The existing event paging semantics are kept.

Message delivery state is:

```text
accepted → admitted → consumed
    └──────────────→ cancelled / expired (when unconsumed)
```

- accepted: the envelope and the budget reservation are persisted. A defer may stay here for a long time.
- admitted: a persisted record already exists in the target's native inbox or in the named turn's input.
- consumed: a persisted turn-input record proves the message entered the context; it does not mean the model understood it, the task is done, or a tool side effect happened exactly once.

A successful queue/steer ACK still waits for the native inbox flush, keeping the guarantee of the existing accepted receipt. A defer ACK only requires the communication ledger to be persisted, and explicitly returns `delivery: deferred`, `wake: false`. If a Host crash after admission loses the ACK, a same-key retry looks up the original record and completes the unfinished delivery.

There is no shared transaction between SQLite and the native session log, so a stable messageId and replayable delivery records are used: persist the intent first, then write and flush the native inbox, and finally confirm admitted. On recovery it first checks whether the native log already holds that messageId before deciding to re-deliver. A receipt tombstone is kept until the chain ends and the retry retention window has passed, so deleting a message never loses the de-duplication evidence.

A defer freezes one batch by recipient sequence before the turn's input collection, records batchId/turnId/messageIds stably, and only then injects the plugin messages with their source. A message arriving after the freeze waits for the next round. A message is marked consumed only after the native turn input is confirmed persisted; recovery matches on turnId/messageId, avoiding both "delete first, then crash and lose the note" and a duplicate injection on a normal resume. Notes beyond one round's input budget are retained in order with no body truncation; leftover defer messages never trigger the next round on their own.

The currently installed version has verified that the timing semantics are implementable through the existing plugin interfaces: freeze the note recipient sequence in the synchronous `session/event` `turn/start` notification, then wait for the batch to persist in the first step's `agent/pre-step` waterfall and append the notes to the returned `decision.messages`. The latter happens after the native inbox claim, so it cannot modify native input that has already been claimed; it only appends notes frozen in the separate mailbox. A session observer cannot block asynchronously or re-enter append; it only records the cutoff or an error, and a missing valid cutoff makes the awaitable pre-step refuse that claim.

`agent.inject()` is equivalent to a nextStep enqueue with no deliberate wake, and a running driver still consumes it in the current turn, so it does not satisfy defer. A note cannot be placed in either native inbox in advance either: `hasPending` would keep the existing driver running.

The owner of each `(stateHome, sessionId)` must be unique. The native JSONL persistence in the current installation already holds an OS-exclusive lock for the whole lifetime of the write handle; the two-real-Host contention test on this macOS machine confirmed it, so this design reuses that lock instead of adding a second owner lock. Communication delivery records still need an owner generation to reject commits from a stale connection or stale delivery work. A live owner must not be preempted on a heartbeat expiry alone. Only a Host that has successfully acquired the native write handle may deliver a communication-ledger message into that session.

## Observability

A send receipt carries messageId, the de-duplication flag, delivery, whether a wake-up was actually requested and the related request's state. list/read provide the pending queue/steer/defer counts and paged message state; communication content is never written into the descriptive card.

The TUI shows the source session, kind, mode and body, and shows "note left, waiting for the next turn" for a defer. A tool call still follows the existing display policy of hiding historical tool calls; a received message shows as a recognisable relay. The user can view notes, cancel an unconsumed request, and see why a chain's budget was exhausted.

Communication events are subscribed through a separate mailbox watch cursor, without reusing or changing the existing session event.seq; native inbox/consumption events keep showing through the existing `watch`. That makes a defer observable before it ever enters a turn while leaving the existing event paging and reconnect semantics intact.

## Delivery order and acceptance

1. Reuse the confirmed native owner exclusivity and the turn/pre-step integration points; complete the persisted mailbox, stable message identity and the crash-recovery protocol.
2. Integrate queue/steer/defer while keeping the existing CLI receipt, retry and title behaviour.
3. Add request/reply/notify, chain budgets, the ancestor check and cross-Host atomic admission, and only then open the agent tools; never open automatic communication without a budget first.
4. Integrate the TUI and the read interface with the communication event subscription, and update the CLI and the user documentation.

Behaviour tests that must pass:

- Idle/running × the three modes; queue batching; steer not cancelling a tool; defer arriving before and after a turn boundary.
- A defer wakes nobody during read, resume or a long idle; the next natural turn claims it exactly once; a batch overflow stays ordered.
- No budget overrun under concurrent sending from several Hosts; a doubly loaded session allows exactly one owner.
- De-duplication and re-delivery across a lost ACK, a crash after the ledger write, a crash after the inbox flush and a crash before the consumption acknowledgement.
- A/B requesting each other, a notify report-back, a cyclic follow-up, a defer delayed cycle, and chain inheritance across a resume and a child agent.
- Exactly one final reply per request; a reserved reply still returns after the send ceiling; repeated and late replies do not wake anyone again.
- Merged chains, a new chain arriving by steer, a forged source/chain ID, and a model unable to reset the allowance by changing the idempotency key.
- Expiry, cancellation, a full mailbox, a target exit and a slow subscriber not blocking other sessions; a message source never becoming user authorisation.

Validate the protocol and scheduling with a deterministic local model, then observe collaboration quality with a real model. The protocol can bound the message count and the number of automatic activations; overthinking inside a single session, tool loops and total token consumption are still governed by its execution budget.

## Underlying investigation results (0.1.5-rc.1 as installed at the time, since upgraded to 0.1.5-rc.2)

The check was against the `node_modules` artifacts dscode actually uses, not a neighbouring Harness source checkout standing in for the running version. Reproducible command: `node scripts/verify-runtime-foundations.mjs`. The script uses only a temporary state directory, the real Harness/JSONL backend and a deterministic local model, and calls no network model.

**Single write owner: already present.** `SessionWriteLease.acquire` (around line 661) in `dsh-session-persistence-jsonl/lib/index.js` takes a non-blocking flock on `session.lock` through the native `tryLockExclusive` on POSIX; contention maps to `SessionAlreadyOwnedError`. `open(id, "write")` (around line 2345) acquires the lock before returning the handle; `resumeWith` in `dsh-agent-loop/lib/index.js` (around line 1887) takes that handle first and only then prepares and publishes the Agent. A new session acquires the lock on its first materialised write, and the normal Agent publication path persists the seed first. The lock is released when the write handle closes or the process dies, with no heartbeat-expiry takeover; a read handle does not take it.

Measured coverage: a newly created but idle Host A already stopped Host B from resuming; after being refused, B published no Agent and could still open/read; after A was SIGKILLed a new Host resumed successfully; after a normal dispose a resume succeeded again. The test has only run on this macOS machine, and other platforms or a combination without JSONL persistence have not been verified.

**Turn input timing: the existing interfaces suffice, but two events have to be combined.** The current order is `turn/start → inbox.claim → systemPrompt.assemble → await agent/pre-step → step/start → prepareRequest → append user/message → model stream`. `turn/start` is a synchronous observer notification, while `agent/pre-step` is an awaitable waterfall that can rewrite messages. The step restarts at 1 in every turn, so the frozen notes are appended only when step=1.

Measured coverage: while the pre-step Promise was not released the model call count was zero; a note arriving before turn/start entered that turn, and a note arriving after the freeze did not enter that turn even when it arrived before the model started; a later natural turn received that note; a standalone note did not wake an idle Agent; the negative case of `inject` entered the next step of the same turn while busy; the appended note was eventually persisted through the native user/message.

**Persistence still needs separate work.** inbox.claim records the removal event first, and user/message is only appended after the later request preparation, with an await in between; observing either event does not mean the disk flush has completed. A note must not be deleted from the mailbox the moment pre-step returns: the batch record has to survive until the native user/message's stable messageId and flush receipt confirm consumption. The investigation fixture's mailbox was an in-memory sample, so it only validates the scheduling integration point and makes no claim to have verified full defer crash recovery or side-effect exactly-once. The implementation still owes the persistence and fault-injection tests described above.
