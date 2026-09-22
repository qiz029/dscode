# Triggers: running the agent from an event

One event starts one run. By default each run starts a fresh session; a persistent trigger resumes its own session across runs. A trigger definition says where the event comes from, which folder the session works in, what it is asked to do, and the limits that keep an unattended run bounded.

A trigger is not a way to reach a session that is already open: that is [session communication](session-communication.md) (`dscode send`, the mailbox). A persistent trigger owns its session binding; it does not attach to an arbitrary open conversation. Each run ends independently, while its session history remains durable.

## Define a trigger

| Where | Who reads it |
| --- | --- |
| `<state>/triggers/<id>.yml` or `.json` | this machine |
| `<project>/.dsh/triggers/<id>.yml` or `.json` | this project, reviewed with it |

The file name must equal the `id`, and a project file wins over a machine file with the same id. An unreadable file is reported by `dscode trigger list` without hiding the others.

```yaml
id: nightly-review
workspace: /Users/me/work/repo        # absolute; the session binds here
prompt: review the diff and fix what is broken
source: { kind: calendar, cron: "0 9 * * *" }
session: { mode: new }               # new (default), or persistent
goal: { objective: the diff is reviewed and the tests pass, maxRounds: 12 }
limits: { timeoutSeconds: 1800, maxRunsPerDay: 4, minIntervalSeconds: 300 }
```

| Field | Meaning |
| --- | --- |
| `id` | identity, also the file name and the spool/log key |
| `enabled` | `false` prevents execution; manual runs skip, scheduled jobs remain pending (default `true`) |
| `source` | what produces the event, see below |
| `workspace` | the session's folder; chosen here and never changed by a run |
| `prompt` | what the session is asked to do; `{{event.text}}`, `{{event.title}}`, `{{event.source}}`, `{{event.eventId}}` and `{{event.fields.NAME}}` are substituted, and an event whose text the template never mentions is appended |
| `session.mode` | `new` (default): a fresh session for every run; `persistent`: create once, then resume the same session |
| `preset` | agent preset (default `dscode`) |
| `permission` | `auto`, `workspace-write` (default), `read-only` or `danger-full-access` — `ask` is refused, because nobody is there to answer |
| `model`, `effort` | optional route and reasoning level for the run |
| `goal` | the objective plus `maxRounds`: the run continues toward it and stops when it is reached or the rounds are spent |
| `limits` | `timeoutSeconds` (1800), `maxRunsPerDay` (24), `minIntervalSeconds` (60), optional `maxCostUsd` |
| `overlap` | `skip` for `new`, `queue` for `persistent`; defaults follow the session mode, and conflicting values are refused |
| `notify` | `log` (the only value) |

Unknown or misspelled fields are refused rather than ignored, so a typo like `maxRound` cannot fall back to the default cap.

## Ask DSCODE to manage schedules

The agent has four tools over the same definition files and SQLite jobs used by the CLI:

| Tool | Actions |
| --- | --- |
| `trigger_manage` | `list`, `get`, `create`, `update`, `enable`, `disable`, `register`, `unregister` |
| `trigger_jobs` | `schedule`, `list`, `cancel` |
| `trigger_source` | `status`, `start`, `stop`, `restart`, `logs` |
| `trigger_scheduler` | `status`, `install` |

For example, ask “Check this project's build every weekday at 9 am in America/Los_Angeles” or “Run this trigger once in 30 minutes.” The agent creates a project-local definition with `trigger_manage`, then uses `trigger_jobs` for a one-shot event. Creating or updating a `calendar` or `interval` definition also registers its cadence. A `script` definition registers a supervised producer. An `external` definition has no recurring schedule. `update` merges top-level fields; a supplied nested object, such as `limits`, replaces that entire object and omitted fields inside it receive their normal defaults. Both `new` and `persistent` session modes are supported.

A delay call supplies an existing `trigger_id`, exactly one of `after` (`30m`) or `at` (an ISO timestamp with a UTC offset), and an `idempotency_key`. Retrying the same key and request returns the original job and original due time, including after cancellation or completion. Reusing that key for a different request is refused. Keys are scoped to the workspace. `list` returns up to 100 jobs (50 by default), newest due time first, including terminal states.

