# Triggers: design record

Status: implemented. [Triggers](triggers.md) is the user guide for what the mechanism does today; this record keeps the decisions behind it, the limits, and what is still open. The only unimplemented piece is a notifier over the run log.

## The shape we chose

**An ingress, not a set of hooks.** Every way of waking the agent — a cron rule, a delay, a file change, a poll, a CI job — is reduced to "something posts one event". That is why the mechanism has one entry point (`dscode trigger emit`, plus `fire` for post-and-run) and one payload grammar, and why new sources cost a definition field rather than a code path.

**A spool, not a live queue.** Producers write a file and return. The spool means an event survives DSCODE not running, survives the producer exiting, and can be inspected (`dscode trigger events`); the cost is that at-most-once delivery is the contract — an event is consumed when its run starts, so a crash between the two loses it.

**One event, one fresh session.** Deliberately not a way to reach an open session (that is session communication): the run owns a clean context, its own folder binding and its own record, and it ends with the run. Two rules follow: an event may never widen authority (it is data; the payload grammar refuses anything that is not `source`/`title`/`text`/`fields`), and a run can never ask for approval (it is rejected, and the record says so).

**The operating system owns the clock.** launchd (or cron) invokes `dscode trigger run`, so there is no resident daemon to supervise, restart, port or secure, and scheduling survives reboots with the machine's own tooling. The price is that only what launchd can express is supported: a cron range, step or list fails the install instead of being approximated, and an inbound HTTP webhook has no place here at all, because nothing is listening.

**The parent owns the lock and the record; the Host owns the agent.** The CLI half takes the single-flight lock, applies the limits and writes the record; the spawned Host composes the session, creates the goal and reports back through one result file. Splitting them this way is what makes either half testable without the other, and it means a Host that is killed still leaves an explanation behind.

**The goal is created through the service, not the tool.** `create_goal` requires a direct human turn by design; an unattended run has none. The goal service is the same path the human-facing `/goal` command uses, so a triggered run gets an ordinary goal with an ordinary round cap.

**A firing has a stable identity per cadence window.** A scheduled source cannot know its planned instant from inside, so the identity is derived from the cadence: `interval:<window>`, `poll:<window>`, `calendar:<minute>`, `watch:<minute>`. A replayed or duplicated scheduler tick inside one window is the same firing and is refused as `duplicate`; external producers supply their own id and are never merged.

## Run log as a contract

`<state>/triggers/runs.jsonl` carries `triggerId`, `runId`, `startedAt`, `endedAt`, `eventId`, `source`, `outcome`, `reason`, `exitCode`, `sessionId`, `cost`, `rounds` and `cwd`; the per-run tail under `logs/<trigger>/<runId>.log` carries the agent's last message (and a poll check's output when it matched nothing). `outcome` is one of `completed`, `skipped`, `failed`, `timedout`, `blocked`, `overrun`; `reason` is a stable code (`model_error`, `approval_required`, `goal_blocked`, `goal_paused`, `round_cap`, `cost_cap`, `timeout`, `interrupted`, `already_running`, `no_match`, `duplicate`, `disabled`, `over_daily_limit`, `too_soon`, `workspace_missing`) or `null`. A notifier is expected to read this file rather than parse terminal output.

## What this deliberately is not

- Not a resident daemon, not a queue consumer beyond the spool, and not an HTTP listener.
- Not a way to feed an existing session, and not a permission-escalation path.
- Not a scheduling DSL beyond what launchd and cron express, plus the `poll` predicate.
- Not a second session store: a run's session is an ordinary DSCODE session with the trigger's workspace as its folder.

## Open items

- **A notifier**: nothing consumes `runs.jsonl` yet. `dscode trigger log --failed` is the current view; the transport (email through the existing plugin, or a webhook) is undecided on purpose.
- **A real triggered run**: the goal round driver is mounted for the Host, but whether it actually drives continuation rounds headless has not been observed end to end — a run that stops after its first turn is the failure mode to look for.
- **Poll predicates**: the validator requires `source.check`; useful first predicates are still being chosen (repository state, file mtime, an HTTP JSON field, or the IMAP mailbox through the existing email plugin).
- **Per-trigger cost cap** is enforced at the end of a turn; a run that overshoots inside one turn is bounded by `timeoutSeconds` instead.
