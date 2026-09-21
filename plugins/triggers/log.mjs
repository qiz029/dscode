// The run log: the durable record every trigger run appends, and the pipe a
// failure notifier will read later (docs/triggers-design.md). One JSONL file for
// outcomes plus a per-run text tail for the transcript end. A record must carry
// enough to explain a run without the terminal: what fired, which session, how
// it ended, and why.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

/** Outcomes a run record may carry. */
export const OUTCOMES = Object.freeze(['completed', 'skipped', 'failed', 'timedout', 'blocked', 'overrun']);

/** Stable skip/failure reasons; `null` on a clean completion. */
export const REASONS = Object.freeze([
  'model_error', 'approval_required', 'goal_blocked', 'goal_paused', 'round_cap', 'cost_cap', 'timeout', 'interrupted',
  'already_running', 'no_match', 'duplicate', 'disabled', 'over_daily_limit', 'too_soon', 'workspace_missing',
]);

const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

class RunLogError extends Error {}

const fail = message => { throw new RunLogError(message); };

/** The append-only outcome log for one state directory. */
export const runsPath = home => join(home, 'triggers', 'runs.jsonl');

/** The text tail of one run (the agent's own last words), beside the outcome log. */
export const runTailPath = (home, triggerId, runId) => join(home, 'triggers', 'logs', triggerId, `${runId}.log`);

/**
 * Append one run record.
 * @param home - the state directory.
 * @param record - the record; see the design record for the field set.
 * @returns the record that was written.
 * @throws {RunLogError} when a required field is missing or a value is outside the vocabulary.
 */
export function appendRun(home, record) {
  if (!isPlainObject(record)) fail('a run record must be an object');
  for (const field of ['triggerId', 'runId', 'startedAt', 'outcome', 'exitCode']) {
    if (record[field] === undefined) fail(`a run record needs ${field}`);
  }
  if (typeof record.triggerId !== 'string' || record.triggerId === '') fail('triggerId must be a non-empty string');
  if (typeof record.runId !== 'string' || record.runId === '') fail('runId must be a non-empty string');
  if (!Number.isFinite(record.startedAt)) fail('startedAt must be a number (epoch milliseconds)');
  if (!Number.isSafeInteger(record.exitCode)) fail('exitCode must be a whole number');
  if (!OUTCOMES.includes(record.outcome)) fail(`outcome must be one of: ${OUTCOMES.join(', ')}`);
  if (record.reason !== null && record.reason !== undefined && !REASONS.includes(record.reason)) {
    fail(`reason must be null or one of: ${REASONS.join(', ')}`);
  }
  const path = runsPath(home);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, JSON.stringify({ endedAt: null, sessionId: null, cost: null, rounds: null, ...record, reason: record.reason ?? null }) + '\n', { mode: 0o600 });
  return record;
}

/**
 * Read recent run records, newest first. A torn or unreadable line is skipped
 * rather than failing the listing: the log is append-only and a half-written
 * line is what a crash mid-append leaves behind.
 * @param home - the state directory.
 * @param options - `{ triggerId, limit }`.
 * @returns run records, newest first.
 */
export function readRuns(home, { triggerId, limit = 20 } = {}) {
  let raw;
  try {
    raw = readFileSync(runsPath(home), 'utf8');
  } catch {
    return [];
  }
  const records = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (triggerId !== undefined && record.triggerId !== triggerId) continue;
    records.push(record);
  }
  records.reverse();
  return limit === 0 ? records : records.slice(0, limit);
}

/** Write (replacing) one run's text tail. */
export function writeRunTail(home, triggerId, runId, text) {
  const path = runTailPath(home, triggerId, runId);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, text, { mode: 0o600 });
  return path;
}

/** One record as the single listing line `/triggers` shows. */
export function formatRun(record) {
  if (record === undefined) return 'never ran';
  const when = new Date(record.startedAt).toISOString().replace('T', ' ').slice(0, 19);
  const reason = record.reason === null || record.reason === undefined ? '' : ` (${record.reason})`;
  const cost = Number.isFinite(record.cost) ? ` $${record.cost.toFixed(2)}` : '';
  const rounds = Number.isFinite(record.rounds) ? ` ${record.rounds}r` : '';
  return `${when} ${record.outcome}${reason} exit ${record.exitCode}${cost}${rounds}`;
}
