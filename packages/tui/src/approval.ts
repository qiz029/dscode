/**
 * The terminal approval answerer: one `approval/request` waterfall listener
 * that renders the pending question as a y/n bar and resolves the decision
 * back into the waterfall. Mirrors the web host's composer takeover — the
 * service (audit pair, policy gate, fail-closed defaults) all live in
 * dsh-base; this module only answers for agents this TUI owns.
 *
 * Vocabulary note: a client answerer may only ever resolve `'allowed-once'`
 * or `'rejected'`; `'cancelled'` belongs to the request signal and
 * `'unavailable'` to the fail-closed waterfall default.
 *
 * @module @deepseek-ai/dsh-code/approval
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'

/** The answer values a client answerer may resolve with. */
export type ApprovalAnswer = 'allowed-once' | 'rejected'

/** One pending approval question, derived from the request for rendering. */
export interface PendingApproval {
  /** The asker's human-readable explanation, or a generic fallback. */
  headline: string
  /** The tool the question is about. */
  toolName: string
  /** Command-line preview resolved from the paired streaming tool call. */
  command: string
  /** Resolve the ask; calling twice is inert (one-shot latch). */
  answer(outcome: ApprovalAnswer): void
}

/** The pending-question snapshot the renderer subscribes to. */
export interface ApprovalSnapshot {
  /** The question on screen (queue head), or undefined when none is asked. */
  pending: PendingApproval | undefined
  /** Presentational: an answer was submitted, the ask has not settled yet. */
  answered: boolean
  /** Further asks waiting behind the on-screen one (FIFO, Codex-style). */
  queued: number
}

/** Store the pending question lands in; the renderer reads, the answerer writes. */
export interface ApprovalStore {
  /** Subscribe to pending-state changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Read the current snapshot (identity-stable between changes). */
  getSnapshot(): ApprovalSnapshot
}

/**
 * Create the approval store and mount the answerer listener on the context.
 * The listener claims only requests for `owns`-owned agents and defers every
 * other request back into the waterfall (`next()`), so sibling answerers stay
 * usable. An aborted ask never reaches the human. Plugin teardown removes the
 * listener; the service then fails its own question closed.
 * @param ctx - plugin context whose event bus carries `approval/request`.
 * @param owns - agents this terminal answers for.
 * @param preview - resolves a tool-call preview for a pending request (the
 * request contract carries no arguments; the UI self-serves from the
 * transcript projection via `callId`).
 * @returns the store the renderer subscribes to.
 */
export function mountApprovalAnswerer(
  ctx: Context,
  owns: (agent: Agent) => boolean,
  preview: (request: ApprovalRequest) => string,
): ApprovalStore {
  /** One live ask: its pending view plus the one-shot settle plumbing. */
  interface Slot {
    readonly pending: PendingApproval
    answered: boolean
  }
  const queue: Slot[] = []
  let snapshot: ApprovalSnapshot = { pending: undefined, answered: false, queued: 0 }
  const listeners = new Set<() => void>()
  const publish = (): void => {
    const head = queue[0]
    snapshot = {
      pending: head === undefined ? undefined : head.pending,
      answered: head !== undefined && head.answered,
      queued: Math.max(0, queue.length - 1),
    }
    for (const listener of listeners) listener()
  }
  const removeSlot = (slot: Slot): void => {
    const at = queue.indexOf(slot)
    if (at !== -1) queue.splice(at, 1)
  }

  ctx.on('approval/request', (request: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => {
    if (!owns(request.agent)) return next()
    // An already-aborted ask never reaches the human (mirrors the host bridge).
    if (request.signal?.aborted === true) return Promise.resolve<ApprovalOutcome>('cancelled')

    let resolved = false
    let settle!: (outcome: ApprovalOutcome) => void
    // Established BEFORE the abort listener mounts: a synchronous throw
    // between the listener registration and a later construction site would
    // otherwise leave a subsequent abort invoking an unassigned settle from
    // inside the AbortSignal listener (an uncaughtException).
    const settled = new Promise<ApprovalOutcome>((resolve) => {
      settle = resolve
    })
    const signal = request.signal
    const onAbort = (): void => withdraw()
    // Detach on every settle so an answered ask never retains a listener on
    // the tool call's signal (long turns ask many times; each ask must let go).
    const detachAbort = (): void => {
      if (signal !== undefined) signal.removeEventListener('abort', onAbort)
    }
    const withdraw = (): void => {
      if (resolved) return
      resolved = true
      detachAbort()
      removeSlot(slot)
      publish()
      // The service's signal race would conclude 'cancelled' anyway; settle
      // the same way so this listener never dangles a pending promise.
      settle('cancelled')
    }
    if (signal !== undefined) {
      signal.addEventListener('abort', onAbort, { once: true })
    }
    const slot: Slot = {
      answered: false,
      pending: {
        headline: request.reason ?? `tool ${request.toolName} asks for your approval`,
        toolName: request.toolName,
        command: preview(request),
        answer: (outcome: ApprovalAnswer): void => {
          // One-shot latch: a second keypress after submission is inert.
          if (resolved) return
          resolved = true
          detachAbort()
          slot.answered = true
          publish()
          settle(outcome)
        },
      },
    }
    queue.push(slot)
    publish()

    return settled.then((outcome) => {
      if (outcome !== 'cancelled') {
        removeSlot(slot)
        publish()
      }
      return outcome
    })
  })

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot(): ApprovalSnapshot {
      return snapshot
    },
  }
}
