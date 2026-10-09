// Charge model calls a plugin makes for a session (review, memory, session cards,
// /doctor) to that session's cost ledger without putting the session on the wire:
// a `sessionId` request option also drives session-log delivery, provider cache
// affinity and agent-only prompt shaping, which these calls must not trigger. The
// ledger middleware runs when the caller iterates the stream, so it reads the charge
// from the caller's async context.
import { AsyncLocalStorage } from 'node:async_hooks';

const charges = new AsyncLocalStorage();

/** Run `fn` with its model calls charged to `sessionId` under `purpose`; no session runs it uncharged. */
export function chargeTo(sessionId, purpose, fn) {
  return sessionId ? charges.run({ sessionId, purpose }, fn) : fn();
}

/** The charge of the model call being iterated, if any. */
export function currentCharge() {
  return charges.getStore();
}

/** Charge a live child request to its ancestors once, with the original session first. */
export function metricRecipients(agents, sessionId) {
  const recipients = new Set([sessionId]);
  let child = agents?.get(sessionId);
  while (child?.session.header.origin === 'subagent' && child.session.header.parentSession && !recipients.has(child.session.header.parentSession)) {
    recipients.add(child.session.header.parentSession);
    child = agents.get(child.session.header.parentSession);
  }
  return recipients;
}
