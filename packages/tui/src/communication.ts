/**
 * Live cross-session communication feed: a bounded, display-only projection of
 * the root session's session-bridge traffic. The transcript store folds tool
 * cards and hides their arguments, so a `send_session` that is waiting on
 * another session looks exactly like any other tool call; this module keeps the
 * direction, the peer, the delivery mode and the outstanding request visible.
 *
 * Two event families feed it, both already durable:
 * - `tool/call` / `tool/result` for `send_session` and `reply_session`, with
 *   the call arguments carrying target, kind and mode (a result carries no such
 *   fields, so a failing call is reported only by its paired error).
 * - `user/message` relayed by the session bridge, which is an inbound message
 *   from another session or an external source.
 *
 * Rows are advisory display state rebuilt from events; nothing here persists or
 * replays, and a resume re-derives the history from the log.
 *
 * @module @deepseek-ai/dsh-code/communication
 */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Hard row cap for `/tasks`; the newest rows survive. */
export const MAX_COMMUNICATION_ROWS = 32

/** Bound on outstanding requests tracked at once (display state, not a budget). */
const MAX_WAITING_REQUESTS = 16

/** Bounded body preview, matching the activity line's display budget. */
const MAX_PREVIEW_CHARS = 72

/** The plugin name the session bridge stamps on its relayed messages. */
const BRIDGE_PLUGIN = 'dscode-session-bridge'

/** Tool names that address another session. */
const SEND_TOOLS = new Set(['send_session', 'reply_session'])

/** How one communication line came to exist. */
export type CommunicationDirection = 'sent' | 'received'

/** One communication row, newest last. */
export interface CommunicationRow {
  /** Stable per-call (outbound) or per-message (inbound) identity. */
  readonly id: string
  readonly direction: CommunicationDirection
  /** Peer session id when the bridge named one, else the free-form source label. */
  readonly peer: string
  /** Message meaning: request, notify, reply; undefined when unparsed. */
  readonly kind?: string
  /** Delivery mode: queue, steer, defer. */
  readonly mode?: string
  /** Bounded message text. */
  readonly preview: string
  /** Event time (ms, session clock). */
  readonly at: number
  /** Outbound only: the tool call has not produced a result yet. */
  readonly pending: boolean
  /** Outbound only: the tool result was an error. */
  readonly failed: boolean
}

/** One request this session sent and has not seen an answer for. */
export interface WaitingRequest {
  /** The outbound row that opened this request; two sends to one peer differ here. */
  readonly id: string
  readonly peer: string
  readonly since: number
}

/** The read-only snapshot the renderer and the runner read. */
export interface CommunicationView {
  /** Newest-last rows, bounded to {@link MAX_COMMUNICATION_ROWS}. */
  readonly rows: readonly CommunicationRow[]
  /** Sent requests with no reply yet, newest last. */
  readonly waiting: readonly WaitingRequest[]
}

/**
 * One peer identity across both directions. Outbound rows carry the bare
 * session id from the tool arguments; an inbound relay's bridge label is
 * `session:<id>`, so the prefix is stripped before they are compared.
 */
function peerKey(peer: string): string {
  return peer.startsWith('session:') ? peer.slice('session:'.length) : peer
}

/** Fold one tool-call argument JSON string into the fields a row needs. */
function callFields(raw: unknown): { peer?: string; kind?: string; mode?: string; preview: string } {
  if (typeof raw !== 'string' || raw.length > 8192) return { preview: '' }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { preview: '' }
  }
  if (parsed === null || typeof parsed !== 'object') return { preview: '' }
  const fields = parsed as Record<string, unknown>
  const text = (value: unknown): string => (typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '')
  const peer = text(fields.session_id) || text(fields.request_message_id)
  const preview = text(fields.text)
  return {
    ...(peer === '' ? {} : { peer }),
    ...(text(fields.kind) === '' ? {} : { kind: text(fields.kind) }),
    ...(text(fields.mode) === '' ? {} : { mode: text(fields.mode) }),
    preview: preview.length > MAX_PREVIEW_CHARS ? `${preview.slice(0, MAX_PREVIEW_CHARS - 1)}…` : preview,
  }
}

/**
 * One relayed message's peer, message kind and bounded text. The bridge stamps
 * the kind only inside the body header (`[External source: …] [kind/mode]`),
 * which is its documented presentation contract, so an unrecognised header
 * leaves the kind undefined and the caller stays conservative: an unknown
 * inbound message never counts as an answer.
 */
