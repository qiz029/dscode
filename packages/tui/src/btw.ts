/**
 * Side-question runs (`/btw`): a child session seeded from the main one answers
 * one question beside it, folded into its own transcript store so the panel can
 * render the answer while the main conversation keeps running. The run's text
 * lives only in the child's session — never the main transcript, never its
 * model context.
 *
 * @module @deepseek-ai/dsh-tui/btw
 */

import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { selectForkSeed } from './fork.ts'
import { createTranscriptStore, type TranscriptStore } from './store.ts'
import { singleLineText, truncateColumns } from './render/text.ts'

/** One content block, as the durable message shapes carry them. */
interface Block {
  readonly type?: string
  readonly text?: string
}

/** Longest prefix `/btw` seeds a child with before it degrades to a brief. */
export const BTW_SEED_EVENT_LIMIT = 400
/** Longest background brief kept when the prefix is too long to seed. */
export const BTW_BRIEF_LIMIT = 1_200
/** Longest question text a run is named by. */
export const BTW_TITLE_LIMIT = 160
/** Settled runs kept for the panel's switcher; the oldest settled run retires. */
export const BTW_RUN_LIMIT = 12

/** How a run's child session starts: inheriting the main log, or a brief. */
export interface BtwSeed {
  /** Events the child inherits; empty when the main prefix was too long. */
  readonly events: readonly SessionEvent[]
  /** Whether the child inherits the main conversation at all. */
  readonly inherited: boolean
}

/**
 * Select the child's inherited history. A complete-turn prefix must stay
 * contiguous from seq 0, so an over-long conversation cannot be trimmed: it
 * degrades to an unseeded child carrying {@link btwBrief} instead.
 * @param events - the main session's events in seq order.
 * @param limit - longest prefix worth handing a child.
 * @returns the inherited events and whether any were inherited.
 */
export function btwSeed(events: readonly SessionEvent[], limit = BTW_SEED_EVENT_LIMIT): BtwSeed {
  let seed
  try {
    seed = selectForkSeed(events)
  } catch {
    // No completed turn yet: a side question asked mid-turn still runs, it just
    // has nothing of the main conversation to inherit.
    return { events: [], inherited: false }
  }
  return seed.events.length <= limit ? { events: seed.events, inherited: true } : { events: [], inherited: false }
}

/**
 * Text blocks of one message event. A `user/message` carries the message
 * directly; an `assistant/message` carries it under `message` (the projection
 * reads the same two shapes).
 */
function messageText(data: unknown): string {
  const record = data as { content?: readonly Block[]; message?: { content?: readonly Block[] } } | undefined
  const content = record?.message?.content ?? record?.content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block?.type === 'text').map(block => String(block.text ?? '')).join('\n').trim()
}

/** Clip one brief line to its share of the budget, marking the cut. */
function clip(text: string, limit: number): string {
  const single = text.replace(/\s+/gu, ' ').trim()
  return single.length <= limit ? single : single.slice(0, Math.max(0, limit - 1)) + '…'
}

/**
 * Build the background a side question runs with when the main conversation is
 * too long to seed: the last thing the user asked and the last answer given.
 * @param events - the main session's events in seq order.
 * @param limit - longest brief kept, columns approximated as characters.
 * @returns the brief, empty when the log carries neither message.
 */
export function btwBrief(events: readonly SessionEvent[], limit = BTW_BRIEF_LIMIT): string {
  const last = (type: 'user/message' | 'assistant/message'): string => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index]
      if (event?.type !== type) continue
      const text = messageText(event.data)
      if (text !== '') return text
    }
    return ''
  }
  const request = last('user/message')
  const answer = last('assistant/message')
  const header = 'Background from the main conversation; answer only the question at the end.'
  const fields = [
    ...(request === '' ? [] : [{ label: 'User last asked: ', text: request }]),
    ...(answer === '' ? [] : [{ label: 'The agent last answered: ', text: answer }]),
  ]
  if (fields.length === 0) return ''
  // Wording and line breaks come out of the same budget as the quoted text,
  // so the brief honors its limit instead of exceeding it by the fixed parts.
  const fixed = header.length + fields.reduce((total, field) => total + field.label.length + 1, 0)
  const share = Math.max(40, Math.floor((limit - fixed) / fields.length))
  return [header, ...fields.map(field => field.label + clip(field.text, share))].join('\n')
}

