/**
 * Live subagent activity feed: a bounded, display-only projection of CHILD
 * session events. The transcript store folds only the root session (the
 * durable truth this TUI renders); subagent conversations are their own
 * sessions, and before this module their events were dropped entirely —
 * a running subagent was invisible until its parent tool call settled.
 *
 * This is NOT a second transcript: each child folds to ONE row (label,
 * running state, bounded last-activity text), capped at
 * {@link MAX_SUBAGENT_ROWS}. The cap is a display budget, not a fan-out
 * limit: a new running child evicts the OLDEST settled row when one
 * exists, and while every row is busy the newcomer waits off-screen — but
 * the observed-session total (getTotalSeen) keeps counting, so status
 * totals never under-report the fan-out. Rows are advisory display
 * state, rebuilt from live events; nothing here persists or replays.
 * Notification is coalesced
 * by the same ~16ms frame throttle as the transcript store (per-burst
 * microtask notify chained SyncLane rerenders past React's nested update
 * limit; a bare macrotask merge repaints a whole turn's bursts at once).
 *
 * @module @deepseek-ai/dsh-code/subagents
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'
// Type-only import merges the subagent package's SessionEventMap variant
// ('subagent/catalog') into the union this fold switches on.
import type {} from '@deepseek-ai/dsh-subagent'

/** Hard row cap: overflow evicts the oldest settled row; a fully busy feed waits. */
export const MAX_SUBAGENT_ROWS = 8

/** Render frame budget: the notification cadence's upper bound. */
const NOTIFY_FRAME_MS = 16

/** Bounded last-activity text (plain characters, display-sliced later). */
const MAX_ACTIVITY_CHARS = 80

/** One live subagent row in the feed. */
export interface SubagentRow {
  /** Child session id. */
  readonly id: string
  /** Display label (session title when observed, else a short id form). */
  readonly label: string
  /** Coarse lifecycle state folded from the child's events. */
  readonly state: 'running' | 'idle' | 'done'
  /** Bounded last-activity text for the status line. */
  readonly activity: string
  /** Last fold time (ms, event clock) — newest-first ordering key. */
  readonly updatedAt: number
}

/** The read-only snapshot surface the renderer subscribes to. */
export interface SubagentFeedView {
  /** Subscribe to feed changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Read the current rows (identity-stable between changes). */
  getSnapshot(): readonly SubagentRow[]
  /**
   * Distinct child sessions observed since the last reset. The row cap is
   * a display budget, not a count of the fan-out; totals surface this.
   */
  getTotalSeen(): number
}

/** Single-line bounded preview of an assembled message's text content. */
function messagePreview(content: unknown): string {
  if (!Array.isArray(content)) return 'replied'
  const texts: string[] = []
  for (const block of content) {
    if (texts.join(' ').length >= MAX_ACTIVITY_CHARS) break
    if (typeof block === 'object' && block !== null) {
      const { type, text } = block as Record<string, unknown>
      if (type === 'text' && typeof text === 'string' && text !== '') texts.push(text)
    }
  }
  const joined = texts.join(' ').replace(/\s+/gu, ' ').trim()
  return joined === '' ? 'replied' : bound(joined)
}

/** Bound one activity string to the display budget. */
function bound(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').trim()
  return flat.length > MAX_ACTIVITY_CHARS ? `${flat.slice(0, MAX_ACTIVITY_CHARS - 1)}…` : flat
}

/**
 * Fold one child-session event into its feed row (pure).
 * Unknown event kinds leave the row untouched.
 * @param previous - the row's current state, when any.
 * @param sessionId - the child session id.
 * @param event - the child session event.
 * @returns the next row state.
 */