The tools bind definitions and job management to the current session's workspace. They create or edit project-local definitions only; machine-level definitions in that workspace can be inspected and scheduled without rewriting their files. Agent-managed execution uses the `dscode` preset with `read-only` or `workspace-write` permission. Mutations go through the existing tool approval pipeline, including automatic review when enabled. Plan mode, read-only sessions, subagents and unattended trigger runs cannot mutate schedules through these tools.

Every scheduling response reports `scheduler.running`. A saved job does not by itself start the scheduler. On macOS, `trigger_scheduler` with `action: install` installs the shared launchd service, which can deliver due jobs from every registered project in that state directory. Other platforms receive instructions for their service manager. Service installation acknowledgement and observed liveness are reported separately. These tools do not stop the shared service; use the CLI for that machine-wide operation.

Disabling a trigger leaves its pending jobs waiting. `unregister` cancels pending recurring jobs from that registration while leaving one-shot jobs intact. `cancel` cancels one pending job and never interrupts a running job. No completion notification is sent yet; inspect the jobs and run log for results.

## Choose a session mode

```yaml
id: project-monitor
workspace: /Users/me/work/repo
source: { kind: external }
session: { mode: persistent }
prompt: "Review this event using the previous findings: {{event.text}}"
goal: { objective: this event has been investigated, maxRounds: 12 }
```

`new` isolates each event's context. `persistent` creates a session on its first run and stores the binding in `<state>/triggers/sessions/<id>.json`; later runs resume that session through the ordinary session persistence service, including after a CLI or machine restart. Each event still has a distinct run id, a fresh goal, its own round cap and its own cost cap. An earlier blocked, paused or unfinished goal is cleared through the goal service before the new goal is created; its history and run result remain available. This is a new attempt for the new event, not an automatic retry of the old one.

A persistent trigger's workspace and agent preset must continue to match its binding. Use a new trigger id to start a different workspace or preset. A missing or unreadable bound session is an error; it never silently becomes an empty conversation. Switching to `new` leaves the old binding alone, so switching back to `persistent` resumes the earlier persistent session.

Persistent runs process queued events oldest first. Concurrent `fire` or scheduled `run` invocations persist their events and wait for the trigger's execution lock; the active command drains arrivals after the current run. The command stays alive while draining, waiting for `minIntervalSeconds` between runs. Reaching the daily cap, disabling the trigger, or losing the runner leaves pending events on disk for a later `run`. Direct `fire` events and legacy spool files still need a `run` invocation after every waiting process exits. `emit` commits a job to the shared scheduler queue; it returns without waiting for the model. A run stopped by interruption leaves subsequent events pending.

The lock is shared across CLI processes and inherited by the Host, so killing a parent cannot start a second writer while its Host is still alive. The ordinary session persistence lock also refuses to resume a session already open for writing in another Host (including the TUI).

## Sources

| `source.kind` | Fields | What fires a run |
| --- | --- | --- |
| `interval` | `seconds` | the schedule, every N seconds |
| `calendar` | `cron` (five numeric fields), optional `timezone`, `misfire` | the schedule, on the cron rule |
| `watch` | `paths` | a change to one of those paths |
| `poll` | `everySeconds`, `check` | the schedule, but only when `check` exits 0 |
| `script` | `mode`, `command`; poll also requires `everySeconds` | a sandboxed script submits explicit events |
| `external` | — | only what someone posts with `dscode trigger emit` |

A legacy `poll` check runs in a filesystem sandbox in the workspace with a 60-second limit; anything other than exit 0 — including a timeout or a check that cannot start — means there is nothing to do. Its output is kept in the run's tail. It never falls back to an unsandboxed shell when sandbox setup fails.

## Post an event

```sh
dscode trigger emit nightly-review --text "the build failed"
dscode trigger emit nightly-review --event event.json     # or "-" for stdin
dscode trigger fire nightly-review --text "do it now"     # post and run
```

An event body may carry only `source`, `title`, `text` and scalar `fields`; any other key is refused, because an event is data and must never name a permission, a session or a tool. Pass a stable `--event-id` when a producer may retry. `emit` commits the event and its job atomically in SQLite before returning success. Repeating the same event id and payload returns the original job, even after completion or cancellation; changing the payload under that id is refused. At most 100 pending/running jobs per project and trigger may be admitted through `emit`. `QUEUE_FULL` means no new event was accepted: retry later with the same id. Event text is limited to 64,000 bytes and the complete normalized body to 128 KiB. Tasks with external side effects should also use `eventId` for their own idempotency.

