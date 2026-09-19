/**
 * Host-clock readings for the model's own context: one mark for a message the
 * step just admitted, one for a turn that closed before it. Pure formatting
 * over one clock, so the plugin's glue stays thin and the marks stay testable
 * without a live agent.
 *
 * @module dscode-time-marks/marks
 */

/** Shortest queue wait worth naming; below it the message simply arrived. */
const WAIT_FLOOR_MS = 1_000

/** One cached `Intl.DateTimeFormat` per zone: construction dominates formatting. */
const formatters = new Map()

/**
 * Zone the host process runs in, used when no zone is configured.
 * @returns an IANA zone name; UTC when the runtime cannot name one.
 */
export function hostTimeZone() {
  try {
    return new Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/**
 * Resolve the display zone, failing load on a zone this runtime cannot use.
 * @param configured - configured zone; empty means the host zone.
 * @returns the IANA zone name to format marks in.
 * @throws when the configured zone is not a zone `Intl` accepts.
 */
export function resolveTimeZone(configured) {
  if (typeof configured !== 'string' || configured === '') return hostTimeZone()
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: configured })
  } catch {
    throw Error(`Unknown time zone: ${configured}`)
  }
  return configured
}

/**
 * One field read off a message source, flattened to a single bounded line: a
 * mark is joined line by line, so a newline inside a label would forge the
 * next mark rather than describe this message.
 * @param value - the raw field, when it is a string at all.
 * @param limit - longest run kept.
 * @returns the flattened field.
 */
export function plain(value, limit = 64) {
  if (typeof value !== 'string') return ''
  return value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, limit)
}

/** Cached formatter for one zone. */
function formatter(timeZone) {
  let cached = formatters.get(timeZone)
  if (cached === undefined) {
    cached = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, timeZoneName: 'longOffset',
    })
    formatters.set(timeZone, cached)
  }
  return cached
}

/**
 * One clock reading in the shape the system prompt already uses:
 * `2026-09-19T01:58:34-07:00[America/Los_Angeles]`. The numeric offset keeps
 * the reading unambiguous and the bracketed zone keeps it interpretable.
 * @param at - Unix epoch milliseconds.
 * @param timeZone - IANA zone to render in.
 * @returns the formatted reading.
 */
export function clockText(at, timeZone) {
  const parts = formatter(timeZone).formatToParts(new Date(at))
  const field = type => parts.find(part => part.type === type)?.value ?? ''
  const match = /^GMT([+-])(\d{1,2})(?::(\d{2}))?$/.exec(field('timeZoneName'))
  const offset = match === null ? '+00:00' : `${match[1]}${match[2].padStart(2, '0')}:${match[3] ?? '00'}`
  // `hour12: false` renders midnight as 24 in some ICU builds.
  const hour = field('hour') === '24' ? '00' : field('hour')
  return `${field('year')}-${field('month')}-${field('day')}T${hour}:${field('minute')}:${field('second')}${offset}[${timeZone}]`
}

/**
 * Compact elapsed time: tenths of a second under a minute, `6m24s` from there
 * on, hours once minutes stop being readable.
 * @param ms - elapsed milliseconds.
 * @returns the display string; `--` when the value is unusable.
 */
export function elapsedText(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '--'
  const seconds = ms / 1_000
  if (seconds < 60) return `${Math.round(seconds * 10) / 10}s`
  const whole = Math.round(seconds)
  if (whole < 3_600) return `${Math.floor(whole / 60)}m${whole % 60}s`
  return `${Math.floor(whole / 3_600)}h${Math.floor(whole % 3_600 / 60)}m`
}

/**
 * Attribution for one arriving message, read off its durable source rather
 * than its body: a relay names its mode and origin, anything else names its
 * producer.
 * @param source - the message's source record.
 * @returns the attribution clause.
 */
export function describeSource(source) {
  const kind = plain(source?.kind)
  if (kind === 'user') return 'user message'
  if (kind !== 'plugin') return kind === '' ? 'message' : `message via ${kind}`
  if (source.form === 'relay') {
    const mode = plain(source.mode) || 'queue'
    const label = plain(source.label) || 'another session'
    return `${mode} relay from ${label}`
  }
  return `message from ${plain(source.plugin) || 'a plugin'}`
}

/**
 * One mark for a message the step just admitted. Injected context carries the
 * `snapshot` form and is never a prompt, so it earns no mark.
 * @param message - the admitted user message.
 * @param at - Unix epoch milliseconds the mark is written.
 * @param timeZone - IANA zone to render in.
 * @returns the mark line, or null when the message is context rather than input.
 */
export function arrivalMark(message, at, timeZone) {
  const source = message?.source
  if (source?.form === 'snapshot') return null
  const waited = Number(source?.composedAt)
  const queue = Number.isFinite(waited) && at - waited >= WAIT_FLOOR_MS
    ? `, waited ${elapsedText(at - waited)} (composed ${clockText(waited, timeZone)})`
    : ''
  return `Time mark: ${clockText(at, timeZone)} — ${describeSource(source)} arrived${queue}.`
}

/**
 * One mark for a turn that closed before this step opened.
 * @param turn - the closed turn's number.
 * @param endedAt - Unix epoch milliseconds the turn stopped.
 * @param startedAt - when that turn opened, when the plugin saw it open.
 * @param timeZone - IANA zone to render in.
 * @returns the mark line.
 */
export function turnEndMark(turn, endedAt, startedAt, timeZone) {
  const ran = Number.isFinite(startedAt) && startedAt <= endedAt ? `, ran ${elapsedText(endedAt - startedAt)}` : ''
  return `Time mark: ${clockText(endedAt, timeZone)} — turn ${turn} ended${ran}.`
}