/**
 * One line naming a run in the panel and the switcher.
 * @param question - the typed side question.
 * @param columns - budget for the naming line.
 * @returns the single-line title.
 */
export function btwTitle(question: string, columns = BTW_TITLE_LIMIT): string {
  return truncateColumns(singleLineText(question).trim(), columns)
}

/** Lifecycle of one side question. */
export type BtwStatus = 'running' | 'done' | 'failed' | 'cancelled'

/** One side-question run as the panel reads it. */
export interface BtwRun {
  /** The child session id. */
  readonly id: string
  /** The question as typed. */
  readonly question: string
  /** The question bounded to one naming line. */
  readonly title: string
  readonly status: BtwStatus
  /** Unix epoch milliseconds the run was started. */
  readonly startedAt: number
  /** Unix epoch milliseconds the run settled; absent while running. */
  readonly endedAt?: number
  /** Settlement failure text, when the run failed to start or run. */
  readonly error?: string
}

/** Observable side-question runs plus each one's own transcript. */
export interface BtwFeed {
  /** Current runs, newest first; identity-stable between changes. */
  list(): readonly BtwRun[]
  /** Subscribe to run-list changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** The run's transcript store, when the id names a live or kept run. */
  store(id: string): TranscriptStore | undefined
  /** Register a starting run and its empty transcript. */
  begin(input: { id: string; question: string; at: number }): void
  /** Fold one child-session event into its run. */
  apply(id: string, event: SessionEvent): void
  /** Fold one live assistant-stream frame into its run. */
  applyStreamFrame(id: string, frame: AssistantStreamFrame): void
  /** Settle a run; later events for the same id are ignored. */
  settle(id: string, status: Exclude<BtwStatus, 'running'>, error?: string): void
  /** Forget one run and its transcript. */
  drop(id: string): void
}

/**
 * Create the side-question feed the kernel drives and the panel reads.
 * @param limit - settled runs kept before the oldest retires.
 * @returns the feed.
 */
export function createBtwFeed(limit = BTW_RUN_LIMIT): BtwFeed {
  const runs = new Map<string, { run: BtwRun; store: TranscriptStore }>()
  const listeners = new Set<() => void>()
  let snapshot: readonly BtwRun[] = []
  const publish = (): void => {
    snapshot = [...runs.values()].map(entry => entry.run).reverse()
    for (const listener of listeners) listener()
  }
  /** Retire the OLDEST settled runs past the limit before announcing, so the list never carries one. */
  const retire = (): void => {
    const settled = [...runs.values()].filter(entry => entry.run.status !== 'running')
    for (const entry of settled.slice(0, Math.max(0, settled.length - limit))) runs.delete(entry.run.id)
  }
  return {
    list: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    store: id => runs.get(id)?.store,
    begin: ({ id, question, at }) => {
      if (runs.has(id)) return
      runs.set(id, {
        run: { id, question, title: btwTitle(question), status: 'running', startedAt: at },
        store: createTranscriptStore(),
      })
      publish()
    },
    apply: (id, event) => { runs.get(id)?.store.apply(event) },
    applyStreamFrame: (id, frame) => { runs.get(id)?.store.applyStreamFrame(frame) },
    settle: (id, status, error) => {
      const entry = runs.get(id)
      if (entry === undefined || entry.run.status !== 'running') return
      entry.run = { ...entry.run, status, endedAt: Date.now(), ...(error === undefined ? {} : { error }) }
      retire()
      publish()
    },
    drop: id => {
      if (runs.delete(id)) publish()
    },
  }
}
