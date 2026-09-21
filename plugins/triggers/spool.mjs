// The ingress: one cheap, uniform way to post an event into a trigger. A producer
// drops a JSON file and returns; a later drain runs it. This is the whole public
// surface of the mechanism (docs/triggers-design.md), so it stays dumb: it
// validates that the payload is *data* and never carries authority, and it does
// not know what a session, a goal or a model is.
//
// Delivery is at-most-once: an event file is consumed when a run is started, and
// the run record carries its identity, so a re-emitted event needs a new id.

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** The only keys an event body may carry; anything else is a producer mistake. */
export const EVENT_FIELDS = Object.freeze(['source', 'title', 'text', 'fields']);

/** Message body cap, matching what one session input accepts. */
export const MAX_EVENT_TEXT_BYTES = 64000;

/** Event identity cap: it names a spool file and a run record, not a payload. */
export const MAX_EVENT_ID_CHARS = 200;

const TRIGGER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/u;

class SpoolError extends Error {}

const fail = message => { throw new SpoolError(message); };

const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The spool directory of one trigger. */
export const spoolPath = (home, triggerId) => join(home, 'triggers', 'spool', triggerId);

/** One event's file name: the id is reversible, so a listing can name the event. */
const eventFile = (triggerId, eventId) => `${encodeURIComponent(eventId)}.json`;

/**
 * Post one event.
 * @param home - the state directory.
 * @param triggerId - the target trigger.
 * @param payload - `{ source?, title?, text?, fields? }`; every value is data.
 * @param options - `{ eventId, now }`; `eventId` is the de-duplication identity and is required.
 * @returns the stored event.
 * @throws {SpoolError} on an unknown field, a non-scalar value, an oversized body or a missing id.
 */
export function emitEvent(home, triggerId, payload, { eventId, now = Date.now() } = {}) {
  if (typeof triggerId !== 'string' || !TRIGGER_ID_PATTERN.test(triggerId)) fail('triggerId must be the definition id');
  if (typeof eventId !== 'string' || eventId.trim() === '') fail('eventId is required: it is how a repeated delivery is recognised');
  if (eventId.trim().length > MAX_EVENT_ID_CHARS) fail(`eventId is longer than ${MAX_EVENT_ID_CHARS} characters`);
  if (/[\u0000-\u001f\u007f]/u.test(eventId)) fail('eventId must not contain control characters');
  if (!isPlainObject(payload)) fail('an event must be an object');
  const unknown = Object.keys(payload).filter(key => !EVENT_FIELDS.includes(key));
  // This is the authority boundary: an event is data, so a payload may not name a
  // permission, a session or a tool. A field that is not understood is refused
  // rather than ignored, so a producer cannot believe it granted something.
  if (unknown.length > 0) fail(`an event carries no such field: ${unknown.join(', ')} (accepted: ${EVENT_FIELDS.join(', ')})`);
  const text = payload.text ?? '';
  if (typeof text !== 'string') fail('event.text must be a string');
  if (Buffer.byteLength(text, 'utf8') > MAX_EVENT_TEXT_BYTES) fail(`event.text is longer than ${MAX_EVENT_TEXT_BYTES} bytes`);
  if (payload.source !== undefined && typeof payload.source !== 'string') fail('event.source must be a string');
  if (payload.title !== undefined && typeof payload.title !== 'string') fail('event.title must be a string');
  if (payload.fields !== undefined) {
    if (!isPlainObject(payload.fields)) fail('event.fields must be an object of scalar values');
    for (const [key, value] of Object.entries(payload.fields)) {
      if (!['string', 'number', 'boolean'].includes(typeof value)) fail(`event.fields.${key} must be a string, number or boolean`);
    }
  }
  const event = {
    triggerId,
    eventId: eventId.trim(),
    ...(payload.source === undefined ? {} : { source: payload.source }),
    ...(payload.title === undefined ? {} : { title: payload.title }),
    text,
    ...(payload.fields === undefined ? {} : { fields: payload.fields }),
    receivedAt: now,
  };
  const directory = spoolPath(home, triggerId);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(join(directory, eventFile(triggerId, event.eventId)), JSON.stringify(event) + '\n', { mode: 0o600 });
  return event;
}

/**
 * List one trigger's pending events, oldest first.
 * @param home - the state directory.
 * @param triggerId - the trigger.
 * @param options - `{ limit }`.
 * @returns the parsed events, unreadable files skipped.
 */
export function listEvents(home, triggerId, { limit = 50 } = {}) {
  let entries;
  try {
    entries = readdirSync(spoolPath(home, triggerId)).filter(name => name.endsWith('.json'));
  } catch {
    return [];
  }
  const events = [];
  for (const name of entries.sort()) {
    try {
      events.push(JSON.parse(readFileSync(join(spoolPath(home, triggerId), name), 'utf8')));
    } catch {
      continue;
    }
  }
  events.sort((left, right) => (left.receivedAt ?? 0) - (right.receivedAt ?? 0) || String(left.eventId).localeCompare(String(right.eventId)));
  return limit === 0 ? events : events.slice(0, limit);
}

/**
 * Consume one event, so a drain cannot start it twice.
 * @returns true when a pending file was removed.
 */
export function consumeEvent(home, triggerId, eventId) {
  try {
    rmSync(join(spoolPath(home, triggerId), eventFile(triggerId, eventId)));
    return true;
  } catch {
    return false;
  }
}

/** One event as a single listing line. */
export function formatEvent(event) {
  const when = new Date(event.receivedAt ?? 0).toISOString().replace('T', ' ').slice(0, 19);
  const source = event.source === undefined ? '' : ` [${event.source}]`;
  const title = event.title === undefined ? '' : `${event.title}: `;
  const text = String(event.text ?? '').replace(/\s+/gu, ' ').trim();
  return `${when}${source} ${event.eventId} — ${title}${text.length > 80 ? `${text.slice(0, 79)}…` : text}`;
}