`fire` retains its direct, synchronous spool path. Legacy spool files are not automatically migrated into the scheduler queue. An interrupted direct spool run can be replayed if its result was never recorded.

## Run one

```sh
dscode trigger run nightly-review     # decide, then run if the limits allow
dscode trigger list                   # definitions and each one's last outcome
dscode trigger show nightly-review    # one definition in full
dscode trigger log nightly-review     # recorded runs, newest first
dscode trigger log --failed           # only what did not complete
dscode trigger events nightly-review  # queued events and legacy spool entries
```

Before a session starts, `run` refuses: a disabled definition, a workspace that does not exist, an event id already recorded, a spent 24-hour cap, a run inside `minIntervalSeconds`, or a run that is still in flight. A refusal is recorded as `skipped` with its reason and exits 0; it never counts against the cap or the interval.

| Exit code | Meaning |
| --- | --- |
| 0 | completed, or skipped with a reason |
| 1 | the run failed |
| 2 | a cap stopped it (rounds or cost) |
| 3 | the goal is blocked or paused |
| 124 | the timeout stopped it |
| 130 | it was interrupted |

## What one run is

A fresh or resumed session in the definition's `workspace` — the same folder binding the terminal uses, so the session's shell and log stay there. The goal is created through the goal service (the model-facing goal tools require a direct human turn, which an unattended run never has), the prompt is delivered, and the goal round driver continues the work turn after turn until:

- the goal is complete (exit 0) or blocked (exit 3);
- the round cap or `maxCostUsd` is reached (exit 2);
- `timeoutSeconds` passes (exit 124);
- the goal is paused (exit 3);
- an approval is needed: it is rejected, because no human is present, and the run is marked `approval_required` when a cap or the timeout then stops it (fail closed).

Cost is the spend added by this run, rather than the persistent session's lifetime spend. The outcome, reason, exit code, session id, cost and rounds go to `<state>/triggers/runs.jsonl`, and the agent's last message to `<state>/triggers/logs/<id>/<runId>.log`. The session itself is durable: it appears in `dscode sessions` and `/resume`.

## Schedule recurring work

```yaml
source:
  kind: calendar
  cron: "0 9 * * 1-5"
  timezone: America/Los_Angeles
  misfire: run-once
```

Cron uses five numeric fields and accepts `*`, lists, ranges and steps, such as `*/15 9-17 * * 1-5`. `timezone` accepts an IANA time zone and defaults to the machine's current time zone. Calendar iteration uses the pinned [cron-parser](https://github.com/harrisiirak/cron-parser) dependency, including its daylight-saving behavior. A cron expression or time zone that cannot be evaluated is rejected before installation.

```sh
dscode trigger install nightly-review
dscode trigger uninstall nightly-review
```

For `calendar`, `interval`, `poll` and `script`, `install` registers the recurring source with the shared scheduler and installs its launchd service on macOS. Reinstalling the same source preserves its cursor. Editing a registered source, or re-enabling it, resets its next firing from the time the scheduler observes the change. A disabled or missing definition generates no new occurrences. `uninstall` removes the recurring registration and cancels its pending recurring jobs; separately scheduled delay jobs remain. It leaves the shared scheduler running for other triggers.

`watch` continues to use its own launchd `WatchPaths` agent. An `external` source has no recurring schedule: emit events or schedule individual jobs for it. Reinstalling a previously installed recurring trigger removes its old per-trigger launchd registration before using the shared scheduler.

When the machine wakes or the scheduler restarts, `misfire: run-once` (the default) merges missed cron occurrences into one job for the latest missed instant. `misfire: skip` drops missed instants older than the current minute. A firing in the current minute is still eligible. Intervals and polls merge missed occurrences into one job. There is no replay of every missed tick.

## Schedule one event

```sh
dscode trigger schedule nightly-review --after 30m --text "check the build again"
dscode trigger schedule nightly-review --at "2026-09-23T09:00:00-07:00" --event event.json
dscode trigger jobs nightly-review
dscode trigger cancel job-REPLACE-WITH-RETURNED-ID
```

