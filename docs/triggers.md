# Triggers: running the agent from an event

One event starts one fresh session. A trigger definition says where the event comes from, which folder the session works in, what it is asked to do, and the limits that keep an unattended run bounded.

A trigger is not a way to reach a session that is already open: that is [session communication](session-communication.md) (`dscode send`, the mailbox). A trigger always starts a new session, and that session ends with its run.

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
goal: { objective: the diff is reviewed and the tests pass, maxRounds: 12 }
limits: { timeoutSeconds: 1800, maxRunsPerDay: 4, minIntervalSeconds: 300 }
```

| Field | Meaning |
| --- | --- |
| `id` | identity, also the file name and the spool/log key |
| `enabled` | `false` makes every event a recorded skip (default `true`) |
| `source` | what produces the event, see below |
| `workspace` | the session's folder; chosen here and never changed by a run |
| `prompt` | what the session is asked to do; `{{event.text}}`, `{{event.title}}`, `{{event.source}}`, `{{event.eventId}}` and `{{event.fields.NAME}}` are substituted, and an event whose text the template never mentions is appended |
| `preset` | agent preset (default `dscode`) |
| `permission` | `auto`, `workspace-write` (default), `read-only` or `danger-full-access` — `ask` is refused, because nobody is there to answer |
| `model`, `effort` | optional route and reasoning level for the run |
| `goal` | the objective plus `maxRounds`: the run continues toward it and stops when it is reached or the rounds are spent |
| `limits` | `timeoutSeconds` (1800), `maxRunsPerDay` (24), `minIntervalSeconds` (60), optional `maxCostUsd` |
| `overlap` | `skip` (the only value): a trigger whose run is still going is skipped |
| `notify` | `log` (the only value) |

Unknown or misspelled fields are refused rather than ignored, so a typo like `maxRound` cannot fall back to the default cap.

## Sources

| `source.kind` | Fields | What fires a run |
| --- | --- | --- |
| `interval` | `seconds` | the schedule, every N seconds |
| `calendar` | `cron` (five fields) | the schedule, on the cron rule |
| `watch` | `paths` | a change to one of those paths |
| `poll` | `everySeconds`, `check` | the schedule, but only when `check` exits 0 |
| `external` | — | only what someone posts with `dscode trigger emit` |

A `poll` check runs in the workspace with a 60-second limit; anything other than exit 0 — including a timeout or a check that cannot start — means there is nothing to do. Its output is kept in the run's tail.

## Post an event

```sh
dscode trigger emit nightly-review --text "the build failed"
dscode trigger emit nightly-review --event event.json     # or "-" for stdin
dscode trigger fire nightly-review --text "do it now"     # post and run
```

An event body may carry only `source`, `title`, `text` and scalar `fields`; any other key is refused, because an event is data and must never name a permission, a session or a tool. `eventId` identifies the event: pass `--event-id` when a producer may retry, and the same id is never run twice. Delivery is at-most-once — an event file is consumed when its run starts.

## Run one

```sh
dscode trigger run nightly-review     # decide, then run if the limits allow
dscode trigger list                   # definitions and each one's last outcome
dscode trigger show nightly-review    # one definition in full
dscode trigger log nightly-review     # recorded runs, newest first
dscode trigger log --failed           # only what did not complete
dscode trigger events nightly-review  # events waiting in the spool
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

A fresh session in the definition's `workspace` — the same folder binding the terminal uses, so the session's shell and log stay there. The goal is created through the goal service (the model-facing goal tools require a direct human turn, which an unattended run never has), the prompt is delivered, and the goal round driver continues the work turn after turn until:

- the goal is complete (exit 0) or blocked (exit 3);
- the round cap or `maxCostUsd` is reached (exit 2);
- `timeoutSeconds` passes (exit 124);
- the goal is paused (exit 3);
- an approval is needed: it is rejected, because no human is present, and the run is marked `approval_required` when a cap or the timeout then stops it (fail closed).

The outcome, reason, exit code, session id, cost and rounds go to `<state>/triggers/runs.jsonl`, and the agent's last message to `<state>/triggers/logs/<id>/<runId>.log`. The session itself is durable: it appears in `dscode sessions` and `/resume`.

## Schedule it

```sh
dscode trigger install nightly-review     # launchd, or the crontab line to paste
dscode trigger uninstall nightly-review
```

`install` writes a LaunchAgent, loads it, and prints the crontab equivalent. `interval` and `poll` become `StartInterval`, a five-field `calendar` becomes `StartCalendarInterval`, and `watch` becomes `WatchPaths`. A cron shape launchd cannot express — ranges, steps, lists — fails the install instead of approximating it; an `external` source has nothing to schedule and says so. On a machine without launchd the same schedule prints as a crontab line. The agent runs while you are logged in.

## In the terminal

`/triggers` lists every definition with its last outcome, and `/triggers show`, `/triggers runs` and `/triggers events` print one definition, its recorded runs, and the events waiting in its spool. The command is read-only; runs are started with `dscode trigger`.

## Current limits

- Nothing notifies you yet. `runs.jsonl` and `dscode trigger log --failed` are the record a notifier will read.
- A scheduled firing is identified by its cadence window: a replayed or duplicated scheduler tick inside the same window is the same firing and does not start a second session, and the next window runs normally.
- A trigger never asks for approval, and an event can never widen its authority.
- An unattended run is bounded by `goal.maxRounds`, the limits, and its definition's permission preset; the goal round driver must be mounted for a run to get past its first turn.