function relayFields(data: unknown): { peer: string; kind?: string; preview: string } | undefined {
  if (data === null || typeof data !== 'object') return undefined
  const message = data as { source?: unknown; content?: unknown }
  const source = message.source
  if (source === null || typeof source !== 'object') return undefined
  const stamp = source as { kind?: unknown; plugin?: unknown; form?: unknown; label?: unknown; communicationId?: unknown }
  if (stamp.kind !== 'plugin' || stamp.plugin !== BRIDGE_PLUGIN || stamp.form !== 'relay') return undefined
  const label = typeof stamp.label === 'string' && stamp.label !== '' ? stamp.label : undefined
  const id = typeof stamp.communicationId === 'string' && stamp.communicationId !== '' ? stamp.communicationId : undefined
  if (label === undefined && id === undefined) return undefined
  const texts: string[] = []
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (typeof block === 'object' && block !== null) {
        const { type, text } = block as { type?: unknown; text?: unknown }
        if (type === 'text' && typeof text === 'string') texts.push(text)
      }
    }
  }
  const body = texts.join(' ').replace(/\s+/gu, ' ').trim()
  // The body opens with the bridge's own header line (`[External source: …]
  // [kind/mode]` plus the message id); the preview is the message under it.
  const kind = body.match(/\[([a-z]+)\/[a-z]+\]/u)?.[1]
  const joinLines = texts.join('\n')
  const joined = joinLines
    .replace(/^\[External source:[^\]]*\](\s*\[[a-z]+\/[a-z]+\])?\s*/u, '')
    .replace(/^Message ID:[^\n]*\n?/u, '')
    .replace(/\s+/gu, ' ')
    .trim()
  return {
    peer: label ?? id ?? 'unknown',
    ...(kind === undefined ? {} : { kind }),
    preview: joined.length > MAX_PREVIEW_CHARS ? `${joined.slice(0, MAX_PREVIEW_CHARS - 1)}…` : joined,
  }
}

/**
 * Fold one root-session event into the feed, returning the same view identity
 * when the event is not communication traffic.
 * @param view - the current view.
 * @param event - one session event from the root session.
 * @returns the next view, or the same object when nothing changed.
 */
export function foldCommunication(view: CommunicationView, event: SessionEvent): CommunicationView {
  if (event.type === 'tool/call') {
    const data = event.data as { callId: string; name: string; arguments: string }
    if (!SEND_TOOLS.has(data.name)) return view
    const fields = callFields(data.arguments)
    const row: CommunicationRow = {
      id: outboundId(data.callId),
      direction: 'sent',
      peer: fields.peer ?? 'unknown',
      ...(fields.kind === undefined ? {} : { kind: fields.kind }),
      ...(fields.mode === undefined ? {} : { mode: fields.mode }),
      preview: fields.preview,
      at: event.time,
      pending: true,
      failed: false,
    }
    const rows = bound([...view.rows, row])
    // A send in flight is not an outstanding request yet: it becomes one when
    // the call settles and the message was a request.
    return { rows, waiting: view.waiting }
  }
  if (event.type === 'tool/result') {
    const data = event.data as { message?: { content?: unknown } }
    const callId = resultCallId(data)
    if (callId === undefined) return view
    const id = outboundId(callId)
    const index = view.rows.findIndex(row => row.id === id)
    if (index === -1) return view
    const settled = { ...view.rows[index]!, pending: false, failed: resultFailed(data) }
    const rows = view.rows.map((row, at) => (at === index ? settled : row))
    const answers = settled.kind === 'request' && !settled.failed
    return {
      rows,
      waiting: answers ? markWaiting(view.waiting, settled) : view.waiting,
    }
  }
  if (event.type === 'user/message') {
    const relay = relayFields(event.data)
    if (relay === undefined) return view
    const row: CommunicationRow = { id: inboundId(event.data, event.seq), direction: 'received', ...(relay.kind === undefined ? {} : { kind: relay.kind }), peer: relay.peer, preview: relay.preview, at: event.time, pending: false, failed: false }
    return {
      rows: bound([...view.rows, row]),
      // Only the single final reply answers a request; a bare notify from the
      // same peer must not clear a turn that is still blocked on an answer.
      waiting: relay.kind === 'reply' ? clearWaiting(view.waiting, row.peer) : view.waiting,
    }
  }
  return view
}

