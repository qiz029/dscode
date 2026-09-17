/** Pure session-fork boundary policy shared by the TUI command and tests. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

export interface ForkSeed {
  readonly boundarySeq: number
  readonly events: readonly SessionEvent[]
}

/** Select a completed turn and trailing between-turn metadata. */
export function selectForkSeed(events: readonly SessionEvent[], atSeq?: number): ForkSeed {
  if (atSeq !== undefined && (!Number.isSafeInteger(atSeq) || atSeq < 0)) {
    throw new Error('fork event sequence must be a non-negative integer')
  }
  const lastSeq = events.at(-1)?.seq ?? -1
  const anchored = atSeq === undefined
    ? undefined
    : events.find(event => event.type === 'turn/end' && event.seq >= atSeq)
  const boundary = anchored
    ?? (atSeq === undefined || atSeq > lastSeq
      ? events.findLast(event => event.type === 'turn/end')
      : undefined)
  if (boundary === undefined) {
    throw new Error(atSeq !== undefined && atSeq <= lastSeq
      ? `the turn containing event ${atSeq} has not completed`
      : 'this session has no completed turn to fork from')
  }
  let cut = events.indexOf(boundary) + 1
  while (cut < events.length && events[cut]?.type !== 'turn/start') cut += 1
  return { boundarySeq: boundary.seq, events: events.slice(0, cut) }
}
