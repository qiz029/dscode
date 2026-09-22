# Triggers: design record

Status: implemented, including fresh/persistent session modes, durable jobs, the shared scheduler, supervised script sources and agent management tools. [Triggers](triggers.md) is the user guide for what the mechanism does today; this record keeps the decisions behind it, the limits, and what is still open. Notification transport and automatic retries remain unimplemented.

## The shape we chose

**An ingress, not a set of hooks.** Every way of waking the agent — a cron rule, a delay, a file change, a poll, a CI job — is reduced to "something posts one event". That is why the mechanism has one entry point (`dscode trigger emit`, plus `fire` for post-and-run) and one payload grammar, and why new sources cost a definition field rather than a code path.

**Durable admission before acknowledgement.** `emit` originally wrote spool files for a later explicit drain. It now commits an event receipt and job together in SQLite, so the scheduler can deliver it after the producer exits. Retries keep the original job; payload conflicts and full queues return errors. Direct `fire` retains its spool path for compatibility. Neither path claims exactly-once external effects.

**One event, one run; the session mode chooses the context.** `session.mode: new` preserves the original fresh-session behavior. `persistent` binds the trigger id to a durable session after flushing its initial state and resumes it in later Hosts. The binding pins workspace and preset; a failed resume never falls back to creating a session. Each run clears the previous goal through the service, creates a new goal and measures spend relative to its own start. Events still carry data only, never session identity or authority. This does not attach to arbitrary open sessions.

**The operating system supervises a small scheduler.** The original implementation delegated every cadence directly to launchd. Dynamic delay jobs, cancellation, time zones and restart recovery now require a durable scheduling layer. launchd owns one scheduler per state directory; it scans due jobs and starts worker CLI processes, leaving model work to the existing Host. `watch` retains its launchd adapter. There is no HTTP listener. Calendar calculations use pinned cron-parser, not launchd's limited calendar translation.

**The parent owns the lock and the record; the Host owns the agent.** A permanent guard inode carries a kernel lock inherited by the child Host, protecting the session even if its parent is killed. New-session invocations skip overlap; persistent invocations spool first, wait for ownership, and drain oldest-first under that lease. Minimum intervals delay the drain; daily caps and disabled definitions leave work pending. Definitions are reloaded between queued events. Direct spool events still require a runner; the shared scheduler consumes emitted events and scheduled jobs through the durable queue. The Host creates or resumes the agent, flushes session state and reports its run result through a file.

**The goal is created through the service, not the tool.** `create_goal` requires a direct human turn by design; an unattended run has none. The goal service is the same path the human-facing `/goal` command uses, so a triggered run gets an ordinary goal with an ordinary round cap.

**A firing has a stable job identity.** Recurring job ids derive from the registration, source configuration and planned UTC instant. SQLite commits the new job and next-firing cursor in one transaction. CLI delay jobs carry a UUID; tool-created jobs derive their identity from the workspace and idempotency key, with the original request saved in the same transaction to reject conflicting retries. A worker first takes the trigger lease, checks limits, then atomically claims the pending row with its run id. Cancellation can win only before that claim. Waiting work stays pending with a reason and next eligible time. A lost running worker is settled from its durable run record, or failed as interrupted after its Host releases the lease; it is never retried automatically. This bounds ambiguous external effects without claiming exactly-once execution.

**Script detection has a separate lifecycle.** A script source either exits after a poll or owns a daemon loop. The scheduler forks a guardian per source; IPC loss stops its process group, and a kernel lease inherited by the script excludes overlapping replacements. Persistent desired state and retry timing live beside jobs. A scoped Unix socket lets the guardian commit events without granting the script write access to the queue database. Filesystem sandbox setup is mandatory. Private cursor state is durable, temporary files are per attempt, and output is capped. This does not isolate network access or inherited credentials; deliberately detached process groups and a forcibly killed guardian remain explicit lifecycle limits.

## Run log as a contract

`<state>/triggers/runs.jsonl` carries `triggerId`, optional `jobId`, `runId`, `startedAt`, `endedAt`, `eventId`, `source`, `outcome`, `reason`, `exitCode`, `sessionId`, `cost`, `rounds` and `cwd`; the per-run tail under `logs/<trigger>/<runId>.log` carries the agent's last message (and a poll check's output when it matched nothing). `outcome` is one of `completed`, `skipped`, `failed`, `timedout`, `blocked`, `overrun`; `reason` is a stable code (`model_error`, `approval_required`, `goal_blocked`, `goal_paused`, `round_cap`, `cost_cap`, `timeout`, `interrupted`, `already_running`, `no_match`, `duplicate`, `disabled`, `over_daily_limit`, `too_soon`, `workspace_missing`) or `null`. A notifier is expected to read this file rather than parse terminal output.

## What this deliberately is not

- Not an HTTP listener or an external distributed queue.
- Not a way to attach to arbitrary existing conversations, and not a permission-escalation path.
- Not an automatic retry engine. Five-field cron, fixed intervals, poll predicates, one-shot events and script producers are supported. Producer restart backoff is separate from model-job retries; failed model jobs still need explicit handling.
- Not a second session store: a run's session is an ordinary DSCODE session with the trigger's workspace as its folder.

## Open items

- **A notifier**: nothing consumes `runs.jsonl` yet. `dscode trigger log --failed` is the current view; the transport (email through the existing plugin, or a webhook) is undecided on purpose.
- **Runtime verification**: `scripts/verify-triggers.mjs` uses real Hosts with a local deterministic model to check two-turn goals, resumed context across processes, fresh goals per event isolated new sessions, delay delivery through worker processes, cancellation, recovered cron and a sandboxed script emitting into the worker queue. `scripts/verify-trigger-tools.mjs` exercises tool discovery, cron creation, delay scheduling/cancellation, script registration and lifecycle tools, direct TUI slash management, and the approval boundary through a real agent turn. Neither probe exercises a paid provider or a live launchd schedule.
- **Poll predicates**: the validator requires `source.check`; useful first predicates are still being chosen (repository state, file mtime, an HTTP JSON field, or the IMAP mailbox through the existing email plugin).
- **Per-trigger cost cap** is enforced at the end of a turn; a run that overshoots inside one turn is bounded by `timeoutSeconds` instead.