/** Outbound row identity, namespaced so an inbound id can never collide with it. */
function outboundId(callId: string): string {
  return `sent:${callId}`
}

/** Inbound row identity, namespaced and falling back to the event sequence. */
function inboundId(data: unknown, seq: number): string {
  return `recv:${relayId(data) ?? seq}`
}

/**
 * Record one settled request as awaiting its answer. Keyed by the outbound row,
 * not by peer: a session may have two requests open to one session, and a
 * peer-keyed entry would let the second send overwrite the first.
 */
function markWaiting(waiting: readonly WaitingRequest[], request: CommunicationRow): readonly WaitingRequest[] {
  if (waiting.some(entry => entry.id === request.id)) return waiting
  const next = [...waiting, { id: request.id, peer: request.peer, since: request.at }]
  return next.length <= MAX_WAITING_REQUESTS ? next : next.slice(next.length - MAX_WAITING_REQUESTS)
}

/**
 * Clear the outstanding requests a reply answers. One reply answers one of the
 * requests sent to that peer; without a request-id correlation in the relay,
 * every open request to that peer retires together, which is the conservative
 * direction — it never leaves the terminal claiming to await an answered peer.
 */
function clearWaiting(waiting: readonly WaitingRequest[], peer: string): readonly WaitingRequest[] {
  const next = waiting.filter(entry => peerKey(entry.peer) !== peerKey(peer))
  return next.length === waiting.length ? waiting : next
}

/** Keep only the newest rows. */
function bound(rows: readonly CommunicationRow[]): readonly CommunicationRow[] {
  return rows.length <= MAX_COMMUNICATION_ROWS ? rows : rows.slice(rows.length - MAX_COMMUNICATION_ROWS)
}

/** The peer of a reply, which the tool result does not name: the call it answers. */
function resultCallId(data: { message?: { content?: unknown } }): string | undefined {
  if (!Array.isArray(data.message?.content)) return undefined
  for (const block of data.message.content) {
    if (typeof block === 'object' && block !== null) {
      const { toolCallId } = block as { toolCallId?: unknown }
      if (typeof toolCallId === 'string') return toolCallId
    }
  }
  return undefined
}

/** True when the tool result's block carries `isError`. */
function resultFailed(data: { message?: { content?: unknown } }): boolean {
  if (!Array.isArray(data.message?.content)) return false
  return data.message.content.some(block => typeof block === 'object' && block !== null && (block as { isError?: unknown }).isError === true)
}

/** The relay's stable message identity, when the bridge stamped one. */
function relayId(data: unknown): string | undefined {
  const source = (data as { source?: { communicationId?: unknown } } | null)?.source
  return typeof source?.communicationId === 'string' && source.communicationId !== '' ? source.communicationId : undefined
}

/**
 * Render the `/tasks` listing: one line per communication, newest last, with
 * the same arrows the activity line and the notices use. A request that is
 * still open is marked so a blocked turn is readable without opening anything.
 * @param view - the folded view.
 * @param limit - the newest rows to show.
 * @returns the panel text, or a short explanation when there is no traffic.
 */
export function communicationPanel(view: CommunicationView, limit = 20): string {
  if (view.rows.length === 0) return 'No cross-session messages in this session.'
  const waiting = new Set(view.waiting.map(entry => peerKey(entry.peer)))
  const shown = view.rows.slice(-limit)
  const lines = shown.map(row => {
    const arrow = row.direction === 'received' ? '←' : '→'
    const state = row.direction === 'received' ? 'received' : row.failed ? 'failed' : row.pending ? 'sending' : waiting.has(peerKey(row.peer)) ? 'awaiting reply' : 'sent'
    const kind = row.kind === undefined ? '' : ` ${row.kind}`
    const mode = row.mode === undefined ? '' : `/${row.mode}`
    const text = row.preview === '' ? '' : ` — ${row.preview}`
    return `${arrow} ${row.peer}${kind}${mode} · ${state}${text}`
  })
  const hidden = view.rows.length - shown.length
  return [
    ...(hidden > 0 ? [`(${hidden} older message${hidden === 1 ? '' : 's'} hidden)`] : []),
    ...lines,
  ].join('\n')
}

/**
 * Build the empty feed and its folder.
 * @returns a feed that folds one event at a time through {@link foldCommunication}.
 * @example
 * let view = createCommunicationFeed()
 * view = foldCommunication(view, event)
 */
export function createCommunicationFeed(): CommunicationView {
  return { rows: [], waiting: [] }
}
