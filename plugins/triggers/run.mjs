// The run decision: everything that must be true before an event may start a
// session, and the record left afterwards. This is the safety half of the
// mechanism, so it is deliberately small and entirely testable: an unattended
// run must never overlap its own previous run, must never fire twice for one
// event, and must never exceed the limits its definition declares.
//
// It does NOT run an agent: executing the session (Host plugin, `dscode trigger
// run`, the goal service) is separate work. `planTriggerRun` answers "may this
// run start, and with what identity", `finishTriggerRun` records how it ended.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, join } from 'node:path';
import { appendRun, readRuns } from './log.mjs';

/** Grace added to a run's timeout before its lock is treated as abandoned. */
export const LOCK_STALE_GRACE_MS = 60000;

/** One trigger's single-flight lock. */
export const lockPath = (home, triggerId) => join(home, 'triggers', 'locks', `${triggerId}.json`);

/** True when a process id exists; EPERM means it exists but belongs to someone else. */
export function alivePid(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function readLock(home, triggerId) {
  try {
    const lock = JSON.parse(readFileSync(lockPath(home, triggerId), 'utf8'));
    return typeof lock?.runId === 'string' ? lock : undefined;
  } catch {
    return undefined;
  }
}

function writeLock(home, handle) {
  const path = lockPath(home, handle.triggerId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, JSON.stringify(handle) + '\n', { mode: 0o600 });
}

/**
 * Decide whether one event may start a run, and take the lock when it may.
 *
 * Order matters: a disabled trigger never runs; a repeated event is recognised
 * before any lock is touched; the rolling day and the minimum interval are
 * checked against recorded runs; and only then does a live lock stop the run.
 * An identity is REQUIRED: without one the duplicate check is inert, so a
 * re-drained event would start a second session. A scheduled source passes the
 * planned instant, an external producer passes its own event id.
 * @param definition - a normalized definition (plugins/triggers/config.mjs).
 * @param options - `{ home, now, eventId, isAlive, runId }`; `eventId` is required.
 * @returns `{ action: 'run', handle }` or `{ action: 'skip', reason }`.
 * @throws {Error} when `eventId` is missing or empty.
 */
export function planTriggerRun(definition, { home, now = Date.now(), eventId, isAlive = alivePid, runId = randomUUID() } = {}) {
  if (typeof eventId !== 'string' || eventId.trim() === '') throw new Error('planTriggerRun needs an eventId: it is how a repeated firing is recognised');
  if (!definition.enabled) return { action: 'skip', reason: 'disabled' };
  if (!existsSync(definition.workspace)) return { action: 'skip', reason: 'workspace_missing' };
  const recorded = readRuns(home, { triggerId: definition.id, limit: 0 }).filter(entry => entry.outcome !== 'skipped');
  if (recorded.some(entry => entry.eventId === eventId)) return { action: 'skip', reason: 'duplicate' };
  const lastDay = recorded.filter(entry => now - entry.startedAt < 24 * 60 * 60 * 1000);
  if (lastDay.length >= definition.limits.maxRunsPerDay) return { action: 'skip', reason: 'over_daily_limit' };
  const newest = recorded[0];
  if (newest !== undefined && now - newest.startedAt < definition.limits.minIntervalSeconds * 1000) return { action: 'skip', reason: 'too_soon' };

  const lock = readLock(home, definition.id);
  if (lock !== undefined) {
    // A dead holder is reclaimed at once. A live pid is normally the run itself,
    // but a recycled pid would look alive forever, so a lock older than the run's
    // own timeout (plus a grace) is abandoned regardless.
    const abandoned = now - lock.startedAt > definition.limits.timeoutSeconds * 1000 + LOCK_STALE_GRACE_MS;
    if (isAlive(lock.pid) && !abandoned) return { action: 'skip', reason: 'already_running' };
  }
  const handle = { triggerId: definition.id, runId, startedAt: now, pid: process.pid, eventId };
  writeLock(home, handle);
  return { action: 'run', handle };
}

/**
 * Drop a lock this run owns, without recording anything.
 * A lock whose contents cannot be read is left in place rather than deleted: an
 * unreadable lock may belong to another run, and deleting it would let two
 * sessions run for one trigger. It ages out on its own.
 */
export function releaseTriggerRun(home, handle) {
  const lock = readLock(home, handle.triggerId);
  if (lock === undefined || lock.runId !== handle.runId) return false;
  try {
    rmSync(lockPath(home, handle.triggerId));
    return true;
  } catch {
    return false;
  }
}

/**
 * Decide whether a run in flight should stop, and how it ended. Called after
 * every turn and by the timeout, so it only reads durable goal state plus the
 * spend the metrics ledger reports.
 *
 * Completion wins over a rejected approval: the goal was reached, and the
 * rejection is recorded in the run tail. When a cap or the timeout stops a run
 * that needed a human, `approval_required` is the reason — that is the failure an
 * operator has to fix.
 * @param state - `{ goal, costUsd, limits, approvalsRejected }`.
 * @returns `{ stop: false }` or `{ stop: true, outcome, reason, exitCode }`.
 */
export function decideStop({ goal, costUsd, limits, approvalsRejected = false } = {}) {
  const capped = approvalsRejected ? 'approval_required' : undefined;
  // A goal that is gone was cleared: nothing left to continue for.
  if (goal === undefined || goal === null) return { stop: true, outcome: 'completed', reason: null, exitCode: 0 };
  if (goal.phase === 'complete') return { stop: true, outcome: 'completed', reason: null, exitCode: 0 };
  if (goal.phase === 'blocked') return { stop: true, outcome: 'blocked', reason: 'goal_blocked', exitCode: 3 };
  if (goal.phase === 'paused') return { stop: true, outcome: 'failed', reason: 'goal_paused', exitCode: 3 };
  if (Number.isFinite(limits?.maxCostUsd) && Number.isFinite(costUsd) && costUsd >= limits.maxCostUsd) {
    return { stop: true, outcome: 'overrun', reason: capped ?? 'cost_cap', exitCode: 2 };
  }
  if (Number.isFinite(goal.maxGoalRounds) && goal.roundsStarted >= goal.maxGoalRounds) {
    return { stop: true, outcome: 'overrun', reason: capped ?? 'round_cap', exitCode: 2 };
  }
  return { stop: false };
}

/**
 * Record how a run ended and release its lock.
 * @param home - the state directory.
 * @param handle - the handle `planTriggerRun` returned.
 * @param result - `{ outcome, reason?, exitCode, sessionId?, cost?, rounds?, cwd?, endedAt?, eventId? }`.
 * @returns the appended record.
 */
export function finishTriggerRun(home, handle, result) {
  const record = appendRun(home, {
    triggerId: handle.triggerId,
    runId: handle.runId,
    startedAt: handle.startedAt,
    endedAt: result.endedAt ?? Date.now(),
    eventId: result.eventId ?? handle.eventId,
    ...(result.jobId ? { jobId: result.jobId } : {}),
    source: result.source ?? null,
    outcome: result.outcome,
    reason: result.reason ?? null,
    exitCode: result.exitCode,
    sessionId: result.sessionId ?? null,
    cost: result.cost ?? null,
    rounds: result.rounds ?? null,
    cwd: result.cwd ?? handle.cwd ?? null,
  });
  releaseTriggerRun(home, handle);
  return record;
}
