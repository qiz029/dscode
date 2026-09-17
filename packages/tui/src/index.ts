/**
 * @deepseek-ai/dsh-code — the interactive terminal driver. The bundle patch
 * rides over dsh-base without Host, HTTP, or browser plugins; this runner
 * creates or resumes preset-composed Agents through the core registry, keeps
 * one Ink owner while the active session changes, folds submitted prompts
 * into the selected durable session, answers approval asks with a y/n bar,
 * dispatches slash commands, and on quit flushes and requests process exit.
 *
 * @module @deepseek-ai/dsh-code
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { appendFile as appendFileAsync, mkdir, readdir, rm, stat, writeFile as writeFileAsync } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { createElement } from 'react'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, AgentStatus, Inbox, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-attachment'
import { createUserMessage, MessageId, type ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JobSnapshot } from '@deepseek-ai/dsh-jobs'
import { SessionId, SessionLogOffset, type Session, type SessionEvent, type SessionHeader, type UserMessage } from '@deepseek-ai/dsh-session'
import { deriveTurnTokenUsage } from '@deepseek-ai/dsh-token-meter/client'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
// Type-only: carries the ctx.sessionTitle service merge for /title.
import type {} from '@deepseek-ai/dsh-session-title'
// Empty type imports carry the loader Context merge for the settlement await
// and the cmdline Context merge for the appExit host value.
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-cmdline'
import { App, type NoticeTone, type QueueMutation } from './app.ts'
import { mountApprovalAnswerer, type ApprovalStore } from './approval.ts'
import { isSlashLine, submissionPayload, watchCommands, type CommandsView } from './commands.ts'
import { internals, type TuiMount } from './internals.ts'
import { syncModelCapabilities } from './model-capabilities.ts'
import { ensureProviderRoute as dscodeEnsureProviderRoute, migrateOpenRouterProfile as dscodeMigrateOpenRouter } from '../../../plugins/providers/catalog.mjs'
import { compactionPreview as dscodeCompactionPreview, pricedThresholdRatio as dscodePricedThresholdRatio } from '../../../plugins/compaction/threshold.mjs'
import { dscodeLoadOpenRouterAccountFor, dscodeManagementKeyStatus, dscodeSaveManagementKey, type DscodeCompactionPreview } from './app.ts'
import { buildModelSelection, applyModelSelectionToConfig, loadModelDirectory, modelSelectionLabel, pendingModelSelection, resolveEffectiveSelection, type ModelRow } from './models.ts'
import {
  discoverProviderModels,
  loadProviderSettings,
  removeProviderSettings,
  saveProviderCredential,
  saveProviderConfiguration,
  subscribeProviderSettings,
  unsetProviderCredential,
} from './provider-settings.ts'
import { createMentions, type MentionsApi } from './mentions.ts'
import { mountQuestionProvider, type QuestionStore } from './questions.ts'
// Type-only import merges the settings Events declarations ('settings/updated',
// 'settings/document-updated') into this program's Cordis bus typing.
import type {} from '@deepseek-ai/dsh-settings'
import { createTranscriptStore, type TranscriptStore } from './store.ts'
import { createSubagentFeed, type SubagentFeedView } from './subagents.ts'
import { parseStatuslineItems } from './render/status.ts'
import { historyLine, HISTORY_MAX_ENTRIES, needsCompaction, parseHistoryFile, serializeHistoryList } from './history.ts'
import { watchSkills, type SkillsView } from './skills.ts'
import { toolArgumentsPreview } from './render/tool-preview.ts'
import { buildExportMarkdown } from './render/export.ts'
import { inspectFilePaths, inspectImagePaths, saveFilePaths, saveImagePaths } from './attachments.ts'
import { copyText, latestAssistantText } from './editor.ts'
import { applyCtrlRPassthrough, resolveEditorKeysStartupHint, type EditorKeysEnv } from './editor-keys.ts'
import {
  beginProviderAuthorization,
  cancelProviderAuthorization,
  loadProviderAuthorizations,
  logoutProviderAuthorization,
  openAuthorizationUrl,
  subscribeProviderAuthorizations,
} from './authorization.ts'
import { selectForkSeed } from './fork.ts'
import {
  buildReviewPrompt,
  listReviewBranches,
  listReviewCommits,
  loadCommitDiff,
  loadGitDiff,
  mergeBaseWith,
  type ReviewSelection,
} from './git-workflow.ts'
import type { TuiStartup } from './startup.ts'
import { SessionSwitchQueue } from './session-switch.ts'
import { agentPresetsFrom, normalizePresetId, resolvePreset, selectPreset } from './presets.ts'
import {
  applyPendingPermission,
  effectivePermission,
  listPermissionRows,
  permissionPresetsFrom,
  selectPermission,
} from './permissions.ts'
import { listPluginRows } from './plugin-inventory.ts'
import { applyLauncherUpdate, probeLauncherUpdate } from './update.ts'
import { parseAnimationsPref } from './render/animations.ts'
import { parseThemeName, setTheme, type ThemeName } from './theme.ts'
import { parseLanguageName, setLanguage, t, type LanguageName } from './i18n.ts'
import {
  isSubagentSession,
  matchSessionId,
  mergeSessionTitles,
  newestRootForCwd,
  isSessionArtifactName,
  jsonlSessionRoot,
  planSessionDeletion,
  projectSessionRows,
  sessionArtifactDirectory,
  sessionDirectoryFor,
  type SessionDirectoryOptions,
  type SessionQueryService,
  type SessionRow,
} from './session-directory.ts'
import type { JobRow, SearchRow } from './kernel-panels.ts'
import { createUserSettingsPersistence, writeFileAtomically } from './settings-file.ts'
import { turnUsages, type UsageView } from './render/usage.ts'
// Type-only import: merges the projection registry into the Context type so
// `ctx.get('sessionProjections')` is typed (the service itself is mounted by
// dsh-base at runtime).
import type {} from '@deepseek-ai/dsh-session-projection'

/** Stable Cordis plugin name. */
export const name = 'tui-runner'

/** Core services required before the interactive session can start. */
export const inject = ['agentDefaultModel', 'agents', 'sessions']

/** Plugin config: the startup resolved from this app's injected provider service. */
export interface Config {
  /** How this invocation obtains its session identity (validated loosely; narrowed in {@link apply}). */
  startup: { kind: string; sessionId?: string; mode?: string; theme?: string; prompt?: string; images?: string[] }
}

export const Config: z<Config> = z.object({
  startup: z.object({
    kind: z.string().required(),
    sessionId: z.string(),
    mode: z.string(),
    theme: z.string(),
    prompt: z.string(),
    images: z.array(z.string()),
  }),
})

/** Process-facing effects of the runner: the Ink mount plus the launcher's exit request. */
interface TuiIo {
  mount: typeof internals.mount
  exit: (code: number) => void
}

/** Report an unexpected direct-driver failure and request a failing exit. */
function fail(io: TuiIo, error: unknown): void {
  internals.stderr.write(`dsh: ${error instanceof Error ? error.message : String(error)}\n`)
  io.exit(1)
}

/**
 * Snapshot caller-visible background jobs for the /jobs panel. Jobs the agent
 * started through run_in_background are fenced by their owner, so the CURRENT
 * agent is the caller. A missing registry is a harmless absence (the base
 * composition may not mount one) and collapses to the empty panel state —
 * the documented degradation for harmless probes, not an error.
 * @param ctx - context carrying the optional `jobs` registry.
 * @param caller - the active agent (undefined sees only unowned jobs).
 * @returns job rows in registration order; never throws.
 */
function listJobs(ctx: Context, caller: Agent | undefined): readonly JobRow[] {
  const jobs = ctx.get('jobs')
  if (jobs === undefined) return []
  try {
    return jobs.list(caller).map((job: JobSnapshot) => ({
      id: job.id,
      kind: job.kind,
      label: job.label,
      status: job.status,
      detail: job.detail,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
    }))
  } catch {
    return []
  }
}

/**
 * Read one user-level settings file as a plain object. The callers all treat a
 * missing file as "unset" and a corrupt one as "warn and fall back", so this
 * helper owns the one distinction they share: readable JSON that is not an
 * object is corruption, not an absent preference, and must not surface as a
 * cryptic property access on `null`.
 * @param path - absolute path of the settings file.
 * @returns the parsed object; the caller narrows each field itself.
 */