`schedule` takes exactly one of `--after` (`s`, `m`, `h`, `d`) or `--at` (a future ISO timestamp with seconds and an explicit UTC offset). The event has the same data-only payload as `emit`; it cannot select a session, workspace or permission. The command returns a durable `jobId` immediately without starting an agent. `cancel` applies only to a pending job and never interrupts a run already claimed by a worker.

Jobs are stored in `<state>/triggers/jobs.sqlite`, independently of the producer process. A delay that becomes due while the machine is asleep runs after the scheduler is available again. Due time means eligible to run: overlap, minimum intervals, daily caps and disabled definitions keep a job pending with its waiting reason shown by `jobs`. Due jobs for one trigger execute oldest first in either session mode. Jobs keep their original workspace; a changed workspace holds them with `workspace_changed` until cancelled and rescheduled.

Each job has its own `jobId`; when claimed, it also has a `runId` and uses `job:<jobId>` as its event identity for cron/delay jobs; emitted jobs keep the producer's original event id. The run record carries the job id and session id. Job states are `pending`, `running`, `completed`, `failed` and `cancelled`. A false poll predicate completes the job with `no_match` without starting an agent. Failed jobs are not automatically retried. If a worker dies, the scheduler waits for any surviving Host to release its lock, then uses the run record to settle the job or marks it `failed (interrupted)` when no result survived. It never assumes an interrupted job had no external effects.

## Script producers and loops

Use `script` when an agent needs to write a custom detector, poll an API, or maintain a subscription. The script does cheap detection work; an emitted event starts the usual bounded agent run. Save scripts in the project so their code can be inspected alongside the trigger definition.

```yaml
source:
  kind: script
  mode: daemon
  command: ["python3", ".dsh/scripts/watch_build.py"]
  permission: read-only
```

`command` is an argv array, with no implicit shell. Relative script paths resolve from the trigger's workspace. `daemon` owns its loop and runs until stopped. For a finite check, use `mode: poll`, `everySeconds: 60`, and optionally `timeoutSeconds: 30` (default 60). A successful poll waits its interval after exit; it creates no model job unless it emits an event. Unexpected daemon exits and failed/timed-out polls restart with exponential backoff from 2 seconds up to 5 minutes. Missed polls are not replayed.

Within either script mode:

```sh
dscode trigger emit build-monitor --event-id "build:123:failed" --text "Build 123 failed"
```

The private `dscode` command provided on the script's PATH supports only `trigger emit`, with `--text` or `--event FILE` (`-` reads JSON from stdin). It returns a JSON receipt containing `jobId`, `state` and `eventId`. A nonzero exit means the producer must retry the same event rather than advance its cursor. Store cursors under the writable directory named by `DSCODE_SOURCE_STATE`; it survives process restarts. `TMPDIR` is a separate temporary directory removed after each attempt. `DSCODE_TRIGGER_ID` names the bound trigger. The local ingress accepts only that trigger and validates the event before acknowledging its durable commit.

The script's filesystem permission is independent of the agent run's permission. It defaults to `read-only`, with writes allowed only in its private state and temporary directories. `source.permission: workspace-write` also permits workspace writes while excluding the DSCODE state directory. Scripts inherit the scheduler's environment and network access; this is a filesystem write boundary, not credential or network isolation. macOS uses Seatbelt, Linux requires bubblewrap, and other platforms refuse execution. Sandbox setup failures never run the script unrestricted. The legacy `poll.check` shell predicate now uses the same sandbox launcher.

```sh
dscode trigger install build-monitor          # register and install shared scheduler
dscode trigger source build-monitor status
dscode trigger source build-monitor logs      # last 32,768 characters
dscode trigger source build-monitor stop
dscode trigger source build-monitor start
dscode trigger source build-monitor restart
```

The agent uses `trigger_manage` to create/update the definition and `trigger_source` for these lifecycle actions. Saving a definition registers it; process startup still requires the shared scheduler. A stop persists until an explicit start/restart. Disabling a definition stops its producer, and re-enabling it resumes a producer whose desired state is running. Editing the command or source settings restarts the process; after editing script contents alone, use `restart`. Stop/unregister leave already accepted event jobs intact; cancel those separately when needed. Status distinguishes desired state, the observed process, next attempt, and the last error. Output tails are bounded; they are not a full log archive.

