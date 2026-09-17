/**
 * The terminal ask_user_question answerer: one `user-questions/request`
 * waterfall listener that drives a FIFO queue — one question request on
 * screen at a time, everything else waiting — then resolves the collected
 * answers back into the waterfall. Mirrors the approval answerer's claim/
 * defer split: only agents this TUI owns are answered, every other request
 * falls through to the next answerer.
 *
 * Plan reviews (`exit_plan_mode`) arrive through the same waterfall with an
 * `intent: { kind: 'plan-review' }` — the renderer highlights the approve
 * option; the answer encoding is identical either way.
 *
 * @module @deepseek-ai/dsh-code/questions
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'

/** One question request waiting on the human, with its settle channels. */
export interface PendingQuestion {
  /** The request the renderer walks through question by question. */
  request: AskUserQuestionRequest
  /** Resolve the provider promise with the collected answers. */
  resolve(answers: AskUserQuestionAnswer): void
  /** Reject the provider promise as aborted (also used for Esc cancel). */
  reject(error: Error): void
  /** Detach the request's abort listener once the question settles (internal). */
  detachAbort?(): void
}

/** The pending-question snapshot the renderer subscribes to. */
export interface QuestionSnapshot {
  /** The active request, or undefined when nothing is being asked. */
  pending: PendingQuestion | undefined
}

/** Store the pending question lands in; the renderer reads, the provider writes. */
export interface QuestionStore {
  /** Subscribe to pending-state changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Read the current snapshot (identity-stable between changes). */
  getSnapshot(): QuestionSnapshot
  /** Submit the collected answers for the active request and advance the queue. */
  submit(pending: PendingQuestion, answers: AskUserQuestionAnswer): void
  /** Cancel the active request (Esc) — rejects ASK_ABORTED and advances the queue. */
  cancel(pending: PendingQuestion): void
}

const ABORT_ERROR = new UserQuestionError(
  'ask_user_question was interrupted before the user answered',
  'ASK_ABORTED',
)

/**
 * Mount the `user-questions/request` answerer over a FIFO queue.
 * @param ctx - plugin context whose event bus carries the waterfall.
 * @param owns - agents this terminal answers for; every other request is
 * deferred back into the waterfall (`next()`), so sibling answerers stay
 * usable. Agent-less asks are claimed: this TUI is the only human surface
 * in the process.
 * @returns the store the renderer subscribes to.
 */
export function mountQuestionProvider(ctx: Context, owns: (agent: Agent) => boolean): QuestionStore {
  let snapshot: QuestionSnapshot = { pending: undefined }
  let active: PendingQuestion | undefined
  const queue: PendingQuestion[] = []
  const listeners = new Set<() => void>()
  const set = (next: QuestionSnapshot): void => {
    snapshot = next
    for (const listener of listeners) listener()
  }

  /** Settle the active request and show the next queued one, if any. */
  const advance = (): void => {
    const next = queue.shift()
    active = next
    set({ pending: next })
  }

  ctx.on('user-questions/request', (
    request: AskUserQuestionRequest,
    next: () => Promise<AskUserQuestionAnswer>,
  ): Promise<AskUserQuestionAnswer> => {
    if (request.agent !== undefined && !owns(request.agent)) return next()
    return new Promise((resolve, reject) => {
      // Abort settles through the same channel as an Esc cancel: the
      // owning tool/step died, so the answer must not linger.
      const onAbort = (): void => {
        if (active === pending) {
          active = undefined
          set({ pending: undefined })
          advance()
        } else {
          const at = queue.indexOf(pending)
          if (at >= 0) queue.splice(at, 1)
        }
        reject(ABORT_ERROR)
      }
      // Detach on every settle so an answered/cancelled question never
      // retains a listener on the owning tool call's signal.
      const detachAbort = (): void => {
        if (request.signal !== undefined) request.signal.removeEventListener('abort', onAbort)
      }
      const pending: PendingQuestion = {
        request,
        resolve,
        reject,
        detachAbort,
      }
      if (request.signal?.aborted === true) {
        reject(ABORT_ERROR)
        return
      }
      request.signal?.addEventListener('abort', onAbort, { once: true })
      if (active === undefined) {
        active = pending
        set({ pending })
      } else {
        queue.push(pending)
      }
    })
  })

  return {
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    getSnapshot(): QuestionSnapshot {
      return snapshot
    },
    submit(pending: PendingQuestion, answers: AskUserQuestionAnswer): void {
      if (active !== pending) return
      active = undefined
      set({ pending: undefined })
      pending.detachAbort?.()
      pending.resolve(answers)
      advance()
    },
    cancel(pending: PendingQuestion): void {
      if (active !== pending) return
      active = undefined
      set({ pending: undefined })
      pending.detachAbort?.()
      pending.reject(ABORT_ERROR)
      advance()
    },
  }
}