function readSettingsObject(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${basename(path)} must contain a JSON object`)
  }
  return parsed as Record<string, unknown>
}

/**
 * Resolve the working directory's git branch for the status line.
 * @param cwd - the session's working directory.
 * @returns the branch name, or '' outside a repository or on a detached HEAD.
 */
function gitBranch(cwd: string): string {
  try {
    const ref = readFileSync(join(cwd, '.git', 'HEAD'), 'utf8').trim().match(/^ref: refs\/heads\/(.+)$/)
    return ref?.[1] ?? ''
  } catch {
    // Only the single HEAD read is attempted, so the sole reachable failure is
    // a missing repository (or unreadable HEAD file): the branch group drops out.
    return ''
  }
}

/** The session identity this invocation will run, plus whether it is resumed. */
interface Target {
  sessionId: string
  resume: boolean
  mode?: string
  cwd?: string
  seed?: readonly SessionEvent[]
  parentSession?: SessionId
  /** Marks the session as a subagent conversation in the durable header. */
  origin?: 'subagent'
  seedLength?: number
}

/**
 * Reduce a session id to a filename-safe /export default-name suffix. Session
 * ids are normally minted `session-<uuid>`, but `--session` accepts arbitrary
 * user text: path separators must never leak into the default export filename
 * (which would escape the session cwd).
 * @param id - the session id.
 * @returns at most the last 8 filename-safe characters.
 */
export function exportSessionIdSuffix(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/gu, '_').slice(-8)
}

/** One ordered step of the terminal quit cleanup. */
export interface QuitCleanupStep {
  /** Step label used in diagnostics and tests. */
  readonly name: string
  /** The step's async work; a rejection is contained by the sequence. */
  readonly run: () => Promise<void>
}

/**
 * Run the ordered quit cleanup, then request exit. Every step rejection is
 * contained (reported through `onError`) so a failed flush or dispose never
 * skips the remaining cleanup; the exit request is always reached exactly
 * once.
 * @param steps - the cleanup steps in dependency order (settle the visible
 * session, await the final in-flight composition, await durable recall).
 * @param exit - the terminal exit request (code 0).
 * @param onError - optional failure sink; called once per failing step and
 * itself contained, so a throwing sink cannot abort the sequence.
 * @returns the names of the steps that started, in order (for tests).
 */
export async function runQuitSequence(
  steps: readonly QuitCleanupStep[],
  exit: (code: number) => void,
  onError?: (name: string, error: unknown) => void,
): Promise<readonly string[]> {
  const started: string[] = []
  for (const step of steps) {
    started.push(step.name)
    try {
      await step.run()
    } catch (error) {
      try {
        onError?.(step.name, error)
      } catch {
        // The failure sink must never abort the cleanup sequence.
      }
    }
  }
  try {
    exit(0)
  } catch {
    // The exit request itself must not become an unhandled rejection.
  }
  return started
}

/** One composer submission waiting behind the startup delivery. */
export interface QueuedSubmission {
  readonly text: string
  /** `steer` inserts into the running turn; `followup` waits for the next one. */
  readonly mode: 'followup' | 'steer'
  readonly images: readonly ContentBlock[]
}

/** What one requested queue mutation did; the runner maps it to one notice. */
export type QueueMutationOutcome =
  | 'removed'
  | 'edited'
  | 'steered'
  | 'unavailable'
  | 'empty'
  | 'steerUnavailable'

/**
 * Replace one queued message's text while keeping its attachments. A queue
 * edit rewrites what the user typed, not what they attached: image and file
 * blocks ride through in delivery order (text first, then attachments, the
 * shape {@link deliverLine} submits). Dropping them here would silently strip
 * an attachment the user already confirmed, so this is the edit's single
 * definition and the panel's read-only marker only mirrors it.
 */
export function queueEditContent(content: readonly ContentBlock[], text: string): ContentBlock[] {
  const attachments = content.filter(block => block.type !== 'text')
  return [{ type: 'text', text }, ...attachments]
}

/**
 * Apply one terminal queue mutation to the live inbox. The decision and the
 * inbox change are pure over the supplied handles so every branch is testable
 * without an agent; steering itself is injected because it wakes the driver
 * rather than mutating the inbox. The durable inbox splices remain the UI's
 * single source of truth — this helper never reports a state the inbox did not
 * actually reach.
 * @param inbox - the live agent inbox (pending lists plus its mutators).
 * @param status - the agent's lifecycle status; steering needs `running`.
 * @param messageId - identity of the queued message to mutate.
 * @param action - the requested mutation.
 * @param steer - submits the removed message as next-step steering.
 * @returns the outcome the caller reports.
 */
export function applyQueueMutation(
  inbox: Pick<Inbox, 'nextTurn' | 'append' | 'remove' | 'replace'>,
  status: AgentStatus,
  messageId: string,
  action: QueueMutation,
  steer: (message: UserMessage) => void,
): QueueMutationOutcome {
  const id = MessageId(messageId)
  const message = inbox.nextTurn.find(candidate => candidate.id === id)
  if (message === undefined) return 'unavailable'
  switch (action.kind) {
    case 'remove':
      return inbox.remove(id) ? 'removed' : 'unavailable'
    case 'edit':
      if (action.text.trim() === '') return 'empty'
      inbox.replace(id, createUserMessage({
        content: queueEditContent(message.content, action.text),
        source: message.source,
      }))
      return 'edited'
    case 'steer':
      if (status !== 'running') return 'steerUnavailable'
      // Steer promotes the message out of next-turn, so a failing submit must
      // put it back: the row the user was looking at never just disappears.
      if (!inbox.remove(id)) return 'unavailable'
      try {
        steer(message)
      } catch (error: unknown) {
        inbox.append('next-turn', message)
        throw error
      }
      return 'steered'
  }
}

/**
 * Cancel the active turn while keeping the next-turn queue, then wake the
 * driver again so the preserved messages actually run. `cancel` clears
 * pending work by default and never wakes the driver on its own, so the queue
 * is captured first and re-submitted afterwards: a waking submission latches
 * the wake while the aborted activity converges to idle, which is what turns
 * "preserved" into "sent next" instead of "parked forever". Next-step
 * steering is deliberately dropped — it belonged to the cancelled turn.
 * @param agent - the live agent handle.
 * @returns how many queued messages were preserved across the abort.
 */
export function cancelPreservingQueue(agent: Pick<Agent, 'inbox' | 'cancel' | 'followup'>): number {
  const queued = [...agent.inbox.nextTurn]
  agent.cancel({ kind: 'user' })
  for (const message of queued) agent.followup(message)
  return queued.length
}

/**
 * Whether a tagged submission still belongs to the active session. Attachment
 * prepares resolve on the microtask timeline, while a queued session switch
 * remounts the app asynchronously — the composing instance's unmount cleanup
 * runs too late to abort, so the delivery itself carries the composing
 * session's full id and the runner drops it here when the world moved on.
 * An untagged (synchronous) or pending-session ('') submission always passes.
 */
export function submissionBelongsToSession(origin: string | undefined, activeSessionId: string | undefined): boolean {
  return origin === undefined || origin === '' || origin === activeSessionId
}

/**
 * Root-log catalog facts a resumed session must replay into the subagent
 * feed: constructor seeds never fire on the live bus, so without this the
 * children of a resumed session vanish behind a restart. The empty-child
 * placeholder row (childId '') is a placeholder, not a child, and stays out.
 */
export function subagentCatalogSeed(events: readonly SessionEvent[]): readonly SessionEvent<'subagent/catalog'>[] {
  return events.filter((event): event is SessionEvent<'subagent/catalog'> =>
    event.type === 'subagent/catalog' && event.data.childId !== '')
}

/**
 * Map one cross-session full-text hit onto the /search panel's row (pure).
 * Labels fall back to the short id form — the engine's hit carries the
 * strongest matching event, not the title observation.
 */
export function searchHitToRow(hit: {
  header: SessionHeader
  bestMatch: { snippet: string; time: number }
}): SearchRow {
  const subagent = hit.header.origin === 'subagent'
  const cwd = hit.header.cwd ?? ''
  // Session cwds may arrive in either separator style regardless of the
  // observing host (a workspace synced from Windows), so split on both.
  const workspace = cwd.split(/[\\/]/u).filter(part => part !== '').at(-1) ?? ''
  const preset = hit.header.agentPreset ?? ''
  const flat = hit.bestMatch.snippet.replace(/\s+/gu, ' ').trim()
  return {
    id: hit.header.id,
    label: hit.header.id.slice(-12),
    detail: [workspace, preset].filter(part => part !== '').join(' · '),
    snippet: flat.length > 158 ? `${flat.slice(0, 157)}…` : flat,
    updatedAt: hit.bestMatch.time,
    subagent,
    resumable: !subagent,
  }
}

/** One Shift+Tab station decision for the mode cycle. */
export type ModeCycleDecision =
  | { readonly kind: 'permission'; readonly preset: string }
  | { readonly kind: 'plan-on' }
  | { readonly kind: 'plan-off'; readonly preset: string }

/**
 * Decide the next Shift+Tab station. The cycle keeps the preset table's
 * own order (most restrictive first) and inserts ONE plan station between
 * the most restrictive preset and the wrap target: with the shipped three
 * presets the user sees workspace-write → danger-full-access → read-only
 * → plan → workspace-write. Plan IS the most restrictive preset plus the
 * plan prompt layer — entering it switches nothing (the cycle is already
 * parked on read-only), and leaving it lands on the next preset after the
 * most restrictive one. Without the /plan command the cycle is exactly the
 * preset table.
 *
 * `planIntent` covers the committed fold's commit lag: upstream queues a
 * plan switch during an open turn (and the command pipeline is async even
 * idle), so the durable plan/mode event lands AFTER the press that chose
 * it. While an intent from an earlier press is in flight it — not the
 * stale committed fold — decides the station, so repeated presses advance
 * the cycle instead of re-issuing the same plan transition (the stuck
 * plan-on/plan-off toggle). Undefined falls back to the committed fold.
 */
export function planCycleDecision(input: {
  readonly names: readonly string[]
  readonly current: string
  readonly inPlan: boolean
  readonly planAvailable: boolean
  readonly planIntent?: boolean
}): ModeCycleDecision | undefined {
  const names = input.names
  if (names.length === 0) return undefined
  const first = names[0]
  if ((input.planIntent ?? input.inPlan) === true) return { kind: 'plan-off', preset: names[1] ?? first }
  const at = names.indexOf(input.current)
  if (at === 0 && input.planAvailable) return { kind: 'plan-on' }
  return { kind: 'permission', preset: names[(at + 1) % names.length] ?? first }
}

/**
 * Order-preserving gate for composer input while the startup prompt/images
 * are still preparing. Anything submitted before the startup delivery settles
 * queues and flushes afterwards in submit order, so the initial request can
 * never be overtaken by typing that raced a slow image preparation. The flush
 * also runs when the startup delivery fails: user input is never stranded.
 */
export class StartupInputGate {
  private readonly queued: QueuedSubmission[] = []
  private pending = false
  private readonly deliver: (submission: QueuedSubmission) => void
  constructor(deliver: (submission: QueuedSubmission) => void) {
    this.deliver = deliver
  }

  /** Submit one line: delivered now while idle, queued behind the startup delivery otherwise. */
  submit(submission: QueuedSubmission): void {
    if (this.pending) this.queued.push(submission)
    else this.deliver(submission)
  }

  /**
   * Run the startup delivery — the callback receives the direct-delivery sink
   * for the startup prompt itself — then flush everything that queued behind
   * it, in order, even when the callback rejects.
   */
  async run(startup: (deliver: (submission: QueuedSubmission) => void) => Promise<void>): Promise<void> {
    this.pending = true
    try {
      await startup(submission => this.deliver(submission))
    } finally {
      this.pending = false
      const queued = this.queued.splice(0)
      for (const submission of queued) this.deliver(submission)
    }
  }
}

/**
 * Resolve the invocation's target session against the persisted headers.
 * @param startup - the parsed startup flags.
 * @param persistence - the persistence service; required for resume/latest.
 * @param cwd - the working directory `--continue` filters by.
 * @returns the target identity.
 * @throws with a user-facing message when the flags name nothing resolvable.
 */
export async function resolveTarget(startup: TuiStartup, persistence: SessionPersistence | undefined, cwd: string): Promise<Target> {
  if (startup.kind === 'fresh') return { sessionId: `session-${randomUUID()}`, resume: false, mode: startup.mode }
  if (startup.kind === 'named') {
    // The id must not exist yet: reject before any Agent composition when the
    // backend can tell us (a live collision is still caught by the session
    // store at create time).
    if (persistence !== undefined) {
      const headers: readonly SessionHeader[] = (await persistence.list()).map(snapshot => snapshot.header)
      if (headers.some(header => header.id === startup.sessionId)) {
        throw new Error(`session "${startup.sessionId}" already exists; use --resume to continue it`)
      }
    }
    return { sessionId: startup.sessionId, resume: false, mode: startup.mode }
  }
  if (persistence === undefined) {
    throw new Error('cannot resolve the requested session: session persistence is not configured')
  }
  const headers: readonly SessionHeader[] = (await persistence.list()).map(snapshot => snapshot.header)
  if (startup.kind === 'resume') {
    const matched = matchSessionId(headers, startup.sessionId)
    // Subagent conversations are read-only everywhere else; the CLI must not
    // be a back door into appending root turns to a child's durable log.
    if (isSubagentSession(matched)) {
      throw new Error('subagent conversations are read-only; resume a root session')
    }
    return { sessionId: matched.id, resume: true }
  }
  // --continue: the newest persisted ROOT session whose header pins this cwd.
  const newest = newestRootForCwd(headers, cwd)
  if (newest === undefined) throw new Error(`no persisted session for this directory (${cwd}); start one without --continue`)
  return { sessionId: newest.id, resume: true }
}

/**
 * Resolve a bounded command preview for one pending approval: the request
 * contract carries no arguments, so the bar self-serves from the transcript
 * projection via `callId` (mirrors the web ApprovalPanel's argsRaw lookup).
 * @param events - the transcript entries to search.
 * @param callId - the tool call the question is about, when the asker had one.
 * @param toolName - the tool the question is about.
 * @returns a bounded preview line, '' when nothing useful resolves.
 */
function approvalCommandPreview(events: readonly { kind: string }[], callId: string | undefined, toolName: string): string {
  if (callId === undefined) return ''
  const entry = events.find(candidate =>
    candidate.kind === 'tool' && (candidate as { callId?: string }).callId === callId)
  if (entry === undefined) return ''
  const args = (entry as { arguments?: string }).arguments ?? ''
  return toolArgumentsPreview(args, toolName)
}

/** The runner's connection between the React app and the process side. */
interface AppBridge {
  /** Post one local notice line (feedback the transcript does not carry). */
  notify: (text: string, tone?: NoticeTone) => void
}

/**
 * Run the interactive terminal session: resolve the target session, create or
 * resume one Agent, mount the app, and keep the process alive until the user
 * quits.
 * @param ctx - plugin context carrying the Agent, default model, Session, and launcher IO services.
 * @param startup - the parsed invocation flags.
 * @param io - process-facing effects.
 */
async function run(ctx: Context, startup: TuiStartup, io: TuiIo): Promise<void> {
  // Loader siblings mount concurrently. Await the complete application before
  // creating an Agent so its scoped tools and adapters are not half-composed.
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const defaultModel = ctx.get('agentDefaultModel')
  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  const sessionQuery = (ctx as unknown as { get(name: string): unknown }).get('sessionQuery') as SessionQueryService | undefined
  // Early process shutdown can dispose the tree while settlement is pending.
  if (agents === undefined || defaultModel === undefined || sessions === undefined) return

  const cwd = process.cwd()
  // Live deployment default (web selectModel parity): read on every use, not
  // snapshotted at launch, so a /model pick this process saves becomes the
  // default for sessions composed afterwards without a restart.
  const currentDefaults = (): ModelSelection => defaultModel.currentSelection()
  const presets = agentPresetsFrom(ctx)
  if (presets === undefined) throw new Error('agent preset service is unavailable; check the dsh-code bundle patch')
  const permissionPresets = permissionPresetsFrom(ctx)

  // A bare fresh launch stays transient: no Agent or session is composed, and
  // nothing is persisted, until the user's first real input. Explicit flags
  // (--resume/--continue/--session/--mode) keep the eager create/resume path.
  const lazy = startup.kind === 'fresh' && startup.mode === undefined

  interface ActiveSession {
    handle: AgentHandle
    agent: Agent
    session: Session
    store: ReturnType<typeof createTranscriptStore>
    mentions: MentionsApi
    mode: string
    selection: { picked?: ModelSelection }
    resumed: boolean
    /**
     * Root-log `subagent/catalog` facts (resume path): constructor seeds
     * never fire on the live bus, so activation replays them into the
     * subagent feed after its reset — a resumed session's children stay
     * visible instead of vanishing behind a restart.
     */
    catalogSeed: readonly SessionEvent<'subagent/catalog'>[]
  }

  /** Prepare a complete next session before disturbing the currently visible one. */
  const prepare = async (next: Target): Promise<ActiveSession> => {
    const nextCwd = next.cwd ?? cwd
    // A bare launch can pick a model before any session exists: the process
    // keeps that explicit choice and every prepared session starts from it
    // (the documented precedence: explicit pick > session header > default).
    const selectionState: { picked?: ModelSelection } = pendingSelection === undefined
      ? {}
      : { picked: pendingSelection }
    let mode = next.resume ? next.mode : next.mode ?? pendingMode
    // An explicit `--mode` or the settings-layer service default may still name
    // an id an upstream rename retired (code → ptc); normalize both.
    if (!next.resume) mode = (await presets.resolve(normalizePresetId(mode ?? presets.defaultId))).id
    // 0.1.5 AgentSetup passes the composed agent as its second argument (the
    // former `ctx.agent` accessor is gone); the preset mount still needs the
    // agent-scoped context.
    const setup = async (agentCtx: Context, agent: Agent): Promise<void> => {
      const sessionPreset = next.resume
        ? resolvePreset(agent.session)
        : mode
      const mounted = await presets.mount(agentCtx, sessionPreset)
      mode = mounted.id
      const selection: ModelSelectionRef = {
        get current(): ModelSelection | undefined {
          return resolveEffectiveSelection(selectionState.picked, agent.session.requestHeader()?.config, currentDefaults())
        },
        set current(value: ModelSelection | undefined) { selectionState.picked = value },
        assembled: undefined,
      }
      installModelSelection(agentCtx, selection)
    }
    // AgentOptions seed the loop's fallback route; effort rides the selection
    // ref (installModelSelection), so only the provider/model pair is seeded.
    const seedOptions = pendingSelection === undefined
      ? { provider: currentDefaults().provider, model: currentDefaults().model }
      : { provider: pendingSelection.provider, model: pendingSelection.model }
    const handle = next.resume
      ? await agents.resume({
        resumeSessionId: SessionId(next.sessionId),
        agentOptions: seedOptions,
        // Quit aborts an in-flight composition so the exit wait never hangs
        // on a prepare that cannot settle; upstream rolls the creation back.
        signal: quitAbort.signal,
        setup,
      })
      : await agents.create({
        sessionId: SessionId(next.sessionId),
        meta: {
          cwd: nextCwd,
          agentPreset: mode,
          ...(next.parentSession === undefined ? {} : { parentSession: next.parentSession }),
          ...(next.origin === undefined ? {} : { origin: next.origin }),
          // 0.1.5 fork lineage: the seed marker lives on the metadata and the
          // inherited prefix length on the top-level option (the v0 header's
          // numeric `seedLength` field is gone from the create contract).
          ...(next.seedLength === undefined ? {} : { isSeeded: true }),
        },
        ...(next.seedLength === undefined ? {} : { inheritedEventCount: SessionLogOffset(next.seedLength) }),
        ...(next.seed === undefined ? {} : { seed: next.seed }),
        agentOptions: seedOptions,
        signal: quitAbort.signal,
        setup,
      })
    const session = handle.agent.session
    if (!next.resume && permissionPresets !== undefined) {
      applyPendingPermission(permissionPresets, session, pendingPermission)
    }
    const seedEvents = session.snapshotEvents()
    // Resume precedence, middle layer: the log's unconsumed `model/selection`
    // (a pick the web host recorded that no request ever assembled) outranks
    // the older request header; an in-process pick still outranks both.
    if (next.resume && selectionState.picked === undefined) {
      const pending = pendingModelSelection(seedEvents)
      if (pending !== undefined) selectionState.picked = pending
    }
    return {
      handle,
      agent: handle.agent,
      session,
      store: createTranscriptStore(seedEvents),
      mentions: createMentions(ctx, handle.agent, session.header.cwd ?? nextCwd),
      mode: mode ?? 'standard',
      selection: selectionState,
      resumed: next.resume,
      catalogSeed: subagentCatalogSeed(seedEvents),
    }
  }

  let active: ActiveSession | undefined
  let agent: Agent | undefined
  let session: Session | undefined
  let store: TranscriptStore = createTranscriptStore()
  // Live subagent activity (child sessions of the current root): one bounded
  // row per child, folded from the same event bus the transcript feeds on.
  const subagents: SubagentFeedView & { apply(sessionId: string, event: SessionEvent): void; reset(): void } = createSubagentFeed()
  // Pre-session @file completion runs the official search over the launch
  // cwd (model- and session-independent); the prepare/activate paths replace
  // this with the agent-scoped instance once a session exists.
  let mentions: MentionsApi = createMentions(ctx, undefined, cwd)
  /** Explicit model pick made before any session exists (a bare launch). */
  let pendingSelection: ModelSelection | undefined
  /** Agent preset selected before the first session exists. */
  let pendingMode: string | undefined
  /** Ordered pre-session preset resolutions; first composition awaits them. */
  let pendingModeWork: Promise<void> = Promise.resolve()
  /** Permission preset selected before the first session exists. */
  let pendingPermission: string | undefined
  /**
   * Plan-mode choice made before the first session exists: materialized as a
   * /plan registry command delivered ahead of the first queued input when the
   * session composes, so the first assembled step already plans.
   */
  let pendingPlan = false
  /**
   * In-flight mid-session plan choice from the Shift+Tab cycle. Upstream
   * queues a plan switch during an open turn (and the command pipeline is
   * async even idle), so the committed plan/mode fold lags the press that
   * chose it; the cycle reads this intent until the durable event lands,
   * then the session/event funnel clears it.
   */
  let planIntent: boolean | undefined
  /**
   * Whether the pre-session effective preset composes plan mode, answered by
   * the presets service composition inventory (minimal does not). Cached and
   * refreshed whenever the pending mode moves; unknown reads as unavailable
   * so one keypress at most lands before the answer arrives.
   */
  let preSessionPlanAvailable = false
  let preSessionPlanKnown = false
  const refreshPreSessionPlan = (): void => {
    if (presets === undefined) {
      preSessionPlanAvailable = false
      preSessionPlanKnown = true
      return
    }
    preSessionPlanKnown = false
    void presets.compositionInventory().then(inventory => {
      const id = pendingMode ?? normalizePresetId(presets.defaultId)
      preSessionPlanAvailable = inventory.some(composition => composition.id === id
        && composition.rows.some(row => row.moduleName === '@deepseek-ai/dsh-plan-mode' && row.enabled !== false))
      preSessionPlanKnown = true
    }, () => {
      preSessionPlanAvailable = false
      preSessionPlanKnown = true
    })
  }
  refreshPreSessionPlan()
  /**
   * Monotonic session epoch: bumped on every successful activation, on every
   * first-session creation, and on quit. Async callbacks (mention prepares,
   * command executions) capture it at call time and drop their result when it
   * changed, so a stale callback can never deliver to an agent that is no
   * longer on screen.
   */
  let epoch = 0
  /** Aborted on quit: an in-flight agent composition (create/resume) races this signal. */
  const quitAbort = new AbortController()
  /** In-flight mention-prepare / command-execute controllers, aborted on any session transition. */
  const pendingControllers = new Set<AbortController>()
  const abortPendingControllers = (): void => {
    for (const controller of [...pendingControllers]) {
      pendingControllers.delete(controller)
      controller.abort()
    }
  }
  /** The in-flight session-composition turn (create/resume/activate), if any. */
  let composing: Promise<void> | undefined
  /**
   * Run one session composition exclusively: concurrent compositions wait
   * their turn, so a bare-launch first-session creation and a /resume
   * activation can never compose agents in parallel (the loser would leak its
   * agent or mis-deliver). Errors propagate to the caller; the shared slot
   * always continues.
   */
  const compose = (work: () => Promise<void>): Promise<void> => {
    const turn = (composing ?? Promise.resolve()).catch(() => {}).then(work)
    composing = turn.catch(() => {})
    return turn
  }

  if (!lazy) {
    const target = await resolveTarget(startup, persistence, cwd)
    const prepared = await prepare(target)
    active = prepared
    agent = prepared.agent
    session = prepared.session
    store = prepared.store
    mentions = prepared.mentions
    // Replayed catalog facts rebuild the resumed session's child rows before
    // the first render (the live handler only folds events from now on).
    for (const event of prepared.catalogSeed) subagents.apply(event.data.childId, event)
  }

  // Seed the transcript from the full session log: constructor seeds never
  // fire on `session/event`, so a resumed session paints its history once
  // before the first render. The handler reads the current session/store, so
  // the deferred first session of a bare launch is covered by the same feed.
  const off = ctx.on('session/event', (subject: Session, event: SessionEvent) => {
    if (session === undefined) return
    if (subject.id === session.id) {
      store.apply(event)
      // The committed plan fold caught up (or diverged via a typed /plan or
      // an approved plan review): the durable event is the live truth again,
      // so the cycle's in-flight intent retires.
      if (event.type === 'plan/mode') planIntent = undefined
      // The parent-owned subagent catalog rides the ROOT log (0.1.5); each
      // fact describes one child, so it feeds that child's live row.
      if (event.type === 'subagent/catalog' && event.data.childId !== '') subagents.apply(event.data.childId, event)
      return
    }
    // Child sessions (subagent conversations this root spawned) fold into
    // the bounded live-activity feed, never the transcript: the root stays
    // the only durable transcript truth while a running subagent remains
    // visible. Lineage comes from the child header, same field the session
    // directory uses to tag `↳` rows.
    if (subject.header.parentSession === session.id && subject.header.origin === 'subagent') subagents.apply(subject.id, event)
  })

  // Live assistant typing (session-log v2+): durable logs are settlement-only,
  // so the streaming tails ride the process-local `agent/assistant-stream`
  // frames of the current root agent. Settlement events clear the tails when
  // they land (always before a committed end frame); an abandoned attempt's
  // partial tail is dropped by the store on its end frame.
  ctx.on('agent/assistant-stream', ({ agent: source, frame }) => {
    if (agent === undefined || source.id !== agent.id) return
    store.applyStreamFrame(frame)
  })

  const commands: CommandsView = watchCommands(ctx)
  if (agent !== undefined) commands.setAgent(agent)

  const skills: SkillsView = watchSkills(ctx, cwd)
  if (agent !== undefined) skills.setAgent(agent)

  // Approval answerer: renders the ask as a y/n bar; only this TUI's agent is
  // claimed, every other ask falls through to the fail-closed waterfall. The
  // owner predicate is empty until the first session exists.
  const approval: ApprovalStore = mountApprovalAnswerer(
    ctx,
    candidate => agent !== undefined && candidate.id === agent.id,
    request => approvalCommandPreview(store.getView().entries, request.callId, request.toolName),
  )

  // Subagent model routing. The kernel seeds child agents from the parent's
  // CREATE-TIME AgentOptions (resolveChildAgentOptions), which a mid-session
  // /model switch never touches — delegated work would keep running on the
  // launch-time route. This plugin-level listener mirrors installModelSelection
  // for subagent-origin requests (scope filtering delivers the agent subject
  // inside the payload): the explicit /subagent override wins, else the root's
  // effective selection (explicit pick > session header > deployment default).
  // Effort rides the selection exactly like the kernel listener applies it.
  let subagentOverride: ModelSelection | undefined
  ctx.on('agent/request', (payload, next) => {
    const subject = payload.agent
    const header = subject.session.header
    if (header.parentSession === undefined && header.origin !== 'subagent') return next()
    // Only the ACTIVE session's explicit pick may steer a subagent request.
    // During a switch window the old agent can still be mid-flight; routing
    // it by the NEW session's pick sent one of its requests to the wrong
    // model. A subject outside the active tree falls back to its own request
    // header (plus any explicit /subagent override, which is user intent).
    const activeAgent = active
    const belongsToActive = activeAgent !== undefined
      && (header.parentSession ?? subject.session.id) === activeAgent.session.id
    const picked = subagentOverride
      ?? resolveEffectiveSelection(
        belongsToActive && activeAgent !== undefined ? (activeAgent.selection.picked ?? pendingSelection) : undefined,
        subject.session.requestHeader()?.config,
        currentDefaults(),
      )
    return next().then(resolved => applyModelSelectionToConfig(resolved, picked))
  })

  // ask_user_question answerer: one waterfall listener, one request on
  // screen at a time. Plan reviews (exit_plan_mode) arrive through this same
  // pipe; sibling answerers stay usable through the claim/defer split.
  const questions: QuestionStore = mountQuestionProvider(
    ctx,
    candidate => agent !== undefined && candidate.id === agent.id,
  )

  // The bridge the React app registers on mount: local notices from the
  // process side (unknown commands, switch confirmations, cancels).
  const bridge: AppBridge = { notify: () => {} }

  // Same-id capability inheritance. Catalog capabilities flow by route key,
  // not model id, so a hand-declared relay model without an explicit
  // reasoningEfforts declaration serves no reasoning levels and offers no
  // effort picker. This background pass materializes declarations from
  // same-id donors (sibling settings entries first, then other routes'
  // advertised levels) over the panel's settings.mutate path, where the
  // upstream serviceability gate still rejects invalid writes atomically.
  // The debounce coalesces the settings/adapters event pair; the applier
  // skips only a same-source same-revision echo of its own write, so the
  // loop converges without ever ignoring a real external edit.
  const capabilitySyncDebounceMs = 400
  const runCapabilitySync = (): void => {
    void syncModelCapabilities(ctx, bridge.notify)
  }
  let capabilitySyncTimer: ReturnType<typeof setTimeout> | undefined
  const scheduleCapabilitySync = (): void => {
    if (capabilitySyncTimer !== undefined) clearTimeout(capabilitySyncTimer)
    capabilitySyncTimer = setTimeout(() => {
      capabilitySyncTimer = undefined
      runCapabilitySync()
    }, capabilitySyncDebounceMs)
  }
  const offCapabilitySync = [
    ctx.on('settings/document-updated', scheduleCapabilitySync),
    ctx.on('llm/adapters-updated', scheduleCapabilitySync),
  ]
  scheduleCapabilitySync()

  // /statusline persistence: one user-level JSON file under the DSH home.
  // Missing file means defaults; a corrupt file degrades to defaults with a
  // surfaced warning (the customization is user-authored, never silent).
  const statuslinePath = join(homedir(), '.dsh', 'dsh-code', 'statusline.json')
  let statuslineWarning: string | undefined
  let statuslineItems: readonly string[] = []
  try {
    statuslineItems = parseStatuslineItems(readSettingsObject(statuslinePath).items)
  } catch (error) {
    statuslineItems = parseStatuslineItems(undefined)
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      statuslineWarning = error instanceof Error ? error.message : String(error)
    }
  }
  // Serialized, crash-atomic writes for the user-level JSON files: the chain
  // orders rapid consecutive saves (the LAST snapshot wins on disk), each
  // write goes through a sibling temp file + rename, and quit waits for the
  // flush exactly like it waits for the recall history.
  const settingsPersistence = createUserSettingsPersistence()
  const saveStatusline = (items: readonly string[]): void => {
    statuslineItems = [...items]
    void settingsPersistence.save(statuslinePath, JSON.stringify({ items }, null, 2) + '\n')
      .catch((writeError: unknown) => {
        bridge.notify(t('notice.statuslineSaveFailed', { message: writeError instanceof Error ? writeError.message : String(writeError) }), 'error')
      })
  }

  // /vscode-keys: detect the hosting editor's user keybindings.json and pass
  // Ctrl+R through the workbench. One marker file under the DSH home keeps
  // the startup hint a once-per-install event.
  const editorKeysEnv: EditorKeysEnv = {
    env: process.env,
    paths: { homedir: homedir(), appdata: process.env.APPDATA, platform: process.platform },
    flagPath: join(homedir(), '.dsh', 'dsh-code', 'editor-keys.json'),
  }
  const applyEditorKeys = (): Promise<string> => applyCtrlRPassthrough(editorKeysEnv)

  // /theme persistence: one user-level JSON file under the DSH home, mirroring
  // the statusline file. A missing file means the dark default; a corrupt file
  // degrades to dark with a surfaced warning. Precedence: CLI --theme > file >
  // auto detection > dark (auto detection itself is a later enhancement and
  // currently falls back to dark inside theme.ts).
  const themePath = join(homedir(), '.dsh', 'dsh-code', 'theme.json')
  let themeWarning: string | undefined
  if (startup.theme === undefined) {
    try {
      setTheme(parseThemeName(readSettingsObject(themePath).theme))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        themeWarning = error instanceof Error ? error.message : String(error)
      }
    }
  } else {
    setTheme(startup.theme)
  }
  const saveTheme = (name: ThemeName): void => {
    setTheme(name)
    void settingsPersistence.save(themePath, JSON.stringify({ theme: name }, null, 2) + '\n')
      .catch((writeError: unknown) => {
        bridge.notify(t('notice.themeSaveFailed', { message: writeError instanceof Error ? writeError.message : String(writeError) }), 'error')
      })
  }

  // /language persistence: one user-level JSON file beside theme.json. A
  // missing file means English; a corrupt file degrades to English with a
  // surfaced warning.
  const languagePath = join(homedir(), '.dsh', 'dsh-code', 'language.json')
  let languageWarning: string | undefined
  try {
    setLanguage(parseLanguageName(readSettingsObject(languagePath).language))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      languageWarning = error instanceof Error ? error.message : String(error)
    }
  }
  const saveLanguage = (name: LanguageName): void => {
    setLanguage(name)
    void settingsPersistence.save(languagePath, JSON.stringify({ language: name }, null, 2) + '\n')
      .catch((writeError: unknown) => {
        bridge.notify(t('notice.languageSaveFailed', { message: writeError instanceof Error ? writeError.message : String(writeError) }), 'error')
      })
  }

  // /animation persistence: one user-level JSON file under the DSH home,
  // mirroring the theme file. A missing file means animations are on; a
  // corrupt file degrades to on with a surfaced warning. Only an explicit
  // `false` disables (parseAnimationsPref), so hand-edited or partial files
  // never silently freeze the UI.
  const animationsPath = join(homedir(), '.dsh', 'dsh-code', 'animations.json')
  let animationsEnabled = true
  let animationsWarning: string | undefined
  try {
    // A literal `null` file reads as corruption and surfaces the warning the
    // block above promises, instead of a property access on `null`.
    animationsEnabled = parseAnimationsPref(readSettingsObject(animationsPath).animations)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      animationsWarning = error instanceof Error ? error.message : String(error)
    }
  }
  const saveAnimations = (enabled: boolean): void => {
    void settingsPersistence.save(animationsPath, JSON.stringify({ animations: enabled }, null, 2) + '\n')
      .catch((writeError: unknown) => {
        bridge.notify(t('notice.animationsSaveFailed', { message: writeError instanceof Error ? writeError.message : String(writeError) }), 'error')
      })
  }

  // Global input recall (Codex composer-history contract): one JSONL file
  // under the DSH home. A missing file means an empty history; unreadable or
  // corrupt content degrades to the valid lines it could parse, silently —
  // recall is a convenience surface, never a gate.
  const historyPath = join(homedir(), '.dsh', 'dsh-code', 'history.jsonl')
  let inputHistory: readonly string[] = []
  let historyWriteChain: Promise<void> = Promise.resolve()
  try {
    const rawHistory = readFileSync(historyPath, 'utf8')
    inputHistory = parseHistoryFile(rawHistory)
    // Stale lines (adjacent duplicates, dropped garbage, an over-cap tail)
    // accumulate in an append-only file; rewrite the canonical form once
    // per boot. The rewrite rides the same chain, so it lands before any
    // submission the user types next. An entry another terminal appends
    // inside the read-to-rename window is dropped — a millisecond-scale
    // gap at boot that recall tolerates by design.
    if (needsCompaction(rawHistory)) {
      historyWriteChain = historyWriteChain
        .then(() => writeFileAtomically(historyPath, serializeHistoryList(inputHistory)))
        .catch(() => {})
    }
  } catch {
    inputHistory = []
  }
  /**
   * Serialized history writes: each submission appends one JSON line at the
   * end of the file, so concurrent terminals add entries after each other
   * instead of overwriting snapshots they read at their own boot. A
   * multi-line draft still occupies one physical line (JSON escapes the
   * newline), and a regular-length line reaches the disk as one positioned
   * write; an oversized paste may interleave mid-line, which the next
   * parse simply drops.
   */
  const recordHistory = (text: string): void => {
    if (text === '') return
    inputHistory = [...inputHistory, text].slice(-HISTORY_MAX_ENTRIES)
    historyWriteChain = historyWriteChain
      .then(() => mkdir(dirname(historyPath), { recursive: true }))
      .then(() => appendFileAsync(historyPath, historyLine(text), 'utf8'))
      .catch((writeError: unknown) => {
        bridge.notify(t('notice.historySaveFailed', { message: writeError instanceof Error ? writeError.message : String(writeError) }), 'error')
      })
  }

  /** Mutate one next-turn inbox item; durable inbox splices remain the UI truth. */
  const updateQueued = (messageId: string, action: QueueMutation): void => {
    const current = agent
    if (current === undefined) return
    try {
      const outcome = applyQueueMutation(
        current.inbox,
        current.status,
        messageId,
        action,
        message => current.steer(message),
      )
      switch (outcome) {
        case 'removed': bridge.notify(t('notice.queueCancelled')); return
        case 'edited': bridge.notify(t('notice.queueEdited')); return
        case 'steered': bridge.notify(t('notice.queueSteered')); return
        case 'empty': bridge.notify(t('notice.queueEditEmpty'), 'warning'); return
        case 'steerUnavailable': bridge.notify(t('notice.queueSteerUnavailable'), 'warning'); return
        case 'unavailable': bridge.notify(t('notice.queueUnavailable'), 'warning'); return
      }
    } catch (error: unknown) {
      bridge.notify(t('notice.queueActionFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
    }
  }

  // The mount handle lives in a box: quit closes over it, while the mount
  // itself is created after quit (the App element needs quit as a prop).
  const mountRef: { current?: TuiMount } = {}
  let quitting = false
  const quit = (fast = false): void => {
    if (quitting) return
    quitting = true
    switchQueue.cancel()
    // Stale prepares/commands die with the session they were for. Aborting
    // the composition signal lets a never-settling prepare reject, so the
    // exit wait below cannot hang (upstream rolls the creation back).
    abortPendingControllers()
    quitAbort.abort()
    epoch += 1
    off()
    for (const dispose of offCapabilitySync) dispose()
    if (capabilitySyncTimer !== undefined) clearTimeout(capabilitySyncTimer)
    const currentSession = session
    const currentActive = active
    const report = (name: string, error: unknown): void => {
      internals.stderr.write(`dsh: quit ${name} failed: ${error instanceof Error ? error.message : String(error)}\n`)
    }
    // A throwing unmount must not strand the terminal (stdin tap alive,
    // keyboard protocol stacks unpopped) or skip the exit sequence below.
    try {
      mountRef.current?.unmount()
    } catch (error: unknown) {
      report('unmount', error)
    }
    // One ordered cleanup: settle the visible session (if any — a bare launch
    // that never composed one resolves immediately), then wait for the final
    // in-flight composition (its work swallows errors and the quitting guard
    // disposes any half-prepared agent), then flush the durable recall and
    // the queued user-level settings writes, then request exit. `composing`
    // and `historyWriteChain` are read at step run
    // time, so a turn that was still being queued when quit ran is included.
    // A failing step must never skip the remaining cleanup.
    const steps: QuitCleanupStep[] = [
      ...(currentSession === undefined || currentActive === undefined
        ? []
        : [
          { name: 'flush', run: async () => { await sessions.flush(currentSession); internals.stderr.write('\nResume this session: dscode resume ' + currentSession.id + '\n') } },
          { name: 'dispose', run: () => currentActive.handle.dispose() },
        ]),
      { name: 'composing', run: () => composing ?? Promise.resolve() },
      { name: 'history', run: () => historyWriteChain },
      { name: 'settings', run: () => settingsPersistence.flush() },
    ]
    if (fast) setTimeout(() => process.exit(0), 250)
    void runQuitSequence(steps, io.exit, report)
  }

  /** Run one slash line through the command registry (closed namespace). */
  const runSlash = (line: string): void => {
    const currentAgent = agent
    if (currentAgent === undefined) return
    if (line.startsWith('/resume ')) {
      requestResume(line.slice(8).trim())
      return
    }
    const registry = ctx.get('commands')
    if (registry === undefined) {
      bridge.notify(t('notice.commandRegistryMissing'), 'error')
      return
    }
    const controller = new AbortController()
    const atEpoch = epoch
    pendingControllers.add(controller)
    const finish = (): void => {
      pendingControllers.delete(controller)
    }
    // 0.1.5 registry.execute's third parameter admits submitted attachments
    // (images and file receipts); the TUI composer never attaches images to a
    // slash line, so every invocation is the empty batch (commands declaring
    // input.attachments still run attachment-free).
    void Promise.resolve().then(() => registry.execute(currentAgent, line, [], controller.signal)).then((execution) => {
      finish()
      // A switch/quit landed while the command ran: its fall-through must not
      // reach an agent that is no longer on screen.
      if (epoch !== atEpoch || agent !== currentAgent) return
      if (execution === undefined) {
        // No command owns this line: send it verbatim so a user-invocable
        // skill gesture (`/skill-name`) reaches the host's tool-skill
        // pre-step injection — the web composer's same fall-through.
        try {
          currentAgent.followup(createUserMessage({
            content: [{ type: 'text', text: line }],
            source: { kind: 'user' },
          }))
        } catch (error: unknown) {
          bridge.notify(t('notice.commandFallbackFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
        }
      }
    }, (error: unknown) => {
      finish()
      if (epoch !== atEpoch || agent !== currentAgent) return
      // A failed plan switch never appends the plan/mode event the cycle's
      // intent retirement waits for, so the in-flight choice dies here too —
      // otherwise every later Shift+Tab reads a phantom plan state.
      if (line === '/plan' || line === '/plan off') planIntent = undefined
      bridge.notify(t('notice.commandFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
    })
  }

  /** Delivery serialization state: the chain's epoch pins it to one session. */
  let deliveryChain: { epoch: number; tail: Promise<void> } = { epoch: 0, tail: Promise.resolve() }

  /** Deliver one trimmed line to the live session, expanding mentions first. */
  const deliverLine = (line: string, images: readonly ContentBlock[] = [], mode: 'followup' | 'steer' = 'followup'): void => {
    const currentAgent = agent!
    const currentMentions = mentions
    // The command registry is a closed namespace: slash lines run out of
    // band and never reach the model through this path.
    if (images.length === 0 && isSlashLine(line)) {
      runSlash(line)
      return
    }
    let parsed: ReturnType<MentionsApi['parse']>
    try {
      parsed = currentMentions.parse(line)
    } catch (error: unknown) {
      bridge.notify(`invalid session reference: ${error instanceof Error ? error.message : String(error)}`, 'error')
      return
    }
    // Ordered delivery: the inbox order IS the user's message order. A line
    // with session mentions prepares asynchronously, and a later plain line
    // used to deliver synchronously past it. Every line now waits for the
    // previous line of the same session; an epoch change (switch/quit)
    // abandons the chain instead of gating the next session on the old one.
    if (deliveryChain.epoch !== epoch) deliveryChain = { epoch, tail: Promise.resolve() }
    const enqueueDelivery = (run: () => void): void => {
      deliveryChain.tail = deliveryChain.tail.then(run)
    }
    const atEpoch = epoch
    const deliver = (readable: string, context?: UserMessage): void => {
      // A switch/quit landed while the snapshot was being prepared: never
      // deliver to an agent that is no longer on screen.
      if (epoch !== atEpoch || agent !== currentAgent) return
      // Session snapshots ride the inbox as model-facing context ahead of
      // the readable message (upstream README wiring: inject before the
      // followup/steer that wakes the driver).
      try {
        if (context !== undefined) currentAgent.inject(context)
        const content: ContentBlock[] = [
          ...(readable === '' ? [] : [{ type: 'text' as const, text: readable }]),
          ...images,
        ]
        const message = createUserMessage({
          content,
          source: { kind: 'user' },
        })
        // Steering is consumed at the next step boundary of the turn already
        // running; a followup becomes its own turn instead.
        if (mode === 'steer') currentAgent.steer(message)
        else currentAgent.followup(message)
      } catch (error: unknown) {
        bridge.notify(`${mode === 'steer' ? 'steering' : 'message'} failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
      }
    }
    if (parsed.references.length === 0) {
      enqueueDelivery(() => deliver(parsed.text))
      return
    }
    const controller = new AbortController()
    pendingControllers.add(controller)
    // `enqueueDelivery` returns nothing; the delivery chain only orders the
    // work, so the promise is consumed here with an explicit void.
    enqueueDelivery(() => {
      void currentMentions.prepare(parsed, controller.signal).then((prepared) => {
        pendingControllers.delete(controller)
        deliver(prepared.text, prepared.additionalContext)
      }, (error: unknown) => {
        pendingControllers.delete(controller)
        if (controller.signal.aborted || epoch !== atEpoch) return
        bridge.notify(`session reference failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
      })
    })
  }

  // Deferred first-session creation for a bare launch: the session is composed
  // only when the user submits real input (or /new), and every line that
  // arrives during creation is delivered in order afterwards. A creation
  // failure reports and clears the queue, leaving the transient state ready
  // for the next attempt.
  const pendingInputs: Array<{ text: string; mode: 'followup' | 'steer'; images: readonly ContentBlock[] }> = []
  // A creation is queued/running: further submissions must not mint more
  // fresh sessions (their lines queue into pendingInputs instead).
  let creating = false
  const ensureSession = (mode?: string): void => {
    if (creating) return
    creating = true
    void compose(async () => {
      try {
        // A direct `/mode <preset>` resolves asynchronously. Preserve submit
        // order so the first composition cannot race ahead with the old mode.
        await pendingModeWork
        // Another composition (e.g. a /resume activated while this creation
        // waited its turn) may have published a session already: deliver the
        // queued lines there instead of minting a competing fresh session
        // (which would orphan the live one without a dispose).
        if (session !== undefined) {
          const queued = pendingInputs.splice(0)
          for (const item of queued) deliverLine(item.text, item.images, item.mode)
          return
        }
        const next = await prepare({
          sessionId: `session-${randomUUID()}`,
          resume: false,
          ...(mode === undefined ? {} : { mode }),
        })
        if (quitting) {
          void next.handle.dispose().catch(() => {})
          return
        }
        const previous = { active, agent, session, store, mentions }
        try {
          active = next
          agent = next.agent
          session = next.session
          store = next.store
          mentions = next.mentions
          subagents.reset()
          for (const event of next.catalogSeed) subagents.apply(event.data.childId, event)
          pendingMode = undefined
          pendingPermission = undefined
          commands.setAgent(agent)
          skills.setAgent(agent)
          // The App mounts with a placeholder key until the first input; the
          // key-change remount below must start from a clean screen or the ghost
          // static header stays visible above the new one (same source-backed
          // clear the session-switch path performs).
          process.stdout.write('\x1b[r\x1b[0m\x1b[H\x1b[2J\x1b[3J\x1b[H')
          renderCurrent()
        } catch (error: unknown) {
          // The session composed but the screen handoff threw (stdout EPIPE,
          // a render-time failure). Roll the published state back exactly
          // like the switch path does — otherwise the runner reports "session
          // creation failed" while the new session is actually live, clears
          // the queued inputs, and every later line lands in the ghost. The
          // queued inputs are KEPT for the next attempt.
          active = previous.active
          agent = previous.agent
          session = previous.session
          store = previous.store === undefined ? createTranscriptStore() : previous.store
          mentions = previous.mentions === undefined ? createMentions(ctx, undefined, cwd) : previous.mentions
          if (agent !== undefined) {
            commands.setAgent(agent)
            skills.setAgent(agent)
          }
          await next.handle.dispose().catch(() => {})
          if (!quitting) renderCurrent()
          bridge.notify(`session activation failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
          return
        }
        abortPendingControllers()
        epoch += 1
        const queued = pendingInputs.splice(0)
        if (pendingPlan) {
          pendingPlan = false
          // A pre-session plan choice materializes as the registry command
          // delivered AHEAD of the queued lines, so the first assembled step
          // of the user's opening message already runs in plan mode.
          deliverLine('/plan')
        }
        for (const item of queued) deliverLine(item.text, item.images, item.mode)
      } finally {
        creating = false
      }
    }).catch((error: unknown) => {
      pendingInputs.length = 0
      bridge.notify(`session creation failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    })
  }

  /** Deliver one readable line to the agent, expanding session mentions first. */
  const sendNow = (text: string, images: readonly ContentBlock[] = [], mode: 'followup' | 'steer' = 'followup'): void => {
    // Blank check on the trimmed form; the payload itself keeps the draft's
    // exact whitespace unless the line is a syntactic slash command.
    const line = submissionPayload(text)
    if (line.trim() === '' && images.length === 0) return
    if (images.length === 0 && line.startsWith('/mode ')) {
      void switchModeAction(line.slice(6).trim()).then(
        selected => bridge.notify(`mode → ${selected}`),
        error => bridge.notify(`mode switch failed: ${error instanceof Error ? error.message : String(error)}`, 'error'),
      )
      return
    }
    if (images.length === 0 && line.startsWith('/permission ')) {
      try {
        const selected = setPermissionAction(line.slice(12).trim())
        bridge.notify(`permission → ${selected}`)
      } catch (error: unknown) {
        bridge.notify(`permission change failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
      }
      return
    }
    if (session === undefined) {
      // The delivery mode rides the buffered line: a steer picked before the
      // first session exists must still steer once that session composes.
      pendingInputs.push({ text: line, mode, images })
      ensureSession()
      return
    }
    deliverLine(line, images, mode)
  }

  // Startup serialization: input submitted while the startup prompt/images
  // are still preparing queues behind the initial request.
  const inputGate = new StartupInputGate(({ text, mode, images }) => sendNow(text, images, mode))
  const send = (text: string, images: readonly ContentBlock[] = [], mode: 'followup' | 'steer' = 'followup'): void => {
    inputGate.submit({ text, mode, images })
  }

  /** Dispatch one submitted line: slash commands to the registry, other text to the agent. */
  const dispatch = (text: string, images: readonly ContentBlock[] = [], origin?: string): void => {
    // An attachment prepare resolved after the app remounted onto another
    // session (queued switch): the composing session is gone, so the stale
    // delivery is dropped instead of landing in the new session's inbox.
    if (!submissionBelongsToSession(origin, session?.id)) return
    send(text, images)
  }

  /**
   * Deliver one line as steering: a running driver consumes it at its next
   * step boundary, an idle one starts a turn with it. The composer's Tab
   * toggle picks this over {@link dispatch} for the next submission.
   */
  const steer = (text: string, images: readonly ContentBlock[] = [], origin?: string): void => {
    if (!submissionBelongsToSession(origin, session?.id)) return
    send(text, images, 'steer')
  }

  /**
   * Interrupt the running turn (Esc); true when a turn was actually
   * cancelled. {@link cancelPreservingQueue} keeps the next-turn queue alive
   * AND re-wakes the driver, so the preserved messages run instead of
   * parking; next-step steering dies with the turn.
   */
  const interrupt = (): boolean => {
    if (agent === undefined || agent.status !== 'running') return false
    try {
      const preserved = cancelPreservingQueue(agent)
      bridge.notify(t(preserved > 0 ? 'notice.turnCancelledKeepQueue' : 'notice.turnCancelled'))
      return true
    } catch (error: unknown) {
      bridge.notify(`cancel failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
      return false
    }
  }

  /** Select one permission preset before the first session or on the active one. */
  const setPermissionAction = (id: string): string => {
    if (permissionPresets === undefined || permissionPresets.names.length === 0) {
      throw new Error('permission presets are not mounted in this composition')
    }
    if (id === '') throw new Error('usage: /permission <preset>')
    const selected = selectPermission(permissionPresets, session, id)
    if (session === undefined) {
      pendingPermission = selected
      renderCurrent()
    }
    return selected
  }

  /**
   * Shift+Tab mode cycle: permission presets in table order, then the plan
   * station when the composition offers the /plan command (preset-mounted,
   * so minimal sessions and the pre-session state cycle permissions only).
   * Plan transitions submit the upstream registry command — it stays the
   * single owner of plan state; the TUI renders the durable plan/mode event
   * it appends. Because that event lags the press (upstream queues the
   * switch during an open turn), each mid-session plan decision records the
   * choice in `planIntent` and the next press reads it back, so the cycle
   * advances stations instead of re-issuing one transition. Returns the
   * notice label, or '' when nothing changed.
   */
  const cycleMode = (): string => {
    if (permissionPresets === undefined || permissionPresets.names.length === 0) {
      bridge.notify('permission presets are not mounted in this composition', 'warning')
      return ''
    }
    try {
      // Pre-session the plan station rides the pending choice; once a
      // session exists the scoped /plan command descriptor decides, and the
      // durable plan/mode event is the live truth.
      const preSession = session === undefined
      if (preSession && !preSessionPlanKnown) refreshPreSessionPlan()
      const decision = planCycleDecision({
        names: permissionPresets.names,
        current: effectivePermission(permissionPresets, session, pendingPermission),
        inPlan: preSession ? pendingPlan : store.getView().plan === true,
        ...(preSession ? {} : { planIntent }),
        planAvailable: preSession ? preSessionPlanAvailable : commands.descriptors.some(descriptor => descriptor.name === 'plan'),
      })
      if (decision === undefined) return ''
      if (decision.kind === 'permission') {
        const next = selectPermission(permissionPresets, session, decision.preset)
        if (preSession) {
          pendingPermission = next
          renderCurrent()
        }
        return `permission → ${next}`
      }
      if (decision.kind === 'plan-on') {
        // Plan IS the most restrictive preset plus the plan prompt layer:
        // the cycle arrives here from that preset, so permission needs no
        // switch — only the plan mode itself toggles.
        if (preSession) {
          pendingPlan = true
          renderCurrent()
          return 'plan → on (applies to the first session)'
        }
        planIntent = true
        send('/plan')
        return 'plan → on'
      }
      // Leaving plan lands on the station after the most restrictive
      // preset (workspace-write with the shipped table).
      if (preSession) {
        pendingPlan = false
        pendingPermission = decision.preset
        renderCurrent()
        return `plan → off · permission → ${decision.preset}`
      }
      planIntent = false
      send('/plan off')
      selectPermission(permissionPresets, session, decision.preset)
      return `plan → off · permission → ${decision.preset}`
    } catch (error: unknown) {
      bridge.notify(`mode change failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
      return ''
    }
  }

  /**
   * Apply one /model selection: takes effect from the next assembled step.
   * The optional reasoning effort must be one the row advertises (the picker
   * only offers those), so an unsupported value cannot reach the request
   * pipeline; an absent effort restores the model's own default.
   */
  const selectModel = (row: ModelRow, effortId?: string): string => {
    const selection = buildModelSelection(row, effortId)
    if (active === undefined) {
      // A bare launch has no session yet: keep the pick process-wide so the
      // first composed session starts from it.
      pendingSelection = selection
    } else {
      active.selection.picked = selection
    }
    // Global default (web selectModel parity): every pick is persisted as the
    // deployment default through the same agentDefaultModel service the web
    // host writes, so the choice survives restarts and other surfaces read
    // it. Save failures degrade to a notice — the in-session switch already
    // took effect and must not roll back (the web contract).
    void defaultModel.saveSelection(selection).catch((error: unknown) => {
      bridge.notify(`model switch applies to this session but was not saved as the default: ${error instanceof Error ? error.message : String(error)}`, 'warning')
    })
    // Advisory immediate validation (web selectModel parity): run the same
    // local resolveCallConfig check the request pipeline would, so a stale
    // directory — an effort the adapter withdrew since /model loaded —
    // surfaces as a pick-time notice instead of failing the next assembled
    // step. Best-effort: an llm service without the resolver keeps the
    // existing request-boundary rejection. Called as a method (`this`-bound)
    // like resolveModelInfo in models.ts.
    const llm = ctx.get('llm')
    const resolveCallConfig = (llm as {
      resolveCallConfig?: (this: unknown, config: { provider: string; model: string; reasoningEffort?: string }) => Promise<unknown>
    } | undefined)?.resolveCallConfig
    if (llm !== undefined && typeof resolveCallConfig === 'function') {
      void Promise.resolve(resolveCallConfig.call(llm, {
        provider: selection.provider,
        model: selection.model,
        ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort },
      })).catch((error: unknown) => {
        bridge.notify(`model selection rejected: ${error instanceof Error ? error.message : String(error)} — reopen /model to pick again`, 'error')
      })
    }
    return `${row.provider}/${row.model}`
  }

  // dscode: measure the picked route against the live context so /model can ask
  // before a switch that would compact the conversation.
  const dscodeCompactionPreviewFor = async (row: ModelRow): Promise<DscodeCompactionPreview | undefined> => {
    const meter = ctx.get('tokenMeter') as { measure?: (session: unknown) => { totalTokens: number } } | undefined
    const llm = ctx.get('llm') as { resolveModelInfo?: (provider: string, model: string) => Promise<{ context?: { contextWindow?: number } } | undefined> } | undefined
    const session = active?.session
    if (session === undefined || typeof meter?.measure !== 'function' || typeof llm?.resolveModelInfo !== 'function') return undefined
    const used = meter.measure(session).totalTokens
    const info = await llm.resolveModelInfo(row.provider, row.model)
    return dscodeCompactionPreview({
      used,
      contextWindow: info?.context?.contextWindow,
      thresholdRatio: await dscodePricedThresholdRatio(row.provider, row.model),
      label: row.provider + '/' + row.model,
    })
  }

  /** The /subagent override label, '' when delegated agents follow the current model. */
  const subagentModelLabel = (): string => subagentOverride === undefined ? '' : modelSelectionLabel(subagentOverride)

  /** Apply one /subagent model pick; returns the override label. */
  const setSubagentModel = (row: ModelRow, effortId?: string): string => {
    subagentOverride = buildModelSelection(row, effortId)
    renderCurrent()
    return modelSelectionLabel(subagentOverride)
  }

  /** Drop the /subagent override: delegated agents follow the current model again. */
  const clearSubagentModel = (): void => {
    subagentOverride = undefined
    renderCurrent()
  }

  /**
   * Export the folded transcript to a markdown file (/export). The default
   * target sits beside the session's cwd so the file lands in the user's
   * workspace; an absolute or cwd-relative argument overrides it.
   */
  const exportTranscript = async (argument: string): Promise<void> => {
    if (session === undefined) {
      bridge.notify('no session yet — submit a message to start', 'warning')
      return
    }
    const wanted = argument.trim()
    const sessionCwd = session.header.cwd ?? cwd
    // The default name derives from the session id, which `--session` lets the
    // user spell freely: reduce it to filename-safe characters first so the
    // default target can never escape the session cwd.
    const defaultName = `dsh-session-${exportSessionIdSuffix(session.id)}.md`
    const target = wanted === ''
      ? join(sessionCwd, defaultName)
      : /^[a-zA-Z]:[\\/]/u.test(wanted) || wanted.startsWith('/')
        ? wanted
        : join(sessionCwd, wanted)
    const markdown = buildExportMarkdown(store.getView(), session.id)
    try {
      await writeFileAsync(target, `${markdown}\n`, 'utf8')
      bridge.notify(`exported to ${target}`)
    } catch (error: unknown) {
      bridge.notify(`export failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  /**
   * Rename the session (/title): a user title pins the session and stops
   * automatic generation (the service's own contract). The appended
   * `session/title` event flows back through the store into the status line.
   */
  const renameTitle = (argument: string): string => {
    const title = argument.trim()
    if (title === '') return 'usage: /title <text>'
    if (session === undefined) return 'no session yet — submit a message to start'
    const service = ctx.get('sessionTitle')
    if (service === undefined) return 'session titles are unavailable in this profile'
    try {
      service.rename(session, title)
      return `title → ${title}`
    } catch (error: unknown) {
      return `rename failed: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  const loadSessions = async (options: SessionDirectoryOptions, signal?: AbortSignal): Promise<readonly SessionRow[]> => {
    if (sessionQuery === undefined) throw new Error('session query is unavailable in this profile')
    const records = await sessionQuery.listSessions(signal)
    // Last-activity timestamps for sorting (codex UpdatedAt default): the
    // newest generation artifact's mtime under the JSONL layout. 0.1.5 dropped
    // the persistence `locate()` query, so paths are derived from the
    // backend's public config root. Backends without a JSONL config (or
    // vanished directories) fall back to createdAt inside the projection.
    const root = jsonlSessionRoot(persistence)
    const updated = new Map<string, number>()
    if (root !== undefined) {
      await Promise.all(records.map(async record => {
        try {
          const dir = sessionDirectoryFor(root, record.header.cwd, record.header.id)
          const entries = await readdir(dir, { withFileTypes: true })
          const stats = await Promise.all(
            entries.filter(entry => entry.isFile() && isSessionArtifactName(entry.name))
              .map(entry => stat(join(dir, entry.name))),
          )
          const newest = Math.max(...stats.map(info => info.mtimeMs))
          if (Number.isFinite(newest)) updated.set(record.header.id, newest)
        } catch {
          // Artifact gone or unreadable: the projection falls back to createdAt.
        }
      }))
    }
    const projected = projectSessionRows(records, options, updated)
    // Titles are the expensive fold. Fetch only the first bounded picker page;
    // navigation/filter changes trigger a fresh, cancellable observation.
    const page = projected.slice(0, 32)
    if (page.length === 0) return projected
    const observations = await sessionQuery.readTitleSnapshots(page.map(row => row.id), signal)
    return mergeSessionTitles(projected, observations)
  }

  /**
   * Delete one session subtree (/delete, codex semantics: subagent threads go
   * with their root). The kernel persistence seam has NO deletion API by
   * design — logs accumulate "until removed externally" — so this is the
   * controlled external removal, in three phases with a hard boundary
   * between planning and touching the filesystem:
   *
   * 1. `planSessionDeletion` collects the subtree and refuses when the root
   *    or ANY member is live (a live child would outlive its deleted
   *    parent), ordering the plan children-first.
   * 2. Every plan node must derive to a guarded artifact directory
   *    (`encodeSegment(id)` layout beneath the backend's config root).
   *    Backends without a derivable artifact (non-JSONL) refuse the WHOLE
   *    deletion here — no file has been touched yet, so a backend or layout
   *    surprise can never strand a half-deleted subtree.
   * 3. Artifacts are removed children-first: only an I/O error mid-delete
   *    can stop it short (reported with removed/total counts), leaving the
   *    shallowest lineage intact.
   *
   * @param id - the root session id to delete.
   * @returns the outcome line for the panel/notice.
   */
  const deleteSession = async (id: string): Promise<string> => {
    if (sessionQuery === undefined) return 'session query is unavailable in this profile'
    if (session !== undefined && session.id === id) return 'cannot delete the session you are using — switch or /new first'
    const records = await sessionQuery.listSessions()
    const plan = planSessionDeletion(records, id)
    if (!plan.ok) return plan.reason
    // Phase 2 completes the plan before the first rm: derive and
    // layout-check every node up front, so a refusal never leaves a
    // partially removed subtree behind.
    const root = jsonlSessionRoot(persistence)
    if (root === undefined) {
      return 'session backend exposes no deletable artifact (deletion is unsupported on this backend)'
    }
    const byId = new Map<string, (typeof records)[number]>(records.map(record => [record.header.id, record]))
    const dirs = new Map<string, string>()
    for (const node of plan.nodes) {
      const record = byId.get(node.id)
      if (record === undefined) return `no persisted session matches "${node.id}"`
      const dir = sessionArtifactDirectory(sessionDirectoryFor(root, record.header.cwd, node.id), node.id)
      if (dir === undefined) {
        return `refusing to delete: unexpected artifact layout for ${node.id.slice(-12)}`
      }
      dirs.set(node.id, dir)
    }
    let removed = 0
    for (const node of plan.nodes) {
      const dir = dirs.get(node.id)!
      try {
        // Remove every canonical generation artifact this build knows; other
        // sibling files are never ours to delete, and the directory itself is
        // only removed once empty. An unreadable directory counts as a
        // failure (not a silent success) so the outcome line stays honest.
        const entries = await readdir(dir, { withFileTypes: true })
        for (const entry of entries) {
          if (entry.isFile() && isSessionArtifactName(entry.name)) {
            await rm(join(dir, entry.name), { force: true })
          }
        }
        await rm(dir, { force: true, recursive: false }).catch(() => {})
        removed += 1
      } catch (error: unknown) {
        return `delete failed for ${node.id.slice(-12)} after ${removed} of ${plan.nodes.length}: ${error instanceof Error ? error.message : String(error)}`
      }
    }
    return `deleted ${removed} session${removed === 1 ? '' : 's'}`
  }

  const loadSessionTranscript = async (id: string, signal?: AbortSignal): Promise<string> => {
    if (sessionQuery === undefined) throw new Error('session query is unavailable in this profile')
    const snapshot = await sessionQuery.readSession(id, signal)
    return buildExportMarkdown(createTranscriptStore(snapshot.events).getView(), snapshot.session.id)
  }

  /**
   * Read one session's usage blocks for the /usage panel: the mounted
   * projection's session totals plus the meter's own per-turn fold over the
   * durable log (which the panel merges by model). A deployment without the
   * projection registry renders the totals as explicitly unavailable rather
   * than as zeros. The read is synchronous — the registry materializes a cell
   * on first touch — so it is handed to the panel behind a resolved promise,
   * which keeps the fold out of the keystroke that opens the panel.
   * @param current - the session to read, or undefined before the first one.
   * @returns the resolved panel data.
   */
  const loadUsage = (current: Session | undefined): Promise<UsageView> => {
    if (current === undefined) return Promise.resolve({ turns: [] })
    const values = ctx.get('sessionProjections')?.snapshot(current, ['tokenUsage']).values
    return Promise.resolve({
      totals: values?.tokenUsage,
      turns: turnUsages(current.snapshotEvents(), deriveTurnTokenUsage),
    })
  }

  const switchModeAction = async (id: string): Promise<string> => {
    if (id === '') throw new Error('usage: /mode <preset>')
    const currentAgent = agent
    if (currentAgent === undefined) {
      const choice = pendingModeWork.then(async () => {
        const preset = await selectPreset(presets, undefined, id)
        // A resume may have won while this roster read was in flight; never
        // leak the old pending choice into a later /new session.
        if (agent === undefined) {
          pendingMode = preset.id
          renderCurrent()
        }
        return preset.id
      })
      pendingModeWork = choice.then(() => {}, () => {})
      return choice
    }


    // Serialize the recomposition with session activations: a /mode that
    // interleaves a switch must not rebind the shared command/skill
    // registries while the switch is composing the next agent.
    const currentActive = active
    const atEpoch = epoch
    let selected: string | undefined
    await compose(async () => {
      const preset = await selectPreset(presets, currentAgent, id)
      // A switch/quit landed while the recomposition ran: applying here
      // would write the old choice into the new session's state and rebind
      // the registries back to a disposed agent. The preset-selection log
      // entry rode the old agent's session; only the local application is
      // dropped.
      if (epoch !== atEpoch || agent !== currentAgent || active !== currentActive) {
        throw new Error('session changed while switching mode — nothing applied; retry in the active session')
      }
      if (active === undefined) throw new Error('active Agent has no session state')
      active.mode = preset.id
      commands.setAgent(currentAgent)
      skills.setAgent(currentAgent)
      selected = preset.id
      renderCurrent()
    })
    return selected!
  }

  interface PendingSwitch { readonly target: Target; readonly label: string }

  const activate = (nextTarget: Target): Promise<void> => {
    if (quitting) return Promise.resolve()
    // Serialized with every other composition (bare-launch creation, queued
    // switches): at most one agent is composed at a time.
    return compose(async () => {
      const previous = active
      const next = await prepare(nextTarget)
      // Quit landed while the next session was being composed: dispose the
      // half-ready agent and leave the current session untouched.
      if (quitting) {
        await next.handle.dispose().catch(() => {})
        return
      }
      active = next
      agent = next.agent
      session = next.session
      store = next.store
      mentions = next.mentions
      commands.setAgent(agent)
      skills.setAgent(agent)
      try {
        // Reseed the feed BEFORE the first frame of the new session so no
        // stale row from the previous one flashes; a rolled-back handoff
        // re-seeds the previous session's catalog the same way.
        subagents.reset()
        for (const event of next.catalogSeed) subagents.apply(event.data.childId, event)
        process.stdout.write('\x1b[r\x1b[0m\x1b[H\x1b[2J\x1b[3J\x1b[H')
        renderCurrent()
        // Only a successful handoff may clear the transient per-session
        // surfaces: a rolled-back switch keeps the previous session's
        // subagent feed plus the user's pre-session /mode and permission
        // picks (the bare-launch promise: explicit choices survive until
        // composition takes them). The in-flight cycle intent belonged to
        // the previous session's presses; the new session's committed fold
        // decides from here.
        pendingMode = undefined
        pendingPermission = undefined
        pendingPlan = false
        planIntent = undefined
      } catch (error: unknown) {
        active = previous
        agent = previous?.agent
        session = previous?.session
        store = previous === undefined ? createTranscriptStore() : previous.store
        mentions = previous === undefined ? createMentions(ctx, undefined, cwd) : previous.mentions
        if (agent !== undefined) commands.setAgent(agent)
        if (agent !== undefined) skills.setAgent(agent)
        subagents.reset()
        if (previous !== undefined) {
          for (const event of previous.catalogSeed) subagents.apply(event.data.childId, event)
        }
        // The failed handoff disposed the incoming session; the restored
        // store's committed plan fold is the truth, so any cycle intent
        // collected against the switch churn retires too.
        planIntent = undefined
        await next.handle.dispose()
        if (!quitting) renderCurrent()
        throw error
      }
      // From here the new session is live: in-flight prepares/commands for
      // the previous agent are stale and must be aborted and ignored.
      abortPendingControllers()
      epoch += 1
      // No previous session (a bare launch switched straight into a resume):
      // nothing to flush or dispose, so just confirm the activation.
      if (previous === undefined) {
        // The key-change remount above swaps the App in this same synchronous
        // continuation; the new App registers its bridge.notify in a passive
        // effect AFTER it, so an immediate notice reaches the UNMOUNTED
        // instance and React drops it silently. Defer past the commit.
        setTimeout(() => {
          bridge.notify(`${next.resumed ? 'resumed' : 'created'} ${next.session.id.slice(-12)} · mode ${next.mode}`)
        }, 0)
        return
      }
      let cleanupWarning: string | undefined
      try {
        await sessions.flush(previous.session)
      } catch (error: unknown) {
        cleanupWarning = `previous session flush failed: ${error instanceof Error ? error.message : String(error)}`
      }
      try {
        await previous.handle.dispose()
      } catch (error: unknown) {
        cleanupWarning = `${cleanupWarning === undefined ? '' : `${cleanupWarning}; `}previous agent release failed: ${error instanceof Error ? error.message : String(error)}`
      }
      bridge.notify(cleanupWarning === undefined
        ? `${next.resumed ? 'resumed' : 'created'} ${next.session.id.slice(-12)} · mode ${next.mode}`
        : `switched to ${next.session.id.slice(-12)}, but ${cleanupWarning}`,
      cleanupWarning === undefined ? 'info' : 'warning')
    })
  }

  const switchQueue = new SessionSwitchQueue<PendingSwitch>(
    async request => { if (!quitting) await activate(request.target) },
    error => bridge.notify(`session switch failed: ${error instanceof Error ? error.message : String(error)}`, 'error'),
  )

  const requestSwitch = (request: PendingSwitch): void => {
    if (session === undefined) {
      // No session yet (a bare launch using /resume before any input): activate
      // the target directly — there is no running turn to wait on and nothing
      // to flush.
      void activate(request.target).catch((error: unknown) => {
        bridge.notify(`session switch failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
      })
      return
    }
    if (request.target.sessionId === session.id) {
      bridge.notify('that session is already active', 'warning')
      return
    }
    const outcome = switchQueue.request(agent!, request)
    if (outcome === 'queued') {
      bridge.notify(`will switch to ${request.label} when the current turn finishes · /resume cancel to abort`)
    }
  }

  const resolveResumeId = async (wanted: string): Promise<string> => {
    if (wanted === '') throw new Error('usage: /resume <id|prefix>')
    if (sessionQuery === undefined) throw new Error('session query is unavailable in this profile')
    const records = await sessionQuery.listSessions()
    const exact = records.filter(record => record.header.id === wanted)
    const matches = exact.length > 0 ? exact : records.filter(record => record.header.id.startsWith(wanted))
    if (matches.length === 0) throw new Error(`no session matches "${wanted}"`)
    if (matches.length > 1) throw new Error(`session prefix "${wanted}" is ambiguous (${matches.length} matches)`)
    const matched = matches[0]
    // Same lineage gate as the CLI --resume path and the picker.
    if (isSubagentSession(matched.header)) {
      throw new Error('subagent conversations are read-only; resume a root session')
    }
    if (session !== undefined && agents.get(SessionId(matched.header.id)) !== undefined && matched.header.id !== session.id) {
      throw new Error('that session is already live in another owner')
    }
    return matched.header.id
  }

  const requestResume = (wanted: string): void => {
    void resolveResumeId(wanted).then(id => {
      requestSwitch({ target: { sessionId: id, resume: true }, label: id.slice(-12) })
    }, (error: unknown) => bridge.notify(`resume failed: ${error instanceof Error ? error.message : String(error)}`, 'error'))
  }

  const createSession = (mode?: string): void => {
    // /new before any input is the first-session creation itself, not a switch.
    if (session === undefined) {
      ensureSession(mode)
      return
    }
    const nextCwd = session.header.cwd ?? cwd
    const id = `session-${randomUUID()}`
    requestSwitch({ target: { sessionId: id, resume: false, mode, cwd: nextCwd }, label: id.slice(-12) })
  }

  const reviewChanges = (selection: ReviewSelection): void => {
    // Works from a bare launch too: with no session yet the read-only
    // choice goes to pendingPermission (materialized when the first
    // session composes) and the review prompt queues behind that
    // creation exactly like a typed first submission. The identity guard
    // below still aborts a load that outlives a mid-flight switch —
    // including one landing on an undefined agent.
    const currentAgent = agent
    // The diff loads from the CALLING session's cwd; capture that
    // workspace and this turn's identity so a switch mid-load can neither
    // flip the new session read-only nor send the old workspace's review
    // into it. The controller rides pendingControllers, so a switch/quit
    // kills the git subprocess itself instead of only ignoring its result.
    const atEpoch = epoch
    const reviewCwd = session?.header.cwd ?? cwd
    const controller = new AbortController()
    pendingControllers.add(controller)
    const finish = (): void => {
      pendingControllers.delete(controller)
    }
    // Branch reviews diff from the precomputed merge base (what would
    // actually land), commit reviews the commit's own patch, everything
    // else reviews the uncommitted working tree.
    const load = selection.kind === 'commit'
      ? loadCommitDiff(reviewCwd, selection.sha, controller.signal)
      : selection.kind === 'base-branch'
        ? mergeBaseWith(reviewCwd, selection.branch, controller.signal)
          .then(base => loadGitDiff(reviewCwd, base ?? selection.branch, controller.signal))
        : loadGitDiff(reviewCwd, '', controller.signal)
    const note = selection.kind === 'custom' ? selection.instructions : undefined
    void load.then(({ title, files }) => {
      finish()
      if (controller.signal.aborted || epoch !== atEpoch || agent !== currentAgent) return
      try {
        setPermissionAction('read-only')
      } catch (error: unknown) {
        bridge.notify(t('notice.reviewUnavailable', { message: error instanceof Error ? error.message : String(error) }), 'error')
        return
      }
      send(buildReviewPrompt(files.flatMap(file => file.lines).join('\n'), title, note))
      bridge.notify(t('notice.reviewStarted'))
    }, (error: unknown) => {
      finish()
      if (controller.signal.aborted || epoch !== atEpoch) return
      bridge.notify(t('notice.reviewFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
    })
  }

  const forkSession = (argument: string): void => {
    if (session === undefined || active === undefined) {
      bridge.notify('no session yet - submit a message to start', 'warning')
      return
    }
    try {
      const text = argument.trim()
      const atSeq = text === '' ? undefined : Number(text)
      if (text !== '' && (!Number.isSafeInteger(atSeq) || (atSeq ?? -1) < 0)) {
        throw new Error('usage: /fork [event-seq]')
      }
      const seed = selectForkSeed(session.snapshotEvents(), atSeq)
      const id = `session-${randomUUID()}`
      requestSwitch({
        target: {
          sessionId: id,
          resume: false,
          mode: active.mode,
          cwd: session.header.cwd ?? cwd,
          seed: seed.events,
          parentSession: session.id,
          seedLength: seed.events.length,
        },
        label: id.slice(-12),
      })
    } catch (error: unknown) {
      bridge.notify(`fork failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    }
  }

  const switchSession = (row: SessionRow): void => {
    if (!row.resumable) {
      bridge.notify('subagent conversations are read-only', 'warning')
      return
    }
    requestSwitch({ target: { sessionId: row.id, resume: true }, label: row.title ?? row.id.slice(-12) })
  }

  // /search reads the SAME in-process engine the model's session_search
  // tools use (the bundle's skip-tolerant subclass). The row may be disabled
  // by a deployment; /search then degrades to a notice instead of a panel.
  const searchSessions = sessionQuery === undefined
    ? undefined
    : async (query: string, signal?: AbortSignal): Promise<readonly SearchRow[]> => {
      const page = await sessionQuery.searchSessions({ query, limit: 30 }, signal === undefined ? undefined : { signal })
      const rows = page.items.map(hit => searchHitToRow(hit))
      // Best-effort title enrichment (the same snapshots /resume merges):
      // a failure keeps the short-id labels instead of failing the search.
      try {
        const observations = await sessionQuery.readTitleSnapshots(rows.map(row => row.id), signal)
        const titles = new Map<string, string>()
        for (const observation of observations) {
          if (observation.status !== 'fulfilled') continue
          const title = observation.value?.title?.title
          if (title !== undefined && title.trim() !== '') titles.set(observation.sessionId, title)
        }
        return rows.map(row => titles.has(row.id) ? { ...row, label: titles.get(row.id)! } : row)
      } catch {
        return rows
      }
    }

  const cancelSessionSwitch = (): boolean => {
    return switchQueue.cancel()
  }

  const appElement = (): ReturnType<typeof createElement> => {
    // A bare launch mounts with pending/default model, mode, and permission
    // facts until the first input composes the real session. These choices stay
    // process-local and create no durable state before that composition.
    const sessionCwd = session?.header.cwd ?? cwd
    const currentView = store.getView()
    const defaults = currentDefaults()
    const model = currentView.model !== ''
      ? currentView.model
      : pendingSelection !== undefined
        ? `${pendingSelection.provider}/${pendingSelection.model}`
        : `${defaults.provider}/${defaults.model}`
    const effort = resolveEffectiveSelection(
      active?.selection.picked ?? pendingSelection,
      session?.requestHeader()?.config,
      defaults,
    ).reasoningEffort
    const permission = permissionPresets === undefined
      ? currentView.permission
      : effectivePermission(permissionPresets, session, pendingPermission)
    return createElement(App, {
      key: session?.id ?? 'pending',
      sessionKey: session?.id ?? '',
      store,
      approval,
      questions,
      subagents,
      commands,
      skills,
      model,
      effort,
      cwd: basename(sessionCwd),
      workspaceRoot: sessionCwd,
      branch: gitBranch(sessionCwd),
      sessionId: session === undefined ? '' : session.id.slice(-8),
      resumed: active?.resumed ?? false,
      mode: active?.mode ?? pendingMode ?? normalizePresetId(presets.defaultId),
      permission,
      /** Pre-session plan choice for the status badge until a session composes. */
      pendingPlan: session === undefined && pendingPlan,
      dispatch,
      steer,
      interrupt,
      quit,
      loadModels: () => dscodeMigrateOpenRouter(ctx.get('settings')).then(() => loadModelDirectory(ctx)),
      dscodeEnsureProviderRoute: (provider: string) => dscodeEnsureProviderRoute(ctx.get('settings'), provider),
      dscodeManagementKeyStatus: () => dscodeManagementKeyStatus(ctx),
      dscodeSaveManagementKey: (key: string) => dscodeSaveManagementKey(ctx, key),
      dscodeLoadOpenRouterAccount: () => dscodeLoadOpenRouterAccountFor(ctx),
      loadModelProviders: () => loadProviderSettings(ctx),
      subscribeModelProviders: listener => subscribeProviderSettings(ctx, listener),
      saveModelProviderCredential: (target, key) => saveProviderCredential(ctx, target, key),
      saveModelProviderConfiguration: (target, configuration) => saveProviderConfiguration(ctx, target, configuration),
      discoverModelProvider: (target, request, signal) => discoverProviderModels(ctx, target, request, signal),
      unsetModelProviderCredential: target => unsetProviderCredential(ctx, target),
      removeModelProvider: target => removeProviderSettings(ctx, target),
      loadProviderAuthorizations: () => loadProviderAuthorizations(ctx),
      subscribeProviderAuthorizations: listener => subscribeProviderAuthorizations(ctx, listener),
      beginProviderAuthorization: (row, method, interaction, signal) => (
        beginProviderAuthorization(ctx, row, method, interaction, signal)
      ),
      cancelProviderAuthorization: row => cancelProviderAuthorization(ctx, row.key),
      logoutProviderAuthorization: row => logoutProviderAuthorization(ctx, row),
      openAuthorizationUrl,
      copyTextValue: copyText,
      loadMentions: (query: string, signal?: AbortSignal) => mentions.candidates(query, signal),
      inspectImages: paths => inspectImagePaths(paths, ctx.get('attachments'), session?.header.cwd ?? cwd),
      prepareImages: (paths, signal) => saveImagePaths(paths, ctx.get('attachments'), signal),
      inspectFiles: paths => inspectFilePaths(paths, ctx.get('attachments'), session?.header.cwd ?? cwd),
      prepareFiles: (paths, signal) => saveFilePaths(paths, ctx.get('attachments'), signal),
      cycleMode,
      setPermission: setPermissionAction,
      selectModel,
      dscodeCompactionPreview: dscodeCompactionPreviewFor,
      subagentModel: subagentModelLabel(),
      setSubagentModel,
      clearSubagentModel,
      deleteSession,
      exportTranscript,
      renameTitle,
      copyLastResponse,
      loadGitDiff: (argument: string) => loadGitDiff(session?.header.cwd ?? cwd, argument),
      listReviewBranches: (signal?: AbortSignal) => listReviewBranches(session?.header.cwd ?? cwd, signal),
      listReviewCommits: (signal?: AbortSignal) => listReviewCommits(session?.header.cwd ?? cwd, signal),
      reviewChanges,
      loadPresets: () => presets.list(),
      switchMode: switchModeAction,
      loadPermissions: () => permissionPresets === undefined
        ? Promise.reject(new Error('permission presets are not mounted in this composition'))
        : Promise.resolve(listPermissionRows(permissionPresets)),
      createSession,
      forkSession,
      loadSessions,
      loadSessionTranscript,
      loadUsage: () => loadUsage(session),
      loadSubagents: () => {
        const current = session
        if (current === undefined || sessionQuery === undefined) return Promise.resolve([])
        return loadSessions({ sessions: 'all', cwd: 'all', sort: 'newest', currentCwd: current.header.cwd ?? cwd, query: '' })
          .then(rows => rows.filter(row => row.parent === current.id && row.subagent))
      },
      switchSession,
      searchSessions,
      cancelSessionSwitch,
      loadPlugins: () => listPluginRows(ctx),
      // The launcher owns every update decision; the TUI only drives its
      // read-only probe and streamed apply as child processes.
      probeUpdate: () => probeLauncherUpdate(),
      applyUpdate: (onLine, plan) => applyLauncherUpdate(onLine, undefined, plan),
      loadJobs: () => listJobs(ctx, active?.agent),
      statusline: statuslineItems,
      saveStatusline,
      applyEditorKeys,
      saveTheme,
      saveLanguage,
      animations: animationsEnabled,
      saveAnimations,
      history: inputHistory,
      recordHistory,
      updateQueued,
      onBridgeReady: (instance: AppBridge) => { bridge.notify = instance.notify },
    })
  }

  const renderCurrent = (): void => {
    mountRef.current?.rerender(appElement())
  }

  mountRef.current = io.mount(appElement())

  // Startup prompt/images use the same durable delivery path as composer
  // submissions. Image bytes are committed before the user/message event, and
  // input typed during that preparation queues behind the initial request so
  // the agent always receives the startup prompt first.
  if (startup.prompt !== undefined || (startup.images?.length ?? 0) > 0) {
    if ((startup.images?.length ?? 0) > 0) {
      bridge.notify(`processing ${startup.images!.length} startup image${startup.images!.length === 1 ? '' : 's'}…`)
    }
    void inputGate.run(async deliver => {
      const images = await saveImagePaths(startup.images ?? [], ctx.get('attachments'))
      if (images.length > 0) bridge.notify(`${images.length} startup image${images.length === 1 ? '' : 's'} attached`)
      deliver({ text: startup.prompt ?? '', mode: 'followup', images })
    }).catch((error: unknown) => {
      bridge.notify(`initial prompt failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
    })
  }

  async function copyLastResponse(): Promise<string> {
    const text = latestAssistantText(store.getView())
    if (text === undefined) return 'nothing to copy yet'
    await copyText(text)
    return 'copied latest response'
  }

  // A corrupt statusline config must not vanish silently: surface it once
  // the notice channel is live, after the first frame settles.
  if (statuslineWarning !== undefined) {
    setTimeout(() => {
      bridge.notify('statusline config unreadable, using defaults: ' + statuslineWarning, 'warning')
    }, 50)
  }
  // Same one-shot surface for a corrupt theme file (dark fallback stays live).
  if (languageWarning !== undefined) {
    setTimeout(() => {
      bridge.notify(t('notice.languageConfigUnreadable', { message: languageWarning }), 'warning')
    }, 0)
  }
  if (themeWarning !== undefined) {
    setTimeout(() => {
      bridge.notify('theme config unreadable, using dark: ' + themeWarning, 'warning')
    }, 50)
  }
  // And for a corrupt animations file (on-by-default fallback stays live).
  if (animationsWarning !== undefined) {
    setTimeout(() => {
      bridge.notify('animations config unreadable, animations stay on: ' + animationsWarning, 'warning')
    }, 50)
  }

  // One-shot VS Code Ctrl+R hint: resolveEditorKeysStartupHint checks the
  // marker file and the live keybindings config; surfacing waits for the
  // notice channel like the other startup warnings. A failed probe stays
  // silent — the hint is cosmetic and /vscode-keys remains discoverable.
  void resolveEditorKeysStartupHint(editorKeysEnv).then(hint => {
    if (hint === undefined) return
    setTimeout(() => {
      bridge.notify(hint)
    }, 50)
  }, () => {})
}

/**
 * Mount the interactive terminal driver.
 * @param ctx - plugin context carrying core services and the launcher-provided exit request.
 * @param config - validated startup config resolved from the tuiStartup provider.
 */
export function apply(ctx: Context, config: Config): void {
  // The CLI validated --theme at parse time; the loose config schema falls
  // back to dark for anything unexpected.
  const theme = config.startup.theme === undefined ? undefined : parseThemeName(config.startup.theme)
  const input = {
    ...(theme === undefined ? {} : { theme }),
    ...(config.startup.prompt === undefined ? {} : { prompt: config.startup.prompt }),
    ...(config.startup.images === undefined ? {} : { images: config.startup.images }),
  }
  const startup: TuiStartup =
    config.startup.kind === 'resume' && config.startup.sessionId !== undefined
      ? { kind: 'resume', sessionId: config.startup.sessionId, ...input }
      : config.startup.kind === 'latest'
        ? { kind: 'latest', ...input }
        : config.startup.kind === 'named' && config.startup.sessionId !== undefined
          ? { kind: 'named', sessionId: config.startup.sessionId, ...config.startup.mode === undefined ? {} : { mode: config.startup.mode }, ...input }
          : { kind: 'fresh', ...config.startup.mode === undefined ? {} : { mode: config.startup.mode }, ...input }
  // Read through the global service store, not the property proxy: appExit is
  // an optional host value, never an injected dependency.
  const exit = ctx.get('appExit')
  if (exit === undefined) {
    throw new Error('tui-runner: the launcher must provide ctx.appExit before the tree mounts')
  }
  const io: TuiIo = { mount: internals.mount, exit }
  void run(ctx, startup, io).catch((error: unknown) => { fail(io, error) })
}
