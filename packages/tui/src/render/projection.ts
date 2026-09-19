/**
 * Pure session-event-to-view projection for the TUI transcript: one reducer
 * over {@link SessionEvent}s producing the ordered entries the renderer draws.
 * Rendering never reads the session directly — this module owns the view
 * model, so tests drive it with plain event arrays.
 *
 * @module @deepseek-ai/dsh-tui/render/projection
 */

import { assistantStreamFirstTokenTime, boundContextSummary, isTokenDelta, type ContentBlock, type FileBlock, type ImageBlock, type MessageId, type StreamChunk } from '@deepseek-ai/dsh-llm'
import type { FileAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import { graphemeWidth, splitGraphemes } from './width.ts'
// Type-only imports merge the plugin-owned SessionEventMap variants
// (agent/inbox/spliced, command/*, compaction/*, goal/change, llm/retry*,
// plan/mode, permission/preset, sandbox/mode, session/title) into the union
// this reducer switches on.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-compaction'
import type {} from '@deepseek-ai/dsh-goal'
import type {} from '@deepseek-ai/dsh-llm-retry'
import type {} from '@deepseek-ai/dsh-plan-mode'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-schedule'
import type {} from '@deepseek-ai/dsh-sandbox-policy'
import type {} from '@deepseek-ai/dsh-session-title'
// The subagent package's durable catalog event joins the union the same way
// (parent-owned facts; the fold itself lives with the live feed).
import type {} from '@deepseek-ai/dsh-subagent'
import { toolArgumentsPreview, toolPromptPreview } from './tool-preview.ts'
import { toolResultDetail, type ToolDetail } from './tool-detail.ts'

/** In-flight UI buffers are tails; the assembled assistant message is authoritative. */
const MAX_STREAMING_CHARS = 65_536

/**
 * Upper bound on remembered `compaction/summary` shadow prices waiting for a
 * matching `compaction/end`. Compactions are sequential and rare, so a few
 * slots suffice; an aborted compaction (summary without end) otherwise leaves
 * an unbounded residue in `anchors.compactionTokens`. An evicted price
 * degrades to the documented `lastPruneTokens` fallback, exactly like a
 * missing summary.
 */
const MAX_COMPACTION_SUMMARY_RESIDUE = 16

/** Append one delta without retaining an unbounded duplicate of the live reply. */
function appendStreamingTail(current: string, delta: string): string {
  const next = current + delta
  return next.length <= MAX_STREAMING_CHARS ? next : next.slice(-MAX_STREAMING_CHARS)
}

/** One user prompt line. */
export interface UserEntry {
  kind: 'user'
  /** Joined text blocks of the user message. */
  text: string
  /** True for collapsed injected context (plugin/continuation notices), which
   * the renderer marks with a dim ↳ instead of the user ❯ prompt. */
  notice: boolean
  /** Durable image references carried by this prompt. */
  images?: readonly ImageBlock['attachment'][]
  /** Durable file references carried by this prompt (0.1.5 file blocks). */
  files?: readonly FileAttachmentRef[]
  /**
   * How the prompt reached the agent, when it did not arrive as an ordinary
   * submission: `queued` waited for this turn, `steered` joined it mid-flight.
   * Absent for a prompt typed straight into an idle composer.
   */
  delivery?: 'queued' | 'steered'
}

/** One user message waiting in the agent inbox (the web's queued-message row). */
export interface PendingEntry {
  kind: 'pending'
  /** Stable message identity shared with the durable `user/message` that retires it. */
  messageId: MessageId
  /** Which inbox list holds the message: steering is consumed at the next step boundary. */
  target: 'next-turn' | 'next-step'
  /** Full message text — Codex PendingSteer renders queued prompts exactly like user rows. */
  text: string
  /** Durable image references queued with this prompt. */
  images?: readonly ImageBlock['attachment'][]
  /** Durable file references queued with this prompt (0.1.5 file blocks). */
  files?: readonly FileAttachmentRef[]
}

/** One authoritative assembled assistant reply. */
export interface AssistantEntry {
  kind: 'assistant'
  /** dscode: `event.time` of this row, rendered as a local HH:MM:SS stamp. */
  time?: number
  /** Joined text blocks of the assistant message. */
  text: string
  /** Joined reasoning blocks from the same assembled message. */
  reasoning: string
  /** True when a cancelled stream's delivered prefix was finalized as this
   * entry (rc.8 `assistant/message.interrupted`) — rendered with a marker. */
  interrupted?: true
  /** dscode: this reply is the turn's last row, so the transcript closes the turn with a rule. */
  turnEnded?: true
}

/** One model-requested tool invocation and its settled state. */
export interface ToolEntry {
  kind: 'tool'
  /** dscode: `event.time` of this row, rendered as a local HH:MM:SS stamp. */
  time?: number
  /** Correlation id shared with the matching `tool/result`. */
  callId: string
  /**
   * Global tool-call ordinal across the whole transcript (1, 2, 3…, never
   * reset between turns). The tool-card badge and every error line that
   * references the failed call share this number, so "call N" in an error
   * always names the exact card the badge shows.
   */
  ordinal: number
  /** Tool name as the model addressed it. */
  name: string
  /** Raw arguments JSON string exactly as the model produced it. */
  arguments: string
  /** Bounded human-meaningful arguments preview for the tool card. */
  preview: string
  /** Bounded delegation prompt (subagent cards' second row), '' when none. */
  prompt: string
  /** Execution state; `running` until the paired result lands. */
  state: 'running' | 'done' | 'error'
  /** Bounded first text block of the result, empty until it lands. */
  summary: string
  /**
   * Bounded expansion payload for the verbose transcript (Ctrl+O), derived
   * from the tool's persisted presentation metadata; undefined until the
   * result lands and only when something renderable exists.
   */
  detail: ToolDetail | undefined
  /**
   * Nested PTC sub-dispatches (`run_code`) in start order, bounded to the
   * newest {@link MAX_TOOL_SUB_DISPATCHES} rows.
   */
  subs: readonly ToolSubDispatch[]
  /** Sub-dispatches evicted from the bounded window. */
  subsDropped: number
}

/**
 * One nested PTC sub-dispatch under a `run_code` parent call: the durable
 * `tool/ptc-dispatch-start`/`tool/ptc-dispatch` pair folded to one bounded
 * row (upstream contract: pair by `subCallId`, every start settles, and the
 * settle carries `tool/result`'s own vocabulary).
 */
export interface ToolSubDispatch {
  /** Opaque sub-call id pairing the start with its settle. */
  subCallId: string
  /** Sub-call tool name. */
  name: string
  /** Bounded arguments preview. */
  preview: string
  /** Lifecycle; `running` until the paired settle lands. */
  state: 'running' | 'done' | 'error'
  /** Bounded first text block of the settle content, '' until it lands. */
  summary: string
  /** Wall-clock duration (settle − start), 0 while running. */
  durationMs: number
}

/** Bounded sub-dispatch window per tool card (display budget only). */
export const MAX_TOOL_SUB_DISPATCHES = 12

/** Bounded member window per workflow run card (display budget only). */
export const MAX_WORKFLOW_MEMBERS = 12

/** One workflow member (an `agent()` call inside a `workflow` script). */
export interface WorkflowMember {
  /** Member sequence within the run (the agent-start/agent-end pairing key). */
  seq: number
  /** Display label. */
  label: string
  /** Declared phase title, '' when none. */
  phase: string
  /** Child session id (cross-links the subagent feed's rows). */
  childId: string
  /** Settlement; `running` until the paired `tool-workflow/agent-end`. */
  outcome: 'running' | 'completed' | 'failed' | 'cancelled'
}

/**
 * One durable workflow run (the `tool-workflow/*` record a `workflow` or
 * `ralph` tool appends to the parent session): run identity plus its
 * bounded member list, live until `tool-workflow/run-end` settles.
 */
export interface WorkflowEntry {
  kind: 'workflow'
  /** Stable run identity shared by every event of the run. */
  runId: string
  /** Display name of the run. */
  name: string
  /** Members in sequence order, bounded to the newest window. */
  members: readonly WorkflowMember[]
  /** Members evicted from the bounded window. */
  membersDropped: number
  /** Run settlement; `running` until `tool-workflow/run-end`. */
  state: 'running' | 'completed' | 'cancelled' | 'error'
}

/** Payload of `tool-workflow/run-start` (dsh-tool-workflow's map merge). */
interface WorkflowRunStartData {
  runId: string
  name: string
}

/** Payload of `tool-workflow/agent-start`. */
interface WorkflowAgentStartData {
  runId: string
  seq: number
  label: string
  phase?: string
  childId: string
}

/** Payload of `tool-workflow/agent-end`. */
interface WorkflowAgentEndData {
  runId: string
  seq: number
  outcome: 'completed' | 'failed' | 'cancelled'
}

/** Payload of `tool-workflow/run-end`. */
interface WorkflowRunEndData {
  runId: string
  stopReason: 'completed' | 'cancelled' | 'error'
}

/** Append one member to a run entry, evicting past the bounded window. */
function pushWorkflowMember(entry: WorkflowEntry, member: WorkflowMember): WorkflowEntry {
  if (entry.members.length >= MAX_WORKFLOW_MEMBERS) {
    return { ...entry, members: [...entry.members.slice(1), member], membersDropped: entry.membersDropped + 1 }
  }
  return { ...entry, members: [...entry.members, member] }
}

/** Settle one member by its sequence number (pure; unmatched stays a no-op). */
function settleWorkflowMember(entry: WorkflowEntry, data: WorkflowAgentEndData): WorkflowEntry {
  let paired = false
  const members = entry.members.map(member => {
    if (member.seq !== data.seq) return member
    paired = true
    return { ...member, outcome: data.outcome }
  })
  return paired ? { ...entry, members } : entry
}

/**
 * Payload of `tool/ptc-dispatch-start` (`@deepseek-ai/dsh-tools`'s
 * SessionEventMap merge — the bundle does not depend on that package, so
 * the fold guards the discriminator by string instead of by type).
 */
interface PtcDispatchStartData {
  rootCallId: string
  subCallId: string
  name: string
  arguments: unknown
}

/** Payload of `tool/ptc-dispatch` (a start plus its settled outcome). */
interface PtcDispatchData extends PtcDispatchStartData {
  isError: boolean
  content: readonly ContentBlock[]
}

/** JSON-stringify one sub-dispatch argument value for the preview helper. */
function subDispatchArguments(arguments_: unknown): string {
  if (typeof arguments_ === 'string') return arguments_
  try {
    return JSON.stringify(arguments_) ?? ''
  } catch {
    return ''
  }
}

/** Append one running sub-dispatch under its parent, evicting past the cap. */
function pushSubDispatch(entry: ToolEntry, sub: ToolSubDispatch): ToolEntry {
  if (entry.subs.length >= MAX_TOOL_SUB_DISPATCHES) {
    return { ...entry, subs: [...entry.subs.slice(1), sub], subsDropped: entry.subsDropped + 1 }
  }
  return { ...entry, subs: [...entry.subs, sub] }
}

/** Fold one settled sub-dispatch into its matching row (pure). */
function settleSubDispatch(entry: ToolEntry, data: PtcDispatchData, summary: string, durationMs: number): ToolEntry {
  let paired = false
  const subs = entry.subs.map(sub => {
    if (sub.subCallId !== data.subCallId) return sub
    paired = true
    return { ...sub, state: data.isError === true ? 'error' as const : 'done' as const, summary, durationMs }
  })
  // A settle without a live row (the sub left the bounded window, or the
  // parent entry was never seen) stays a provable no-op.
  return paired ? { ...entry, subs } : entry
}

/** One slash-command execution dispatched through `ctx.commands`. */
export interface CommandEntry {
  kind: 'command'
  /** Pairing id shared with the matching `command/done`. */
  commandId: string
  /** Lowercase command name without the leading slash. */
  name: string
  /** Verbatim text following the command name. */
  args: string
  /** Execution state; `running` until the paired lifecycle event lands. */
  state: 'running' | 'done' | 'error'
  /** Handler outcome text, empty until it lands. */
  summary: string
}

/** One turn-level failure surfaced from `turn/end`. */
export interface ErrorEntry {
  kind: 'error'
  /** `code: message` of the failure. */
  text: string
}

/** One non-error turn outcome surfaced from `turn/end`. */
export interface TurnMarkerEntry {
  kind: 'turn-marker'
  /** Human-readable outcome line, dim-rendered. */
  text: string
}

/** One completed compaction lifecycle surfaced from `compaction/end`. */
export interface CompactionEntry {
  kind: 'compaction'
  /** True when the compaction completed, false when it failed. */
  ok: boolean
  /** Heuristic tokens shadowed by the compaction (summary or prune price). */
  tokens: number
  /** Failure text when `ok` is false, empty otherwise. */
  error: string
}

/** One provider-routed model-request retry (the `llm/retry` pair). */
export interface RetryEntry {
  kind: 'retry'
  /** Correlation id shared with the matching `llm/retry-started`. */
  retryId: string
  /** Retry policy mode from the event: `always` has no attempt cap. */
  mode: 'normal' | 'always'
  /** Attempt ordinal and its cap. */
  attempt: number
  max: number
  /** Failure code that triggered the retry. */
  code: string
  /** Backoff wait before the next attempt, in ms. */
  delayMs: number
  /**
   * `running` while the backoff waits, `done` once the attempt started — or
   * when the turn ended first (the turn-end sweep finalizes orphans so they
   * never pin the settled boundary).
   */
  state: 'running' | 'done'
}

/** Turn-tail deliverables: files mutated by the turn's diff-bearing tools. */
export interface FilesEntry {
  kind: 'files'
  /** Unique mutated paths in call order, bounded. */
  paths: readonly string[]
}

/** Ordered transcript items the renderer draws. */
export type TranscriptEntry = UserEntry | PendingEntry | AssistantEntry | ToolEntry | CommandEntry | ErrorEntry | TurnMarkerEntry | CompactionEntry | RetryEntry | FilesEntry | WorkflowEntry

/** The live goal the status line badges, folded from `goal/change`. */
export interface GoalFold {
  /** Human-requested completion objective. */
  objective: string
  /** Durable lifecycle phase. */
  phase: 'active' | 'paused' | 'blocked' | 'complete'
  /** Highest admitted continuation round and its cap. */
  rounds: number
  max: number
  /** Blocked explanation, empty outside the blocked phase. */
  blocked: string
}

/**
 * Cumulative token accounting folded from `assistant/message` usage reports.
 * The buckets are disjoint and mirror the provider's report, so the prompt
 * side is never double counted: reasoning tokens are already inside
 * `outputTokens`, and cache reads are never folded into the uncached input.
 */
export interface UsageTotals {
  /** Prompt-side tokens billed outside the cache. */
  uncachedInputTokens: number
  /** Completion-side tokens over the whole log. */
  outputTokens: number
  /** Cache-read tokens over the whole log (0 when the adapter reports none). */
  cacheReadTokens: number
  /** Cache-write tokens over the whole log (0 when the adapter reports none). */
  cacheWriteTokens: number
}

/**
 * Estimated used tokens per context content type, folded from transcript
 * events via {@link estimateTokens}. The segmented context bar's composition
 * source: proportions across types are meaningful, absolute values are not
 * (they never touch billing or the reported `lastPromptTokens`).
 */
export interface ContextSegments {
  /** Rendered system-prompt text (latest `request/header`) plus injected-context notices. */
  system: number
  /** Direct human prompts (durable `user/message` rows). */
  prompt: number
  /** Assistant text blocks (visible replies). */
  assistant: number
  /** Assistant reasoning blocks (hidden thinking). */
  thinking: number
  /** Tool call arguments plus result text. */
  tools: number
}

/** Window-scoped figures the status line shows; timing uses event timestamps. */
export interface TranscriptStats {
  /** Durable turns opened (`turn/start` events). */
  turns: number
  /** Model requests made (`step/start` events). */
  steps: number
  /** Summed model wall time: `step/start` → `assistant/message`, in ms. */
  llmMs: number
  /** Summed tool wall time: `tool/call` → `tool/result`, in ms. */
  toolMs: number
  /** Cumulative token accounting; input stays 0 until a report lands. */
  usage: UsageTotals
  /** Prompt-side size of the most recent reported request (context pressure). */
  lastPromptTokens: number
  /** Newest advertised route capacity, 0 when no adapter ever advertised one. */
  contextWindow: number
  /** Estimated used tokens per content type (the segmented bar's composition). */
  contextSegments: ContextSegments
  /** Summed first-token waits: `step/start` → first non-empty chunk, in ms. */
  ttftMs: number
  /** Steps that produced a first chunk (the TTFT average's denominator). */
  ttftSteps: number
  /** Summed decode spans: first chunk → `assistant/message`, in ms. */
  decodeMs: number
  /** Completion tokens over timed decode spans (the tok/s numerator). */
  decodeTokens: number
  /**
   * Adapter-owned reasoning effort of the latest `request/header` config —
   * the EFFECTIVE effort the session actually uses (a materialized model
   * default is included, exactly as the adapter resolved it). Empty when the
   * header carried none (provider-default behavior). The status line appends
   * it to the model segment as `provider/model@effort`.
   */
  reasoningEffort: string
}

/** One active reminder folded from durable `schedule/change` events. */
export interface ScheduleRow {
  readonly id: string
  readonly kind: 'after' | 'at' | 'every'
  readonly prompt: string
  /** Next due time (epoch ms); the /schedule panel derives overdue/relative labels. */
  readonly targetAt: number
  /** Recurrence seconds for 'every' rows, undefined otherwise. */
  readonly everySeconds?: number
}

/**
 * The durable `schedule/change` payload shape this fold consumes. Upstream
 * strict-decodes the whole transition stream before appending, so unknown
 * ids here are corrupt-input edges that degrade to a no-op.
 */
export interface ScheduleChangeLike {
  readonly operation: 'create' | 'delete' | 'dispatch'
  readonly schedule?: {
    readonly id: string
    readonly kind: 'after' | 'at' | 'every'
    readonly prompt: string
    readonly afterSeconds?: number
    readonly everySeconds?: number
    readonly scheduledAt: string
  }
  readonly id?: string
  readonly acceptedAt?: string
}

/*
 * Upstream record semantics (dsh-schedule types): `scheduledAt` is ALREADY
 * the due instant — AfterScheduleRecord carries the RFC 3339 UTC target
 * (delay included), EveryScheduleRecord carries the earliest anchor-aligned
 * occurrence not yet dispatched. No kind ever adds its own interval on top.
 */

/** Fold one `schedule/change` into the active-reminder list (create/delete/dispatch). */
export function applyScheduleChange(rows: readonly ScheduleRow[], data: ScheduleChangeLike): readonly ScheduleRow[] {
  if (data.operation === 'create' && data.schedule !== undefined) {
    const schedule = data.schedule
    const row: ScheduleRow = {
      id: schedule.id,
      kind: schedule.kind,
      prompt: schedule.prompt,
      targetAt: Date.parse(schedule.scheduledAt),
      ...(schedule.kind === 'every' ? { everySeconds: schedule.everySeconds ?? 0 } : {}),
    }
    return [...rows.filter(existing => existing.id !== schedule.id), row]
  }
  if (data.operation === 'delete' && data.id !== undefined) {
    return rows.filter(existing => existing.id !== data.id)
  }
  if (data.operation === 'dispatch' && data.id !== undefined) {
    // A dispatched one-shot reminder is finished. An 'every' reminder
    // advances PAST every missed occurrence in one step: the next target is
    // the first anchor-aligned instant strictly after acceptedAt, stepping
    // from the previous aligned target (upstream advances the same way).
    if (data.acceptedAt === undefined) return rows.filter(existing => existing.id !== data.id)
    const accepted = Date.parse(data.acceptedAt)
    return rows.map(existing => existing.id === data.id
      ? { ...existing, targetAt: nextEveryTarget(existing.targetAt, accepted, existing.everySeconds ?? 0) }
      : existing)
  }
  return rows
}

/** First anchor-aligned target after `acceptedAt`, stepping from the previous aligned target. */
export function nextEveryTarget(previousTarget: number, acceptedAt: number, everySeconds: number): number {
  const interval = Math.max(1, everySeconds) * 1000
  if (acceptedAt <= previousTarget) return previousTarget + interval
  const missed = Math.ceil((acceptedAt - previousTarget + 1) / interval)
  return previousTarget + missed * interval
}

/** Plugin snapshot sources folded into token stats but never rendered as rows. */
const HIDDEN_SNAPSHOT_PLUGINS = new Set(['time-context', 'tmux-context', 'dscode-time-marks'])
/** Plugin prompt sources rendered as full user rows (they ARE the conversation). */
const REMINDER_PLUGINS = new Set(['schedule'])

/** The complete TUI transcript view for one session. */
export interface TranscriptView {
  /** Settled entries in log order. */
  entries: readonly TranscriptEntry[]
  /** Bounded text tail accumulated from live stream frames since the last settlement. */
  streaming: string
  /** Bounded thinking tail accumulated from reasoning deltas since the last flush. */
  streamingReasoning: string
  /** Latest whole-list todo snapshot from `todo/write`, empty when none. */
  todos: readonly TodoItem[]
  /**
   * Global tool-call ordinal counter: the number the NEXT `tool/call` lands
   * with (1-based). Never reset, so the counter and the badges/error lines
   * stay consistent across turns and resumed sessions.
   */
  toolCallOrdinal: number
  /** True while a durable turn is open (`turn/start` … `turn/end`). */
  busy: boolean
  /** `turn/start` time of the open turn (0 while idle) — the web TurnStatus clock anchor. */
  busySince: number
  /** dscode: `compaction/start` time of the running compaction (0 while none). */
  dscodeCompactingSince: number
  /** Figures the status line renders. */
  stats: TranscriptStats
  /**
   * The `provider/model` pair of the last `request/header` snapshot — the
   * session's own model record, which a resumed TUI prefers over the
   * deployment default (mirrors the web host's resume selection order).
   * Empty before the session's first request.
   */
  model: string
  /** Plan mode state folded from the last `plan/mode` event. */
  plan: boolean
  /** Active permission preset folded from the last `permission/preset` event, empty before one. */
  permission: string
  /** Latest session title folded from the last `session/title` event, empty before one. */
  title: string
  /**
   * Effective system prompt assembled from `system/message` surface nodes
   * (v3): the head node's text joined with every later non-empty node, blank
   * lines between. Empty before the first system node or when every node is
   * empty ("no system prompt").
   */
  systemPrompt: string
  /** Sandbox-mode override folded from the last `sandbox/mode` event, empty when never switched. */
  sandbox: string
  /** Current long-running goal folded from the last `goal/change`, undefined when cleared. */
  goal: GoalFold | undefined
  /** Active reminders folded from `schedule/change` events, oldest target first at render. */
  schedules: readonly ScheduleRow[]
  /**
   * Ordered live message ids per inbox target, mirrored from
   * `agent/inbox/spliced` exactly like the upstream Inbox projection — the
   * coordinates later removals resolve against.
   */
  pending: { 'next-turn': readonly string[]; 'next-step': readonly string[] }
  /**
   * In-flight inbox messages by the list they were inserted into, kept until
   * the durable user message that claims them lands. The claim itself is a
   * plain splice that empties the pending row first, so this map — not
   * {@link pending} — is what lets a settled prompt say it was queued or
   * steered rather than typed into an idle composer.
   */
  claimOrigin: ReadonlyMap<string, 'next-turn' | 'next-step'>
  /**
   * Fold-internal timing anchors, never rendered: open step and tool-call
   * start timestamps the next `assistant/message` / `tool/result` resolves
   * against. Keyed `turn:step` and by call id. `turnSteps`/`turnTools`
   * track which step/tool anchors still belong to the open turn so
   * `turn/end` (and a superseding `step/start`) can sweep anchors an
   * interruption left behind; `turnFiles` keys mutated paths by turn.
   */
  readonly anchors: {
    stepStart: Map<string, number>
    toolStart: Map<string, number>
    /** Open PTC sub-dispatch starts by `subCallId` (duration anchors). */
    subStart: Map<string, number>
    firstChunkAt: Map<string, number>
    compactionTokens: Map<string, number>
    lastPruneTokens: number
    turnFiles: Map<number, Set<string>>
    turnSteps: Map<number, string>
    turnTools: Map<number, Set<string>>
    /** Live `system/message` surface nodes by event seq (empty string = an empty node). */
    systemNodes: Map<number, string>
  }
}

/** Assemble the effective system prompt from surface nodes: head text plus every later non-empty node. */
function assembleSystemPrompt(nodes: ReadonlyMap<number, string>): string {
  if (nodes.size === 0) return ''
  const ordered = [...nodes.entries()].sort((left, right) => left[0] - right[0])
  const texts = ordered
    .map(([, text]) => text)
    .filter(text => text !== '')
  return texts.join('\n\n')
}

/**
 * Apply one surface event's replace to the live system nodes. Any surface
 * event may shadow system nodes — the kernel's compaction summary lands as a
 * `user/message` replace whose range can cover later system nodes (only node
 * 0 is compaction-protected upstream) — so every surface fold retires covered
 * nodes, not just `system/message` itself.
 * @param nodes - the live system-node map (mutated when the event replaces).
 * @param surfaceOp - the surface operation the event carries, when it is a
 * surface event (log-only events have none and change nothing).
 * @returns the reassembled prompt when nodes were retired, `changed: false`
 * when the event shadows nothing.
 */
function retireShadowedSystemNodes(
  nodes: Map<number, string>,
  surfaceOp: 'append' | { readonly op: 'replace'; readonly startSeq: number; readonly endSeq: number } | undefined,
): { readonly prompt: string; readonly changed: boolean } {
  if (surfaceOp === undefined || surfaceOp === 'append') return { prompt: '', changed: false }
  let changed = false
  for (const seq of nodes.keys()) {
    if (seq >= surfaceOp.startSeq && seq <= surfaceOp.endSeq) {
      nodes.delete(seq)
      changed = true
    }
  }
  return changed ? { prompt: assembleSystemPrompt(nodes), changed } : { prompt: '', changed: false }
}

/** Join the text blocks of a content list; non-text blocks contribute nothing. */
function textOf(content: readonly ContentBlock[]): string {
  return content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Snapshot-isolate one anchors block (Maps and their nested Sets): a view
 * already handed to the renderer must never observe a later fold through a
 * shared container. The collections are small and turn-bounded, so cloning
 * per event is cheap next to the entries copy the reducer already makes.
 */
function cloneViewAnchors(anchors: TranscriptView['anchors']): TranscriptView['anchors'] {
  return {
    stepStart: new Map(anchors.stepStart),
    toolStart: new Map(anchors.toolStart),
    subStart: new Map(anchors.subStart),
    firstChunkAt: new Map(anchors.firstChunkAt),
    compactionTokens: new Map(anchors.compactionTokens),
    lastPruneTokens: anchors.lastPruneTokens,
    turnFiles: new Map([...anchors.turnFiles].map(([turn, files]) => [turn, new Set(files)])),
    turnSteps: new Map(anchors.turnSteps),
    turnTools: new Map([...anchors.turnTools].map(([turn, tools]) => [turn, new Set(tools)])),
    systemNodes: new Map(anchors.systemNodes),
  }
}

/** Durable image references in their model-visible order. */
function imagesOf(content: readonly ContentBlock[]): readonly ImageBlock['attachment'][] {
  return content.filter((block): block is ImageBlock => block.type === 'image').map(block => block.attachment)
}

/** Durable file references in their model-visible order. */
function filesOf(content: readonly ContentBlock[]): readonly FileAttachmentRef[] {
  return content.filter((block): block is FileBlock => block.type === 'file').map(block => block.attachment)
}

/** Human-readable bounded image labels for transcript, inspector, and export surfaces. */
export function imageLabels(images: readonly ImageBlock['attachment'][] | undefined): string {
  if (images === undefined || images.length === 0) return ''
  return images.map((image, index) => {
    const rawName = image.name?.trim() || `image ${index + 1}`
    const name = rawName.length <= 80 ? rawName : `${rawName.slice(0, 79)}…`
    const original = image.originalDimensions
    const dimensions = original === undefined
      ? `${image.width}×${image.height}`
      : `${image.width}×${image.height} · original ${original.width}×${original.height}`
    return `[image: ${name} · ${dimensions} · ${image.bytes} B]`
  }).join('\n')
}

/** Human-readable bounded file labels for the same surfaces (0.1.5 file blocks). */
export function fileLabels(files: readonly FileAttachmentRef[] | undefined): string {
  if (files === undefined || files.length === 0) return ''
  return files.map((file, index) => {
    const rawName = file.name?.trim() || `file ${index + 1}`
    const name = rawName.length <= 80 ? rawName : `${rawName.slice(0, 79)}…`
    return `[file: ${name} · ${file.bytes} B]`
  }).join('\n')
}

/** Prompt text with its durable image and file labels, without exposing local paths or bytes. */
export function promptDisplayText(entry: Pick<UserEntry | PendingEntry, 'text' | 'images' | 'files'>): string {
  const imageText = imageLabels(entry.images)
  const fileText = fileLabels(entry.files)
  const labels = imageText === '' ? fileText : fileText === '' ? imageText : `${imageText}\n${fileText}`
  return entry.text === '' ? labels : labels === '' ? entry.text : `${entry.text}\n${labels}`
}

/** Join the reasoning blocks of a content list; non-reasoning blocks contribute nothing. */
function reasoningOf(content: readonly ContentBlock[]): string {
  return content.filter(block => block.type === 'reasoning').map(block => block.text).join('')
}

/**
 * Rough token estimate for the segmented context bar (pi-nano-context's ~4
 * chars/token heuristic, CJK-aware so a Chinese prompt is not quartered):
 * CJK/wide chars cost ~1 token each, ASCII ~4 chars per token. Estimates
 * drive bar PROPORTIONS, never billing, so precision is not required.
 * @param text - the text to estimate.
 * @returns an integer token estimate, 0 for empty text.
 */
function estimateTokens(text: string): number {
  let wide = 0
  let narrow = 0
  for (const cluster of splitGraphemes(text)) {
    if (graphemeWidth(cluster) > 1) wide += 1
    else narrow += 1
  }
  return wide + Math.ceil(narrow / 4)
}

/** A fresh, empty transcript view. */
export function createTranscriptView(): TranscriptView {
  return {
    entries: [],
    streaming: '',
    streamingReasoning: '',
    todos: [],
    toolCallOrdinal: 0,
    busy: false,
    busySince: 0,
    dscodeCompactingSince: 0,
    model: '',
    plan: false,
    permission: '',
    title: '',
    systemPrompt: '',
    sandbox: '',
    goal: undefined,
    schedules: [],
    pending: { 'next-turn': [], 'next-step': [] },
    claimOrigin: new Map(),
    stats: { turns: 0, steps: 0, llmMs: 0, toolMs: 0, usage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, lastPromptTokens: 0, contextWindow: 0, contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 }, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0, reasoningEffort: '' },
    anchors: { stepStart: new Map(), toolStart: new Map(), subStart: new Map(), firstChunkAt: new Map(), compactionTokens: new Map(), lastPruneTokens: 0, turnFiles: new Map(), turnSteps: new Map(), turnTools: new Map(), systemNodes: new Map() },
  }
}

/** Full prompt text of a queued message (identical to the durable user row it retires into). */
function pendingText(content: readonly ContentBlock[]): string {
  return textOf(content)
}

/**
 * Fold one session event into an updated view (copy-on-write).
 * @param view - the view before the event.
 * @param event - one durable session event from `session/event` or the log.
 * @returns the view after the event; the input view is never mutated.
 */
export function projectEvent(view: TranscriptView, event: SessionEvent): TranscriptView {
  // Fold against a private anchors block so the documented contract holds —
  // "the input view is never mutated" — even for the in-place anchor sweeps
  // below; without this, every handed-out view shared live Maps.
  view = { ...view, anchors: cloneViewAnchors(view.anchors) }
  // Any surface event's replace may shadow system nodes (a compaction
  // summary lands as a user/message replace whose range can cover later
  // system nodes); the switch below folds against the shadowed view.
  const shadow = retireShadowedSystemNodes(view.anchors.systemNodes, event.surfaceOp)
  if (shadow.changed) {
    view = {
      ...view,
      systemPrompt: shadow.prompt,
      stats: { ...view.stats, contextSegments: { ...view.stats.contextSegments, system: estimateTokens(shadow.prompt) } },
    }
  }
  switch (event.type) {
    case 'user/message': {
      // A queued row retires when its durable user message lands (the agent
      // claims the inbox and logs the same message identity) — the transient
      // steering/queued preview yields to the real transcript entry.
      const message = event.data
      let entries = view.entries
      let pending = view.pending
      for (const target of ['next-turn', 'next-step'] as const) {
        const index = pending[target].indexOf(message.id)
        if (index < 0) continue
        pending = { ...pending, [target]: pending[target].filter((_, i) => i !== index) }
        entries = entries.filter(entry => !(entry.kind === 'pending' && entry.messageId === message.id))
      }
      // How this message reached the agent. The claim that precedes this event
      // is a plain splice (no `canceled` outcome), so it has already emptied
      // the pending row above; `claimOrigin` is what survives to say whether
      // the prompt was queued for this turn or steered into it.
      const origin = view.claimOrigin.get(message.id)
      let claimOrigin = view.claimOrigin
      if (origin !== undefined) {
        const next = new Map(claimOrigin)
        next.delete(message.id)
        claimOrigin = next
      }
      const delivery = origin === undefined ? {} : { delivery: origin === 'next-turn' ? 'queued' as const : 'steered' as const }
      // Injected context (plugin/model-continuation sources) stays collapsed
      // to a bounded notice row, exactly like collapsed transcript context
      // elsewhere in the product; only direct human prompts render in full.
      const text = textOf(message.content)
      const images = imagesOf(message.content)
      const files = filesOf(message.content)
      if (message.source.kind === 'user' || dscodeVisibleRelay(message)) {
        return {
          ...view,
          pending,
          claimOrigin,
          entries: [...entries, { kind: 'user', text, notice: false, ...delivery, ...(images.length === 0 ? {} : { images }), ...(files.length === 0 ? {} : { files }) }],
          stats: {
            ...view.stats,
            contextSegments: {
              ...view.stats.contextSegments,
              prompt: view.stats.contextSegments.prompt + estimateTokens(text),
            },
          },
        }
      }
      // Snapshot injections (time/tmux context) still spend model context but
      // render nothing; the schedule reminder is a real prompt and renders in
      // full — the model acts on it, so the transcript must show it.
      if (message.source.kind === 'plugin' && HIDDEN_SNAPSHOT_PLUGINS.has(message.source.plugin)) {
        return {
          ...view,
          pending,
          claimOrigin,
          entries,
          stats: {
            ...view.stats,
            contextSegments: {
              ...view.stats.contextSegments,
              system: view.stats.contextSegments.system + estimateTokens(text),
            },
          },
        }
      }
      if (message.source.kind === 'plugin' && REMINDER_PLUGINS.has(message.source.plugin)) {
        return {
          ...view,
          pending,
          claimOrigin,
          entries: [...entries, { kind: 'user', text, notice: false, ...delivery, ...(images.length === 0 ? {} : { images }), ...(files.length === 0 ? {} : { files }) }],
          stats: {
            ...view.stats,
            contextSegments: {
              ...view.stats.contextSegments,
              prompt: view.stats.contextSegments.prompt + estimateTokens(text),
            },
          },
        }
      }
      const notice = message.source.kind === 'plugin' && message.source.form === 'notice'
        ? message.source.summary
        : message.source.kind === 'plugin'
          ? message.source.plugin
          : message.source.kind
      const summary = boundContextSummary(notice)
      return {
        ...view,
        pending,
        claimOrigin,
        entries: [...entries, { kind: 'user', text: summary, notice: true }],
        stats: {
          ...view.stats,
          contextSegments: {
            ...view.stats.contextSegments,
            system: view.stats.contextSegments.system + estimateTokens(summary),
          },
        },
      }
    }
    case 'agent/inbox/spliced': {
      // The durable inbox mutation (web queue-mirror contract, event-sourced):
      // removals drop the projected rows at their inbox coordinates, inserted
      // messages gain a pending row at their log position.
      const { target, start, removedCount = 0, inserted, outcome } = event.data
      const ids = view.pending[target]
      const removed = ids.slice(start, start + removedCount)
      // Which list each in-flight message came from, so the durable user
      // message it later becomes can say how it was delivered. Only messages
      // that arrived while a turn was already running count: `followup` is
      // the ordinary submission path too, so an idle submission lands in
      // next-turn exactly like a queued one and must stay unmarked. A claim
      // (no `outcome`) keeps the entry because the user message is still
      // coming; a real cancellation retires it.
      const inFlight = view.busy
      let claimOrigin: ReadonlyMap<string, 'next-turn' | 'next-step'> = view.claimOrigin
      let mutableOrigins: Map<string, 'next-turn' | 'next-step'> | undefined
      const remember = (id: string): void => {
        mutableOrigins ??= new Map(claimOrigin)
        mutableOrigins.set(id, target)
        claimOrigin = mutableOrigins
      }
      if (outcome === 'canceled' && removed.length > 0) {
        const next = new Map(claimOrigin)
        for (const id of removed) next.delete(id)
        claimOrigin = next
      }
      // In-place upstream semantics: the kernel's authoritative fold is
      // `inbox.splice(start, removedCount, ...inserted)` — inserted ids land
      // AT the splice position (prepend/replace shapes), never at the tail.
      // A tail append diverged the id order, so later coordinate-based events
      // (next-turn head claims, positioned remove/replace) tombstoned the
      // wrong pending row.
      const nextIds = [
        ...ids.slice(0, start),
        ...inserted.map(message => message.id),
        ...ids.slice(start + removedCount),
      ]
      let entries = view.entries
      if (removed.length > 0) {
        const removedSet = new Set(removed)
        entries = entries.filter(entry =>
          !(entry.kind === 'pending' && entry.target === target && removedSet.has(entry.messageId)))
      }
      for (const message of inserted) {
        if (inFlight) remember(message.id)
        entries = [...entries, {
          kind: 'pending',
          messageId: message.id,
          target,
          text: pendingText(message.content),
          ...imagesOf(message.content).length === 0 ? {} : { images: imagesOf(message.content) },
          ...filesOf(message.content).length === 0 ? {} : { files: filesOf(message.content) },
        }]
      }
      return { ...view, entries, claimOrigin, pending: { ...view.pending, [target]: nextIds } }
    }
    case 'system/message': {
      // Session-log v3 carries the system prompt as surface nodes (the
      // `request/header.system` field is gone): append adds one node;
      // replace(startSeq, endSeq) retires the covered nodes and this event's
      // node takes their place. The effective prompt is the head text joined
      // with every later non-empty node (kernel in-history assembly), and
      // the context estimate prices that assembly — a tail-clearing
      // replacement never zeroes a surviving head.
      const text = textOf(event.data.message.content)
      const nodes = view.anchors.systemNodes
      retireShadowedSystemNodes(nodes, event.surfaceOp)
      nodes.set(event.seq, text)
      const systemPrompt = assembleSystemPrompt(nodes)
      return {
        ...view,
        systemPrompt,
        stats: {
          ...view.stats,
          contextSegments: {
            ...view.stats.contextSegments,
            system: estimateTokens(systemPrompt),
          },
        },
      }
    }
    case 'assistant/attempt': {
      // A failed, retried, cancelled, or stream-error attempt that produced no
      // surface message (session-log v2+ folds its chunk stream in here). The
      // step is NOT closed — the kernel's session-stats keeps one step start
      // across in-step retries, so llmMs spans them; keep the anchors so a
      // retrying attempt and its final settlement time the step from one
      // start. An attempt whose first token streamed only live (the frames
      // died before the fold) restores its first-token anchor from the
      // embedded stream exactly like a replayed one.
      const key = `${event.data.turn}:${event.data.step}`
      let stats = view.stats
      if (!view.anchors.firstChunkAt.has(key)) {
        const first = assistantStreamFirstTokenTime(event.data.stream ?? [])
        if (first !== undefined) {
          view.anchors.firstChunkAt.set(key, first)
          const started = view.anchors.stepStart.get(key)
          if (started !== undefined) {
            stats = {
              ...stats,
              ttftMs: stats.ttftMs + Math.max(0, first - started),
              ttftSteps: stats.ttftSteps + 1,
            }
          }
        }
      }
      if (view.streaming === '' && view.streamingReasoning === '' && stats === view.stats) return view
      return { ...view, streaming: '', streamingReasoning: '', stats }
    }
    case 'assistant/message': {
      // The assembled message is authoritative; drop the streamed buffers.
      const key = `${event.data.turn}:${event.data.step}`
      const started = view.anchors.stepStart.get(key)
      view.anchors.stepStart.delete(key)
      // Live streaming anchored the first token through the process-local
      // assistant-stream frames; a replayed settlement has no live frames, so
      // the embedded stream's own first-token time restores the same anchor
      // AND the TTFT figures live frames accumulate on the live path.
      let firstChunk = view.anchors.firstChunkAt.get(key)
      let stats = view.stats
      if (firstChunk === undefined) {
        firstChunk = assistantStreamFirstTokenTime(event.data.stream ?? [])
        if (firstChunk !== undefined && started !== undefined) {
          stats = {
            ...stats,
            ttftMs: stats.ttftMs + Math.max(0, firstChunk - started),
            ttftSteps: stats.ttftSteps + 1,
          }
        }
      }
      view.anchors.firstChunkAt.delete(key)
      // The assembled message consumes the turn's current step anchor; a
      // later `turn/end` sweep then has nothing left to clean for this step.
      if (view.anchors.turnSteps.get(event.data.turn) === key) view.anchors.turnSteps.delete(event.data.turn)
      const usage = event.data.usage
      const totals = stats.usage
      const text = textOf(event.data.message.content)
      const reasoning = reasoningOf(event.data.message.content)
      // A tool-only step settles with no text, no reasoning, and (unless the
      // attempt was interrupted) nothing to render: appending an entry would
      // create an invisible zero-line card that pads the inspector's ←→
      // walk and an empty block in /export. The event still updates timing
      // and usage above; only the transcript entry is skipped.
      const renderable = text !== '' || reasoning !== '' || event.data.interrupted === true
      return {
        ...view,
        streaming: '',
        streamingReasoning: '',
        ...(renderable ? { entries: [...view.entries, { kind: 'assistant', text, reasoning, time: event.time, interrupted: event.data.interrupted === true ? true : undefined }] } : {}),
        stats: {
          ...stats,
          llmMs: stats.llmMs + (started === undefined ? 0 : Math.max(0, event.time - started)),
          usage: usage === undefined ? totals : {
            uncachedInputTokens: totals.uncachedInputTokens + usage.inputTokens,
            outputTokens: totals.outputTokens + usage.outputTokens,
            cacheReadTokens: totals.cacheReadTokens + (usage.cacheReadTokens ?? 0),
            cacheWriteTokens: totals.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
          },
          lastPromptTokens: usage === undefined ? stats.lastPromptTokens
            : usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
          // Decode span and its tokens pair up: an un-timed step (no first
          // chunk landed) contributes neither, so the rate stays honest.
          decodeMs: stats.decodeMs + (firstChunk === undefined ? 0 : Math.max(0, event.time - firstChunk)),
          decodeTokens: stats.decodeTokens + (firstChunk === undefined || usage === undefined ? 0 : usage.outputTokens),
          contextSegments: {
            ...stats.contextSegments,
            thinking: stats.contextSegments.thinking + estimateTokens(reasoning),
            assistant: stats.contextSegments.assistant + estimateTokens(text),
          },
        },
      }
    }
    case 'tool/call': {
      const data = event.data
      view.anchors.toolStart.set(data.callId, event.time)
      // Remember the call's turn so `turn/end` can sweep a start that never
      // pairs with a result (an interrupted tool otherwise leaks its anchor).
      const turnTools = view.anchors.turnTools.get(data.turn) ?? new Set<string>()
      turnTools.add(data.callId)
      view.anchors.turnTools.set(data.turn, turnTools)
      const ordinal = view.toolCallOrdinal + 1
      return {
        ...view,
        toolCallOrdinal: ordinal,
        entries: [
          ...view.entries,
          {
            kind: 'tool',
          time: event.time,
          callId: data.callId,
          ordinal,
          name: data.name,
          arguments: data.arguments,
          preview: toolArgumentsPreview(data.arguments, data.name),
          prompt: toolPromptPreview(data.name, data.arguments),
          state: 'running',
          summary: '',
          detail: undefined,
          subs: [],
          subsDropped: 0,
        }],
        stats: {
          ...view.stats,
          contextSegments: {
            ...view.stats.contextSegments,
            tools: view.stats.contextSegments.tools
              + (typeof data.arguments === 'string' ? estimateTokens(data.arguments) : 0),
          },
        },
      }
    }
    case 'tool/result': {
      const block = event.data.message.content[0]
      const started = view.anchors.toolStart.get(block.toolCallId)
      view.anchors.toolStart.delete(block.toolCallId)
      // Deregister the call from its turn's registry so `turn/end` does not
      // sweep a start that already paired with a result.
      const turnTools = view.anchors.turnTools.get(event.data.turn)
      if (turnTools !== undefined) {
        turnTools.delete(block.toolCallId)
        if (turnTools.size === 0) view.anchors.turnTools.delete(event.data.turn)
      }
      const rawText = textOf(block.content)
      const summary = boundContextSummary(rawText)
      // The verbose expansion self-serves from the persisted presentation
      // metadata (diffs, read windows, web sources) with the bounded raw text
      // as the universal fallback — the capable-UI degradation ladder.
      const detail = toolResultDetail(event.data.meta, rawText)
      // Turn-tail deliverables: a diff-bearing mutation records its paths.
      if (detail?.kind === 'diff') {
        const set = view.anchors.turnFiles.get(event.data.turn) ?? new Set<string>()
        for (const diff of detail.diffs) set.add(diff.path)
        view.anchors.turnFiles.set(event.data.turn, set)
      }
      const entries = view.entries.map((entry) => {
        if (entry.kind !== 'tool' || entry.callId !== block.toolCallId) return entry
        return { ...entry, state: block.isError === true ? 'error' as const : 'done' as const, summary, detail }
      })
      return {
        ...view,
        entries,
        stats: {
          ...view.stats,
          toolMs: view.stats.toolMs + (started === undefined ? 0 : Math.max(0, event.time - started)),
          contextSegments: {
            ...view.stats.contextSegments,
            tools: view.stats.contextSegments.tools + estimateTokens(rawText),
          },
        },
      }
    }
    case 'todo/write':
      return { ...view, todos: event.data.todos }
    case 'turn/start':
      // The web todo projection clears on turn/start: a fresh turn's first
      // write is the authoritative list, and a stale snapshot must not linger
      // through a turn that has not written one yet.
      return {
        ...view,
        busy: true,
        busySince: view.busy ? view.busySince : event.time,
        dscodeCompactingSince: 0,
        todos: [],
        stats: { ...view.stats, turns: view.stats.turns + 1 },
      }
    case 'step/start': {
      // A step supersedes the turn's previous step: if that step never
      // assembled a message (interrupted), its timing anchors are stale the
      // moment the next step opens and are swept here instead of leaking.
      const key = `${event.data.turn}:${event.data.step}`
      const previous = view.anchors.turnSteps.get(event.data.turn)
      if (previous !== undefined && previous !== key) {
        view.anchors.stepStart.delete(previous)
        view.anchors.firstChunkAt.delete(previous)
      }
      view.anchors.turnSteps.set(event.data.turn, key)
      view.anchors.stepStart.set(key, event.time)
      return {
        ...view,
        streaming: '',
        streamingReasoning: '',
        stats: { ...view.stats, steps: view.stats.steps + 1 },
      }
    }
    case 'turn/end': {
      const reason = event.data.reason
      const appended: TranscriptEntry[] = []
      if (reason.kind === 'error') {
        const recovery = reason.error.code === 'MISSING_CREDENTIAL'
          ? ' · open /model to add an API key'
          : ''
        appended.push({ kind: 'error', text: `${reason.error.code}: ${reason.error.message}${recovery}` })
      } else {
        // Non-error outcomes deserve their own durable row (the web renders
        // distinct max-tokens / abort / interruption nodes); `completed` stays
        // silent so an ordinary turn never grows a marker.
        const userCancelled = reason.kind === 'aborted' && reason.reason.kind === 'user'
        const marker = reason.kind === 'aborted'
          ? userCancelled ? 'turn cancelled by the user' : `turn stopped (${reason.reason.kind})`
          : reason.kind === 'max-tokens'
            ? 'turn hit the output-token ceiling (max-tokens)'
            : reason.kind === 'blocked'
              ? 'turn ended blocked'
              : reason.kind === 'interrupted'
                ? 'turn was interrupted by a restart'
                : undefined
        if (marker !== undefined) appended.push({ kind: userCancelled || reason.kind === 'max-tokens' ? 'turn-marker' : 'error', text: marker })
      }
      // Deliverables ride the turn tail (the web's turnTail chips): the
      // turn's mutated files flush as one bounded row, then the set resets.
      const files = view.anchors.turnFiles.get(event.data.turn)
      view.anchors.turnFiles.delete(event.data.turn)
      if (files !== undefined && files.size > 0) appended.push({ kind: 'files', paths: [...files].slice(0, 12) })
      // Derivable boundary sweep: the turn is over, so any step/tool anchors
      // it left behind (interruptions that never produced their message or
      // result) can never be resolved and are reclaimed now.
      const stepKey = view.anchors.turnSteps.get(event.data.turn)
      if (stepKey !== undefined) {
        view.anchors.stepStart.delete(stepKey)
        view.anchors.firstChunkAt.delete(stepKey)
        view.anchors.turnSteps.delete(event.data.turn)
      }
      const turnToolSet = view.anchors.turnTools.get(event.data.turn)
      if (turnToolSet !== undefined) {
        for (const callId of turnToolSet) view.anchors.toolStart.delete(callId)
        view.anchors.turnTools.delete(event.data.turn)
      }
      // Orphaned retry/command rows can never be resolved after the turn
      // ends: an aborted retry backoff returns upstream without its
      // `llm/retry-started`, and crash repair synthesizes only tool/step/
      // turn closers. Left `running` they pin the settled boundary forever,
      // so the turn end finalizes them exactly like the anchor sweep above.
      let orphans = false
      const swept = view.entries.map((entry) => {
        if (entry.kind === 'retry' && entry.state === 'running') {
          orphans = true
          return { ...entry, state: 'done' as const }
        }
        if (entry.kind === 'command' && entry.state === 'running') {
          orphans = true
          return { ...entry, state: 'error' as const, summary: 'interrupted before the turn ended' }
        }
        return entry
      })
      const entries = orphans ? swept : view.entries
      if (appended.length === 0) {
        return { ...view, busy: false, busySince: 0, dscodeCompactingSince: 0, streaming: '', streamingReasoning: '', entries: dscodeCloseTurn(entries) }
      }
      return {
        ...view,
        busy: false,
        busySince: 0,
        dscodeCompactingSince: 0,
        streaming: '',
        streamingReasoning: '',
        entries: dscodeCloseTurn([...entries, ...appended]),
      }
    }
    case 'llm/retry': {
      const data = event.data
      return {
        ...view,
        streaming: '',
        streamingReasoning: '',
        entries: [...view.entries, {
          kind: 'retry',
          retryId: data.retryId,
          mode: data.mode,
          attempt: data.retry,
          max: 'maxRetries' in data ? data.maxRetries : data.retry,
          code: data.failure.code,
          delayMs: data.delayMs,
          state: 'running',
        }],
      }
    }
    case 'llm/retry-started': {
      const data = event.data
      const entries = view.entries.map((entry) => {
        if (entry.kind !== 'retry' || entry.retryId !== data.retryId) return entry
        return { ...entry, state: 'done' as const }
      })
      return { ...view, entries }
    }
    case 'sandbox/mode':
      // Log-only override switch; last write wins for the status badge.
      return { ...view, sandbox: event.data.mode }
    case 'goal/change': {
      const data = event.data
      const clip = (text: string): string => (text.length > 60 ? `${text.slice(0, 59)}…` : text)
      if (data.operation === 'clear') {
        return {
          ...view,
          goal: undefined,
          entries: [...view.entries, { kind: 'turn-marker', text: '◎ goal cleared' }],
        }
      }
      const goal: GoalFold = {
        objective: data.goal.objective,
        phase: data.goal.phase,
        rounds: data.roundsStarted,
        max: data.goal.maxGoalRounds,
        blocked: data.goal.blockedReason?.message ?? '',
      }
      const line = data.operation === 'create'
        ? `◎ goal: ${clip(data.goal.objective)}`
        : data.operation === 'complete'
          ? '◎ goal complete'
          : data.operation === 'pause'
            ? '◎ goal paused'
            : data.operation === 'resume'
              ? '◎ goal resumed'
              : data.operation === 'block'
                ? `◎ goal blocked: ${clip(goal.blocked)}`
                : undefined
      return {
        ...view,
        goal,
        entries: line === undefined ? view.entries : [...view.entries, { kind: 'turn-marker', text: line }],
      }
    }
    case 'schedule/change':
      // Non-conversational catalog state: the /schedule panel renders the
      // active list, the transcript shows only the reminder prompts
      // (handled at user/message above).
      return { ...view, schedules: applyScheduleChange(view.schedules, event.data) }
    case 'session/title':
      // Latest-wins title snapshot, log-only; the status line prefers it.
      return { ...view, title: event.data.title }
    case 'compaction/summary':
      // Remember the shadow price so the matching `compaction/end` row can
      // state what the compaction reclaimed. The map is capped so an aborted
      // compaction (summary without end) cannot leave an unbounded residue.
      if (view.anchors.compactionTokens.size >= MAX_COMPACTION_SUMMARY_RESIDUE) {
        const oldest = view.anchors.compactionTokens.keys().next().value
        if (oldest !== undefined) view.anchors.compactionTokens.delete(oldest)
      }
      view.anchors.compactionTokens.set(event.data.compactionId, event.data.shadowedTokenCount)
      return view
    case 'compaction/start':
      return { ...view, dscodeCompactingSince: event.time }
    case 'compaction/prune':
      // A model-free prune carries no compaction id; its price serves the next
      // `compaction/end` that cannot find a summary price.
      return { ...view, anchors: { ...view.anchors, lastPruneTokens: event.data.shadowedTokenCount } }
    case 'compaction/end': {
      const ok = event.data.error === undefined
      const tokens = view.anchors.compactionTokens.get(event.data.compactionId) ?? view.anchors.lastPruneTokens
      view.anchors.compactionTokens.delete(event.data.compactionId)
      return {
        ...view,
        dscodeCompactingSince: 0,
        entries: [...view.entries, { kind: 'compaction', ok, tokens, error: event.data.error ?? '' }],
      }
    }
    case 'request/context':
      // Route capacity, logged only when it changes; last one wins.
      return {
        ...view,
        stats: { ...view.stats, contextWindow: event.data.contextWindow ?? view.stats.contextWindow },
      }
    case 'request/header': {
      // The session's own model record: the latest snapshot's provider/model
      // pair, exactly what a resumed TUI restores as the selection, plus the
      // effective reasoning effort that snapshot carried (the adapter may
      // materialize the model default, which is what the status line shows).
      // The system-prompt estimate lives with `system/message` events since
      // session-log v3 removed the header's `system` field.
      const config = event.data.header.config
      return {
        ...view,
        model: `${config.provider}/${config.model}`,
        stats: {
          ...view.stats,
          reasoningEffort: config.reasoningEffort === undefined ? '' : String(config.reasoningEffort),
        },
      }
    }
    case 'plan/mode':
      // Whole-value replace; the last one wins (upstream fold semantics).
      return { ...view, plan: event.data.active }
    case 'permission/preset':
      return { ...view, permission: event.data.preset }
    case 'command/run': {
      const data = event.data
      return {
        ...view,
        entries: [...view.entries, {
          kind: 'command',
          commandId: data.commandId,
          name: data.name,
          args: data.args ?? '',
          state: 'running',
          summary: '',
        }],
      }
    }
    case 'command/done': {
      const data = event.data
      const entries = view.entries.map((entry) => {
        if (entry.kind !== 'command' || entry.commandId !== data.commandId) return entry
        return {
          ...entry,
          state: data.kind === 'success' ? 'done' as const : 'error' as const,
          summary: boundContextSummary(data.text ?? ''),
        }
      })
      return { ...view, entries }
    }
    default: {
      // `tool/ptc-dispatch*` live in @deepseek-ai/dsh-tools' map merge,
      // which this bundle does not depend on; the string guards keep the
      // fold decoupled while following the upstream contract exactly (pair
      // by subCallId; every start settles; settle speaks tool/result's own
      // vocabulary). Log-only upstream: deriveMessages ignores them, so the
      // sub rows are pure display state on the parent run_code card.
      const type = event.type as string
      if (type === 'tool/ptc-dispatch-start') {
        const data = event.data as PtcDispatchStartData
        view.anchors.subStart.set(data.subCallId, event.time)
        const entries = view.entries.map(entry => entry.kind !== 'tool' || entry.callId !== data.rootCallId
          ? entry
          : pushSubDispatch(entry, {
            subCallId: data.subCallId,
            name: data.name,
            preview: toolArgumentsPreview(subDispatchArguments(data.arguments), data.name),
            state: 'running',
            summary: '',
            durationMs: 0,
          }))
        return { ...view, entries }
      }
      if (type === 'tool/ptc-dispatch') {
        const data = event.data as PtcDispatchData
        const started = view.anchors.subStart.get(data.subCallId)
        view.anchors.subStart.delete(data.subCallId)
        const summary = boundContextSummary(textOf(data.content))
        const durationMs = started === undefined ? 0 : Math.max(0, event.time - started)
        const entries = view.entries.map(entry => entry.kind !== 'tool' || entry.callId !== data.rootCallId
          ? entry
          : settleSubDispatch(entry, data, summary, durationMs))
        return { ...view, entries }
      }
      // The durable workflow record (`tool-workflow/*`, appended by the
      // workflow/ralph tools): one bounded card per run, members paired by
      // their sequence number, the run settling on run-end.
      if (type === 'tool-workflow/run-start') {
        const data = event.data as WorkflowRunStartData
        return {
          ...view,
          entries: [...view.entries, {
            kind: 'workflow',
            runId: data.runId,
            name: data.name,
            members: [],
            membersDropped: 0,
            state: 'running',
          }],
        }
      }
      if (type === 'tool-workflow/agent-start') {
        const data = event.data as WorkflowAgentStartData
        const entries = view.entries.map(entry => entry.kind !== 'workflow' || entry.runId !== data.runId
          ? entry
          : pushWorkflowMember(entry, {
            seq: data.seq,
            label: data.label,
            phase: data.phase ?? '',
            childId: data.childId,
            outcome: 'running',
          }))
        return { ...view, entries }
      }
      if (type === 'tool-workflow/agent-end') {
        const data = event.data as WorkflowAgentEndData
        const entries = view.entries.map(entry => entry.kind !== 'workflow' || entry.runId !== data.runId
          ? entry
          : settleWorkflowMember(entry, data))
        return { ...view, entries }
      }
      if (type === 'tool-workflow/run-end') {
        const data = event.data as WorkflowRunEndData
        const entries = view.entries.map(entry => entry.kind !== 'workflow' || entry.runId !== data.runId
          ? entry
          : { ...entry, state: data.stopReason })
        return { ...view, entries }
      }
      return view
    }
  }
}

/**
 * Mutable replay accumulator: folds a persisted log into the identical view
 * `projectEvent` would produce, but in near-linear time. Where `projectEvent`
 * is copy-on-write — every append/scan rebuilds the whole `entries` array, so
 * folding a full log costs O(N²) — the accumulator appends by push, resolves
 * id-keyed updates (tool/result, command/done, retry-started) through index
 * maps, and tombstones retired pending rows, so the whole log folds in O(N)
 * plus one compaction pass when tombstones exist.
 *
 * Index maps never delete: every appended row registers its index, so an id
 * lookup miss provably means no matching row exists and the update is an O(1)
 * no-op (a malicious/orphan-heavy log cannot force per-orphan full-array
 * scans). Each id maps to ALL of its indices, so a duplicate id updates every
 * matching row exactly like the copy-on-write reducer.
 *
 * @internal Exported only so tests can (a) prove replay ≡ sequential
 * `projectEvent` folds and (b) assert the linear complexity deterministically
 * via {@link ReplayAccumulator.ops}, which counts entry-level container work
 * instead of relying on wall-clock thresholds. No public consumer.
 */
export interface ReplayAccumulator {
  /** Working entry list; `undefined` marks a retired pending row (tombstone). */
  entries: (TranscriptEntry | undefined)[]
  /** callId → every index into `entries` holding a `tool` row with that id. */
  toolIndex: Map<string, number[]>
  /** commandId → every index into `entries` holding a `command` row with that id. */
  commandIndex: Map<string, number[]>
  /** retryId → every index into `entries` holding a `retry` row with that id. */
  retryIndex: Map<string, number[]>
  /** messageId → every index into `entries` holding a `pending` row with that id. */
  pendingIndex: Map<string, number[]>
  /** runId → every index into `entries` holding a `workflow` row with that id. */
  workflowIndex: Map<string, number[]>
  /** Tombstone count; zero means `entries` is already the final array. */
  removedCount: number
  /** Mutable inbox id lists, mirroring `view.pending` order per target. */
  pendingTurn: string[]
  pendingStep: string[]
  /** Mutable mirror of `view.claimOrigin` (see the reducer's field doc). */
  claimOrigin: Map<string, 'next-turn' | 'next-step'>
  streaming: string
  streamingReasoning: string
  todos: readonly TodoItem[]
  /** Global tool-call ordinal counter (see `TranscriptView.toolCallOrdinal`). */
  toolCallOrdinal: number
  busy: boolean
  busySince: number
  dscodeCompactingSince: number
  model: string
  plan: boolean
  permission: string
  title: string
  systemPrompt: string
  sandbox: string
  goal: GoalFold | undefined
  schedules: readonly ScheduleRow[]
  stats: TranscriptStats
  stepStart: Map<string, number>
  toolStart: Map<string, number>
  /** Open PTC sub-dispatch starts by `subCallId` (duration anchors). */
  subStart: Map<string, number>
  firstChunkAt: Map<string, number>
  compactionTokens: Map<string, number>
  lastPruneTokens: number
  turnFiles: Map<number, Set<string>>
  turnSteps: Map<number, string>
  turnTools: Map<number, Set<string>>
  /** Live `system/message` surface nodes by event seq (empty string = an empty node). */
  systemNodes: Map<number, string>
  /** Entry-level container operations performed so far (test instrumentation). */
  ops: number
}

/** @internal A fresh replay accumulator whose state mirrors `createTranscriptView()`. */
export function createReplayAccumulator(): ReplayAccumulator {
  return {
    entries: [],
    toolIndex: new Map(),
    commandIndex: new Map(),
    retryIndex: new Map(),
    pendingIndex: new Map(),
    workflowIndex: new Map(),
    removedCount: 0,
    pendingTurn: [],
    pendingStep: [],
    claimOrigin: new Map(),
    streaming: '',
    streamingReasoning: '',
    todos: [],
    toolCallOrdinal: 0,
    busy: false,
    busySince: 0,
    dscodeCompactingSince: 0,
    model: '',
    plan: false,
    permission: '',
    title: '',
    systemPrompt: '',
    sandbox: '',
    goal: undefined,
    schedules: [],
    stats: { turns: 0, steps: 0, llmMs: 0, toolMs: 0, usage: { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, lastPromptTokens: 0, contextWindow: 0, contextSegments: { system: 0, prompt: 0, assistant: 0, thinking: 0, tools: 0 }, ttftMs: 0, ttftSteps: 0, decodeMs: 0, decodeTokens: 0, reasoningEffort: '' },
    stepStart: new Map(),
    toolStart: new Map(),
    subStart: new Map(),
    firstChunkAt: new Map(),
    compactionTokens: new Map(),
    lastPruneTokens: 0,
    turnFiles: new Map(),
    turnSteps: new Map(),
    turnTools: new Map(),
    systemNodes: new Map(),
    ops: 0,
  }
}

/** Append one entry (O(1)) and account the push. */
function appendReplayEntry(acc: ReplayAccumulator, entry: TranscriptEntry): void {
  acc.entries.push(entry)
  acc.ops += 1
}

/**
 * Get (or create) the index list an id owns. Lists are never removed: every
 * appended row registers its index, so a lookup miss later proves no matching
 * row exists and the caller can no-op in O(1).
 */
function indexList(map: Map<string, number[]>, id: string): number[] {
  let list = map.get(id)
  if (list === undefined) {
    list = []
    map.set(id, list)
  }
  return list
}

/**
 * Finalize replay rows the ended turn left `running`, mirroring the reducer's
 * turn-end orphan sweep: an orphaned retry settles `done`, an orphaned command
 * settles `error` with an interruption note. Only the id-indexed rows are
 * visited, so the sweep stays O(retries+commands of the log), never a scan.
 */
function finalizeReplayOrphans(acc: ReplayAccumulator): void {
  for (const list of acc.retryIndex.values()) {
    for (const index of list) {
      const entry = acc.entries[index]
      if (entry !== undefined && entry.kind === 'retry' && entry.state === 'running') {
        acc.entries[index] = { ...entry, state: 'done' }
      }
    }
  }
  for (const list of acc.commandIndex.values()) {
    for (const index of list) {
      const entry = acc.entries[index]
      if (entry !== undefined && entry.kind === 'command' && entry.state === 'running') {
        acc.entries[index] = { ...entry, state: 'error', summary: 'interrupted before the turn ended' }
      }
    }
  }
}

/**
 * Apply an id-keyed update to every row that registered the id, mirroring the
 * copy-on-write reducer's full-array map semantics (all matching rows update,
 * in order). Each registered index is O(1), so a duplicate id costs
 * O(#duplicates) — never a full-array scan. The kind+id re-check is defensive:
 * registered indices are valid by construction, because tool/command/retry
 * rows are never removed and tombstones never shift indices.
 */
function updateReplayById<T extends TranscriptEntry>(
  acc: ReplayAccumulator,
  map: Map<string, number[]>,
  id: string,
  isMatch: (entry: T) => boolean,
  update: (entry: T) => T,
): void {
  const list = map.get(id)
  if (list === undefined) return // miss provably means no matching row
  for (const index of list) {
    const entry = acc.entries[index]
    if (entry === undefined || !isMatch(entry as T)) continue
    acc.entries[index] = update(entry as T)
    acc.ops += 1
  }
}

/** Tombstone a retired pending row, keeping every other index stable. */
function retireReplayEntry(acc: ReplayAccumulator, index: number): void {
  if (acc.entries[index] !== undefined) {
    acc.entries[index] = undefined
    acc.removedCount += 1
    acc.ops += 1
  }
}

/**
 * Fold one session event into a replay accumulator. This mirrors
 * {@link projectEvent} case for case — same stats arithmetic, same anchor
 * set/delete behavior, same entry shapes — so the finished view is identical
 * to a sequential fold; only the `entries` container operations are mutable.
 *
 * @internal Test-instrumentation path; `projectEvents` is the public entry.
 * @returns whether the event changed the accumulated state — the live store
 * stays silent and keeps its snapshot identity for ignored events, exactly
 * like the copy-on-write reducer returning its input view unchanged.
 */
export function replayProjectEvent(acc: ReplayAccumulator, event: SessionEvent): boolean {
  // Mirror of the reducer's entry shadow: any surface replace retires the
  // system nodes it covers before the per-event fold runs.
  const shadow = retireShadowedSystemNodes(acc.systemNodes, event.surfaceOp)
  if (shadow.changed) {
    acc.systemPrompt = shadow.prompt
    acc.stats = { ...acc.stats, contextSegments: { ...acc.stats.contextSegments, system: estimateTokens(shadow.prompt) } }
  }
  switch (event.type) {
    case 'user/message': {
      const message = event.data
      for (const target of ['next-turn', 'next-step'] as const) {
        const ids = target === 'next-turn' ? acc.pendingTurn : acc.pendingStep
        const index = ids.indexOf(message.id)
        acc.ops += index < 0 ? ids.length : index + 1
        if (index < 0) continue
        ids.splice(index, 1)
        acc.ops += 1
        // Retire every pending row carrying this message id (duplicate ids
        // included), exactly like the reducer's full-array filter.
        const list = acc.pendingIndex.get(message.id)
        if (list !== undefined) {
          for (const entryIndex of list) retireReplayEntry(acc, entryIndex)
          acc.ops += 1
        }
      }
      const text = textOf(message.content)
      const images = imagesOf(message.content)
      const files = filesOf(message.content)
      // Same delivery-origin rule as the reducer: the claim splice that
      // precedes this event never carried the origin, so `claimOrigin` is the
      // only surviving record of how the prompt was submitted.
      const origin = acc.claimOrigin.get(message.id)
      const delivery = origin === undefined ? {} : { delivery: origin === 'next-turn' ? 'queued' as const : 'steered' as const }
      acc.claimOrigin.delete(message.id)
      if (message.source.kind === 'user' || (message.source.kind === 'plugin' && REMINDER_PLUGINS.has(message.source.plugin))) {
        appendReplayEntry(acc, { kind: 'user', text, notice: false, ...delivery, ...(images.length === 0 ? {} : { images }), ...(files.length === 0 ? {} : { files }) })
        acc.stats = {
          ...acc.stats,
          contextSegments: {
            ...acc.stats.contextSegments,
            prompt: acc.stats.contextSegments.prompt + estimateTokens(text),
          },
        }
        return true
      }
      if (message.source.kind === 'plugin' && HIDDEN_SNAPSHOT_PLUGINS.has(message.source.plugin)) {
        acc.stats = {
          ...acc.stats,
          contextSegments: {
            ...acc.stats.contextSegments,
            system: acc.stats.contextSegments.system + estimateTokens(text),
          },
        }
        return true
      }
      const notice = message.source.kind === 'plugin' && message.source.form === 'notice'
        ? message.source.summary
        : message.source.kind === 'plugin'
          ? message.source.plugin
          : message.source.kind
      const summary = boundContextSummary(notice)
      appendReplayEntry(acc, { kind: 'user', text: summary, notice: true })
      acc.stats = {
        ...acc.stats,
        contextSegments: {
          ...acc.stats.contextSegments,
          system: acc.stats.contextSegments.system + estimateTokens(summary),
        },
      }
      return true
    }
    case 'agent/inbox/spliced': {
      const { target, start, removedCount = 0, inserted, outcome } = event.data
      const ids = target === 'next-turn' ? acc.pendingTurn : acc.pendingStep
      const removed = ids.slice(start, start + removedCount)
      acc.ops += removed.length
      ids.splice(start, removedCount)
      acc.ops += removed.length
      // A claim keeps the origin for the user message still to come; a real
      // cancellation retires it with the row.
      if (outcome === 'canceled') for (const id of removed) acc.claimOrigin.delete(id)
      for (const id of removed) {
        const list = acc.pendingIndex.get(id)
        if (list === undefined) continue
        for (const entryIndex of list) {
          const entry = acc.entries[entryIndex]
          if (entry !== undefined && entry.kind === 'pending' && entry.target === target) {
            retireReplayEntry(acc, entryIndex)
          }
        }
      }
      // Mirror the reducer's in-place order: inserted ids join at the splice
      // position (upstream `splice(start, removedCount, ...inserted)`), never
      // at the tail — the id list must stay coordinate-compatible with every
      // later inbox event.
      ids.splice(start, 0, ...inserted.map(message => message.id))
      for (const message of inserted) {
        // Same rule as the reducer: only a submission that arrived while a
        // turn was running is "queued"/"steered" rather than ordinary.
        if (acc.busy) acc.claimOrigin.set(message.id, target)
        const images = imagesOf(message.content)
        const files = filesOf(message.content)
        appendReplayEntry(acc, { kind: 'pending', messageId: message.id, target, text: pendingText(message.content), ...(images.length === 0 ? {} : { images }), ...(files.length === 0 ? {} : { files }) })
        indexList(acc.pendingIndex, message.id).push(acc.entries.length - 1)
        acc.ops += 1
      }
      return true
    }
    case 'system/message': {
      // Mirrors the reducer's per-node fold: append adds, replace retires the
      // covered seq range, and the estimate prices the assembled prompt.
      const text = textOf(event.data.message.content)
      retireShadowedSystemNodes(acc.systemNodes, event.surfaceOp)
      acc.systemNodes.set(event.seq, text)
      acc.systemPrompt = assembleSystemPrompt(acc.systemNodes)
      acc.stats = {
        ...acc.stats,
        contextSegments: {
          ...acc.stats.contextSegments,
          system: estimateTokens(acc.systemPrompt),
        },
      }
      return true
    }
    case 'assistant/attempt': {
      // Mirrors the reducer: the step stays open across in-step retries; a
      // missing first-token anchor is restored (and accrued) from the
      // attempt's embedded stream, and only the live tails are dropped.
      const key = `${event.data.turn}:${event.data.step}`
      let changed = false
      if (!acc.firstChunkAt.has(key)) {
        const first = assistantStreamFirstTokenTime(event.data.stream ?? [])
        if (first !== undefined) {
          acc.firstChunkAt.set(key, first)
          const started = acc.stepStart.get(key)
          if (started !== undefined) {
            acc.stats = {
              ...acc.stats,
              ttftMs: acc.stats.ttftMs + Math.max(0, first - started),
              ttftSteps: acc.stats.ttftSteps + 1,
            }
          }
          changed = true
        }
      }
      const streamed = acc.streaming !== '' || acc.streamingReasoning !== ''
      acc.streaming = ''
      acc.streamingReasoning = ''
      return changed || streamed
    }
    case 'assistant/message': {
      const key = `${event.data.turn}:${event.data.step}`
      const started = acc.stepStart.get(key)
      acc.stepStart.delete(key)
      let firstChunk = acc.firstChunkAt.get(key)
      if (firstChunk === undefined) {
        // A replayed settlement has no live frames; the embedded stream's
        // first-token time restores both the anchor and the TTFT figures the
        // live path accumulates in applyAssistantStreamChunk.
        firstChunk = assistantStreamFirstTokenTime(event.data.stream ?? [])
        if (firstChunk !== undefined && started !== undefined) {
          acc.stats = {
            ...acc.stats,
            ttftMs: acc.stats.ttftMs + Math.max(0, firstChunk - started),
            ttftSteps: acc.stats.ttftSteps + 1,
          }
        }
      }
      acc.firstChunkAt.delete(key)
      if (acc.turnSteps.get(event.data.turn) === key) acc.turnSteps.delete(event.data.turn)
      const usage = event.data.usage
      const totals = acc.stats.usage
      const text = textOf(event.data.message.content)
      const reasoning = reasoningOf(event.data.message.content)
      acc.streaming = ''
      acc.streamingReasoning = ''
      // Same zero-line guard as the live fold: tool-only settlements carry
      // timing/usage but no renderable transcript entry.
      if (text !== '' || reasoning !== '' || event.data.interrupted === true) {
        appendReplayEntry(acc, { kind: 'assistant', text, reasoning, time: event.time, interrupted: event.data.interrupted === true ? true : undefined })
      }
      acc.stats = {
        ...acc.stats,
        llmMs: acc.stats.llmMs + (started === undefined ? 0 : Math.max(0, event.time - started)),
        usage: usage === undefined ? totals : {
          uncachedInputTokens: totals.uncachedInputTokens + usage.inputTokens,
          outputTokens: totals.outputTokens + usage.outputTokens,
          cacheReadTokens: totals.cacheReadTokens + (usage.cacheReadTokens ?? 0),
          cacheWriteTokens: totals.cacheWriteTokens + (usage.cacheWriteTokens ?? 0),
        },
        lastPromptTokens: usage === undefined ? acc.stats.lastPromptTokens
          : usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0),
        decodeMs: acc.stats.decodeMs + (firstChunk === undefined ? 0 : Math.max(0, event.time - firstChunk)),
        decodeTokens: acc.stats.decodeTokens + (firstChunk === undefined || usage === undefined ? 0 : usage.outputTokens),
        contextSegments: {
          ...acc.stats.contextSegments,
          thinking: acc.stats.contextSegments.thinking + estimateTokens(reasoning),
          assistant: acc.stats.contextSegments.assistant + estimateTokens(text),
        },
      }
      return true
    }
    case 'tool/call': {
      const data = event.data
      acc.toolStart.set(data.callId, event.time)
      const turnTools = acc.turnTools.get(data.turn) ?? new Set<string>()
      turnTools.add(data.callId)
      acc.turnTools.set(data.turn, turnTools)
      acc.toolCallOrdinal += 1
      appendReplayEntry(acc, {
        kind: 'tool',
        time: event.time,
        callId: data.callId,
        ordinal: acc.toolCallOrdinal,
        name: data.name,
        arguments: data.arguments,
        preview: toolArgumentsPreview(data.arguments, data.name),
        prompt: toolPromptPreview(data.name, data.arguments),
        state: 'running',
        summary: '',
        detail: undefined,
        subs: [],
        subsDropped: 0,
      })
      indexList(acc.toolIndex, data.callId).push(acc.entries.length - 1)
      acc.stats = {
        ...acc.stats,
        contextSegments: {
          ...acc.stats.contextSegments,
          tools: acc.stats.contextSegments.tools
            + (typeof data.arguments === 'string' ? estimateTokens(data.arguments) : 0),
        },
      }
      return true
    }
    case 'tool/result': {
      const block = event.data.message.content[0]
      const started = acc.toolStart.get(block.toolCallId)
      acc.toolStart.delete(block.toolCallId)
      const turnTools = acc.turnTools.get(event.data.turn)
      if (turnTools !== undefined) {
        turnTools.delete(block.toolCallId)
        if (turnTools.size === 0) acc.turnTools.delete(event.data.turn)
      }
      const rawText = textOf(block.content)
      const summary = boundContextSummary(rawText)
      const detail = toolResultDetail(event.data.meta, rawText)
      if (detail?.kind === 'diff') {
        const set = acc.turnFiles.get(event.data.turn) ?? new Set<string>()
        for (const diff of detail.diffs) set.add(diff.path)
        acc.turnFiles.set(event.data.turn, set)
      }
      const update = (entry: ToolEntry): ToolEntry => ({
        ...entry,
        state: block.isError === true ? 'error' as const : 'done' as const,
        summary,
        detail,
      })
      // Every matching row updates (duplicate callIds included); an id with no
      // registered index is a provable no-op — no full-array fallback scan.
      updateReplayById<ToolEntry>(acc, acc.toolIndex, block.toolCallId, entry => entry.callId === block.toolCallId, update)
      acc.stats = {
        ...acc.stats,
        toolMs: acc.stats.toolMs + (started === undefined ? 0 : Math.max(0, event.time - started)),
        contextSegments: {
          ...acc.stats.contextSegments,
          tools: acc.stats.contextSegments.tools + estimateTokens(rawText),
        },
      }
      return true
    }
    case 'todo/write':
      acc.todos = event.data.todos
      return true
    case 'turn/start': {
      const wasBusy = acc.busy
      acc.busy = true
      acc.busySince = wasBusy ? acc.busySince : event.time
      acc.dscodeCompactingSince = 0
      acc.todos = []
      acc.stats = { ...acc.stats, turns: acc.stats.turns + 1 }
      return true
    }
    case 'step/start': {
      const key = `${event.data.turn}:${event.data.step}`
      const previous = acc.turnSteps.get(event.data.turn)
      if (previous !== undefined && previous !== key) {
        acc.stepStart.delete(previous)
        acc.firstChunkAt.delete(previous)
      }
      acc.turnSteps.set(event.data.turn, key)
      acc.stepStart.set(key, event.time)
      acc.streaming = ''
      acc.streamingReasoning = ''
      acc.stats = { ...acc.stats, steps: acc.stats.steps + 1 }
      return true
    }
    case 'turn/end': {
      const reason = event.data.reason
      const appended: TranscriptEntry[] = []
      acc.streamingReasoning = ''
      acc.streaming = ''
      if (reason.kind === 'error') {
        const recovery = reason.error.code === 'MISSING_CREDENTIAL'
          ? ' · open /model to add an API key'
          : ''
        appended.push({ kind: 'error', text: `${reason.error.code}: ${reason.error.message}${recovery}` })
      } else {
        const userCancelled = reason.kind === 'aborted' && reason.reason.kind === 'user'
        const marker = reason.kind === 'aborted'
          ? userCancelled ? 'turn cancelled by the user' : `turn stopped (${reason.reason.kind})`
          : reason.kind === 'max-tokens'
            ? 'turn hit the output-token ceiling (max-tokens)'
            : reason.kind === 'blocked'
              ? 'turn ended blocked'
              : reason.kind === 'interrupted'
                ? 'turn was interrupted by a restart'
                : undefined
        if (marker !== undefined) appended.push({ kind: userCancelled || reason.kind === 'max-tokens' ? 'turn-marker' : 'error', text: marker })
      }
      const files = acc.turnFiles.get(event.data.turn)
      acc.turnFiles.delete(event.data.turn)
      if (files !== undefined && files.size > 0) appended.push({ kind: 'files', paths: [...files].slice(0, 12) })
      const stepKey = acc.turnSteps.get(event.data.turn)
      if (stepKey !== undefined) {
        acc.stepStart.delete(stepKey)
        acc.firstChunkAt.delete(stepKey)
        acc.turnSteps.delete(event.data.turn)
      }
      const turnToolSet = acc.turnTools.get(event.data.turn)
      if (turnToolSet !== undefined) {
        for (const callId of turnToolSet) acc.toolStart.delete(callId)
        acc.turnTools.delete(event.data.turn)
      }
      finalizeReplayOrphans(acc)
      acc.busy = false
      acc.busySince = 0
      acc.dscodeCompactingSince = 0
      for (const entry of appended) appendReplayEntry(acc, entry)
      return true
    }
    case 'llm/retry': {
      const data = event.data
      acc.streaming = ''
      acc.streamingReasoning = ''
      appendReplayEntry(acc, {
        kind: 'retry',
        retryId: data.retryId,
        mode: data.mode,
        attempt: data.retry,
        max: 'maxRetries' in data ? data.maxRetries : data.retry,
        code: data.failure.code,
        delayMs: data.delayMs,
        state: 'running',
      })
      indexList(acc.retryIndex, data.retryId).push(acc.entries.length - 1)
      return true
    }
    case 'llm/retry-started': {
      const data = event.data
      updateReplayById<RetryEntry>(acc, acc.retryIndex, data.retryId, entry => entry.retryId === data.retryId, entry => ({ ...entry, state: 'done' as const }))
      return true
    }
    case 'sandbox/mode':
      acc.sandbox = event.data.mode
      return true
    case 'goal/change': {
      const data = event.data
      const clip = (text: string): string => (text.length > 60 ? `${text.slice(0, 59)}…` : text)
      if (data.operation === 'clear') {
        acc.goal = undefined
        appendReplayEntry(acc, { kind: 'turn-marker', text: '◎ goal cleared' })
        return true
      }
      const goal: GoalFold = {
        objective: data.goal.objective,
        phase: data.goal.phase,
        rounds: data.roundsStarted,
        max: data.goal.maxGoalRounds,
        blocked: data.goal.blockedReason?.message ?? '',
      }
      const line = data.operation === 'create'
        ? `◎ goal: ${clip(data.goal.objective)}`
        : data.operation === 'complete'
          ? '◎ goal complete'
          : data.operation === 'pause'
            ? '◎ goal paused'
            : data.operation === 'resume'
              ? '◎ goal resumed'
              : data.operation === 'block'
                ? `◎ goal blocked: ${clip(goal.blocked)}`
                : undefined
      acc.goal = goal
      if (line !== undefined) appendReplayEntry(acc, { kind: 'turn-marker', text: line })
      return true
    }
    case 'schedule/change':
      acc.schedules = applyScheduleChange(acc.schedules, event.data)
      acc.ops += 1
      return true
    case 'session/title':
      acc.title = event.data.title
      return true
    case 'compaction/summary':
      if (acc.compactionTokens.size >= MAX_COMPACTION_SUMMARY_RESIDUE) {
        const oldest = acc.compactionTokens.keys().next().value
        if (oldest !== undefined) acc.compactionTokens.delete(oldest)
      }
      acc.compactionTokens.set(event.data.compactionId, event.data.shadowedTokenCount)
      return true
    case 'compaction/start':
      acc.dscodeCompactingSince = event.time
      return true
    case 'compaction/prune':
      acc.lastPruneTokens = event.data.shadowedTokenCount
      return true
    case 'compaction/end': {
      const ok = event.data.error === undefined
      const tokens = acc.compactionTokens.get(event.data.compactionId) ?? acc.lastPruneTokens
      acc.compactionTokens.delete(event.data.compactionId)
      acc.dscodeCompactingSince = 0
      appendReplayEntry(acc, { kind: 'compaction', ok, tokens, error: event.data.error ?? '' })
      return true
    }
    case 'request/context':
      acc.stats = { ...acc.stats, contextWindow: event.data.contextWindow ?? acc.stats.contextWindow }
      return true
    case 'request/header': {
      const config = event.data.header.config
      acc.model = `${config.provider}/${config.model}`
      acc.stats = {
        ...acc.stats,
        reasoningEffort: config.reasoningEffort === undefined ? '' : String(config.reasoningEffort),
      }
      return true
    }
    case 'plan/mode':
      acc.plan = event.data.active
      return true
    case 'permission/preset':
      acc.permission = event.data.preset
      return true
    case 'command/run': {
      const data = event.data
      appendReplayEntry(acc, {
        kind: 'command',
        commandId: data.commandId,
        name: data.name,
        args: data.args ?? '',
        state: 'running',
        summary: '',
      })
      indexList(acc.commandIndex, data.commandId).push(acc.entries.length - 1)
      return true
    }
    case 'command/done': {
      const data = event.data
      const update = (candidate: CommandEntry): CommandEntry => ({
        ...candidate,
        state: data.kind === 'success' ? 'done' as const : 'error' as const,
        summary: boundContextSummary(data.text ?? ''),
      })
      updateReplayById<CommandEntry>(acc, acc.commandIndex, data.commandId, entry => entry.commandId === data.commandId, update)
      return true
    }
    default: {
      // PTC sub-dispatch pair, string-guarded like the live fold above; the
      // parent run_code row is addressed through the same call-id index the
      // tool/result case uses.
      const type = event.type as string
      if (type === 'tool/ptc-dispatch-start') {
        const data = event.data as PtcDispatchStartData
        acc.subStart.set(data.subCallId, event.time)
        updateReplayById<ToolEntry>(acc, acc.toolIndex, data.rootCallId, entry => entry.callId === data.rootCallId, entry =>
          pushSubDispatch(entry, {
            subCallId: data.subCallId,
            name: data.name,
            preview: toolArgumentsPreview(subDispatchArguments(data.arguments), data.name),
            state: 'running',
            summary: '',
            durationMs: 0,
          }))
        return true
      }
      if (type === 'tool/ptc-dispatch') {
        const data = event.data as PtcDispatchData
        const started = acc.subStart.get(data.subCallId)
        acc.subStart.delete(data.subCallId)
        const summary = boundContextSummary(textOf(data.content))
        const durationMs = started === undefined ? 0 : Math.max(0, event.time - started)
        updateReplayById<ToolEntry>(acc, acc.toolIndex, data.rootCallId, entry => entry.callId === data.rootCallId, entry =>
          settleSubDispatch(entry, data, summary, durationMs))
        return true
      }
      // Durable workflow record, string-guarded like the live fold above.
      if (type === 'tool-workflow/run-start') {
        const data = event.data as WorkflowRunStartData
        appendReplayEntry(acc, {
          kind: 'workflow',
          runId: data.runId,
          name: data.name,
          members: [],
          membersDropped: 0,
          state: 'running',
        })
        indexList(acc.workflowIndex, data.runId).push(acc.entries.length - 1)
        return true
      }
      if (type === 'tool-workflow/agent-start') {
        const data = event.data as WorkflowAgentStartData
        updateReplayById<WorkflowEntry>(acc, acc.workflowIndex, data.runId, entry => entry.runId === data.runId, entry =>
          pushWorkflowMember(entry, {
            seq: data.seq,
            label: data.label,
            phase: data.phase ?? '',
            childId: data.childId,
            outcome: 'running',
          }))
        return true
      }
      if (type === 'tool-workflow/agent-end') {
        const data = event.data as WorkflowAgentEndData
        updateReplayById<WorkflowEntry>(acc, acc.workflowIndex, data.runId, entry => entry.runId === data.runId, entry =>
          settleWorkflowMember(entry, data))
        return true
      }
      if (type === 'tool-workflow/run-end') {
        const data = event.data as WorkflowRunEndData
        updateReplayById<WorkflowEntry>(acc, acc.workflowIndex, data.runId, entry => entry.runId === data.runId, entry =>
          ({ ...entry, state: data.stopReason }))
        return true
      }
      return false
    }
  }
}

/**
 * Materialize the accumulated fold as a `TranscriptView`, compacting any
 * retired tombstones. The anchors maps are handed through as-is (their
 * content is identical to a sequential fold's).
 *
 * @internal Test-instrumentation path; `projectEvents` is the public entry.
 */
export function finishReplay(acc: ReplayAccumulator): TranscriptView {
  return materializeReplayView(acc, false)
}

/**
 * Materialize the accumulated fold as a fresh immutable snapshot for the
 * live store. Unlike {@link finishReplay} — the one-shot replay entry, which
 * hands the accumulator's own arrays through because the accumulator is
 * discarded — every array a renderer can hold is copied here, so later
 * folds never mutate a snapshot already handed out. Same fields, same
 * tombstone compaction.
 *
 * @internal Live-store path; `projectEvents` is the public entry.
 */
export function snapshotReplayView(acc: ReplayAccumulator): TranscriptView {
  return materializeReplayView(acc, true)
}

/** Field-for-field materialization; `copy` selects snapshot array isolation. */
function materializeReplayView(acc: ReplayAccumulator, copy: boolean): TranscriptView {
  const entries: readonly TranscriptEntry[] = acc.removedCount === 0
    ? (copy ? [...acc.entries] : acc.entries) as TranscriptEntry[]
    : acc.entries.filter((entry): entry is TranscriptEntry => entry !== undefined)
  if (acc.removedCount > 0) acc.ops += acc.entries.length
  return {
    entries,
    streaming: acc.streaming,
    streamingReasoning: acc.streamingReasoning,
    todos: acc.todos,
    toolCallOrdinal: acc.toolCallOrdinal,
    busy: acc.busy,
    busySince: acc.busySince,
    dscodeCompactingSince: acc.dscodeCompactingSince,
    model: acc.model,
    plan: acc.plan,
    permission: acc.permission,
    title: acc.title,
    systemPrompt: acc.systemPrompt,
    sandbox: acc.sandbox,
    goal: acc.goal,
    schedules: acc.schedules,
    pending: { 'next-turn': [...acc.pendingTurn], 'next-step': [...acc.pendingStep] },
    claimOrigin: new Map(acc.claimOrigin),
    stats: acc.stats,
    // Handed-out views get their own anchors snapshot: the accumulator keeps
    // folding its live containers, and no consumer may observe that.
    anchors: {
      stepStart: new Map(acc.stepStart),
      toolStart: new Map(acc.toolStart),
      subStart: new Map(acc.subStart),
      firstChunkAt: new Map(acc.firstChunkAt),
      compactionTokens: new Map(acc.compactionTokens),
      lastPruneTokens: acc.lastPruneTokens,
      turnFiles: new Map([...acc.turnFiles].map(([turn, files]) => [turn, new Set(files)])),
      turnSteps: new Map(acc.turnSteps),
      turnTools: new Map([...acc.turnTools].map(([turn, tools]) => [turn, new Set(tools)])),
      systemNodes: new Map(acc.systemNodes),
    },
  }
}

/**
 * Fold a replayed event history into one view.
 *
 * Folding is near-linear in the log size: the mutable replay accumulator
 * appends in place and resolves id-keyed updates through index maps, so a
 * long persisted session replays without the O(N²) copy-on-write rebuilds a
 * naive sequential fold would incur. The result is identical to folding
 * {@link projectEvent} per event in order.
 * @param events - events in `seq` order.
 * @returns the folded view.
 */
export function projectEvents(events: readonly SessionEvent[]): TranscriptView {
  const acc = createReplayAccumulator()
  for (const event of events) replayProjectEvent(acc, event)
  return finishReplay(acc)
}

/**
 * Fold one process-local assistant-stream chunk frame (session-log v2+ keeps
 * durable logs settlement-only; live typing rides the `agent/assistant-stream`
 * agent event). Same first-token anchoring the durable `assistant/chunk` event
 * used to carry: the first non-empty delta anchors the TTFT and empty
 * keep-alive deltas do not count. The caller maps the frame's attempt to the
 * `turn:step` key (the start frame owns turn/step; chunk frames do not).
 * @param acc - the live replay accumulator.
 * @param key - the `turn:step` key the attempt's start frame declared.
 * @param time - the frame's safe-integer timestamp.
 * @param chunk - the model chunk the frame carries.
 * @returns whether the accumulator changed (the store stays silent otherwise).
 */
export function applyAssistantStreamChunk(acc: ReplayAccumulator, key: string, time: number, chunk: StreamChunk): boolean {
  // First-token latency uses the kernel's isTokenDelta rule (a non-empty
  // text, reasoning, or tool-call fragment counts; block/usage/finish chunks
  // do not), so live frames and replayed embedded streams time the same
  // token.
  if (isTokenDelta(chunk) && !acc.firstChunkAt.has(key)) {
    acc.firstChunkAt.set(key, time)
    const started = acc.stepStart.get(key)
    if (started !== undefined) {
      acc.stats = {
        ...acc.stats,
        ttftMs: acc.stats.ttftMs + Math.max(0, time - started),
        ttftSteps: acc.stats.ttftSteps + 1,
      }
    }
  }
  if (chunk.type === 'text-delta') {
    acc.streaming = appendStreamingTail(acc.streaming, chunk.text)
    return true
  }
  if (chunk.type === 'reasoning-delta') {
    acc.streamingReasoning = appendStreamingTail(acc.streamingReasoning, chunk.text)
    return true
  }
  return false
}

/**
 * Drop the live streaming tails without a settlement (an `agent/assistant-stream`
 * end frame with an `abandoned` outcome, or a session switch). The next start
 * frame rebuilds from scratch.
 * @param acc - the live replay accumulator.
 * @returns whether any tail text was discarded.
 */
export function clearAssistantStream(acc: ReplayAccumulator): boolean {
  const streamed = acc.streaming !== '' || acc.streamingReasoning !== ''
  acc.streaming = ''
  acc.streamingReasoning = ''
  return streamed
}

/**
 * The append-only flush boundary for a transcript view: the count of entries
 * no later event can remove. Entries at or beyond this index are mutable and
 * must stay in the live tree.
 *
 * `pending` rows are excluded even though they are not a running tool/retry:
 * the inbox claims or cancels them durably (`agent/inbox/spliced` removals,
 * `user/message` retirement), and an append-only `<Static>` flush cannot
 * erase a row that vanishes from the view — the retired row would ghost on
 * screen until the next source-backed replay. Running commands join the
 * mutable boundary for the same reason in reverse: `command/done` mutates the
 * row's state/summary, so a flushed row would keep its stale running mark
 * until a resize-triggered replay. Everything else (including a completed
 * tail) is final: later events only APPEND new rows.
 * @param entries - the view's transcript entries in order.
 * @returns the count of entries safe to flush (0 for an empty transcript).
 */
export function settledEntryCount(entries: readonly TranscriptEntry[]): number {
  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index]
    if (entry.kind === 'pending') return index
    if (entry.kind === 'tool' && entry.state === 'running') return index
    if (entry.kind === 'retry' && entry.state === 'running') return index
    if (entry.kind === 'command' && entry.state === 'running') return index
    if (entry.kind === 'workflow' && entry.state === 'running') return index
  }
  return entries.length
}

/**
 * dscode: mark the turn's final reply so the renderer can close the turn with its
 * own rule. The upstream transcript keeps no turn boundary of its own.
 */
function dscodeCloseTurn(entries: readonly TranscriptEntry[]): readonly TranscriptEntry[] {
  const last = entries[entries.length - 1]
  if (last === undefined || last.kind !== 'assistant' || last.turnEnded === true) return entries
  return [...entries.slice(0, -1), { ...last, turnEnded: true }]
}

/**
 * dscode: session-bridge relays are plugin messages that must render as visible
 * user turns (the bridge delivers a peer session's message), so the replay
 * branch admits them alongside direct human prompts.
 */
function dscodeVisibleRelay(message: { source: { kind: string; plugin?: string; form?: string } }): boolean {
  return message.source.kind === 'plugin' && message.source.plugin === 'dscode-session-bridge' && message.source.form === 'relay'
}