Each source has a singleton lock. The scheduler starts a guardian that terminates the script process group on stop or loss of its scheduler IPC connection, escalating to `SIGKILL` after a short grace period. The script inherits the lock so a surviving process cannot overlap a replacement. Deliberately detached processes that create another process group are outside this cleanup guarantee. If the guardian itself is forcibly killed and a script survives with the lock, a replacement reports the held lease rather than starting a duplicate; inspect and terminate that orphan before restarting. Source supervision requires the scheduler service, so it can continue after the TUI closes but cannot run while the machine is asleep or powered off.

## Run the scheduler

```sh
dscode trigger scheduler install     # macOS: start now and at future logins
dscode trigger scheduler status
dscode trigger scheduler start       # foreground, also usable under another service manager
dscode trigger scheduler tick        # one scan; wait for the workers it starts
dscode trigger scheduler uninstall   # remove the service; retain jobs and registrations
```

One scheduler owns each state directory. It scans roughly once per second, launches at most four workers concurrently and never runs model work itself. Each worker uses the ordinary trigger execution path, with a fresh or persistent session according to the definition. It also supervises up to 16 script processes, independently of the four model workers. Ordinary `emit` events use the same durable job queue. `scheduler tick` only scans jobs; use the long-running scheduler to supervise scripts.

The macOS service is written to `~/Library/LaunchAgents/ai.dscode.scheduler.<state-hash>.plist` with an explicit Node executable, state directory and PATH. launchd restarts it after exit and starts it at login; jobs do not run while the machine is powered off. On other platforms, `install` prints the foreground command for your service manager. `scheduler.log` and per-job worker output under `<state>/triggers/jobs/<jobId>.log` explain startup failures. Updating or moving the Node/DSCODE executable requires updating and restarting the service (`scheduler uninstall`, then `scheduler install`).

## In the terminal

`/trigger` opens a text overview of this workspace's definitions, source registrations and scheduler status. `/triggers` is a compatible alias with the same management commands. Use `/trigger help` for the complete syntax.

```text
/trigger
/trigger new build-monitor
/trigger show build-monitor
/trigger enable build-monitor
/trigger disable build-monitor
/trigger run build-monitor Check the latest build
/trigger schedule build-monitor 30m Check again after deployment
/trigger jobs build-monitor
/trigger cancel <jobId>
/trigger source build-monitor status
/trigger source build-monitor restart
/trigger source build-monitor logs
/trigger scheduler status
/trigger scheduler install
```

`new` creates a disabled, project-local `external` starter. Configure its prompt, goal and source before enabling it, either by asking the agent or by supplying JSON fields directly:

```text
/trigger update build-monitor {"prompt":"Review recent build failures","goal":{"objective":"Report the failures and suggested fixes"},"source":{"kind":"calendar","cron":"0 9 * * 1-5","timezone":"America/Los_Angeles"}}
/trigger enable build-monitor
```

`create <id> <JSON>` creates a fully specified definition, and `update` uses the same top-level merge semantics as `trigger_manage`. `register` and `unregister` control recurring registration separately from the enabled flag. `schedule` accepts a duration (`30s`, `10m`, `2h`, `1d`) or an ISO timestamp with an explicit offset; the remainder of the line is literal event text and needs no shell quoting. `run` queues an event immediately and returns its job id. Both use the shared scheduler and report when it is stopped; neither launches a blocking agent run inside the TUI. `jobs` displays up to 100 workspace jobs. `runs` shows recent outcomes, and `events` shows durable emitted events and legacy spool entries.

These are direct user commands and do not invoke the model or its tool-approval flow. Mutations retain the same writable-session, plan-mode, unattended/subagent and workspace boundaries as the agent management tools. Definition edits remain project-local. Source start/stop/restart saves desired state for the scheduler to apply; it does not cancel accepted jobs. `/trigger scheduler install` explicitly installs the machine-wide shared service, which can deliver work from other registered projects too.

## Current limits

- Nothing notifies you yet. `runs.jsonl` and `dscode trigger log --failed` are the record a notifier will read.
- Recurring jobs have stable identities derived from their registration, source and scheduled UTC instant; job creation and advancing the schedule cursor commit together. Manual `run` invocations retain their cadence-window identities.
- A trigger never asks for approval, and an event can never widen its authority.
- An unattended run is bounded by `goal.maxRounds`, the limits, and its definition's permission preset; the goal round driver must be mounted for a run to get past its first turn.
