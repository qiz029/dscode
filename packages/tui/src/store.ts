/**
 * Observable transcript store: folds session events into the projection view
 * and notifies subscribers. The renderer subscribes through
 * `useSyncExternalStore`; the runner owns event feeding.
 *
 * Folding runs on the same mutable replay accumulator the persisted-log
 * path uses (`replayProjectEvent`: id-indexed row updates, in-place
 * appends), so a live structural event costs O(1) entry work regardless of
 * transcript length — the copy-on-write fold rebuilt the whole entries
 * array per event, making a growing session quadratic. An immutable
 * `TranscriptView` snapshot is materialized only when a changed view is
 * READ (once per rendered frame under the notification throttle, never per
 * event), and every snapshot copies its arrays, so a view already handed
 * out never observes later folds.
 *
 * Notification coalescing: the fold stays synchronous — `getView()` always
 * returns the latest state the moment `apply` returns — but listener
 * notification is frame-throttled (~16ms) and deduplicated. The zai/GLM
 * adapter delivers tokens as a sustained stream of sub-millisecond,
 * microtask-spaced bursts: per-burst notification renders at microtask
 * cadence, which chained SyncLane `useSyncExternalStore` rerenders past
 * React's nested-update limit ("Maximum update depth exceeded"), while a
 * bare `setImmediate` merges a whole macrotask turn's bursts into one
 * chunky repaint (streaming text visibly staggers). The frame budget gives
 * both: an event ≥16ms after the last paint notifies via `setImmediate`
 * (sub-millisecond latency for sparse/first tokens), and anything denser
 * defers to the next 16ms boundary — a 60fps render cap that also breaks
 * the nesting chain by construction.
 *
 * @module @deepseek-ai/dsh-tui/store
 */

import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  applyAssistantStreamChunk,
  clearAssistantStream,
  createReplayAccumulator,
  replayProjectEvent,
  snapshotReplayView,
  type TranscriptView,
} from './render/projection.ts'

/** Render frame budget: the notification cadence's upper bound. */
const NOTIFY_FRAME_MS = 16

/** The externally readable, event-fed transcript store for one session. */
export interface TranscriptStore {
  /** The current view; the same object identity until an event changes it. */
  getView(): TranscriptView
  /** Subscribe to view changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Fold one session event; ignored events change nothing and notify nobody. */
  apply(event: SessionEvent): void
  /** Fold one live assistant-stream frame; frames without visible deltas stay silent. */
  applyStreamFrame(frame: AssistantStreamFrame): void
  /** Drop the folded view entirely (/clear): the next event starts a fresh one. */
  reset(): void
}

/**
 * Create one transcript store, optionally seeded with replayed history. The
 * seed folds synchronously BEFORE the first render, so a resumed session
 * paints its full transcript on mount (no live `session/event` fires for
 * constructor seeds — the store's `session/event` feed only carries new
 * appends).
 * @param replay - persisted events in `seq` order (e.g. a resumed session's
 * constructor seed); folded once and never re-notified.
 * @returns the store the runner feeds and the renderer subscribes to.
 */
export function createTranscriptStore(replay?: readonly SessionEvent[]): TranscriptStore {
  let acc = createReplayAccumulator()
  for (const event of replay ?? []) replayProjectEvent(acc, event)
  let view = snapshotReplayView(acc)
  let dirty = false
  const listeners = new Set<() => void>()
  let scheduled = false
  let lastNotifyAt = 0
  // Live attempt → `turn:step` key: chunk frames name only their attempt, so
  // the start frame's turn/step anchor is remembered until the end frame
  // retires the attempt. A replacement attempt (new start frame) overwrites
  // the entry; committed settlements already cleared the tails it replaces.
  const attemptKeys = new Map<string, string>()
  const notify = (): void => {
    if (scheduled) return
    scheduled = true
    const wait = NOTIFY_FRAME_MS - (Date.now() - lastNotifyAt)
    const dispatch = (): void => {
      scheduled = false
      lastNotifyAt = Date.now()
      for (const listener of listeners) {
        listener()
      }
    }
    // Sparse streams paint with setImmediate latency; a denser burst defers
    // to the next frame boundary instead of repainting per microtask batch.
    if (wait <= 0) setImmediate(dispatch)
    else setTimeout(dispatch, wait)
  }
  return {
    getView: (): TranscriptView => {
      if (dirty) {
        view = snapshotReplayView(acc)
        dirty = false
      }
      return view
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    apply(event: SessionEvent): void {
      if (!replayProjectEvent(acc, event)) return
      dirty = true
      notify()
    },
    applyStreamFrame(frame: AssistantStreamFrame): void {
      if (frame.type === 'start') {
        attemptKeys.set(frame.attemptId, `${frame.turn}:${frame.step}`)
        return
      }
      if (frame.type === 'chunk') {
        const key = attemptKeys.get(frame.attemptId)
        if (key === undefined) return
        if (!applyAssistantStreamChunk(acc, key, frame.time, frame.chunk)) return
        dirty = true
        notify()
        return
      }
      // End frame: committed settlements arrive as durable events before
      // their end frame and already cleared the tails; an abandoned attempt
      // has no settlement, so its partial tail is dropped here.
      attemptKeys.delete(frame.attemptId)
      if (frame.outcome.kind === 'abandoned' && clearAssistantStream(acc)) {
        dirty = true
        notify()
      }
    },
    reset(): void {
      acc = createReplayAccumulator()
      attemptKeys.clear()
      dirty = true
      notify()
    },
  }
}
