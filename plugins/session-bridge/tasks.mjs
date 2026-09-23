// Cross-session traffic as a data fold, for `/tasks` in the terminal's plugin
// half. This is the same fold the TUI's live activity line and notices use
// (`packages/tui/src/communication.ts`): the bridge can only import from the
// shipped `plugins/` tree, because the Hub bundle carries `packages/tui/lib`
// without `packages/tui/src`. The two must stay in step — the rules are:
//
// - a `send_session` / `reply_session` call is an outbound row; its paired
//   result settles it, and an errored result is `failed`, never `awaiting`;
// - a settled `request` awaits its answer until a relay whose bridge header
//   says `reply` arrives from that peer;
// - a bridge relayed `user/message` is an inbound row;
// - rows are bounded, and outbound/inbound ids are namespaced apart.

/** Hard row cap for `/tasks`; the newest rows survive. */
export const MAX_COMMUNICATION_ROWS = 32

/** Bound on outstanding requests tracked at once (display state, not a budget). */
const MAX_WAITING_REQUESTS = 16

/** Bounded body preview, matching the activity line's display budget. */
const MAX_PREVIEW_CHARS = 72

/** The plugin name the session bridge stamps on its relayed messages. */
import { producerKind } from '../message-source/kind.mjs'

const BRIDGE_PLUGIN = 'dscode-session-bridge'

/** Tool names that address another session. */
const SEND_TOOLS = new Set(['send_session', 'reply_session'])

/**
 * One peer identity across both directions. Outbound rows carry the bare
 * session id from the tool arguments; an inbound relay's bridge label is
 * `session:<id>`, so the prefix is stripped before they are compared.
 */
function peerKey(peer) {
  return peer.startsWith('session:') ? peer.slice('session:'.length) : peer
}

/** Fold one tool-call argument JSON string into the fields a row needs. */
function callFields(raw) {
  if (typeof raw !== 'string' || raw.length > 8192) return { preview: '' }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { preview: '' }
  }
  if (parsed === null || typeof parsed !== 'object') return { preview: '' }
  const text = value => (typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '')
  const peer = text(parsed.session_id) || text(parsed.request_message_id)
  const preview = text(parsed.text)
  return {
    ...(peer === '' ? {} : { peer }),
    ...(text(parsed.kind) === '' ? {} : { kind: text(parsed.kind) }),
    ...(text(parsed.mode) === '' ? {} : { mode: text(parsed.mode) }),
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
function relayFields(data) {
  if (data === null || typeof data !== 'object') return undefined
  const source = data.source
  if (source === null || typeof source !== 'object') return undefined
  if (producerKind(source) !== BRIDGE_PLUGIN || source.form !== 'relay') return undefined
  const label = typeof source.label === 'string' && source.label !== '' ? source.label : undefined
  const id = typeof source.communicationId === 'string' && source.communicationId !== '' ? source.communicationId : undefined
  if (label === undefined && id === undefined) return undefined
  const texts = []
  if (Array.isArray(data.content)) {
    for (const block of data.content) {
      if (typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
    }
  }
  const body = texts.join(' ').replace(/\s+/gu, ' ').trim()
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

/** Keep only the newest rows. */
function bound(rows) {
  return rows.length <= MAX_COMMUNICATION_ROWS ? rows : rows.slice(rows.length - MAX_COMMUNICATION_ROWS)
}

/** The call id a tool result pairs with. */
function resultCallId(data) {
  if (!Array.isArray(data.message?.content)) return undefined
  for (const block of data.message.content) {
    if (typeof block === 'object' && block !== null && typeof block.toolCallId === 'string') return block.toolCallId
  }
  return undefined
}

/** True when the tool result's block carries `isError`. */
function resultFailed(data) {
  if (!Array.isArray(data.message?.content)) return false
  return data.message.content.some(block => typeof block === 'object' && block !== null && block.isError === true)
}

/** The relay's stable message identity, when the bridge stamped one. */
function relayId(data) {
  const source = data?.source
  return typeof source?.communicationId === 'string' && source.communicationId !== '' ? source.communicationId : undefined
}

/** Outbound row identity, namespaced so an inbound id can never collide with it. */
function outboundId(callId) {
  return `sent:${callId}`
}

/** Inbound row identity, namespaced and falling back to the event sequence. */
function inboundId(data, seq) {
  return `recv:${relayId(data) ?? seq}`
}

/** Record one settled request as awaiting its answer. Keyed by the outbound row. */
function markWaiting(waiting, request) {
  if (waiting.some(entry => entry.id === request.id)) return waiting
  const next = [...waiting, { id: request.id, peer: request.peer, since: request.at }]
  return next.length <= MAX_WAITING_REQUESTS ? next : next.slice(next.length - MAX_WAITING_REQUESTS)
}

/** Clear the outstanding requests a reply answers. */
function clearWaiting(waiting, peer) {
  const next = waiting.filter(entry => peerKey(entry.peer) !== peerKey(peer))
  return next.length === waiting.length ? waiting : next
}

/** The empty view the fold starts from. */
export function createCommunicationFeed() {
  return { rows: [], waiting: [] }
}

/**
 * Fold one root-session event into the feed, returning the same view identity
 * when the event is not communication traffic.
 * @param view - the current view.
 * @param event - one session event from the root session.
 * @returns the next view, or the same object when nothing changed.
 */
export function foldCommunication(view, event) {
  if (event.type === 'tool/call') {
    const data = event.data
    if (!SEND_TOOLS.has(data.name)) return view
    const fields = callFields(data.arguments)
    const row = {
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
    return { rows: bound([...view.rows, row]), waiting: view.waiting }
  }
  if (event.type === 'tool/result') {
    const data = event.data
    const callId = resultCallId(data)
    if (callId === undefined) return view
    const index = view.rows.findIndex(row => row.id === outboundId(callId))
    if (index === -1) return view
    const settled = { ...view.rows[index], pending: false, failed: resultFailed(data) }
    const rows = view.rows.map((row, at) => (at === index ? settled : row))
    const answers = settled.kind === 'request' && !settled.failed
    return { rows, waiting: answers ? markWaiting(view.waiting, settled) : view.waiting }
  }
  if (event.type === 'user/message') {
    const relay = relayFields(event.data)
    if (relay === undefined) return view
    const row = {
      id: inboundId(event.data, event.seq), direction: 'received',
      ...(relay.kind === undefined ? {} : { kind: relay.kind }),
      peer: relay.peer, preview: relay.preview, at: event.time, pending: false, failed: false,
    }
    return {
      rows: bound([...view.rows, row]),
      // Only the single final reply answers a request; a bare notify from the
      // same peer must not clear a turn that is still blocked on an answer.
      waiting: relay.kind === 'reply' ? clearWaiting(view.waiting, row.peer) : view.waiting,
    }
  }
  return view
}

/**
 * Render the `/tasks` listing: one line per communication, newest last, with
 * the same arrows the activity line and the notices use.
 * @param view - the folded view.
 * @param limit - the newest rows to show.
 * @returns the panel text, or a short explanation when there is no traffic.
 */
export function communicationPanel(view, limit = 20) {
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