export function foldSubagentRow(previous: SubagentRow | undefined, sessionId: string, event: SessionEvent): SubagentRow {
  const base: SubagentRow = previous ?? {
    id: sessionId,
    label: `agent ${sessionId.slice(-6)}`,
    state: 'running',
    activity: 'starting…',
    updatedAt: event.time,
  }
  const data = event.data as Record<string, unknown>
  switch (event.type) {
    case 'session/title': {
      const title = data['title']
      const text = typeof title === 'string' && title.trim() !== '' ? title : undefined
      return text === undefined || text === base.label ? base : { ...base, label: bound(text), updatedAt: event.time }
    }
    case 'request/header':
      return { ...base, state: 'running', activity: 'working…', updatedAt: event.time }
    case 'user/message':
      return { ...base, state: 'running', activity: 'prompted', updatedAt: event.time }
    case 'assistant/attempt':
      // Durable logs are settlement-only since session-log v2; an attempt
      // landing without a surface message means the model is retrying or
      // recovered from a stream error, so the child stays running.
      return { ...base, state: 'running', activity: 'thinking…', updatedAt: event.time }
    case 'subagent/catalog': {
      // Parent-owned durable discovery fact (0.1.5): the catalog names the
      // child's mode (one-shot vs continuable) and its authored label — the
      // most semantic label the row can carry. It is a discovery fact, not a
      // lifecycle signal: a fresh row starts idle, but a late delivery never
      // regresses a row that already ran or finished. An unchanged fact keeps
      // the row's identity (the no-op discipline of the default branch), so
      // repeated deliveries never churn the snapshot array.
      const mode = event.data.mode === 'continuable' ? 'continuable' : 'one-shot'
      const label = event.data.label !== undefined && event.data.label.trim() !== '' ? bound(event.data.label) : undefined
      const nextLabel = label === undefined ? base.label : label
      const activity = label === undefined ? `catalog · ${mode}` : `catalog · ${mode} · ${label}`
      const state = previous === undefined ? 'idle' : base.state
      if (nextLabel === base.label && state === base.state && activity === base.activity) return base
      return { ...base, state, label: nextLabel, activity, updatedAt: event.time }
    }
    case 'assistant/message':
      return { ...base, state: 'idle', activity: messagePreview(data['message'] === undefined ? undefined : (data['message'] as { content?: unknown }).content), updatedAt: event.time }
    case 'tool/call': {
      const name = typeof data['name'] === 'string' ? data['name'] : 'tool'
      return { ...base, state: 'running', activity: `tool ${name}`, updatedAt: event.time }
    }
    case 'tool/result':
      return { ...base, state: 'running', activity: 'tool done', updatedAt: event.time }
    case 'turn/start':
      return { ...base, state: 'running', activity: base.activity === 'starting…' ? 'working…' : base.activity, updatedAt: event.time }
    case 'turn/end':
      return { ...base, state: 'done', activity: 'finished', updatedAt: event.time }
    default:
      // Unknown kinds leave the row untouched (identity-stable: a no-op
      // fold must not churn the snapshot array).
      return base
  }
}

/**
 * Create one subagent feed. `apply` folds a child event (the caller gates
 * which sessions are children); `reset` clears on a session switch. Row
 * order is first-seen; the snapshot array is frozen and only replaced when
 * a row actually changed.
 * @returns the mutable feed handle plus its `SubagentFeedView`.
 */
export function createSubagentFeed(): SubagentFeedView & {
  apply(sessionId: string, event: SessionEvent): void
  reset(): void
} {
  let rows: readonly SubagentRow[] = Object.freeze([])
  const seen = new Set<string>()
  const listeners = new Set<() => void>()
  let scheduled = false
  let lastNotifyAt = 0
  const notify = (): void => {
    if (scheduled) return
    scheduled = true
    const wait = NOTIFY_FRAME_MS - (Date.now() - lastNotifyAt)
    const dispatch = (): void => {
      scheduled = false
      lastNotifyAt = Date.now()
      for (const listener of listeners) listener()
    }
    if (wait <= 0) setImmediate(dispatch)
    else setTimeout(dispatch, wait)
  }
  return {
    apply(sessionId: string, event: SessionEvent): void {
      const index = rows.findIndex(row => row.id === sessionId)
      const previous = index === -1 ? undefined : rows[index]
      const next = foldSubagentRow(previous, sessionId, event)
      if (index !== -1) {
        if (next === previous) return
        rows = Object.freeze(rows.map((row, at) => at === index ? next : row))
        notify()
        return
      }
      // A child this feed has not shown yet: the honest total grows even
      // when every row is busy; admission then prefers evicting the OLDEST
      // settled row (idle or done — both are non-running) so a new running
      // agent never waits on one that already settled.
      const counted = !seen.has(sessionId)
      if (counted) seen.add(sessionId)
      if (rows.length >= MAX_SUBAGENT_ROWS) {
        const evict = rows.findIndex(row => row.state !== 'running')
        if (evict === -1) {
          if (counted) notify()
          return
        }
        rows = Object.freeze([...rows.slice(0, evict), next, ...rows.slice(evict + 1)])
      } else {
        rows = Object.freeze([...rows, next])
      }
      notify()
    },
    reset(): void {
      seen.clear()
      if (rows.length === 0) return
      rows = Object.freeze([])
      notify()
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot(): readonly SubagentRow[] {
      return rows
    },
    getTotalSeen(): number {
      return seen.size
    },
  }
}
