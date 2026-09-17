/**
 * The Ink terminal app: the DSCODE snowflake welcome header, the live
 * transcript, the todo panel, the streaming line, the approval bar, the model
 * panel, local notices, and the input box with history and slash-command
 * completion. All state arrives through the transcript store (derived from
 * the durable session log) plus local input state; the app owns no session
 * mutation of its own.
 *
 * Element construction uses `createElement` (not JSX): the `dsh` source launch
 * compiles this file through tsx's ESM-only hook, which does not adopt this
 * package's `jsx: react-jsx` compiler option, and the classic JSX runtime
 * would demand a React global.
 *
 * @module @deepseek-ai/dsh-code/app
 */

import { basename } from 'node:path'
import {
  createElement, memo, useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactElement,
} from 'react'
import { Box, Static, Text, useInput, useStdin, useStdout, type Key } from 'ink'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'
import type { ContentBlock, FileBlock, ImageBlock } from '@deepseek-ai/dsh-llm'
import type { TodoItem } from '@deepseek-ai/dsh-tool-todo'
import type { AskUserQuestionAnswerItem, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type { AuthorizationInteraction, AuthorizationStatus } from '@deepseek-ai/dsh-authorization'
import {
  dim,
  diffBackground,
  promptRowTokens,
  rowBackground,
  FLOW_ANCHORS,
  getPalette,
  getTheme,
  inkColor,
  isPrismatic,
  isRainbow,
  themeFlow,
  setTheme,
  type RgbTriple,
  type ThemeName,
} from './theme.ts'
import { panelAccent } from './panel-accent.ts'
import { parseRainbowArgument, rainbowRoll, rainbowSeedLabel, rerollRainbow } from './rainbow.ts'
import { ThemePanel } from './theme-panel.ts'
import { LanguagePanel } from './language-panel.ts'
import { getLanguage, parseLanguageName, t, type LanguageName, type MessageKey } from './i18n.ts'
import { UpdatePanel } from './update-panel.ts'
import type { LauncherUpdateStatus } from './update.ts'
import { WHALE_GLYPH, WHALE_GLYPH_COLUMNS } from './whale-glyph.ts'
import { DSH_CODE_VERSION, dshKernelVersion } from './version.ts'
import type { TranscriptStore } from './store.ts'
import { DEFAULT_TERMINAL_TITLE, sanitizeTerminalTitle, terminalTitleSequence, useTerminalTitle } from './terminal-title.ts'
import { settledEntryCount, type TranscriptEntry } from './render/projection.ts'
import { imeCursorRowsUp, useImeCursorAnchor } from './render/ime-cursor.ts'
import { readClipboardImage } from './dscode/clipboard-image/index.mjs'
import { dscodeChatLines } from './dscode/chat.ts'
import { readFileSync } from 'node:fs'
import { footerFor as dscodeFooterFor } from '../../../plugins/session-metrics/view.mjs'
import { newerVersion as dscodeNewerVersion } from '../../../plugins/tui-tools/update.mjs'
import { t as dscodeMessage, normalizeLanguage as dscodeNormalizeLanguage } from '../../../plugins/i18n/messages.mjs'
import { dscodeTelemetryNodes } from './dscode/telemetry.ts'
import { dscodeFooterHeader } from './render/status.ts'
import { dscodePadEnd, welcomeArtRows, welcomePath, WELCOME_ART, WELCOME_ART_SMALL } from './dscode/welcome.ts'
import { TETRIS_TICK_MS as DSCODE_TETRIS_TICK_MS, TETRIS_WIDTH as DSCODE_TETRIS_WIDTH, tetrisFrame as dscodeTetrisFrame } from '../../../plugins/compaction/tetris.mjs'
import {
  PROVIDERS as DSCODE_PROVIDERS,
  providerSpec as dscodeProviderSpec,
  providerArgument as dscodeProviderArgument,
  providerOfLabel as dscodeProviderOfLabel,
  splitModelLabel as dscodeSplitModelLabel,
  pickModel as dscodePickModel,
  credentialState as dscodeCredentialState,
  ensureProviderRoute as dscodeEnsureProviderRoute,
  waitForModels as dscodeWaitForModels,
} from '../../../plugins/providers/catalog.mjs'
import { ENV_ASSIGNMENT, hasWrappingQuotes } from './provider-settings.ts'
import { collapseLargePaste, expandLargePastes, pasteAtomicEdit, pasteCursorEdge } from './dscode/paste.ts'
import { loadFlag, saveFlag } from './dscode/flags.ts'
import { dscodeFilterModels } from './dscode/model-search.ts'
import {
  createEmailInbox as dscodeCreateEmailInbox,
  emailKey as dscodeEmailKey,
  emailPrompt as dscodeEmailPrompt,
  emailText as dscodeEmailText,
} from '../../../plugins/email/inbox.mjs'
import { createGmailConnector as dscodeCreateGmailConnector } from '../../../plugins/email/gmail.mjs'
import { createImapConnector as dscodeCreateImapConnector } from '../../../plugins/email/imap.mjs'
import {
  MANAGEMENT_REF as DSCODE_OPENROUTER_MANAGEMENT_REF,
  loadOpenRouterAccount as dscodeLoadOpenRouterAccount,
  openRouterAccountLines as dscodeOpenRouterAccountLines,
  verifyManagementKey as dscodeVerifyManagementKey,
} from '../../../plugins/providers/openrouter-account.mjs'

export async function dscodeOpenRouterSecret(ctx, ref) {
  const hit = await ctx.get("credentials")?.resolve(ref);
  return typeof hit?.value === "string" && hit.value.length > 0 ? hit.value : void 0;
}

export async function dscodeManagementKeyStatus(ctx) {
  const credentials = ctx.get("credentials");
  if (credentials === void 0) return { state: "unavailable" };
  try {
    const facts = await credentials.describe(DSCODE_OPENROUTER_MANAGEMENT_REF);
    if (facts?.configured) return { state: facts.source === "env" ? "env" : "saved" };
    return { state: facts?.writable === false ? "readonly" : "missing" };
  } catch {
    return { state: "error" };
  }
}

export async function dscodeSaveManagementKey(ctx, key) {
  const credentials = ctx.get("credentials");
  if (typeof credentials?.set !== "function") throw new Error("Credential storage is unavailable.");
  await dscodeVerifyManagementKey(key);
  await credentials.set(DSCODE_OPENROUTER_MANAGEMENT_REF, key);
}

export async function dscodeLoadOpenRouterAccountFor(ctx) {
  const [apiKey, managementKey] = await Promise.all(["OPENROUTER_API_KEY", DSCODE_OPENROUTER_MANAGEMENT_REF].map(ref => dscodeOpenRouterSecret(ctx, ref)));
  return dscodeLoadOpenRouterAccount({ apiKey, managementKey });
}


/**
 * dscode: DSCODE-owned UI strings in the interface language. The DSCODE tables key
 * Simplified Chinese as `zh-CN` while the terminal reports `zh`, so the name is
 * normalized through the DSCODE alias table before lookup.
 */
const dscodeT = (key: string, params?: Record<string, unknown>): string =>
  dscodeMessage(dscodeNormalizeLanguage(getLanguage()) ?? 'en', key, params)

/** The published DSCODE release the startup update check reads. */
const DSCODE_REGISTRY_URL = 'https://registry.npmjs.org/@toddzheng024/dscode/latest'
/** The launcher release this terminal compares itself against. */
const DSCODE_VERSION: string = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url), 'utf8')).version
import { type MdSegment, visibleColumns } from './render/markdown.ts'
import {
  busyChaseFrame,
  BUSY_CHASE_TICK_MS,
  CARET_BLINK_TICK_MS,
  caretVisible,
  DEEP_DIVING_SHIMMER_TICK_MS,
  DEEPSEEK_WAVE_TICK_MS,
  deepseekWaveColumnBg,
  deepseekWaveDuration,
  deepseekWaveSpark,
  deepseekWaveStyleRandom,
  deepseekWaveTier,
  deepseekWaveWordHue,
  deepseekWaveWordVisible,
  deepDivingGradientColor,
  deepDivingSparkColor,
  flowColor,
  effortAboveHigh,
  isOfficialDeepSeekLabel,
  parseAnimationsArgument,
  RAINBOW_BURST_DURATION_MS,
  RAINBOW_BURST_TICK_MS,
  rainbowBurstColumnBg,
  rainbowSpectrumHue,
  type DeepseekWaveStyle,
  type DeepseekWaveTier,
} from './render/animations.ts'
import type { ApprovalSnapshot, ApprovalStore } from './approval.ts'
import { isSlashLine, submissionPayload, type CommandsView } from './commands.ts'
import { rankByName } from './render/fuzzy.ts'
import type { ModelDirectory, ModelRow } from './models.ts'
import {
  isDeclaredReasoningEfforts,
  parseReasoningEffortsDraft,
  serializeReasoningEfforts,
  type DiscoveredModelView,
  type ProviderConfiguration,
  type ProviderModelSettings,
  type ProviderSettingsDirectory,
  type ProviderTargetView,
  type ReasoningEffortsValue,
} from './provider-settings.ts'
import type { QuestionSnapshot, QuestionStore } from './questions.ts'
import type { SkillsView, SkillRow } from './skills.ts'
import { isPathLikeMentionQuery, type MentionCandidate } from './mentions.ts'
import type { SubagentFeedView, SubagentRow } from './subagents.ts'
import type { UsageView } from './render/usage.ts'
import { AgentsPanel, editQuery, EffortPanel as NativeEffortPanel, HistoryPanel, JobsPanel, ModePanel, PermissionPanel, PluginPanel, ResumePanel, ReviewPickerPanel, SchedulePanel, SearchPanel, StatuslinePanel, runClock, SubagentPanel, UsagePanel, type JobRow, type SearchRow } from './kernel-panels.ts'
import type { PresetRow } from './presets.ts'
import type { PermissionRow } from './permissions.ts'
import type { PluginRow } from './plugin-inventory.ts'
import {
  beginRecall,
  recallEntries,
  recallNewer,
  recallOlder,
  recordLocalEntry,
  type RecallState,
} from './history.ts'
import type { SessionDirectoryOptions, SessionRow } from './session-directory.ts'
import { parseReviewArgument, type GitDiffView, type ReviewBranch, type ReviewCommit, type ReviewSelection } from './git-workflow.ts'
import {
  authorizationForProvider,
  providerAuthorizationStatus,
  type ProviderAuthorizationDirectory,
  type ProviderAuthorizationRow,
} from './authorization.ts'
import { ProviderAuthorizationLogoutPanel, ProviderAuthorizationPanel } from './authorization-panel.ts'
import {
  looksLikeImagePath,
  parsePastedAttachmentPaths,
  type FilePathInspection,
  type ImagePathInspection,
} from './attachments.ts'

/** Match Codex's settled-resize window before rebuilding terminal scrollback. */
const RESIZE_REFLOW_DELAY_MS = 75

/**
 * Cap on rendered settled history, in physical rows (header and hint
 * included). 3,000 rows sits inside Codex's 1k–10k reflow budget range:
 * replays stay under ~200ms while roughly a hundred messages stay visible
 * before the oldest drop out. `DSH_SETTLED_ROWS` overrides it; 0 disables
 * the cap entirely (the historical unbounded behavior).
 */
const SETTLED_ROW_CAP = readSettledRowCap()
/** Hysteresis: the cap may overflow by 25% before one trimming replay fires. */
/** Header rows plus the trim hint, reserved out of the row cap. */
const SETTLED_ROW_RESERVE = 12

/** Read the configurable settled-history cap once per process. */
function readSettledRowCap(): number {
  const raw = process.env.DSH_SETTLED_ROWS
  if (raw === undefined) return 3_000
  const parsed = Number.parseInt(raw, 10)
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 3_000
}

// The paste safety-net window itself lives in keyboard.ts next to the paste
// markers: the input splitter's stale-paste escape hatch and this reset net
// must always share one window.

/** Reset region/style, clear the visible screen and scrollback, then home. */
const RESIZE_REFLOW_CLEAR = '\x1b[r\x1b[0m\x1b[H\x1b[2J\x1b[3J\x1b[H'
/** Ask terminals supporting DEC synchronized updates to hold the frame. */
const SYNCHRONIZED_UPDATE_BEGIN = '\x1b[?2026h'
/** Release the held frame after Ink has replayed the source-backed Static rows. */
const SYNCHRONIZED_UPDATE_END = '\x1b[?2026l'
import {
  layoutStatusBar,
  parseStatuslineItems,
  statusCycleHint,
  STATUS_GROUP_SEPARATOR,
  STATUS_ITEM_SEPARATOR,
  STATUS_ROW2_INDENT,
  type StatusFacts,
  type StatusGroup,
  type StatusItemId,
  type StatusSpan,
  type StatusTone,
} from './render/status.ts'
import { displayTail, displayText, singleLineText, truncateColumns } from './render/text.ts'
import {
  isVsCodeTerminalEnv,
  normalizeKeyboardChunk,
  PASTE_BRACKET_TIMEOUT_MS,
  PASTE_END_MARKER,
  PASTE_START_MARKER,
  stripPasteMarkers,
  stripTerminalFocusEvents,
  tokenizeRawEditorChunk,
  type RawEditorToken,
} from './keyboard.ts'
import {
  clampScroll,
  followInspectorCursor,
  inspectorViewport,
  layoutGutterRows,
  liveRegionBudget,
  moveScroll,
  panelViewport,
  revealRow,
  selectionWindow,
} from './render/inspector.ts'
import {
  clampLiveAllocation,
  diffLineStyle,
  fillDiffLineBars,
  lineSegment,
  markdownLines,
  settledEntryLines,
  styledLines,
  textLines,
  transcriptEntryLines,
  type LineStyle,
  type StyledLine,
} from './render/lines.ts'
import {
  caretSite,
  clampCursor,
  composerMaxRows,
  deleteBackward,
  deleteForward,
  deleteLastGrapheme,
  deleteWordBackward,
  deleteWordForward,
  editorModel,
  editorRowParts,
  insertText,
  type EditResult,
  type EditorRowModel,
  killToLineEnd,
  killToLineStart,
  moveCursorBy,
  moveCursorVertically,
  moveToLineEnd,
  moveToLineStart,
  moveWordLeft,
  moveWordRight,
  remapStableRange,
  replaceRangePreservingCursor,
  sanitizeDraftText,
  shouldRecallNavigate,
  splitGraphemes,
} from './render/editor.ts'

/** Visual priority for one bounded local notice. */
export type NoticeTone = 'info' | 'warning' | 'error'

/** One source of truth for TUI-owned slash commands in completion and `/help`. */
/** One TUI-owned slash command: label plus its i18n description key. */
interface LocalCommand { readonly label: string; readonly descriptionKey: MessageKey }

const LOCAL_COMMANDS: readonly LocalCommand[] = [
  { label: '/help', descriptionKey: 'cmd.help' },
  { label: '/model', descriptionKey: 'cmd.model' },
  { label: '/effort', descriptionKey: 'cmd.effort' },
  { label: '/mode', descriptionKey: 'cmd.mode' },
  { label: '/permission', descriptionKey: 'cmd.permission' },
  { label: '/new', descriptionKey: 'cmd.new' },
  { label: '/fork', descriptionKey: 'cmd.fork' },
  { label: '/resume', descriptionKey: 'cmd.resume' },
  { label: '/search', descriptionKey: 'cmd.search' },
  { label: '/plugin', descriptionKey: 'cmd.plugin' },
  { label: '/update', descriptionKey: 'cmd.update' },
  { label: '/jobs', descriptionKey: 'cmd.jobs' },
  { label: '/schedule', descriptionKey: 'cmd.schedule' },
  { label: '/statusline', descriptionKey: 'cmd.statusline' },
  { label: '/theme', descriptionKey: 'cmd.theme' },
  { label: '/language', descriptionKey: 'cmd.language' },
  { label: '/rainbow', descriptionKey: 'cmd.rainbow' },
  { label: '/animation', descriptionKey: 'cmd.animation' },
  { label: '/history', descriptionKey: 'cmd.history' },
  { label: '/queue', descriptionKey: 'cmd.queue' },
  { label: '/usage', descriptionKey: 'cmd.usage' },
  { label: '/agents', descriptionKey: 'cmd.agents' },
  { label: '/todos', descriptionKey: 'cmd.todos' },
  { label: '/subagent', descriptionKey: 'cmd.subagent' },
  { label: '/vscode-keys', descriptionKey: 'cmd.vscode-keys' },
  { label: '/delete', descriptionKey: 'cmd.delete' },
  { label: '/clear', descriptionKey: 'cmd.clear' },
  { label: '/verbose', descriptionKey: 'cmd.verbose' },
  { label: '/status', descriptionKey: 'cmd.dscode.status' },
  { label: '/doctor', descriptionKey: 'cmd.dscode.doctor' },
  { label: '/mcp', descriptionKey: 'cmd.dscode.mcp' },
  { label: '/skills', descriptionKey: 'cmd.dscode.skills' },
  { label: '/hooks', descriptionKey: 'cmd.dscode.hooks' },
  { label: '/email', descriptionKey: 'cmd.dscode.email' },
  { label: '/login', descriptionKey: 'cmd.dscode.login' },
  { label: '/provider', descriptionKey: 'cmd.dscode.provider' },
  { label: '/openrouter', descriptionKey: 'cmd.dscode.openrouter' },
  { label: '/export', descriptionKey: 'cmd.export' },
  { label: '/title', descriptionKey: 'cmd.title' },
  { label: '/copy', descriptionKey: 'cmd.copy' },
  { label: '/diff', descriptionKey: 'cmd.diff' },
  { label: '/review', descriptionKey: 'cmd.review' },
  { label: '/quit', descriptionKey: 'cmd.quit' },
] as const

const LOCAL_COMMAND_NAMES = new Set(LOCAL_COMMANDS.map(command => command.label.slice(1)))

/** One mutation the terminal may request for a pending next-turn inbox item. */
export type QueueMutation =
  | { readonly kind: 'remove' }
  | { readonly kind: 'edit'; readonly text: string }
  | { readonly kind: 'steer' }

/** Props the runner hands the app; callbacks stay owned by the runner. */
/** dscode: what a /model pick would cost the live context; measured before switching. */
export interface DscodeCompactionPreview {
  compacts?: boolean
  label: string
  used: number
  threshold: number
  contextWindow: number
  thresholdRatio: number
  overflows?: boolean
}

export interface AppProps {
  /** Event-fed transcript store for the live session. */
  store: TranscriptStore
  /** Approval-question store fed by the answerer listener. */
  approval: ApprovalStore
  /** ask_user_question store fed by the single UI provider. */
  questions: QuestionStore
  /** Live subagent activity feed (child sessions of the current root). */
  subagents: SubagentFeedView
  /** Live slash-command descriptor list (completion candidates). */
  commands: CommandsView
  /** Live user-invocable skill catalog (completion candidates). */
  skills: SkillsView
  /** `provider/model` selection serving this session (updated on /model). */
  model: string
  /** Effective reasoning effort in force ('' when none), for the /model picker mark. */
  effort?: string
  /** Working-directory basename the session serves. */
  cwd: string
  /** Absolute working directory used by session filters and references. */
  workspaceRoot: string
  /** Git branch name, empty outside a repository. */
  branch: string
  /** Short session identifier. */
  sessionId: string
  /** Whether this session was resumed from persistence. */
  resumed: boolean
  /** Agent preset selected for the current or pending first session. */
  mode: string
  /** Permission preset selected for the current or pending first session. */
  permission: string
  /**
   * Submit one line: slash commands to the registry, other text to the agent.
   * The optional origin names the session the submission was composed for —
   * an attachment prepare resolves after the app remounted onto another
   * session, and the runner drops the stale delivery then.
   */
  dispatch: (text: string, attachments?: readonly ContentBlock[], origin?: string) => void
  /**
   * Submit one line as steering: it joins the turn already running at its next
   * step boundary instead of waiting for the next turn. Same stale-delivery
   * guard as {@link dispatch}.
   */
  steer: (text: string, attachments?: readonly ContentBlock[], origin?: string) => void
  /**
   * The FULL current session identity ('' while the first session is pending)
   * — the stale-delivery origin above. Distinct from the short display id.
   */
  sessionKey: string
  /** Interrupt the running turn (Esc); true when a turn was cancelled. */
  interrupt: () => boolean
  /** Quit: unmount, flush, and request process exit. */
  quit: (fast?: boolean) => void
  /** Load the selectable model directory (called when /model opens). */
  loadModels: () => Promise<ModelDirectory>
  /** Load @mention candidates for the typed query (files + sessions). */
  loadMentions: (query: string, signal?: AbortSignal) => Promise<readonly MentionCandidate[]>
  /** Validate draft image paths without committing attachment objects. */
  inspectImages: (paths: readonly string[]) => Promise<readonly ImagePathInspection[]>
  /** Validate, normalize and persist images immediately before submission. */
  prepareImages: (paths: readonly string[], signal?: AbortSignal) => Promise<readonly ImageBlock[]>
  /** Validate draft non-image file paths without committing attachment objects. */
  inspectFiles: (paths: readonly string[]) => Promise<readonly FilePathInspection[]>
  /** Persist non-image files immediately before submission as durable file blocks. */
  prepareFiles: (paths: readonly string[], signal?: AbortSignal) => Promise<readonly FileBlock[]>
  /** Apply one /model selection (with an advertised reasoning effort, when picked); returns the display label. */
  selectModel: (row: ModelRow, effortId?: string) => string
  /** The /subagent override label, '' when delegated agents follow the current model. */
  subagentModel: string
  /** Apply one /subagent model pick; returns the override label. */
  setSubagentModel: (row: ModelRow, effortId?: string) => string
  /** Drop the /subagent override (delegated agents follow the current model). */
  clearSubagentModel: () => void
  /** Delete one session subtree; resolves with the outcome line. */
  deleteSession: (id: string) => Promise<string>
  /** Load provider/settings/credential facts for the optional /model provider stage. */
  loadModelProviders?: () => Promise<ProviderSettingsDirectory>
  /** Subscribe to Harness credential/settings/adapter invalidations while /model is open. */
  subscribeModelProviders?: (listener: () => void) => () => void
  /** Store or rotate one provider credential through the Harness credential service. */
  saveModelProviderCredential?: (target: ProviderTargetView, key: string) => Promise<void>
  /** dscode: prepare a provider route (settings migration) before switching. */
  dscodeEnsureProviderRoute?: (provider: string) => Promise<boolean>
  /** dscode: status of the optional OpenRouter management key. */
  dscodeManagementKeyStatus?: () => Promise<{ state: string }>
  /** dscode: verify and store the OpenRouter management key. */
  dscodeSaveManagementKey?: (key: string) => Promise<void>
  /** dscode: load the OpenRouter account (balance, keys, 30-day spend). */
  dscodeLoadOpenRouterAccount?: () => Promise<unknown>
  /** dscode: measure a /model pick against the live context; undefined when unavailable. */
  dscodeCompactionPreview?: (row: ModelRow) => Promise<DscodeCompactionPreview | undefined>
  /** Remove one writable provider credential without removing its settings profile. */
  unsetModelProviderCredential?: (target: ProviderTargetView) => Promise<void>
  /** Remove one user-owned provider profile and its page-managed credential. */
  removeModelProvider?: (target: ProviderTargetView) => Promise<void>
  /** Save endpoint and explicit model capacities through the provider profile. */
  saveModelProviderConfiguration?: (target: ProviderTargetView, configuration: ProviderConfiguration) => Promise<void>
  /**
   * Interrogate the provider's real endpoint (typed key wins over the stored
   * credential) for the models it actually serves — the discovery stage of
   * the provider setup page.
   */
  discoverModelProvider?: (
    target: ProviderTargetView,
    request: { readonly apiKey?: string; readonly baseURL?: string },
    signal?: AbortSignal,
  ) => Promise<readonly DiscoveredModelView[]>
  /** Provider authorization flows and value-free stored-record facts. */
  loadProviderAuthorizations?: () => Promise<ProviderAuthorizationDirectory>
  subscribeProviderAuthorizations?: (listener: () => void) => () => void
  beginProviderAuthorization?: (
    row: ProviderAuthorizationRow,
    method: string,
    interaction: AuthorizationInteraction,
    signal: AbortSignal,
  ) => Promise<AuthorizationStatus>
  cancelProviderAuthorization?: (row: ProviderAuthorizationRow) => void
  logoutProviderAuthorization?: (row: ProviderAuthorizationRow) => Promise<void>
  openAuthorizationUrl?: (url: string) => boolean
  copyTextValue?: (text: string) => Promise<void>
  /** Cycle to the next mode station (Shift+Tab): a permission preset or a plan switch; returns the notice label. */
  cycleMode: () => string
  /** Pre-session plan choice: shows the plan badge before the first session exists. */
  pendingPlan?: boolean
  /** Select or inspect a permission preset without requiring a pre-existing session. */
  setPermission: (id: string) => string
  /** Export the transcript to a markdown file (/export [path]); reports via notices. */
  exportTranscript: (argument: string) => Promise<void>
  /** Rename the session (/title <text>); returns the outcome line for the notice. */
  renameTitle: (argument: string) => string
  /** Copy the latest complete assistant response; resolves to notice text. */
  copyLastResponse: () => Promise<string>
  /** Load a complete read-only Git diff for the file-oriented viewport. */
  loadGitDiff: (argument: string) => Promise<GitDiffView>
  /** Local branches for the /review picker (absent: the picker hides the branch phase's list). */
  listReviewBranches?: (signal?: AbortSignal) => Promise<readonly ReviewBranch[]>
  /** Recent commits on the current branch for the /review picker. */
  listReviewCommits?: (signal?: AbortSignal) => Promise<readonly ReviewCommit[]>
  /** Start a model review after applying the read-only permission preset. */
  reviewChanges: (selection: ReviewSelection) => void
  /** Preset/session/plugin kernel operations. */
  loadPresets: () => Promise<readonly PresetRow[]>
  switchMode: (id: string) => Promise<string>
  /** Load the switchable permission presets for the /permission panel. */
  loadPermissions: () => Promise<readonly PermissionRow[]>
  createSession: (mode?: string) => void
  /** Fork the active session at a completed-turn boundary. */
  forkSession: (argument: string) => void
  loadSessions: (options: SessionDirectoryOptions, signal?: AbortSignal) => Promise<readonly SessionRow[]>
  loadSessionTranscript: (id: string, signal?: AbortSignal) => Promise<string>
  /** Read the current session's usage blocks (projections plus per-turn fold). */
  loadUsage: () => Promise<UsageView>
  /**
   * Full-text search over every persisted session (the in-process
   * session-query engine). Absent when the deployment disabled the row;
   * /search degrades to a notice instead of opening the panel.
   */
  searchSessions?: (query: string, signal?: AbortSignal) => Promise<readonly SearchRow[]>
  /** Load this session's subagent conversations (children by lineage). */
  loadSubagents: () => Promise<readonly SessionRow[]>
  switchSession: (row: SessionRow) => void
  cancelSessionSwitch: () => boolean
  loadPlugins: () => readonly PluginRow[]
  /** Caller-visible background jobs (the host jobs registry, read-only). */
  loadJobs: () => readonly JobRow[]
  /** Probe the launcher's aligned update plan (read-only; never installs). */
  probeUpdate: () => Promise<LauncherUpdateStatus>
  /** Run the launcher's aligned update; streams sanitized lines; resolves with the exit code. */
  applyUpdate: (onLine: (line: string) => void, plan?: { readonly dshSpec: string; readonly codeSpec: string; readonly pluginSpecs: readonly string[] }) => Promise<number>
  /** Registers the app's notice channel with the runner (called once on mount). */
  onBridgeReady: (bridge: { notify: (text: string, tone?: NoticeTone) => void }) => void
  /** Ordered enabled status items (/statusline config); the runner owns persistence. */
  statusline: readonly string[]
  /** Persist a new statusline item set; the runner surfaces IO failures as notices. */
  saveStatusline: (items: readonly string[]) => void
  /** Apply and persist one /language selection; the runner owns the language.json file. */
  saveLanguage: (name: LanguageName) => void
  /** Apply and persist one /theme selection; the runner owns the theme.json file. */
  saveTheme?: (name: ThemeName) => void
  /** Whether timed animations run at startup (animations.json; on by default
   * — like parseAnimationsPref, only an explicit false disables them). */
  animations?: boolean
  /** Apply and persist one /animation toggle; the runner owns the file. */
  saveAnimations?: (enabled: boolean) => void
  /** Persistent cross-session input history (oldest first); the runner owns the file. */
  history: readonly string[]
  /** Persist one submitted prompt to the global history file. */
  recordHistory: (text: string) => void
  /** Mutate one next-turn inbox message; durable inbox splices reconcile the result. */
  updateQueued?: (messageId: string, action: QueueMutation) => void
  /** Apply the Ctrl+R terminal passthrough to the detected editor (/vscode-keys); resolves to a one-line summary. */
  applyEditorKeys: () => Promise<string>
}

/** Pad text with spaces to a visible-column target (menu name column). */
function padColumns(text: string, width: number): string {
  const clipped = truncateColumns(singleLineText(text), width)
  return clipped + ' '.repeat(Math.max(0, width - visibleColumns(clipped)))
}

/**
 * Wall-clock frame counter for one self-contained animated leaf. Each fire
 * derives the tick from elapsed time instead of counting intervals, so a
 * stretched interval (busy event loop, slow SSH) skips the animation ahead
 * rather than slowing it down; the tick always tracks real time.
 */
function useFrames(intervalMs: number, active = true): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    if (!active) return
    const startedAt = Date.now()
    setTick(0)
    const id = setInterval(() => {
      // Clock setback (NTP resync) must not produce negative ticks — the
      // blink parity check would flip the caret off for a full period.
      setTick(Math.max(0, Math.floor((Date.now() - startedAt) / intervalMs)))
    }, intervalMs)
    return () => {
      clearInterval(id)
    }
  }, [active, intervalMs])
  return tick
}

/**
 * Ink re-subscribes its input effect whenever the handler identity changes.
 * Keep terminal input ownership stable while a local surface updates cursor,
 * scroll, or draft state; otherwise every key toggles raw mode and can make
 * Ink repeatedly repaint the live region.
 */
function useStableInput(handler: (input: string, key: Key) => void, active: boolean): void {
  const handlerRef = useRef(handler)
  handlerRef.current = handler
  const stableHandler = useCallback((input: string, key: Key): void => {
    handlerRef.current(input, key)
  }, [])
  useInput(stableHandler, { isActive: active })
}

/**
 * The original web StateDot chase used by the busy composer marker. With
 * animations off it freezes on the first frame (still visibly busy).
 */
function BusyChase({ animated = true }: { animated?: boolean }): ReactElement {
  const tick = useFrames(BUSY_CHASE_TICK_MS, animated)
  // Flowing themes (prismatic, rainbow) ride their anchor walk while busy;
  // every other theme (and the frozen state) keeps the palette's live accent.
  const flow = themeFlow()
  const marker = flow !== undefined && animated
    ? flowColor(tick * BUSY_CHASE_TICK_MS + flow.phaseMs, flow.anchors)
    : getPalette().brandBright
  return createElement(Text, { color: inkColor(marker) }, busyChaseFrame(tick) + ' ')
}

/** Blinking block caret appended to streaming text; solid when frozen. */
function Caret({ animated = true }: { animated?: boolean }): ReactElement {
  const tick = useFrames(CARET_BLINK_TICK_MS, animated)
  return createElement(Text, null, caretVisible(tick) ? '▍' : ' ')
}

/** One resettable input-caret phase shared by the entire composer. */
function useCursorBlink(active: boolean): { visible: boolean; reset: () => void } {
  const [epoch, setEpoch] = useState(0)
  const [visible, setVisible] = useState(true)
  useEffect(() => {
    setVisible(true)
    if (!active) return
    const id = setInterval(() => setVisible(current => !current), CARET_BLINK_TICK_MS)
    return () => {
      clearInterval(id)
    }
  }, [active, epoch])
  const reset = useCallback((): void => {
    setVisible(true)
    setEpoch(current => current + 1)
  }, [])
  return { visible, reset }
}

/**
 * One bounded line painted with the deep-diving shimmer: a continuously
 * moving blue gradient across graphemes, the `✻` glyph in the breathing
 * spark color. Shared by the busy line and the collapsed thinking marker;
 * always exactly one row (truncate-end) so the live budget stays exact. With
 * animations off the same spans render in fixed colors — no timer, no
 * per-frame repaint, the `✻` keeps its highlight.
 */
function ShimmerLine({ text, animated = true }: { text: string; animated?: boolean }): ReactElement {
  const tick = useFrames(DEEP_DIVING_SHIMMER_TICK_MS, animated)
  const palette = getPalette()
  // Flowing themes walk their anchors for the shimmer highlight so
  // streaming text glows along the spectrum; other themes keep the bright
  // accent.
  const flow = themeFlow()
  const highlight = flow !== undefined && animated
    ? flowColor(tick * DEEP_DIVING_SHIMMER_TICK_MS + flow.phaseMs, flow.anchors)
    : palette.brandBright
  const graphemes = splitGraphemes(text)
  return createElement(
    Text,
    { wrap: 'truncate-end' },
    ...graphemes.map((grapheme, index) => {
      const sparkle = grapheme.text === '✻'
      return createElement(
        Text,
        {
          key: `${grapheme.start}-${grapheme.end}`,
          color: inkColor(!animated
            ? (sparkle ? palette.brandBright : palette.brandDeep)
            : sparkle
              ? deepDivingSparkColor(tick, palette.brandDeep, highlight)
              : deepDivingGradientColor(index, tick, graphemes.length, palette.brandDeep, highlight)),
          bold: sparkle || undefined,
        },
        grapheme.text,
      )
    }),
  )
}

/**
 * The busy line, web TurnStatus contract: a continuously moving blue gradient
 * paints the complete `Deep diving...` label, with the elapsed clock appended
 * only once the turn has clearly been running (15s) — anchored to `turn/start`
 * so a resumed mid-turn keeps the real time.
 */
// dscode: the activity line — a comet orbiting the flake, the running tool's name
// and the turn clock, replacing the bare list of running tools.
const DSCODE_ORBIT: readonly (readonly [string, number])[] = [
  ['right', 1], ['right', 2], ['right', 4], ['right', 64],
  ['left', 128], ['left', 32], ['left', 16], ['left', 8],
]

interface DscodeSpinnerCell {
  text: string
  color: readonly number[]
}

function dscodeMixTone(from: readonly number[], to: readonly number[], amount: number): readonly number[] {
  return from.map((value, index) => Math.round(value + ((to[index] ?? value) - value) * amount))
}

/** One orbit position: the leading dot is bright, the trailing dot lingers dim. */
function dscodeSpinnerCells(tick: number, palette: ReturnType<typeof getPalette>): { left: DscodeSpinnerCell; flake: readonly number[]; right: DscodeSpinnerCell } {
  const index = ((tick % DSCODE_ORBIT.length) + DSCODE_ORBIT.length) % DSCODE_ORBIT.length
  const [side, bit] = DSCODE_ORBIT[index]!
  const [previousSide, previousBit] = DSCODE_ORBIT[(index + DSCODE_ORBIT.length - 1) % DSCODE_ORBIT.length]!
  const cells: Record<string, DscodeSpinnerCell> = {
    left: { text: ' ', color: palette.brandMid },
    right: { text: ' ', color: palette.brandMid },
  }
  if (previousSide === side) {
    cells[side] = { text: String.fromCharCode(0x2800 | bit | previousBit), color: palette.brandMid }
  } else {
    cells[side] = { text: String.fromCharCode(0x2800 | bit), color: palette.brandMid }
    cells[previousSide] = { text: String.fromCharCode(0x2800 | previousBit), color: palette.dim }
  }
  // The flake breathes with the orbit: brightest as the comet passes the top.
  const flake = dscodeMixTone(palette.brandDeep, palette.brandBright, (Math.cos(2 * Math.PI * index / DSCODE_ORBIT.length) + 1) / 2)
  return { left: cells.left!, flake, right: cells.right! }
}

/** What the turn is doing: the running tool's label, else replying/thinking. */
function dscodeActivity(entries: readonly TranscriptEntry[], streaming: boolean): string {
  const running = entries.filter(entry => entry.kind === 'tool' && entry.state === 'running')
  const tool = running.at(-1)
  if (tool === undefined || tool.kind !== 'tool') return streaming ? dscodeT('activity.replying') : dscodeT('activity.thinking')
  let description = ''
  try {
    if (typeof tool.arguments === 'string' && tool.arguments.length <= 4096) {
      const args = JSON.parse(tool.arguments)
      if (typeof args?.description === 'string') description = args.description
    }
  } catch {}
  // No raw argument or command dump in the chat chrome; a supplied description is
  // a task label, not a claim that the command succeeded.
  return dscodeT('activity.running') + ' · ' + singleLineText(tool.name) + (running.length > 1 ? ' +' + (running.length - 1) : '')
    + (description ? ' · ' + truncateColumns(singleLineText(description), 56) : '')
}

// dscode: the compaction indicator — a small scripted Tetris bot that lines each
// piece up, drops it and clears full rows, the way compaction clears older history.
function dscodeTetrisCells(row: string, palette: ReturnType<typeof getPalette>, key: string): readonly ReactElement[] {
  return [...row].map((cell, index) => createElement(
    Text,
    {
      key: key + '-' + index,
      color: inkColor(cell === '@' ? palette.brandBright : cell === '#' ? palette.brandMid : cell === '=' ? palette.warn : palette.dim),
    },
    cell === '.' ? ' .' : cell === '=' ? '==' : '[]',
  ))
}

export function DscodeCompactionLine({ since, rows, animated = true }: { since: number; rows: number; animated?: boolean }): ReactElement {
  const columns = useStdout().stdout?.columns ?? 80
  const tick = useFrames(animated ? DSCODE_TETRIS_TICK_MS : 1000)
  const palette = getPalette()
  const board = dscodeTetrisFrame(animated ? tick : 0)
  const clock = runClock(since > 0 ? Math.max(0, Date.now() - since) : 0)
  const room = Math.max(1, columns - 8 - DSCODE_TETRIS_WIDTH * 2)
  const wall = (key: string): ReactElement => createElement(Text, { key, color: inkColor(palette.dim) }, '|')
  const label = (labelText: string, color: readonly number[]): ReactElement =>
    createElement(Text, { key: 'label', color: inkColor(color), wrap: 'truncate-end' }, '  ' + truncateColumns(labelText, room))
  if (columns < DSCODE_TETRIS_WIDTH * 2 + 12) {
    return createElement(
      Box,
      { paddingX: 2 },
      createElement(Text, { color: inkColor(palette.brandBright), wrap: 'truncate-end' }, truncateColumns(dscodeT('compaction.running') + ' · ' + clock, Math.max(1, columns - 4))),
    )
  }
  if (rows < 5) {
    return createElement(
      Box,
      { paddingX: 2 },
      wall('left'),
      ...dscodeTetrisCells(board[board.length - 1]!, palette, 'cell'),
      wall('right'),
      label(dscodeT('compaction.running') + ' · ' + clock, palette.brandBright),
    )
  }
  return createElement(
    Box,
    { flexDirection: 'column', paddingX: 2 },
    ...board.map((row, y) => createElement(
      Box,
      { key: y },
      wall('left'),
      ...dscodeTetrisCells(row, palette, 'cell'),
      wall('right'),
      y === 1 ? label(dscodeT('compaction.running'), palette.brandBright) : y === 2 ? label(clock, palette.dim) : undefined,
    )),
    createElement(Text, { color: inkColor(palette.dim) }, '+' + '-'.repeat(DSCODE_TETRIS_WIDTH * 2) + '+'),
  )
}

export function DscodeActivityLine({ entries, streaming, since, animated = true }: { entries: readonly TranscriptEntry[]; streaming: boolean; since: number; animated?: boolean }): ReactElement {
  const columns = useStdout().stdout?.columns ?? 80
  const tick = useFrames(animated ? 100 : 1000)
  const elapsed = since > 0 ? Math.max(0, Date.now() - since) : 0
  const suffix = columns >= 64
    ? ' · ' + dscodeT('activity.turn') + ' ' + runClock(elapsed) + ' · ' + dscodeT('activity.interrupt')
    : ' · ' + dscodeT('activity.turn') + ' ' + runClock(elapsed)
  const palette = getPalette()
  const spinner = animated
    ? dscodeSpinnerCells(tick, palette)
    : { left: { text: ' ', color: palette.brandMid as readonly number[] }, flake: palette.brandBright as readonly number[], right: { text: ' ', color: palette.brandMid as readonly number[] } }
  const label = truncateColumns(dscodeActivity(entries, streaming), Math.max(1, columns - 9 - visibleColumns(suffix)))
  return createElement(
    Box,
    { paddingX: 2 },
    createElement(
      Text,
      { wrap: 'truncate-end' },
      createElement(Text, { color: inkColor(spinner.left.color as never) }, spinner.left.text),
      createElement(Text, { color: inkColor(spinner.flake as never) }, '❄'),
      createElement(Text, { color: inkColor(spinner.right.color as never) }, spinner.right.text),
      createElement(Text, { color: inkColor(getPalette().brandBright) }, ' ' + label),
      createElement(Text, { color: inkColor(getPalette().dim) }, suffix),
    ),
  )
}

function DeepDivingLine({ since, animated = true }: { since: number; animated?: boolean }): ReactElement {
  const elapsed = since === 0 ? 0 : Date.now() - since
  const text = elapsed >= 15_000 ? `✻ Deep diving... ${runClock(elapsed)}` : '✻ Deep diving...'
  return createElement(ShimmerLine, { text, animated })
}

/**
 * The streaming buffer rendered with a hard size cap: the live region must
 * ALWAYS fit the terminal, or Ink's erase/rewrite of a dynamic tree taller
 * than the screen freezes (cursor-up past the top, garbage, no scroll). The
 * cap counts explicit newlines and terminal wrapping, slicing from the END so
 * the freshest tokens stay visible while a long reply streams; the complete
 * text lands in the flushed scrollback once the turn assembles it.
 */
function StreamTail({ text, dim, maxRows, prefix = '', continuationPrefix = prefix, children }: {
  text: string
  dim: boolean
  maxRows: number
  prefix?: string
  continuationPrefix?: string
  children?: ReactElement
}): ReactElement {
  const columns = useStdout().stdout?.columns ?? 80
  const safeRows = Math.max(1, maxRows)
  // The final extra column keeps a caret from wrapping onto an unbudgeted
  // row. Both prefixes participate because every physical row repeats its
  // hanging indent.
  const prefixColumns = Math.max(visibleColumns(prefix), visibleColumns(continuationPrefix))
  // Content takes the full physical row minus prefixes and the final wrap
  // column — a forced 10-column FLOOR on a narrower terminal made every row
  // autowrap onto a second, unbudgeted row (the live budget then
  // under-counted and the tree overflowed), so the width now shrinks with
  // the real terminal instead of flooring at 10.
  const contentColumns = Math.max(1, columns - 1 - prefixColumns)
  const initial = displayTail(text, contentColumns, safeRows)
  // Reserve one row for the omission marker only when a marker is needed.
  const tail = initial.truncated && safeRows > 1
    ? displayTail(text, contentColumns, safeRows - 1)
    : initial
  const rows = tail.text.split('\n')
  return createElement(
    Box,
    { flexDirection: 'column' },
    tail.truncated && safeRows > 1
      ? createElement(Text, { color: inkColor(getPalette().dim) }, continuationPrefix, '…')
      : undefined,
    ...rows.map((row, index) => createElement(
      Text,
      // truncate-end is the same belt-and-braces StyledRows uses: any width
      // miscalculation clips a row instead of wrapping it out of budget.
      { key: index, dimColor: dim || undefined, wrap: 'truncate-end' },
      index === 0 ? prefix : continuationPrefix,
      row,
      index + 1 === rows.length ? children : undefined,
    )),
  )
}

/** Ink props for one markdown style class. */
function segmentProps(style: MdSegment['style']): {
  color: string | undefined
  bold: boolean | undefined
  italic: boolean | undefined
  strikethrough: boolean | undefined
} {
  switch (style) {
    case 'accent':
      return { color: inkColor(getPalette().brandBright), bold: undefined, italic: undefined, strikethrough: undefined }
    case 'accentBold':
      return { color: inkColor(getPalette().brandBright), bold: true, italic: undefined, strikethrough: undefined }
    case 'code':
      return { color: inkColor(getPalette().code), bold: undefined, italic: undefined, strikethrough: undefined }
    case 'dim':
      return { color: inkColor(getPalette().dim), bold: undefined, italic: undefined, strikethrough: undefined }
    case 'bold':
      return { color: undefined, bold: true, italic: undefined, strikethrough: undefined }
    case 'italic':
      return { color: undefined, bold: undefined, italic: true, strikethrough: undefined }
    case 'boldItalic':
      return { color: undefined, bold: true, italic: true, strikethrough: undefined }
    case 'strike':
      return { color: inkColor(getPalette().dim), bold: undefined, italic: undefined, strikethrough: true }
    case 'diffAdd':
    case 'diffDel':
      // Inline-markdown twin of lineStyleProps' diff cases: tinted rows for
      // ```diff fences rendered through the markdown span path. The diff
      // foreground tokens stay AA-legible both on the row tints (when the
      // background rides along) and on the plain terminal background.
      return {
        color: inkColor(style === 'diffAdd' ? getPalette().diffAddFg : getPalette().diffDelFg),
        bold: undefined,
        italic: undefined,
        strikethrough: undefined,
      }
    default:
      return { color: undefined, bold: undefined, italic: undefined, strikethrough: undefined }
  }
}

/** Ink props for the richer line model used by bounded scrolling panels. */
function lineStyleProps(style: LineStyle): {
  color: string | undefined
  bold: boolean | undefined
  italic: boolean | undefined
  strikethrough: boolean | undefined
  dimColor: boolean | undefined
  backgroundColor: string | undefined
} {
  switch (style) {
    case 'brand':
      return { color: inkColor(getPalette().brandBright), bold: undefined, italic: undefined, strikethrough: undefined, dimColor: undefined, backgroundColor: undefined }
    case 'success':
      return { color: inkColor(getPalette().success), bold: undefined, italic: undefined, strikethrough: undefined, dimColor: undefined, backgroundColor: undefined }
    case 'error':
      return { color: inkColor(getPalette().error), bold: undefined, italic: undefined, strikethrough: undefined, dimColor: undefined, backgroundColor: undefined }
    case 'warn':
      return { color: inkColor(getPalette().warn), bold: undefined, italic: undefined, strikethrough: undefined, dimColor: undefined, backgroundColor: undefined }
    case 'dimItalic':
      return { color: inkColor(getPalette().dim), bold: undefined, italic: true, strikethrough: undefined, dimColor: undefined, backgroundColor: undefined }
    // Codex diff rendering: added/removed lines carry a theme tint behind
    // the sign and text, with the AA-tuned diff foreground tokens on top; the
    // depth gate turns this into plain foreground styling on 16-color
    // terminals.
    case 'diffAdd':
      return { color: inkColor(getPalette().diffAddFg), bold: undefined, italic: undefined, strikethrough: undefined, dimColor: undefined, backgroundColor: diffBackground('diffAdd') }
    case 'diffDel':
      return { color: inkColor(getPalette().diffDelFg), bold: undefined, italic: undefined, strikethrough: undefined, dimColor: undefined, backgroundColor: diffBackground('diffDel') }
    // Prompt rows: one full-width bar per delivery kind. The tint comes from
    // the row token and the foreground from its AA-tuned twin; the depth gate
    // inside rowBackground degrades this to foreground-only on 16-color
    // terminals, matching the diff rows.
    case 'promptRow':
    case 'promptQueuedRow':
    case 'promptSteeredRow': {
      const tokens = promptRowTokens(style === 'promptQueuedRow' ? 'queued' : style === 'promptSteeredRow' ? 'steered' : undefined)
      return {
        color: inkColor(getPalette()[tokens.fg]),
        bold: undefined,
        italic: undefined,
        strikethrough: undefined,
        dimColor: undefined,
        backgroundColor: rowBackground(tokens.fg),
      }
    }
    default:
      return { ...segmentProps(style), dimColor: undefined, backgroundColor: undefined }
  }
}

/** Render width-safe rows; every child is exactly one terminal row. */
function StyledRows({ lines }: { lines: readonly StyledLine[] }): ReactElement {
  return createElement(
    Box,
    { flexDirection: 'column' },
    ...lines.map((line, index) => createElement(
      Text,
      {
        key: index,
        wrap: 'truncate-end',
        // dscode: the wrapped prompt paints as one continuous band.
        backgroundColor: line.background === 'user' ? inkColor(getPalette().composerBand) : undefined,
        color: line.background === 'user' ? inkColor(getPalette().text) : undefined,
      },
      line.segments.length === 0
        ? ' '
        : line.segments.map((segment, at) => createElement(
          Text,
          { key: at, ...lineStyleProps(segment.style) },
          segment.text,
        )),
    )),
  )
}

/** File-oriented, color-coded unified diff viewport. */
function DiffPanel({ view, onClose }: { view: GitDiffView; onClose: () => void }): ReactElement {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const [fileIndex, setFileIndex] = useState(0)
  const [scroll, setScroll] = useState(0)
  const file = view.files[fileIndex]
  const lines = useMemo(() => {
    if (file === undefined) return textLines('  (no changes)', viewport.contentColumns, 'dim')
    return fillDiffLineBars(file.lines.flatMap(line => styledLines([lineSegment(line, diffLineStyle(line))], viewport.contentColumns)), viewport.contentColumns)
  }, [file, viewport.contentColumns])
  const visibleScroll = clampScroll(scroll, lines.length, viewport.bodyRows)
  useInput((input, key) => {
    if (key.escape || input === 'q') onClose()
    else if (key.leftArrow && view.files.length > 0) {
      setFileIndex(current => (current + view.files.length - 1) % view.files.length)
      setScroll(0)
    } else if (key.rightArrow && view.files.length > 0) {
      setFileIndex(current => (current + 1) % view.files.length)
      setScroll(0)
    }
    else if (input === 'g') setScroll(0)
    else if (input === 'G') setScroll(Math.max(0, lines.length - viewport.bodyRows))
    else if (key.upArrow) setScroll(current => moveScroll(current, -1, lines.length, viewport.bodyRows))
    else if (key.downArrow) setScroll(current => moveScroll(current, 1, lines.length, viewport.bodyRows))
    else if (key.pageUp) setScroll(current => moveScroll(current, -viewport.bodyRows, lines.length, viewport.bodyRows))
    else if (key.pageDown) setScroll(current => moveScroll(current, viewport.bodyRows, lines.length, viewport.bodyRows))
  })
  if (viewport.compact) return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(t('panel.diff.compact', { title: view.title, files: view.files.length }), viewport.contentColumns))
  const accent = panelAccent('diff', getPalette().dim, getPalette().brand)
  return createElement(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: inkColor(accent.border), paddingX: 1 },
    createElement(Text, { color: inkColor(accent.title), bold: true, wrap: 'truncate-end' }, truncateColumns(`${view.title} · ${view.files.length === 0 ? t('panel.diff.noFiles') : `${fileIndex + 1}/${view.files.length} ${file?.path ?? ''}`} · rows ${lines.length === 0 ? 0 : visibleScroll + 1}-${Math.min(lines.length, visibleScroll + viewport.bodyRows)}/${lines.length}`, viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(StyledRows, { lines: lines.slice(visibleScroll, visibleScroll + viewport.bodyRows) }),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(t('panel.diff.footer'), viewport.contentColumns)),
  )
}

/** Codex-style panel rhythm that still participates in the row budget. */
function PanelGap({ visible }: { visible: boolean }): ReactElement | undefined {
  return visible ? createElement(Text, null, ' ') : undefined
}


/**
 * The whale header with a compact copy lockup. The dsh kernel version (when
 * the host manifest resolves), the title, the bilingual slogan, and the key
 * hint stay centered inside the existing eight content rows, preserving the
 * Static header's ten physical rows; without a resolvable host the lockup
 * keeps its historical three lines. Short or narrow terminals keep a one-line
 * form without the kernel line.
 */
/**
 * One whale-glyph row painted as a frozen seven-color spectrum (column 0
 * red, column 25 violet). Spaces stay uncolored so the silhouette punches
 * through; adjacent same-hue blocks merge into one span.
 */
function rainbowGlyphRow(row: string, rowKey: number): ReactElement {
  const span = Math.max(1, WHALE_GLYPH_COLUMNS - 1)
  const children: ReactElement[] = []
  let start = 0
  while (start < row.length) {
    if (row[start] === ' ') {
      let end = start + 1
      while (end < row.length && row[end] === ' ') end += 1
      children.push(createElement(Text, { key: start }, row.slice(start, end)))
      start = end
      continue
    }
    const color = inkColor(rainbowSpectrumHue(start / span))
    let end = start + 1
    while (end < row.length && row[end] !== ' ' && inkColor(rainbowSpectrumHue(end / span)) === color) end += 1
    children.push(createElement(Text, { key: start, color }, row.slice(start, end)))
    start = end
  }
  return createElement(Text, { key: rowKey }, ...children)
}

/** dscode's own identity header: the project, model and effort in one line. */
/** dscode's welcome header: a rippling pixel snowflake beside the session facts. */
export function Header({ cwd = '', model = '', effort = '', animated = false }: { cwd?: string; model?: string; effort?: string; animated?: boolean }): ReactElement {
  const stdout = useStdout().stdout
  const rippleTick = useFrames(animated ? 450 : 3600000)
  const ripplePhase = animated ? rippleTick % 4 : 3
  const columns = stdout?.columns ?? 80
  const full = (stdout?.rows ?? 30) >= 24 && columns >= 64
  const width = Math.max(1, full ? Math.min(columns - 2, 84) : columns - 4)
  const contentWidth = Math.max(1, width - (full ? 4 : 0))
  const detailsWidth = Math.max(1, contentWidth - (full ? 28 : 0))
  const modelName = singleLineText(model).split('/').at(-1) || 'unknown'
  const effortName = singleLineText(effort) || 'default'
  const project = welcomePath(cwd, detailsWidth)
  const palette = getPalette()
  const art = (stdout?.rows ?? 30) >= 26 ? WELCOME_ART : WELCOME_ART_SMALL
  const luminance = ([red, green, blue]: readonly number[]): number => red * 299 + green * 587 + blue * 114
  const tones = [palette.brandDeep, palette.brand, palette.brandBright].sort((left, right) => luminance(left) - luminance(right))
  // Ripple: the bright band moves core → ring → tips, then rests one frame in the base tones.
  const rippleBand: Record<number, number> = { 1: 2, 2: 1, 3: 0 }
  const tone = (level: number): readonly number[] => ripplePhase < 3
    ? (rippleBand[level] === ripplePhase ? tones[2]! : level === 3 ? tones[1]! : tones[0]!)
    : tones[level - 1]!
  if (!full) {
    return createElement(
      Box,
      { flexDirection: 'column', paddingX: 2, marginBottom: 1 },
      createElement(
        Text,
        { wrap: 'truncate-end' },
        createElement(Text, { color: inkColor(getPalette().brandBright), bold: true }, '❄ DSCODE'),
        createElement(Text, { color: inkColor(getPalette().dim) }, '  v' + DSCODE_VERSION),
      ),
      createElement(Text, { wrap: 'truncate-end' }, truncateColumns(modelName + ' · ' + effortName, width)),
      createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, welcomePath(cwd, width)),
    )
  }
  return createElement(
    Box,
    { flexDirection: 'column', width, borderStyle: 'round', borderColor: inkColor(getPalette().brand), paddingX: 1 },
    createElement(
      Box,
      { flexDirection: 'row' },
      createElement(
        Box,
        { flexDirection: 'column', width: 28 },
        ...welcomeArtRows(art, { '1': inkColor(tone(1)), '2': inkColor(tone(2)), '3': inkColor(tone(3)) }).map((segments, row) =>
          createElement(
            Text,
            { key: row },
            '  ',
            ...segments.map((segment, index) => createElement(Text, { key: index, color: segment.color || undefined, backgroundColor: segment.background || undefined }, segment.text)),
          )),
      ),
      createElement(
        Box,
        { flexDirection: 'column', width: detailsWidth, marginTop: 2 },
        createElement(Text, { color: inkColor(getPalette().text), bold: true }, 'DSCODE'),
        createElement(Text, { color: inkColor(getPalette().brandDeep) }, '────────────'),
        createElement(Text, { color: inkColor(getPalette().dim) }, 'v' + DSCODE_VERSION),
        createElement(Text, { wrap: 'truncate-end' }, truncateColumns(dscodePadEnd(dscodeT('welcome.model'), 9) + modelName, detailsWidth)),
        createElement(Text, { wrap: 'truncate-end' }, truncateColumns(dscodePadEnd(dscodeT('welcome.effort'), 9) + effortName, detailsWidth)),
        createElement(Text, null, ' '),
        createElement(Text, { color: inkColor(getPalette().dim) }, dscodeT('welcome.project')),
        createElement(Text, { wrap: 'truncate-end' }, project),
      ),
    ),
  )
}
function todoMark(status: TodoItem['status']): string {
  return status === 'completed' ? '✓' : status === 'in_progress' ? '●' : '○'
}

/**
 * One-row live subagent summary (the Codex agent status feed, compressed to
 * the transcript's budget): running count, the observed total (the row cap
 * is a display budget, not the fan-out size), and the most recently active
 * child's current activity. One line, never more — the full view is the
 * /agents panel.
 */
function AgentsLine({ rows, total }: { rows: readonly SubagentRow[]; total: number }): ReactElement | undefined {
  const columns = useStdout().stdout?.columns ?? 80
  if (rows.length === 0) return undefined
  const running = rows.filter(row => row.state === 'running')
  const idle = rows.filter(row => row.state === 'idle').length
  const done = rows.filter(row => row.state === 'done').length
  const active = [...running].sort((a, b) => b.updatedAt - a.updatedAt)[0]
  const counts = [
    running.length + ' ' + dscodeT('agents.running'),
    idle ? idle + ' ' + dscodeT('agents.idle') : '',
    done ? done + ' ' + dscodeT('agents.done') : '',
    total > rows.length ? total + ' ' + dscodeT('agents.total') : '',
  ].filter(Boolean).join(' · ')
  const summary = 'agents ' + (columns < 60 ? running.length + ' ' + dscodeT('agents.running') : counts) + ' · /agents'
  const detail = active && columns >= 80 ? ' — ' + singleLineText(active.label) + ' · ' + singleLineText(active.activity) : ''
  return createElement(
    Box,
    { paddingX: 2 },
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(summary + detail, Math.max(1, columns - 4))),
  )
}

function TodoPanel({ todos }: { todos: readonly TodoItem[] }): ReactElement | undefined {
  if (todos.length === 0) return undefined
  const completed = todos.filter(todo => todo.status === 'completed').length
  const inProgress = todos.filter(todo => todo.status === 'in_progress').length
  const pending = todos.length - completed - inProgress
  const current = todos.find(todo => todo.status === 'in_progress')
  return createElement(
    Box,
    { paddingX: 1 },
    createElement(
      Text,
      { color: inkColor(getPalette().brand), bold: true, wrap: 'truncate-end' },
      `todos ${completed}/${todos.length}`,
      createElement(Text, { dimColor: true }, ` · ${inProgress} active · ${pending} pending`),
      current === undefined ? '' : createElement(Text, { color: inkColor(getPalette().brandBright) }, ` · ${todoMark(current.status)} ${displayText(current.content)}`),
      createElement(Text, { color: inkColor(getPalette().dim) }, ' · /todos'),
    ),
  )
}

/**
 * The /todos subpage: the full todo list in one bounded, scrollable panel.
 * The live tree's TodoPanel stays a one-row summary; this exclusive view
 * shows EVERY item with its three-state mark inside the shared panel
 * viewport (same contract as /help and Ctrl+O: border/title/body/footer all
 * ride one height budget, the composer and status stay put below).
 */
function TodoListPanel({ todos, onClose }: { todos: readonly TodoItem[]; onClose: () => void }): ReactElement {
  const stdout = useStdout().stdout
  const columns = stdout?.columns ?? 80
  const viewport = panelViewport(columns, stdout?.rows ?? 30)
  const [scroll, setScroll] = useState(0)
  const bodyColumns = Math.max(4, viewport.contentColumns - 4)
  const completed = todos.filter(todo => todo.status === 'completed').length
  const inProgress = todos.filter(todo => todo.status === 'in_progress').length
  const pending = todos.length - completed - inProgress
  const rows = todos.length === 0
    ? [createElement(Text, { key: 'empty', dimColor: true, wrap: 'truncate-end' }, `  ${t('panel.todos.empty')}`)]
    : todos.map(todo => createElement(
      Text,
      { key: todo.content, dimColor: true, wrap: 'truncate-end' },
      `  ${todoMark(todo.status)} ${truncateColumns(displayText(todo.content), bodyColumns)}`,
    ))
  const visibleScroll = clampScroll(scroll, rows.length, viewport.bodyRows)
  const scrollBy = (delta: number): void => {
    setScroll(current => moveScroll(current, delta, rows.length, viewport.bodyRows))
  }

  useEffect(() => {
    if (visibleScroll !== scroll) setScroll(visibleScroll)
  }, [visibleScroll, scroll])

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onClose()
      return
    }
    if (key.upArrow) scrollBy(-1)
    else if (key.downArrow) scrollBy(1)
    else if (key.pageUp) scrollBy(-Math.max(1, viewport.bodyRows - 1))
    else if (key.pageDown) scrollBy(Math.max(1, viewport.bodyRows - 1))
    else if (input === 'g') setScroll(0)
    else if (input === 'G') setScroll(Math.max(0, rows.length - viewport.bodyRows))
  })

  if (viewport.maxHeight === 0 || viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(t('panel.todos.compact'), viewport.contentColumns))
  }

  const accent = panelAccent('todos', getPalette().brand)
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(accent.border) },
    createElement(Text, { color: inkColor(accent.title), bold: true, wrap: 'truncate-end' }, truncateColumns(t('panel.todos.title', { done: completed, total: todos.length, active: inProgress, pending, from: rows.length === 0 ? 0 : visibleScroll + 1, to: Math.min(rows.length, visibleScroll + viewport.bodyRows), rows: rows.length }), viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    ...rows.slice(visibleScroll, visibleScroll + viewport.bodyRows),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { wrap: 'truncate-end' }, dim(truncateColumns(t('panel.todos.footer'), viewport.contentColumns))),
  )
}

const MemoTodoListPanel = memo(TodoListPanel)

/** Rows in the exact next-turn inbox order, never transcript append order. */
export function queuedInboxRows(
  entries: readonly TranscriptEntry[],
  ids: readonly string[],
): readonly Extract<TranscriptEntry, { kind: 'pending' }>[] {
  const byId = new Map<string, Extract<TranscriptEntry, { kind: 'pending' }>>()
  for (const entry of entries) {
    if (entry.kind === 'pending' && entry.target === 'next-turn') byId.set(entry.messageId, entry)
  }
  return ids.flatMap(id => {
    const row = byId.get(id)
    return row === undefined ? [] : [row]
  })
}

/** A bounded, keyboard-owned management surface for the durable next-turn inbox. */
function QueuePanel({ rows, busy, update, onClose }: {
  rows: readonly Extract<TranscriptEntry, { kind: 'pending' }>[]
  busy: boolean
  update?: (messageId: string, action: QueueMutation) => void
  onClose: () => void
}): ReactElement {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const [selected, setSelected] = useState(0)
  const [scroll, setScroll] = useState(0)
  const [editing, setEditing] = useState<{ messageId: string; text: string; cursor: number } | undefined>(undefined)
  // Ink can deliver a following key before its effect swaps the input
  // listener after an edit-mode render; this ref keeps the editor's key
  // stream coherent while the visible state catches up.
  const editingRef = useRef(editing)
  const current = rows[selected]
  const visibleScroll = revealRow(clampScroll(scroll, rows.length, viewport.bodyRows), selected, rows.length, viewport.bodyRows)
  const move = (delta: number): void => {
    setSelected(current => Math.max(0, Math.min(rows.length - 1, current + delta)))
  }

  useEffect(() => {
    setSelected(current => Math.max(0, Math.min(rows.length - 1, current)))
    if (editing !== undefined && !rows.some(row => row.messageId === editing.messageId)) {
      editingRef.current = undefined
      setEditing(undefined)
    }
  }, [rows, editing])
  useEffect(() => {
    if (visibleScroll !== scroll) setScroll(visibleScroll)
  }, [visibleScroll, scroll])

  useStableInput((input, key) => {
    const activeEdit = editingRef.current
    if (activeEdit !== undefined) {
      if (key.escape) {
        editingRef.current = undefined
        setEditing(undefined)
        return
      }
      if (key.return) {
        if (activeEdit.text.trim() !== '') update?.(activeEdit.messageId, { kind: 'edit', text: activeEdit.text })
        editingRef.current = undefined
        setEditing(undefined)
        return
      }
      if (key.leftArrow) {
        const next = { ...activeEdit, cursor: moveCursorBy(activeEdit.text, activeEdit.cursor, -1) }
        editingRef.current = next
        setEditing(next)
        return
      }
      if (key.rightArrow) {
        const next = { ...activeEdit, cursor: moveCursorBy(activeEdit.text, activeEdit.cursor, 1) }
        editingRef.current = next
        setEditing(next)
        return
      }
      // Ink 5 reports 0x7F (backspace) and the forward-delete sequence as the
      // same `key.delete`, so a bare Delete binding here would erase on a
      // habitual Backspace. This management surface keeps `d` as its only
      // removal key instead of guessing which byte arrived.
      if (key.backspace || key.delete) {
        const edit = deleteBackward(activeEdit.text, activeEdit.cursor)
        const next = { ...activeEdit, text: edit.value, cursor: edit.cursor }
        editingRef.current = next
        setEditing(next)
        return
      }
      if (input !== '' && !key.ctrl && !key.meta) {
        const edit = insertText(activeEdit.text, activeEdit.cursor, input)
        const next = { ...activeEdit, text: edit.value, cursor: edit.cursor }
        editingRef.current = next
        setEditing(next)
      }
      return
    }
    if (key.escape || input === 'q') {
      onClose()
      return
    }
    if (key.upArrow) move(-1)
    else if (key.downArrow) move(1)
    else if (key.pageUp) move(-Math.max(1, viewport.bodyRows - 1))
    else if (key.pageDown) move(Math.max(1, viewport.bodyRows - 1))
    else if (input === 'g') setSelected(0)
    else if (input === 'G') setSelected(Math.max(0, rows.length - 1))
    else if (input === 'e' && current !== undefined) {
      // Text is editable on every row: an edit rewrites what the user typed
      // and carries the row's attachments through untouched, which is exactly
      // what the row's read-only attachment marker promises.
      const next = { messageId: current.messageId, text: current.text, cursor: current.text.length }
      editingRef.current = next
      setEditing(next)
    }
    else if (input === 'd' && current !== undefined) update?.(current.messageId, { kind: 'remove' })
    else if (key.return && current !== undefined && busy) update?.(current.messageId, { kind: 'steer' })
  }, true)

  if (viewport.maxHeight === 0 || viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(t('panel.queue.compact'), viewport.contentColumns))
  }
  const body = rows.length === 0
    ? [createElement(Text, { key: 'empty', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(t('panel.queue.empty'), viewport.contentColumns))]
    : rows.map((row, index) => {
      const selectedRow = index === selected
      const suffix = (row.images?.length ?? 0) + (row.files?.length ?? 0) > 0 ? ` ${t('panel.queue.attachments')}` : ''
      if (editing?.messageId === row.messageId) {
        const before = editing.text.slice(0, editing.cursor)
        const caret = editing.text.slice(editing.cursor, editing.cursor + 1) || ' '
        const after = editing.text.slice(editing.cursor + caret.length)
        return createElement(Text, { key: row.messageId, color: inkColor(getPalette().brandBright), wrap: 'truncate-end' }, truncateColumns(`✎ ${before}[${caret}]${after}`, viewport.contentColumns))
      }
      return createElement(Text, { key: row.messageId, color: inkColor(selectedRow ? getPalette().brandBright : getPalette().dim), bold: selectedRow || undefined, wrap: 'truncate-end' }, truncateColumns(`${selectedRow ? '›' : ' '} ${index + 1}. ${singleLineText(row.text)}${suffix}`, viewport.contentColumns))
    })
  const footer = editing !== undefined
    ? t('panel.queue.editFooter')
    : busy
      ? t('panel.queue.footerBusy')
      : t('panel.queue.footerIdle')
  const accent = panelAccent('queue', getPalette().brand)
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(accent.border) },
    createElement(Text, { color: inkColor(accent.title), bold: true, wrap: 'truncate-end' }, truncateColumns(t('panel.queue.title', { count: rows.length, from: rows.length === 0 ? 0 : visibleScroll + 1, to: Math.min(rows.length, visibleScroll + viewport.bodyRows) }), viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    ...body.slice(visibleScroll, visibleScroll + viewport.bodyRows),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(footer, viewport.contentColumns)),
  )
}

/**
 * Ink props for one status tone: the Codex status-line accent mapping over
 * the DeepSeek palette, all blue by design — the status bar speaks only in
 * degrees of blue (deep accent, primary figures, model identity, sky
 * paths and done states), with amber/red reserved for warnings and errors.
 */
function statusToneProps(tone: StatusTone, flowMs?: number): {
  color: string | undefined
  bold: boolean | undefined
  dimColor: boolean | undefined
} {
  if (isRainbow()) {
    // Carnival roll: every tone carries its rolled color (adjacent tones in
    // canonical on-screen order never match, the row boundary included);
    // the live dot rides the flow walk while busy. Bold emphasis carries
    // the semantic hierarchy so randomness never hides importance.
    const emphasized = tone === 'model' || tone === 'success' || tone === 'plan' || tone === 'warn' || tone === 'error'
    const color = tone === 'live' && flowMs !== undefined
      ? flowColor(flowMs, themeFlow()?.anchors ?? FLOW_ANCHORS)
      : rainbowRoll().toneColors[tone]
    return { color: inkColor(color), bold: emphasized || undefined, dimColor: undefined }
  }
  switch (tone) {
    case 'model':
      // dscode: the model name is plain identity text now — the tone merely
      // marks which segment it is.
      return { color: undefined, bold: undefined, dimColor: undefined }
    case 'live':
      // With a flow sample (flowing theme while busy), the live dot rides
      // the anchor walk; otherwise the palette's live accent.
      return { color: inkColor(flowMs === undefined ? getPalette().brandBright : flowColor(flowMs, themeFlow()?.anchors ?? FLOW_ANCHORS)), bold: undefined, dimColor: undefined }
    case 'path':
      return { color: inkColor(getPalette().code), bold: undefined, dimColor: undefined }
    case 'branch':
      return { color: inkColor(getPalette().text), bold: undefined, dimColor: undefined }
    case 'value':
      return { color: inkColor(getPalette().brand), bold: undefined, dimColor: undefined }
    case 'label':
    case 'meta':
      // Explicit RGB gray, not SGR dim: Ink's token stream inherits an
      // unclosed `dim` into the next span (the model name after the busy dot
      // rendered dim+bold and looked gray), and a concrete color closes
      // cleanly on the style transition. Theme-aware via the palette.
      return { color: inkColor(getPalette().dim), bold: undefined, dimColor: undefined }
    case 'accent':
      return { color: inkColor(getPalette().brandDeep), bold: undefined, dimColor: undefined }
    // Context-bar fill: one DeepSeek blue over the whole occupied run; the
    // dotted free track reads through the dim label gray.
    case 'ctxFill':
      return { color: inkColor(getPalette().brand), bold: undefined, dimColor: undefined }
    case 'success':
      return { color: inkColor(getPalette().code), bold: true, dimColor: undefined }
    // The plan station's dedicated green: the status bar otherwise speaks in
    // blues, but the fourth cycle station IS a distinct green mode marker.
    case 'plan':
      return { color: inkColor(getPalette().success), bold: true, dimColor: undefined }
    case 'warn':
      return { color: inkColor(getPalette().warn), bold: true, dimColor: undefined }
    case 'error':
      return { color: inkColor(getPalette().error), bold: true, dimColor: undefined }
    default:
      return { color: inkColor(getPalette().dim), bold: undefined, dimColor: undefined }
  }
}

/**
 * The footer status line: two stacked physical rows in every mode. Row 1
 * carries Claude-Code-style identity facts and session figures from the left
 * with the Codex-style permission badge — the autonomous-selection anchor
 * with its shift+tab cycle hint — pinned to the right edge. Row 2 (mode,
 * context progress bar, cache, duration figures) renders only while it has
 * content, so the footer degrades to a single row on narrow terminals. Both
 * layouts arrive pre-measured from the pure reducer, so Ink only paints;
 * truncation degrades groups, it never wraps a row.
 *
 * The DeepSeek easter egg: when the model label *switches* to an official
 * DeepSeek route, the composer's INPUT ROW (the band's middle) plays Codex's
 * effort-ignition "Wave" — a blue crest sweeping the content row column by
 * column, with the `· ✦ ✧` sparkles on the deepseek tier — and the prompt
 * marker keeps the tier accent afterwards. The border stays a constant
 * static dim; only the row's per-column background tints during the wave,
 * so the row and column budget is untouched throughout.
 */

/** Theme anchors for the one-shot composer wave, read from the active palette
 * so the wave stays coordinated in both themes. The flash tier runs the
 * brand blues; the deepseek AND unknown tiers swap in the code sky-blue for
 * a brighter, richer mix (the unknown tier reuses the pro palette). Codex's
 * Wave bands carry no hue index (only hues[0] tints the row), so the accent
 * the prompt keeps is always hues[0]. */
function deepseekWaveHues(tier: DeepseekWaveTier): readonly [RgbTriple, RgbTriple, RgbTriple] {
  const palette = getPalette()
  // Rainbow waves pick three SPECTRALLY SPREAD anchors from the rolled
  // pool — spectral neighbors would wash into one hue across the band.
  if (isRainbow()) {
    const anchors = rainbowRoll().flowAnchors
    const stride = Math.max(1, Math.floor(anchors.length / 3))
    return [anchors[0], anchors[stride], anchors[stride * 2]]
  }
  // Prismatic waves ride the flow anchors for both tiers — the model-switch
  // easter egg becomes a violet→fuchsia→cyan sweep.
  if (isPrismatic()) return [FLOW_ANCHORS[0], FLOW_ANCHORS[1], FLOW_ANCHORS[2]]
  return tier === 'flash'
    ? [palette.brandBright, palette.brand, palette.brandMid]
    : [palette.brandBright, palette.code, palette.brandMid]
}

export function StatusLine({ facts, stats, busy, columns, items, onRows, animated }: {
  facts: StatusFacts
  stats: Parameters<typeof layoutStatusBar>[1]
  busy: boolean
  columns: number
  items: readonly string[]
  /** Reports the footer's exact physical row count (1 or 2) so the IME
   * anchor ledger below the composer stays exact. */
  onRows?: (rows: 1 | 2) => void
  /** Whether timed animations run (the persisted preference). */
  animated: boolean
}): ReactElement {
  // dscode: the metrics row re-reads its live ledger once a second, so tps and
  // spend track the turn instead of the last remount.
  const [, dscodeRefreshMetrics] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => dscodeRefreshMetrics(n => n + 1), 1000)
    return () => clearInterval(timer)
  }, [])
  // dscode: the telemetry segment carries the header and only appears once the
  // terminal can seat it; below that the identity row keeps the model.
  facts = { ...facts, telemetry: columns >= 48 ? dscodeFooterFor(facts.fullSessionId, stats, Math.max(1, Math.min(columns - 8, Math.max(40, Math.floor(columns * 0.8) - 4))), dscodeFooterHeader(facts, stats), getLanguage()) : '' }
  // Flowing-theme busy flow: the identity cluster's live dot cycles the
  // anchor walk while a turn runs; static themes never start the timer.
  const flow = themeFlow()
  const flowActive = animated && busy && flow !== undefined
  const flowTick = useFrames(BUSY_CHASE_TICK_MS, flowActive)
  const flowMs = flowActive ? flowTick * BUSY_CHASE_TICK_MS + (flow?.phaseMs ?? 0) : undefined
  const language = getLanguage()
  const layout = useMemo(() => layoutStatusBar(facts, stats, Math.max(8, columns - 2), {
    busy,
    items,
    // Match the composer content budget: border + horizontal padding are
    // already excluded, and layoutStatusBar shrinks this ceiling as needed.
    contextWidth: Math.max(5, columns - 6),
  }), [
    facts.telemetry,
    facts.model,
    facts.effort,
    facts.mode,
    facts.cwd,
    facts.branch,
    facts.sessionId,
    facts.title,
    facts.sandbox,
    facts.plan,
    facts.permission,
    facts.goal?.phase,
    facts.goal?.rounds,
    facts.goal?.max,
    stats,
    busy,
    columns,
    items,
    // Labels come from t(); a language switch must rebuild the rows.
    language,
  ])
  // The IME anchor below the composer counts every row between the caret and
  // Ink's parked cursor, so the footer reports its exact row count one-way
  // (same contract as the composer's row report).
  const statusRowCount: 1 | 2 = layout.row2.left.length > 0 || layout.row2.right.length > 0 ? 2 : 1
  useEffect(() => {
    onRows?.(statusRowCount)
  }, [onRows, statusRowCount])

  const renderRow = (row: { left: readonly StatusGroup[]; right: readonly StatusSpan[]; hint: boolean }, key: string, indent = 0): ReactElement => {
    const leftParts: ReactElement[] = []
    row.left.forEach((group, groupIndex) => {
      if (groupIndex > 0) {
        leftParts.push(createElement(Text, { key: key + 'gs' + groupIndex, color: inkColor(getPalette().dim) }, STATUS_GROUP_SEPARATOR))
      }
      group.spans.forEach((span, spanIndex) => {
        leftParts.push(createElement(
          Text,
          { key: key + 'g' + groupIndex + 's' + spanIndex, wrap: 'truncate-end', ...statusToneProps(span.tone, flowMs) },
          span.text,
        ))
      })
    })
    const rightParts: ReactElement[] = []
    // dscode: row 2 joins its left figures to the right-pinned telemetry with a
    // quieter rule than the cluster separator.
    if (key === 's2' && row.left.length > 0 && row.right.length > 0) {
      rightParts.push(createElement(Text, { key: key + 'divider', color: inkColor(getPalette().dim) }, '｜ '))
    }
    row.right.forEach((span, index) => {
      if (index > 0) {
        rightParts.push(createElement(Text, { key: key + 'rs' + index, color: inkColor(getPalette().dim) }, STATUS_ITEM_SEPARATOR))
      }
      rightParts.push(createElement(
        Text,
        { key: key + 'r' + index, wrap: 'truncate-end', ...statusToneProps(span.tone, flowMs) },
        key === 's2' && index === 0 ? dscodeTelemetryNodes(span.text, key + 'r' + index) : span.text,
      ))
    })
    if (row.hint) {
      rightParts.push(createElement(Text, { key: key + 'hint', color: inkColor(getPalette().dim) }, statusCycleHint()))
    }
    // Each row already fits the column budget; truncate-end stays as the
    // terminal-measurement backstop so a drifting cell count clips instead
    // of wrapping.
    return createElement(
      Box,
      // Match the prompt text inside the composer band: two padding columns.
      // The secondary row adds the model-name indent
      // (its budget already shrinks by the same amount) so its figures align
      // under the model name rather than under the busy dot.
      { paddingLeft: 2 + indent, width: columns, justifyContent: rightParts.length > 0 ? 'space-between' : undefined },
      createElement(Text, { wrap: 'truncate-end' }, ...leftParts),
      rightParts.length > 0 ? createElement(Text, { wrap: 'truncate-end' }, ...rightParts) : undefined,
    )
  }
  const row2Present = layout.row2.left.length > 0 || layout.row2.right.length > 0
  return createElement(
    Box,
    { flexDirection: 'column' },
    renderRow(layout.row1, 's1'),
    row2Present ? renderRow(layout.row2, 's2', STATUS_ROW2_INDENT) : undefined,
  )
}

/**
 * One fixed-height local feedback row. Errors remain visible while a slash
 * subpage is open, but arbitrary exception text can never add physical rows
 * above the composer.
 */
function NoticeLine({ text, tone, columns }: {
  text: string
  tone: NoticeTone
  columns: number
}): ReactElement {
  const color = tone === 'error'
    ? getPalette().error
    : tone === 'warning'
      ? getPalette().warn
      : getPalette().brandBright
  const mark = tone === 'error' ? '⨯' : tone === 'warning' ? '!' : '•'
  return createElement(
    Box,
    { paddingLeft: 2 },
    createElement(
      Text,
      { color: inkColor(color), wrap: 'truncate-end' },
      truncateColumns(`${mark} ${singleLineText(text)}`, Math.max(1, columns - 2)),
    ),
  )
}

/** One selectable approval decision (Codex approval-overlay wording). */
interface ApprovalOption {
  readonly key: 'allow' | 'reject-note' | 'reject'
  readonly label: string
  readonly hotkey: string
}

/** The fixed decision list; answers stay in the binary answerer vocabulary. */
const APPROVAL_OPTIONS: readonly ApprovalOption[] = [
  { key: 'allow', label: 'Yes, proceed', hotkey: 'y' },
  { key: 'reject-note', label: 'No, and tell it what to do differently', hotkey: 'n' },
  { key: 'reject', label: 'No, continue without running it', hotkey: 'd' },
]

/**
 * The approval dialog (Codex ApprovalOverlay contract): a bold question
 * header, the bounded command body with an explicit overflow marker, a
 * numbered option list with a `›` cursor, single-key shortcuts, and digits
 * for direct selection. Askers queue FIFO — the count rides the header.
 * The upstream answerer vocabulary stays binary (`allowed-once` /
 * `rejected`): "tell it what to do differently" rejects and hands the
 * composer back with a hint notice, exactly Codex's decline-then-type flow.
 */
function ApprovalBar({ snapshot, locked, notify, interrupt, summarize }: {
  snapshot: ApprovalSnapshot
  locked: boolean
  notify: (text: string, tone?: NoticeTone) => void
  /** Cancel the running turn (Ctrl+C), matching the composer's busy branch. */
  interrupt: () => boolean
  /** Render as the bounded one-line form even on tall terminals (another
   * human-asked surface already owns the full panel budget). */
  summarize?: boolean
}): ReactElement | undefined {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const [cursor, setCursor] = useState(0)
  const pending = snapshot.pending
  const active = !locked && pending !== undefined && !snapshot.answered
  const body = useMemo<readonly StyledLine[]>(() => pending === undefined || pending.command === ''
    ? []
    : textLines(pending.command, viewport.contentColumns, 'dim'), [pending, viewport.contentColumns])

  useEffect(() => {
    setCursor(0)
  }, [pending])

  const decide = (option: ApprovalOption): void => {
    const ask = snapshot.pending
    if (ask === undefined || snapshot.answered) return
    if (option.key === 'allow') {
      ask.answer('allowed-once')
      return
    }
    ask.answer('rejected')
    if (option.key === 'reject-note') {
      notify(t('notice.rejected'), 'warning')
    }
  }

  useInput((input, key) => {
    const ask = snapshot.pending
    if (ask === undefined || snapshot.answered) return
    // Ctrl+C keeps its app-wide meaning while the ask owns the keys: cancel
    // the running turn (the ask's abort signal withdraws the question).
    // Without this branch the keystroke died here silently — the ask was the
    // only reachable surface and offered no way out.
    if (key.ctrl && input === 'c') {
      interrupt()
      return
    }
    if (key.upArrow) {
      setCursor(current => (current + APPROVAL_OPTIONS.length - 1) % APPROVAL_OPTIONS.length)
      return
    }
    if (key.downArrow) {
      setCursor(current => (current + 1) % APPROVAL_OPTIONS.length)
      return
    }
    if (key.return) {
      decide(APPROVAL_OPTIONS[cursor])
      return
    }
    if (key.escape) {
      decide(APPROVAL_OPTIONS[2])
      return
    }
    if (input === 'y' || input === 'Y') {
      decide(APPROVAL_OPTIONS[0])
      return
    }
    if (input === 'n' || input === 'N') {
      decide(APPROVAL_OPTIONS[1])
      return
    }
    if (input === 'd' || input === 'D') {
      decide(APPROVAL_OPTIONS[2])
      return
    }
    if (/^[1-9]$/u.test(input)) {
      const index = Number(input) - 1
      if (index < APPROVAL_OPTIONS.length) decide(APPROVAL_OPTIONS[index])
    }
  }, { isActive: active })

  if (pending === undefined) return undefined
  const queuedSuffix = snapshot.queued > 0 ? ` · +${snapshot.queued} queued` : ''
  if (viewport.maxHeight === 0 || viewport.compact || summarize === true) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(t('approval.compact', { queued: queuedSuffix }), viewport.contentColumns))
  }
  // Body budget: title + options + footer consume fixed rows; the command
  // preview shrinks with an explicit overflow marker (Codex's "[… N lines]").
  const reservedRows = 3 + APPROVAL_OPTIONS.length
  const bodyBudget = Math.max(1, viewport.bodyRows - reservedRows)
  const visibleBody = body.slice(0, bodyBudget)
  const overflow = body.length - visibleBody.length
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(getPalette().warn) },
    createElement(
      Text,
      { color: inkColor(getPalette().warn), bold: true, wrap: 'truncate-end' },
      truncateColumns(`${pending.headline}${queuedSuffix}`, viewport.contentColumns),
    ),
    createElement(PanelGap, { visible: viewport.gapRows > 0 && body.length > 0 }),
    ...visibleBody.map((line, index) => createElement(StyledRows, { key: `body-${index}`, lines: [line] })),
    ...(overflow > 0
      ? [createElement(Text, { key: 'overflow', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(t('approval.overflow', { count: overflow }), viewport.contentColumns))]
      : []),
    ...(body.length > 0 ? [createElement(PanelGap, { visible: viewport.gapRows > 0 })] : []),
    ...APPROVAL_OPTIONS.map((option, index) => {
      const selected = !snapshot.answered && index === cursor
      return createElement(
        Text,
        {
          key: option.key,
          color: selected ? inkColor(getPalette().brandBright) : inkColor(getPalette().text),
          bold: selected || undefined,
          wrap: 'truncate-end',
        },
        truncateColumns(`${selected ? '›' : ' '} ${index + 1}. ${option.label} (${option.hotkey})`, viewport.contentColumns),
      )
    }),
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(snapshot.answered
      ? t('approval.submitted')
      : t('approval.footer'), viewport.contentColumns)),
  )
}

interface QuestionDraftState {
  readonly selected: readonly number[]
  readonly custom: string
  readonly cursor: number
  readonly mode: 'options' | 'custom'
  readonly scroll: number
  readonly manualScroll: boolean
  readonly followCustomTail: boolean
  readonly committed: boolean
}

function initialQuestionDraft(question: AskUserQuestionItem | undefined): QuestionDraftState {
  const hasOptions = (question?.options?.length ?? 0) > 0
  return {
    selected: [],
    custom: '',
    cursor: 0,
    mode: hasOptions ? 'options' : 'custom',
    scroll: 0,
    manualScroll: false,
    followCustomTail: !hasOptions,
    committed: false,
  }
}

function answerFromQuestionDraft(question: AskUserQuestionItem, draft: QuestionDraftState): AskUserQuestionAnswerItem {
  // Multi-select changes are answers as soon as a value is toggled, matching
  // Claude-Code's draft store. `committed` still records an explicit Enter so
  // an intentionally empty answer can be submitted, while navigation away
  // from a non-empty draft never discards the user's selection.
  const hasAnswer = question.multiSelect === true
    ? draft.committed || draft.selected.length > 0 || draft.custom.trim() !== ''
    : draft.committed
  if (!hasAnswer) {
    return { id: question.id, selected: [] }
  }
  const options = question.options ?? []
  const selected = draft.selected
    .map(at => options[at]?.label)
    .filter((label): label is string => label !== undefined)
  const custom = draft.custom.trim()
  return { id: question.id, selected, ...(custom === '' ? {} : { custom }) }
}

/**
 * The ask_user_question bar: walks one request question by question,
 * retaining an independent draft for every question. Options use Space/1-9
 * to toggle a multi-select, Enter to confirm, and arrows/Ctrl+P/N to move
 * between questions. Plan reviews arrive through the same service with a
 * `plan-review` intent — the approve option gets a ✓ mark, the answer
 * encoding stays identical.
 */
function QuestionBar({ store, snapshot, locked }: { store: QuestionStore; snapshot: QuestionSnapshot; locked: boolean }): ReactElement | undefined {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const pending = snapshot.pending
  const request = pending?.request
  const [index, setIndex] = useState(0)
  const [drafts, setDrafts] = useState<readonly QuestionDraftState[]>(() => request?.questions.map(question => initialQuestionDraft(question)) ?? [])
  const [submitted, setSubmitted] = useState(false)
  const draftsRef = useRef<readonly QuestionDraftState[]>([])
  const indexRef = useRef(0)
  draftsRef.current = drafts
  indexRef.current = index

  // A new request resets the walk; questions without options start in the
  // custom-answer box (a free-form question). Depend on the request rather
  // than its wrapper snapshot: external stores may refresh that wrapper while
  // a question is still active, and a reset must never become a render loop.
  useEffect(() => {
    const next = request?.questions.map(question => initialQuestionDraft(question)) ?? []
    draftsRef.current = next
    indexRef.current = 0
    setDrafts(next)
    setIndex(0)
    setSubmitted(false)
  }, [request])

  const question = pending?.request.questions[index]
  const options = question?.options ?? []
  const isPlan = question?.intent?.kind === 'plan-review'
  const isMulti = question?.multiSelect === true
  const currentDraft = drafts[index] ?? initialQuestionDraft(question)
  const { cursor, selected, mode, custom, scroll, manualScroll, followCustomTail } = currentDraft
  const active = !locked && pending !== undefined && question !== undefined && !submitted
  const rendered = useMemo(() => {
    if (question === undefined) return { lines: [] as readonly StyledLine[], optionRows: [] as readonly number[] }
    const lines: StyledLine[] = []
    const optionRows: number[] = []
    if (question.header !== undefined) {
      lines.push(...styledLines([lineSegment(question.header, 'bold')], viewport.contentColumns))
    }
    lines.push(...textLines(question.question, viewport.contentColumns))
    if (question.detail !== undefined) {
      lines.push(...(isPlan
        ? markdownLines(question.detail, viewport.contentColumns)
        : textLines(question.detail, viewport.contentColumns, 'dim')))
    }
    if (submitted) {
      lines.push(...textLines('  submitted…', viewport.contentColumns, 'dim'))
    } else if (mode === 'custom' || options.length === 0) {
      lines.push(...styledLines([
        lineSegment('  custom: ', 'brand'),
        lineSegment(custom, 'plain'),
        lineSegment('▌', 'brand'),
      ], viewport.contentColumns))
    } else {
      options.forEach((option, at) => {
        optionRows.push(lines.length)
        const chosen = isMulti && selected.includes(at)
        const approve = isPlan && question.intent?.approve === option.label
        const mark = approve ? '✓ ' : chosen ? '◉ ' : at === cursor ? '❯ ' : '  '
        const style: LineStyle = at === cursor ? 'brand' : chosen || approve ? 'success' : 'plain'
        lines.push(...styledLines([
          lineSegment(mark, style),
          // Claude-Code numbering: the digit addresses the row from the
          // keyboard, so the prefix advertises the binding it enables.
          lineSegment(at < 9 ? `${at + 1}. ` : '', 'dim'),
          lineSegment(option.label, style),
          lineSegment(option.description === undefined ? '' : ` — ${option.description}`, 'dim'),
        ], viewport.contentColumns))
      })
    }
    return { lines, optionRows }
  }, [question, isPlan, submitted, mode, options, custom, isMulti, selected, cursor, viewport.contentColumns])
  // Keeping a focused option visible is derived from the current render. It
  // deliberately does not write state from an effect: keyboard selection
  // then has one update path, rather than a cursor update repeatedly causing
  // a post-render scroll update (and, under rapid input, an update-depth
  // loop). Page scrolling explicitly takes ownership until focus moves again.
  const focusedRow = rendered.optionRows[cursor] ?? 0
  const automaticScroll = mode === 'options' && options.length > 0 && !manualScroll
    ? revealRow(scroll, focusedRow, rendered.lines.length, viewport.bodyRows)
    : (mode === 'custom' || options.length === 0) && followCustomTail
      ? Math.max(0, rendered.lines.length - viewport.bodyRows)
      : scroll
  const visibleScroll = clampScroll(automaticScroll, rendered.lines.length, viewport.bodyRows)

  const updateDrafts = (update: (current: readonly QuestionDraftState[]) => readonly QuestionDraftState[]): void => {
    const next = update(draftsRef.current)
    draftsRef.current = next
    setDrafts(next)
  }

  const updateCurrentDraft = (update: (current: QuestionDraftState) => QuestionDraftState): void => {
    const currentIndex = indexRef.current
    updateDrafts(current => current.map((draft, at) => at === currentIndex ? update(draft) : draft))
  }

  const moveQuestion = (direction: -1 | 1): void => {
    const total = request?.questions.length ?? 0
    if (total <= 1) return
    const currentIndex = indexRef.current
    const nextIndex = Math.max(0, Math.min(total - 1, currentIndex + direction))
    if (nextIndex === currentIndex) return
    indexRef.current = nextIndex
    setIndex(nextIndex)
  }

  const commit = (answer: AskUserQuestionAnswerItem): void => {
    if (pending === undefined || question === undefined) return
    const currentIndex = indexRef.current
    const optionLabels = new Set(answer.selected)
    const selectedIndices = (question.options ?? [])
      .map((option, at) => optionLabels.has(option.label) ? at : -1)
      .filter((at): at is number => at >= 0)
    const nextDrafts = draftsRef.current.map((draft, at) => at === currentIndex
      ? { ...draft, selected: selectedIndices, custom: answer.custom ?? '', committed: true }
      : draft)
    draftsRef.current = nextDrafts
    setDrafts(nextDrafts)
    const total = pending.request.questions.length
    if (currentIndex + 1 >= total) {
      setSubmitted(true)
      store.submit(pending, {
        answers: pending.request.questions.map((item, at) => answerFromQuestionDraft(item, nextDrafts[at] ?? initialQuestionDraft(item))),
      })
      return
    }
    const nextIndex = currentIndex + 1
    indexRef.current = nextIndex
    setIndex(nextIndex)
  }

  const commitOption = (): void => {
    if (pending === undefined || question === undefined) return
    const currentIndex = indexRef.current
    const current = draftsRef.current[currentIndex] ?? initialQuestionDraft(question)
    if (isMulti) {
      const labels = current.selected
        .map(at => options[at]?.label)
        .filter((label): label is string => label !== undefined)
      const customText = current.custom.trim()
      commit({ id: question.id, selected: labels, ...(customText === '' ? {} : { custom: customText }) })
      return
    }
    const option = options[current.cursor]
    if (option === undefined) return
    commit({ id: question.id, selected: [option.label] })
  }

  /**
   * A question with choices has two local focus surfaces, just like Codex:
   * the choice list and the optional custom-answer editor. Returning to the
   * list keeps the user's current choice and multi-select state, but drops the
   * transient custom draft so a second Escape can cancel the question.
   */
  const returnToOptions = (): void => {
    if (options.length === 0) return
    updateCurrentDraft(current => ({ ...current, mode: 'options', custom: '', scroll: 0, manualScroll: false, followCustomTail: false }))
  }

  useStableInput((input, key) => {
    if (pending === undefined || question === undefined || submitted) return
    if (viewport.maxHeight === 0) {
      // Options are not rendered at this height, so blind picks stay
      // disabled; only the explicit cancel remains available.
      if (key.escape || (key.ctrl && input === 'c')) store.cancel(pending)
      return
    }
    if (key.ctrl && input === 'c') {
      store.cancel(pending)
      return
    }
    if (key.escape) {
      if (mode === 'custom' && options.length > 0) {
        returnToOptions()
        return
      }
      store.cancel(pending)
      return
    }
    if (key.tab && key.shift) {
      moveQuestion(-1)
      return
    }
    if (key.leftArrow || (key.ctrl && input === 'p')) {
      moveQuestion(-1)
      return
    }
    if (key.rightArrow || (key.ctrl && input === 'n')) {
      moveQuestion(1)
      return
    }
    if (key.pageUp) {
      updateCurrentDraft(current => ({
        ...current,
        manualScroll: true,
        followCustomTail: false,
        scroll: moveScroll(visibleScroll, -Math.max(1, viewport.bodyRows - 1), rendered.lines.length, viewport.bodyRows),
      }))
      return
    }
    if (key.pageDown) {
      updateCurrentDraft(current => ({
        ...current,
        manualScroll: true,
        followCustomTail: false,
        scroll: moveScroll(visibleScroll, Math.max(1, viewport.bodyRows - 1), rendered.lines.length, viewport.bodyRows),
      }))
      return
    }
    if (mode === 'custom' || options.length === 0) {
      if (key.tab && options.length > 0) {
        returnToOptions()
        return
      }
      if (key.upArrow) {
        updateCurrentDraft(current => ({
          ...current,
          followCustomTail: false,
          scroll: moveScroll(visibleScroll, -1, rendered.lines.length, viewport.bodyRows),
        }))
        return
      }
      if (key.downArrow) {
        updateCurrentDraft(current => ({
          ...current,
          followCustomTail: false,
          scroll: moveScroll(visibleScroll, 1, rendered.lines.length, viewport.bodyRows),
        }))
        return
      }
      if (key.return) {
        if (custom.trim() === '' && options.length > 0) {
          commitOption()
          return
        }
        commit({
          id: question.id,
          selected: isMulti
            ? selected.map(at => options[at]?.label).filter((label): label is string => label !== undefined)
            : [],
          ...(custom.trim() === '' ? {} : { custom: custom.trim() }),
        })
        return
      }
      if (key.backspace || key.delete) {
        if (custom === '' && options.length > 0) {
          returnToOptions()
          return
        }
        updateCurrentDraft(current => ({ ...current, custom: deleteLastGrapheme(current.custom), committed: false }))
        return
      }
      if (input !== '' && !key.ctrl && !key.meta) {
        // Panel drafts see paste markers as literal text (Ink strips only the
        // leading ESC); strip them so a pasted answer never persists "[200~".
        const text = stripPasteMarkers(input)
        if (text !== '') updateCurrentDraft(current => ({ ...current, custom: current.custom + text, committed: false }))
      }
      return
    }
    if (key.upArrow) {
      updateCurrentDraft(current => ({
        ...current,
        cursor: (current.cursor + options.length - 1) % options.length,
        manualScroll: false,
      }))
      return
    }
    if (key.downArrow) {
      updateCurrentDraft(current => ({
        ...current,
        cursor: (current.cursor + 1) % options.length,
        manualScroll: false,
      }))
      return
    }
    if (key.return) {
      commitOption()
      return
    }
    if (key.tab || input === 'c' || input === 'C') {
      updateCurrentDraft(current => ({ ...current, mode: 'custom', manualScroll: false, followCustomTail: true }))
      return
    }
    if (input === ' ' && isMulti) {
      updateCurrentDraft(current => ({
        ...current,
        selected: current.selected.includes(current.cursor)
          ? current.selected.filter(at => at !== current.cursor)
          : [...current.selected, current.cursor],
        committed: false,
      }))
      return
    }
    // Claude-Code option numbers: the digit addresses a row directly — a
    // toggle in multi-select, an immediate pick in single-select.
    if (/^[1-9]$/.test(input)) {
      const at = Number(input) - 1
      if (at >= options.length) return
      if (isMulti) {
        updateCurrentDraft(current => ({
          ...current,
          selected: current.selected.includes(at)
            ? current.selected.filter(row => row !== at)
            : [...current.selected, at],
          committed: false,
        }))
      } else {
        const option = options[at]
        if (option !== undefined) commit({ id: question.id, selected: [option.label] })
      }
    }
  }, active)

  if (pending === undefined || question === undefined) return undefined
  if (viewport.maxHeight === 0 || viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(isPlan ? t('question.compact.plan') : t('question.compact.normal'), viewport.contentColumns))
  }
  const footerBase = submitted
    ? t('question.submitted')
    : mode === 'custom'
      ? options.length === 0
        ? t('question.customNoOptions')
        : t('question.customOptions')
      : options.length === 0
        ? t('question.customNoOptions')
      : isMulti
        ? t('question.multiOptions')
        : t('question.singleOptions')
  const footer = pending.request.questions.length > 1 && !submitted
    ? `${footerBase}${t('question.switch')}`
    : footerBase
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(isPlan ? getPalette().brand : getPalette().brandDeep) },
    createElement(
      Text,
      { color: inkColor(isPlan ? getPalette().brand : getPalette().brandDeep), bold: true, wrap: 'truncate-end' },
      truncateColumns(`${isPlan ? t('question.title.plan') : t('question.title.normal')} ${index + 1}/${pending.request.questions.length} · lines ${rendered.lines.length === 0 ? 0 : visibleScroll + 1}-${Math.min(rendered.lines.length, visibleScroll + viewport.bodyRows)}/${rendered.lines.length}`, viewport.contentColumns),
    ),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(StyledRows, { lines: rendered.lines.slice(visibleScroll, visibleScroll + viewport.bodyRows) }),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { wrap: 'truncate-end' }, dim(truncateColumns(footer, viewport.contentColumns))),
  )
}

/** The /model panel: a scrolling list over the advisory model directory. */

export function ModelPanel({ directory, error, current, onSelect, onProviders, onRetry, onClose }) {
  const [cursor, setCursor] = useState(0);
  const [dscodeQuery, setDscodeQuery] = useState("");
  const [dscodeFocused, setDscodeFocused] = useState(true);
  const stdout = useStdout().stdout;
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30);
  const dscodeRows = directory?.rows ?? [];
  // `current` is "provider/model"; the provider never contains "/", so the first segment is it.
  const dscodeProvider = typeof current === "string" && current.includes("/") ? current.slice(0, current.indexOf("/")) : void 0;
  const rows = useMemo(() => dscodeFilterModels(dscodeRows, dscodeQuery, dscodeProvider), [dscodeRows, dscodeQuery, dscodeProvider]);
  const positioned = useRef(false);
  useEffect(() => {
    if (rows.length === 0) {
      if (cursor !== 0) setCursor(0);
      return;
    }
    if (cursor >= rows.length) {
      setCursor(rows.length - 1);
      return;
    }
    if (positioned.current || current === void 0 || dscodeQuery !== "") return;
    const index = rows.findIndex((row) => `${row.provider}/${row.model}` === current);
    if (index >= 0) {
      positioned.current = true;
      setCursor(index);
    }
  }, [rows, cursor, current, dscodeQuery]);
  const search = (next) => {
    setDscodeQuery(next.slice(0, 120));
    setCursor(0);
    setDscodeFocused(false);
  };
  useInput((input, key) => {
    if (key.ctrl && input === "c") { onClose(); return; }
    if (key.escape) {
      if (dscodeQuery === "") { onClose(); return; }
      positioned.current = false;
      setDscodeQuery("");
      setCursor(0);
      setDscodeFocused(true);
      return;
    }
    if (key.tab && onProviders !== void 0) { onProviders(); return; }
    if (key.ctrl && input === "r") { onRetry(); return; }
    if (key.return || key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
      if (rows.length === 0) return;
      if (!dscodeFocused) {
        setCursor(0);
        setDscodeFocused(true);
        return;
      }
      const page = Math.max(1, viewport.bodyRows - 1);
      if (key.return) { if (rows[cursor] !== void 0) onSelect(rows[cursor]); }
      else if (key.upArrow) setCursor(cursor > 0 ? cursor - 1 : rows.length - 1);
      else if (key.downArrow) setCursor(cursor < rows.length - 1 ? cursor + 1 : 0);
      else if (key.pageUp) setCursor((value) => Math.max(0, value - page));
      else setCursor((value) => Math.min(rows.length - 1, value + page));
      return;
    }
    if (key.ctrl && input === "u") { if (dscodeQuery !== "") search(""); return; }
    if (key.ctrl || key.meta) return;
    const next = editQuery(dscodeQuery, input, key);
    if (next !== void 0 && next !== dscodeQuery) search(next);
  });
  const focusRow = dscodeFocused && rows.length > 0;
  const searchText = dscodeQuery === "" ? "type to search" : `search: ${dscodeQuery}`;
  const escape = dscodeQuery === "" ? "esc close" : "esc clears search";
  if (viewport.maxHeight === 0 || viewport.compact) {
    const providers = onProviders === void 0 ? "" : " · tab providers";
    const state = rows.length === 0 ? directory === void 0 && error === void 0 ? "loading…" : error !== void 0 ? "error" : dscodeQuery === "" ? "no models" : "no match"
      : focusRow ? `❯ ${rows[cursor]?.modelName ?? rows[cursor]?.model ?? ""}` : `${rows.length} ${rows.length === 1 ? "match" : "matches"}`;
    return createElement(Text, { wrap: "truncate-end" }, truncateColumns(`/model · ${searchText} · ${state}${providers} · ${escape}`, viewport.contentColumns));
  }
  const visibleStateRows = (directory === void 0 && error === void 0 ? [createElement(Text, {
    key: "loading",
    dimColor: true,
    wrap: "truncate-end"
  }, "  loading models…")] : error !== void 0 ? [createElement(Text, {
    key: "error",
    color: inkColor(getPalette().error),
    wrap: "truncate-end"
  }, truncateColumns(`  ${singleLineText(error)}`, viewport.contentColumns))] : [...directory?.failures.length === 0 ? [] : [createElement(Text, {
    key: "failures",
    color: inkColor(getPalette().warn),
    wrap: "truncate-end"
  }, truncateColumns(`  unavailable providers: ${directory?.failures.join(", ")}`, viewport.contentColumns))], ...rows.length === 0 ? [createElement(Text, {
    key: "empty",
    dimColor: true,
    wrap: "truncate-end"
  }, dscodeQuery === "" ? "  no models available" : "  no models match the search")] : []]).slice(0, viewport.bodyRows);
  const rowBudget = Math.max(0, viewport.bodyRows - visibleStateRows.length);
  const first = selectionWindow(cursor, rows.length, rowBudget);
  const visible = rowBudget === 0 ? [] : rows.slice(first, first + rowBudget);
  const count = rows.length === 0 ? "" : focusRow ? ` · ${cursor + 1}/${rows.length}` : ` · ${rows.length} ${rows.length === 1 ? "match" : "matches"}`;
  return createElement(Box, {
    flexDirection: "column",
    width: viewport.outerColumns,
    paddingX: 1,
    borderStyle: "round",
    borderColor: inkColor(getPalette().brand)
  }, createElement(Text, {
    color: inkColor(getPalette().brand),
    bold: true,
    wrap: "truncate-end"
  }, truncateColumns(`/model — select model${count} · ${searchText}`, viewport.contentColumns)), createElement(PanelGap, { visible: viewport.gapRows > 0 }), ...visibleStateRows, ...visible.map((row) => {
    const index = rows.indexOf(row);
    const focused = focusRow && index === cursor;
    const capability = row.inputModalities?.includes("image") === true ? " · image" : "";
    const label = displayText(`${row.providerName} · ${row.modelName}${capability}`);
    return createElement(Text, {
      key: `${row.provider}/${row.model}`,
      color: focused ? inkColor(getPalette().brandBright) : inkColor(getPalette().dim),
      wrap: "truncate-end"
    }, truncateColumns(`${focused ? "❯ " : "  "}${label}`, viewport.contentColumns));
  }), createElement(PanelGap, { visible: viewport.gapRows > 0 }), createElement(Text, {
    dimColor: true,
    wrap: "truncate-end"
  }, dim(truncateColumns(`type to search · ↑↓ move · enter ${focusRow ? "select" : "focus first match"}${onProviders === void 0 ? "" : " · tab providers"} · ctrl+r retry · ${escape}`, viewport.contentColumns))));
}


/** Compact provider-state copy; only value-free credential facts cross this boundary. */
function providerStateLabel(row: ProviderTargetView): string {
  const route = row.active ? t('panel.provider.active') : t('panel.provider.dormant')
  const credential = row.credential
  if (credential?.kind === 'error') return t('panel.provider.state', { route, value: t('panel.provider.keyStatusUnavailable') })
  if (credential?.kind === 'facts') {
    if (!credential.configured) return t('panel.provider.state', { route, value: t('panel.provider.noKey') })
    const source = credential.source === undefined ? t('panel.provider.configured') : singleLineText(credential.source)
    return t('panel.provider.state', { route, value: `${t('panel.provider.key', { value: source })}${credential.writable ? '' : ` · ${t('panel.provider.readOnly')}`}` })
  }
  return t('panel.provider.state', { route, value: row.configured ? t('panel.provider.authConfigured') : t('panel.provider.noLogin') })
}

/** The provider-management stage reached from /model with `a`. */
function ProviderPanel({ directory, error, authorizations, authorizationError, onConfigure, onUnset, onRemove, onLogin, onLogout, onRetry, onBack, onExit }: {
  directory: ProviderSettingsDirectory | undefined
  error: string | undefined
  authorizations: ProviderAuthorizationDirectory | undefined
  authorizationError: string | undefined
  onConfigure: (target: ProviderTargetView) => void
  onUnset: (target: ProviderTargetView) => void
  onRemove: (target: ProviderTargetView) => void
  onLogin: (target: ProviderTargetView, authorization: ProviderAuthorizationRow) => void
  onLogout: (target: ProviderTargetView, authorization: ProviderAuthorizationRow) => void
  onRetry: () => void
  onBack: () => void
  /** Leave the whole /model flow (Ctrl+C), not just this stage. */
  onExit: () => void
}): ReactElement {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const rows = directory?.rows ?? []
  // Configured providers float to the top so a long dormant tail never buries
  // the ones in use; a dim separator labels the boundary between groups.
  const sorted = [...rows].sort((left, right) =>
    (left.configured ? 0 : 1) - (right.configured ? 0 : 1))
  const configuredCount = sorted.filter(row => row.configured).length
  const hasSeparator = configuredCount > 0 && configuredCount < sorted.length
  const [cursor, setCursor] = useState(0)
  const [actionError, setActionError] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (rows.length === 0) {
      if (cursor !== 0) setCursor(0)
      return
    }
    if (cursor >= rows.length) setCursor(rows.length - 1)
  }, [rows.length, cursor])

  useStableInput((input, key) => {
    if (key.escape || input === 'q') {
      onBack()
      return
    }
    if (key.ctrl && input === 'c') {
      onExit()
      return
    }
    if (input === 'r') {
      setActionError(undefined)
      onRetry()
      return
    }
    if (rows.length === 0) return
    if (key.upArrow) {
      setActionError(undefined)
      setCursor(cursor > 0 ? cursor - 1 : rows.length - 1)
      return
    }
    if (key.downArrow) {
      setActionError(undefined)
      setCursor(cursor < rows.length - 1 ? cursor + 1 : 0)
      return
    }
    if (key.pageUp) {
      setActionError(undefined)
      setCursor(current => Math.max(0, current - Math.max(1, viewport.bodyRows - 1)))
      return
    }
    if (key.pageDown) {
      setActionError(undefined)
      setCursor(current => Math.min(rows.length - 1, current + Math.max(1, viewport.bodyRows - 1)))
      return
    }
    const target = sorted[cursor]
    if (target === undefined) return
    if (input === 'd') {
      const facts = target.credential
      if (facts?.kind !== 'facts' || !facts.configured) {
        setActionError(t('panel.provider.noConfiguredKey'))
      } else if (!facts.writable) {
        setActionError(t('panel.provider.readOnlyKey'))
      } else {
        onUnset(target)
      }
      return
    }
    if (input === 'x') {
      if (!target.removable) {
        setActionError(t('panel.provider.notRemovable'))
      } else {
        onRemove(target)
      }
      return
    }
    const authorization = authorizationForProvider(authorizations, target.provider)
    if (input === 'l' || input === 'L') {
      if (authorization === undefined) setActionError(t('panel.provider.noLoginFlow'))
      else if (authorization.inFlight) setActionError(t('panel.provider.loginRunning'))
      else onLogin(target, authorization)
      return
    }
    if (input === 'o' || input === 'O') {
      if (authorization === undefined || !authorization.record.configured) setActionError(t('panel.provider.noLoginRecord'))
      else if (!authorization.record.writable) setActionError(t('panel.provider.readOnlyLogin'))
      else onLogout(target, authorization)
      return
    }
    // Enter opens the unified setup page (key, endpoint, models, discovery):
    // the old split — Enter for the key alone, Tab for the deep menu — hid
    // the configuration surface behind an undiscoverable chord.
    if (key.return) {
      if (target.settingsNs.length === 0) {
        setActionError(t('panel.provider.notManaged'))
      } else {
        onConfigure(target)
      }
    }
  }, true)

  if (viewport.maxHeight === 0 || viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(t('panel.providers.compact'), viewport.contentColumns))
  }
  const stateRows: ReactElement[] = directory === undefined && error === undefined
    ? [createElement(Text, { key: 'loading', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, `  ${t('panel.provider.loading')}`)]
    : error !== undefined
      ? [createElement(Text, { key: 'error', color: inkColor(getPalette().error), wrap: 'truncate-end' }, truncateColumns(`  ${singleLineText(error)}`, viewport.contentColumns))]
      : [
        ...(actionError === undefined
          ? []
          : [createElement(Text, { key: 'action-error', color: inkColor(getPalette().error), wrap: 'truncate-end' }, truncateColumns(`  ${actionError}`, viewport.contentColumns))]),
        ...(directory?.failures ?? []).map((failure, index) => createElement(
          Text,
          { key: `failure-${index}`, color: inkColor(getPalette().warn), wrap: 'truncate-end' },
          truncateColumns(`  ${singleLineText(failure)}`, viewport.contentColumns),
        )),
        ...(authorizationError === undefined
          ? []
          : [createElement(Text, { key: 'authorization-error', color: inkColor(getPalette().warn), wrap: 'truncate-end' }, truncateColumns(`  ${t('panel.provider.loginStatusUnavailable', { message: singleLineText(authorizationError) })}`, viewport.contentColumns))]),
        ...(authorizations?.failures ?? []).map((failure, index) => createElement(
          Text,
          { key: `authorization-failure-${index}`, color: inkColor(getPalette().warn), wrap: 'truncate-end' },
          truncateColumns(`  ${singleLineText(failure)}`, viewport.contentColumns),
        )),
        ...(rows.length === 0
          ? [createElement(Text, { key: 'empty', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, `  ${t('panel.provider.empty')}`)]
          : []),
      ]
  const visibleStateRows = stateRows.slice(0, viewport.bodyRows)
  const rowBudget = Math.max(0, viewport.bodyRows - visibleStateRows.length)
  const displayLength = sorted.length + (hasSeparator ? 1 : 0)
  const displayCursor = cursor + (hasSeparator && cursor >= configuredCount ? 1 : 0)
  const first = selectionWindow(displayCursor, displayLength, rowBudget)
  const itemRows: ReactElement[] = []
  for (let display = first; display < first + rowBudget && display < displayLength; display += 1) {
    if (hasSeparator && display === configuredCount) {
      itemRows.push(createElement(Text, { key: 'separator', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(`  ${t('panel.provider.notConfiguredDivider')}`, viewport.contentColumns)))
      continue
    }
    const index = hasSeparator && display > configuredCount ? display - 1 : display
    const row = sorted[index]
    if (row === undefined) continue
    const identity = row.displayName === row.provider ? row.provider : row.displayName + ' (' + row.provider + ')'
    const authorization = authorizationForProvider(authorizations, row.provider)
    const manualKeyConfigured = row.credential?.kind === 'facts' && row.credential.configured
    const showAuthorization = !manualKeyConfigured || authorization?.record.configured === true || authorization?.inFlight === true
    const authLabel = showAuthorization ? ' · ' + providerAuthorizationStatus(authorization) : ''
    // The adapter's configuration diagnostic rides the row (the provider
    // stays listed and repairable — this is why it did not vanish).
    const diagnostic = row.diagnostic === undefined ? '' : ' · ! ' + singleLineText(row.diagnostic)
    const label = identity + ' · ' + providerStateLabel(row) + authLabel + (row.removable ? ' · custom' : '') + diagnostic
    // Configured rows render in the intermediate brand blue so the in-use
    // group reads at a glance; the dormant tail keeps the dim caption gray.
    const idleColor = row.configured ? inkColor(getPalette().brandMid) : inkColor(getPalette().dim)
    itemRows.push(createElement(
      Text,
      { key: row.provider, color: index === cursor ? inkColor(getPalette().brandBright) : idleColor, wrap: 'truncate-end' },
      truncateColumns((index === cursor ? '❯ ' : '  ') + displayText(label), viewport.contentColumns),
    ))
  }
  const accent = panelAccent('model-providers', getPalette().brand)
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(accent.border) },
    createElement(Text, { color: inkColor(accent.title), bold: true, wrap: 'truncate-end' }, truncateColumns(rows.length === 0 ? t('panel.provider.title') : t('panel.provider.titleCount', { index: cursor + 1, total: rows.length }), viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    ...visibleStateRows,
    ...itemRows,
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(t('panel.providers.footer'), viewport.contentColumns)),
  )
}

/** Provider configuration editor: only explicit models are written to settings. */
/**
 * The unified provider setup page: API key, endpoint, and the explicit model
 * list (with per-model context/output capacities) on ONE screen — the deep
 * Tab menu and the separate key panel merged into a single discoverable
 * surface. A saved key rides the same Enter as the endpoint and models; an
 * empty endpoint keeps the provider's official default. Tab moves to the
 * discovery page, which interrogates the real endpoint and returns checkable
 * models for adoption; the last row also accepts hand-typed model ids.
 */
/** One declarable donor the setup page can copy reasoning efforts from verbatim. */
interface EffortDonor {
  /** Provider route the declaration lives on. */
  readonly provider: string
  /** Model id the declaration belongs to. */
  readonly id: string
  /** The stored display-level to wire-value map, copied verbatim. */
  readonly efforts: Record<string, string | null>
}

export function DscodeEmailPanel({ columns, rows, pick, close, gmail, imap }) {
  const [snapshot, setSnapshot] = useState({ emails: [], rejected: 0 });
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [offset, setOffset] = useState(0);
  const [preview, setPreview] = useState(false);
  const [gmailStatus, setGmailStatus] = useState(() => gmail.status());
  const [imapStatus, setImapStatus] = useState(() => imap.status());
  const [setup, setSetup] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const operation = useRef(null);
  useEffect(() => () => operation.current?.abort(), []);
  const inbox = useMemo(() => dscodeCreateEmailInbox(), []);
  const refresh = () => {
    try { setSnapshot(inbox.list()); setGmailStatus(gmail.status()); setImapStatus(imap.status()); }
    catch { setError('Could not read inbox. Press r to retry.'); }
  };
  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [inbox]);
  const emails = snapshot.emails;
  const index = Math.max(0, emails.findIndex(mail => dscodeEmailKey(mail) === selected));
  const mail = emails[index];
  useEffect(() => {
    if (mail) setSelected(dscodeEmailKey(mail));
  }, [mail && dscodeEmailKey(mail)]);
  const height = Math.max(3, rows);
  const contentRows = Math.max(1, height - 4);
  const wide = columns >= 64;
  const listWidth = wide ? Math.max(26, Math.floor(columns * 0.4)) : columns;
  const previewWidth = wide ? Math.max(1, columns - listWidth - 1) : columns;
  const clean = value => dscodeEmailText(value).replace(/\n/g, ' ');
  const bodyLines = mail ? wrapText(dscodeEmailText(mail.body), Math.max(1, previewWidth - 2), 'wrap').split('\n') : [];
  useStableInput((input, key) => {
    if (setup) return;
    if (key.escape || key.ctrl && input === 'c') { close(); return; }
    if (input === 'i' && !operation.current) { setSetup(true); setError(''); return; }
    if (input === 'g' || input === 'r') {
      if (operation.current) return;
      const controller = new AbortController(); operation.current = controller;
      setError(''); setConnecting(input === 'g');
      const action = input === 'g' ? gmail.connect({ signal: controller.signal }) : (imapStatus.connected ? imap : gmail).sync({ force: true, signal: controller.signal });
      Promise.resolve(action).then(result => {
        if (!controller.signal.aborted) { if (result.busy) setError('Gmail is busy in another session. Retry shortly.'); refresh(); }
      }, reason => { if (!controller.signal.aborted) setError(reason.message); }).finally(() => {
        operation.current = null;
        if (!controller.signal.aborted) setConnecting(false);
      });
      return;
    }
    if (key.tab) { setPreview(current => !current); return; }
    if (!mail) return;
    if (key.upArrow || key.downArrow) {
      const next = Math.max(0, Math.min(emails.length - 1, index + (key.upArrow ? -1 : 1)));
      setSelected(dscodeEmailKey(emails[next])); setOffset(0); return;
    }
    if (key.pageDown || key.pageUp) {
      setOffset(current => Math.max(0, Math.min(Math.max(0, bodyLines.length - contentRows + 2), current + (key.pageUp ? -1 : 1) * Math.max(1, contentRows - 2)))); return;
    }
    if (key.return) pick(mail);
  });
  if (setup) return createElement(Box, { height, overflow: 'hidden', flexDirection: 'column' },
    createElement(DscodeImapSetup, { connector: imap, back: () => setSetup(false), done: () => { setSetup(false); refresh(); } }));
  const text = (value, extra = {}) => createElement(Text, { wrap: 'truncate-end', ...extra }, value);
  const start = Math.max(0, index - contentRows + 1);
  const list = createElement(Box, { width: listWidth, flexDirection: 'column', overflow: 'hidden' },
    text('Email · newest updates first', { bold: true }),
    ...emails.slice(start, start + contentRows).map((entry, i) => text(
      (start + i === index ? '› ' : '  ') + entry.updatedAt.slice(5, 16).replace('T', ' ') + ' ' + clean(entry.subject),
      { key: dscodeEmailKey(entry), color: start + i === index ? 'cyan' : undefined })),
    !mail ? text(error || 'No emails received.') : null);
  return createElement(Box, { flexDirection: 'column', height, overflow: 'hidden' },
    text(imapStatus.connected ? imapStatus.error || 'IMAP · ' + clean(imapStatus.account) + ' · ' + clean(imapStatus.mailbox) : connecting ? 'Gmail · Complete Google login in your browser · Esc cancels' : gmailStatus.error || (gmailStatus.connected ? 'Gmail · ' + clean(gmailStatus.account) + (gmailStatus.lastSyncAt ? ' · synced ' + new Date(gmailStatus.lastSyncAt).toLocaleTimeString() : ' · waiting for new mail') : 'Email not connected · i IMAP · g Google OAuth'), { dimColor: true }),
    createElement(Box, { flexDirection: 'row', height: Math.max(1, height - 2) },
      wide || preview ? createElement(Box, { width: previewWidth, marginRight: wide ? 1 : 0, flexDirection: 'column', overflow: 'hidden' },
        text(mail ? clean(mail.subject) : 'Email preview', { bold: true }),
        text(mail ? 'From: ' + clean(mail.from) : 'Waiting for a connector', { dimColor: true }),
        ...bodyLines.slice(offset, offset + Math.max(1, contentRows - 1)).map((line, i) => text(line, { key: i }))) : null,
      wide || !preview ? list : null),
    text(error || (snapshot.rejected ? snapshot.rejected + ' invalid records skipped · ' : '') + (wide ? '↑↓ select · Enter steer · Esc · PgUp/Dn · i IMAP · g OAuth · r sync' : '↑↓ Enter · Tab · i IMAP · r sync'), { dimColor: true }));
}

export function DscodeImapSetup({ connector, back, done }) {
  const [values, setValues] = useState(() => {
    const saved = connector.status();
    return [saved.account || '', saved.host || 'imap.gmail.com', String(saved.port || 993), saved.mailbox || 'INBOX', ''];
  });
  const [step, setStep] = useState(0);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const operation = useRef(null);
  useEffect(() => () => operation.current?.abort(), []);
  const names = ['Email address', 'IMAP host', 'TLS port', 'Mailbox folder', 'Application password'];
  useStableInput((input, key) => {
    if (key.escape || key.ctrl && input === 'c') { operation.current?.abort(); setValues([]); back(); return; }
    if (operation.current) return;
    if (key.return) {
      if (!values[step]?.trim()) { setError('This field is required.'); return; }
      if (step < 4) { setStep(step + 1); setError(''); return; }
      const [account, host, port, mailbox, password] = values;
      const controller = new AbortController(); operation.current = controller;
      setValues(current => current.map((value, index) => index === 4 ? '' : value)); setBusy(true); setError('');
      Promise.resolve().then(() => connector.connect({ account, host, port, mailbox, password }, { signal: controller.signal })).then(result => {
        if (controller.signal.aborted) return;
        if (result.busy) { setError('Another session is syncing. Retry shortly.'); return; }
        done();
      }, reason => { if (!controller.signal.aborted) setError(reason.message); }).finally(() => {
        operation.current = null; if (!controller.signal.aborted) setBusy(false);
      });
      return;
    }
    if (key.tab) { setStep(current => (current + (key.shift ? 4 : 1)) % 5); setError(''); return; }
    if (key.ctrl && input === 'u') { setValues(current => current.map((value, index) => index === step ? '' : value)); return; }
    if (key.backspace || key.delete) { setValues(current => current.map((value, index) => index === step ? [...value].slice(0, -1).join('') : value)); return; }
    if (key.ctrl || key.meta || !input) return;
    const pasted = stripPasteMarkers(input).replace(/[\x00-\x1f\x7f]/g, '');
    setValues(current => current.map((value, index) => index === step ? (value + pasted).slice(0, 1024) : value));
  });
  const text = (value, props = {}) => createElement(Text, { wrap: 'truncate-end', ...props }, value);
  return createElement(Box, { flexDirection: 'column' },
    text('Connect IMAP · ' + (step + 1) + '/5', { bold: true }),
    text(busy ? 'Connecting securely…' : names[step] + ' › ' + (step === 4 ? values[step] ? '••••••••' : '' : values[step])),
    text(error || (step === 4 ? 'Gmail: use an app password from 2-Step Verification.' : 'Enter keeps defaults · Ctrl+U clears'), { dimColor: !error, color: error ? 'red' : undefined }),
    text('Enter next/connect · Tab edit · Esc cancel', { dimColor: true }));
}


export function DscodeManagementKeyPanel({ optional, status, save, done, back }) {
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState(void 0);
  const saving = useRef(false);
  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => status?.()).then(result => { if (active) setState(result?.state ?? "missing"); }, () => { if (active) setState("error"); });
    return () => { active = false; };
  }, []);
  const locked = state === "env" || state === "readonly" || state === "unavailable";
  useStableInput((input, key) => {
    if (saving.current) return;
    if (key.escape || key.ctrl && input === "c") { setDraft(""); back(); return; }
    if (state === void 0) return;
    if (key.return) {
      const raw = draft.trim();
      if (!raw) { done(false); return; }
      if (locked) return;
      if (/[\s\x00-\x1f\x7f-￿]/.test(raw) || ENV_ASSIGNMENT.test(raw) || hasWrappingQuotes(raw)) {
        setError("Paste only the management key, without quotes, spaces or an environment-variable name."); return;
      }
      saving.current = true; setBusy(true); setError(""); setDraft("");
      Promise.resolve().then(() => save(raw)).then(() => done(true), reason => {
        saving.current = false; setBusy(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      });
      return;
    }
    if (locked) return;
    if (key.ctrl && input === "u") { setDraft(""); setError(""); return; }
    if (key.backspace || key.delete) { setDraft(current => [...current].slice(0, -1).join("")); return; }
    if (key.ctrl || key.meta || !input) return;
    setDraft(current => (current + stripPasteMarkers(input)).slice(0, 4096));
    setError("");
  });
  const stateLine = state === "saved" ? "A management key is saved; paste a new one to replace it."
    : state === "env" ? "OPENROUTER_MANAGEMENT_KEY is set by your environment."
      : state === "readonly" ? "OPENROUTER_MANAGEMENT_KEY is read-only here."
        : state === "unavailable" ? "Credential storage is unavailable."
          : state === "error" ? "Could not read the management key status." : "";
  return createElement(Box, { flexDirection: "column", paddingX: 2 },
    createElement(Text, { bold: true }, "OpenRouter management key" + (optional ? " (optional)" : "")),
    createElement(Text, { dimColor: true }, "Adds every API key's usage and your 30-day spend by model to /openrouter."),
    createElement(Text, { dimColor: true }, "It cannot call models; DSCODE only reads."),
    createElement(Text, { dimColor: true }, "Saved on this Mac in ~/.dscode/credentials.yaml"),
    stateLine ? createElement(Text, { dimColor: true }, stateLine) : void 0,
    createElement(Text, null, busy ? "Checking with OpenRouter…" : state === void 0 ? "Loading…" : locked ? "" : "Management key › " + (draft ? "••••••••" : "paste your key")),
    error ? createElement(Text, { color: "red" }, error) : void 0,
    createElement(Text, { dimColor: true }, locked ? "Enter continue · Esc close" : optional ? "Enter save · Enter on empty skips · Esc skip · Ctrl+U clear" : "Enter save · Esc back · Ctrl+U clear"));
}

export function DscodeOpenRouterPanel({ load, setManagement, back }) {
  const [account, setAccount] = useState(void 0);
  const [error, setError] = useState("");
  const [epoch, setEpoch] = useState(0);
  const stdout = useStdout().stdout;
  const columns = stdout?.columns ?? 80, rows = stdout?.rows ?? 30;
  useEffect(() => {
    let active = true;
    setAccount(void 0); setError("");
    Promise.resolve().then(() => load()).then(value => { if (active) setAccount(value); }, reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [epoch]);
  useStableInput((input, key) => {
    if (key.escape || input === "q" || key.ctrl && input === "c") { back(); return; }
    if (input === "r") { setEpoch(value => value + 1); return; }
    if (input === "m") setManagement();
  });
  const palette = getPalette();
  const width = Math.max(1, columns - 4);
  const lines = account === void 0
    ? [{ text: error ? "Could not load the OpenRouter account: " + error : "Loading OpenRouter account…", tone: error ? "error" : "dim" }]
    : dscodeOpenRouterAccountLines(account);
  const colorOf = tone => tone === "error" ? palette.error : tone === "dim" ? palette.dim : tone === "title" ? palette.brandBright : palette.text;
  return createElement(Box, { flexDirection: "column", paddingX: 2 },
    createElement(Text, { bold: true }, "/openrouter — account"),
    ...lines.slice(0, Math.max(1, rows - 6)).map((line, index) => createElement(Text, { key: index, color: inkColor(colorOf(line.tone)), bold: line.tone === "title" || void 0, wrap: "truncate-end" }, truncateColumns(line.text, width))),
    createElement(Text, { dimColor: true }, "r refresh · m management key · esc close"));
}


export function DscodeLoginPanel({ provider, load, save, done, back }) {
  const spec = dscodeProviderSpec(provider) ?? DSCODE_PROVIDERS[0];
  const [draft, setDraft] = useState("");
  const [target, setTarget] = useState(void 0);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => load()).then(directory => {
      if (!active) return;
      const row = directory.rows.find(row => row.provider === spec.id);
      if (!row || !save) { setError(spec.name + " credential storage is unavailable."); return; }
      if (row.credential?.kind === "error") { setError("Could not read credential status. Check local file permissions."); return; }
      if (row.credential?.kind === "facts" && !row.credential.writable) { setError(spec.credentialRef + " is set by your environment. Remove it and restart to use /login."); return; }
      setTarget(row);
    }, () => { if (active) setError("Could not load " + spec.name + " credential settings."); });
    return () => { active = false; };
  }, [spec.id]);
  useStableInput((input, key) => {
    if (saving.current) return;
    if (key.escape || key.ctrl && input === "c") { setDraft(""); back(); return; }
    if (!target) return;
    if (key.return) {
      const raw = draft.trim();
      if (!raw || /[\s\x00-\x1f\x7f-￿]/.test(raw) || ENV_ASSIGNMENT.test(raw) || hasWrappingQuotes(raw)) {
        setError("Paste only the API key, without quotes, spaces or an environment-variable name."); return;
      }
      saving.current = true; setBusy(true); setError(""); setDraft("");
      Promise.resolve().then(() => save(target, raw)).then(done, () => {
        saving.current = false; setBusy(false);
        setError("Could not save the API key. Check file permissions and available disk space, then paste again.");
      });
      return;
    }
    if (key.ctrl && input === "u") { setDraft(""); setError(""); return; }
    if (key.backspace || key.delete) { setDraft(current => [...current].slice(0, -1).join("")); return; }
    if (key.ctrl || key.meta || !input) return;
    const pasted = stripPasteMarkers(input);
    setDraft(current => (current + pasted).slice(0, 4096));
    setError("");
  });
  return createElement(Box, { flexDirection: "column", paddingX: 2 },
    createElement(Text, { bold: true }, spec.name + " login"),
    createElement(Text, { dimColor: true }, "Saved on this Mac in ~/.dscode/credentials.yaml"),
    createElement(Text, null, busy ? "Saving…" : target ? "API key › " + (draft ? "••••••••" : "paste your key") : error ? "" : "Loading…"),
    error ? createElement(Text, { color: "red" }, error) : void 0,
    createElement(Text, { dimColor: true }, "Enter save · Esc cancel · Ctrl+U clear"));
}

export function DscodeProviderPanel({ current, load, choose, back }) {
  const [directory, setDirectory] = useState(void 0);
  const [failed, setFailed] = useState(false);
  const [cursor, setCursor] = useState(() => Math.max(0, DSCODE_PROVIDERS.findIndex(provider => provider.id === current)));
  useEffect(() => {
    let active = true;
    Promise.resolve().then(() => load()).then(loaded => { if (active) setDirectory(loaded); }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, []);
  useStableInput((input, key) => {
    const count = DSCODE_PROVIDERS.length;
    if (key.escape || key.ctrl && input === "c" || input === "q") { back(); return; }
    if (key.upArrow || input === "k") { setCursor(index => (index + count - 1) % count); return; }
    if (key.downArrow || input === "j") { setCursor(index => (index + 1) % count); return; }
    if (key.return) { back(); choose(DSCODE_PROVIDERS[cursor].id); }
  });
  const status = provider => {
    if (failed) return "status unavailable";
    if (directory === void 0) return "…";
    const row = directory.rows.find(row => row.provider === provider.id);
    const state = dscodeCredentialState(row);
    if (state === "saved") return "key saved";
    if (state === "env") return "key from " + provider.credentialRef;
    if (state === "readonly") return provider.credentialRef + " is empty";
    if (state === "error") return "credential status unavailable";
    if (state === "unavailable") return "unavailable in this profile";
    return row?.configured === true || provider.id === "deepseek-official" ? "needs an API key" : "not set up · Enter sets it up";
  };
  return createElement(Box, { flexDirection: "column", paddingX: 2 },
    createElement(Text, { bold: true }, "Provider"),
    createElement(Text, { dimColor: true, wrap: "truncate-end" }, "The next step uses the chosen provider; /model picks among its models."),
    ...DSCODE_PROVIDERS.map((provider, index) => createElement(Text, { key: provider.id, bold: index === cursor, wrap: "truncate-end" },
      (index === cursor ? "› " : "  ") + (provider.id === current ? "● " : "○ ") + provider.name.padEnd(11) + provider.id + " · " + status(provider))),
    createElement(Text, { dimColor: true }, "↑↓ choose · Enter switch · Esc cancel"));
}


function ProviderSetupPanel({ target, save, saveCredential, discover, effortDonors, done, back, onExit }: {
  target: ProviderTargetView
  /** Models with declared efforts (settings first, catalog-advertised after) a model row can copy from. */
  effortDonors: readonly EffortDonor[]
  save: (target: ProviderTargetView, configuration: ProviderConfiguration) => Promise<void>
  saveCredential: ((target: ProviderTargetView, key: string) => Promise<void>) | undefined
  discover: (target: ProviderTargetView, request: { readonly apiKey?: string; readonly baseURL?: string }, signal?: AbortSignal) => Promise<readonly DiscoveredModelView[]>
  /** Report a successful save so the surface can notice the key rotation. */
  done: (result: { readonly key: boolean }) => void
  back: () => void
  /** Leave the whole /model flow (Ctrl+C), not just this page. */
  onExit: () => void
}): ReactElement {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const [page, setPage] = useState<'setup' | 'discover' | 'donor'>('setup')
  const [keyDraft, setKeyDraft] = useState('')
  const [baseURL, setBaseURL] = useState(target.configuration.baseURL ?? '')
  const [models, setModels] = useState<readonly ProviderModelSettings[]>(target.configuration.models)
  const [cursor, setCursor] = useState(0)
  const [zone, setZone] = useState<'key' | 'url' | 'models'>('key')
  const [field, setField] = useState<'none' | 'ctx' | 'out'>('none')
  const [addDraft, setAddDraft] = useState('')
  /** Micro-editor for the selected model's reasoningEfforts declaration. */
  const [effEditing, setEffEditing] = useState(false)
  const [effDraft, setEffDraft] = useState('')
  const [donorCursor, setDonorCursor] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const credential = target.credential
  const keyStatus = saveCredential === undefined
    ? 'key storage unavailable'
    : credential?.kind === 'error'
      ? 'key status unavailable'
      : credential?.kind === 'facts' && credential.configured
        ? 'key saved' + (credential.source === undefined ? '' : ' · ' + credential.source)
        : 'no key set'
  // A dormant route (no resolved profile yet, so no credential facts) may
  // still receive a key: the save path materializes the apiKeyEnv reference
  // itself. Only a known-unwritable or indescribable credential blocks.
  const keyEditable = saveCredential !== undefined
    && (credential === undefined || (credential.kind === 'facts' && credential.writable))
  const onAddRow = cursor >= models.length
  const selected = onAddRow ? undefined : models[cursor]

  const updateSelected = (change: Partial<ProviderModelSettings>): void => {
    if (selected === undefined) return
    setModels(current => current.map((model, index) => index === cursor ? { ...model, ...change } : model))
  }

  const commitAddDraft = (): void => {
    const id = addDraft.trim()
    if (id === '') return
    if (models.some(model => model.id === id)) {
      setError('model "' + id + '" is already in the list')
      return
    }
    setError(undefined)
    setModels([...models, { id }])
    setCursor(models.length)
    setAddDraft('')
  }

  /** Compact declaration summary for the row label: count, off, or inherit. */
  const effortsSummary = (model: ProviderModelSettings): string => {
    const raw = (model.extras)?.reasoningEfforts
    if (raw === false) return 'off'
    if (isDeclaredReasoningEfforts(raw)) return String(Object.keys(raw).length)
    return '~'
  }

  /** Write (or clear) the selected model's declaration through extras. */
  const applyDeclaration = (value: ReasoningEffortsValue): void => {
    setModels(current => current.map((model, index) => {
      if (index !== cursor) return model
      const extras: Record<string, unknown> = { ...model.extras }
      if (value === undefined) delete extras.reasoningEfforts
      else extras.reasoningEfforts = value
      return { ...model, ...Object.keys(extras).length === 0 ? {} : { extras } }
    }))
  }

  /** Donors excluding the row being edited (copying from itself is a no-op). */
  const donorRows = selected === undefined
    ? []
    : effortDonors.filter(donor => !(donor.provider === target.provider && donor.id === selected.id))
  const donorIndex = Math.min(donorCursor, Math.max(0, donorRows.length - 1))
  const donorRow = donorRows[donorIndex]

  const submit = (): void => {
    if (busy) return
    const key = keyDraft.trim()
    // A typed key must never vanish silently: when it cannot be written here
    // (read-only env supply, or credential status failed to describe), refuse
    // the whole save with one actionable line instead of saving the endpoint
    // and models while dropping the key the user believes was stored.
    if (key !== '' && !keyEditable) {
      setError('this API key cannot be written here (read-only or status unavailable); clear the key field to save the endpoint and models alone')
      return
    }
    setBusy(true)
    setError(undefined)
    const keySave = key !== '' ? saveCredential : undefined
    void (async () => {
      if (keySave !== undefined) await keySave(target, key)
      await save(target, { ...(baseURL.trim() === '' ? {} : { baseURL }), models })
      return keySave !== undefined
    })().then(keySaved => done({ key: keySaved }), (reason: unknown) => {
      setBusy(false)
      setError(singleLineText(reason instanceof Error ? reason.message : String(reason)))
    })
  }

  useStableInput((input, key) => {
    if (busy) return
    // Ctrl+C leaves the whole model configuration flow from any stage.
    if (key.ctrl && input === 'c') {
      onExit()
      return
    }
    // Efforts micro-editor: consumes every key while open (space is the
    // pair separator, so the composer-style remove must not fire here).
    if (effEditing) {
      if (key.escape) { setEffEditing(false); setEffDraft(''); return }
      if (key.return) {
        const parsed = parseReasoningEffortsDraft(effDraft)
        if (!parsed.ok) { setError(parsed.error); return }
        setError(undefined)
        applyDeclaration(parsed.value)
        setEffEditing(false)
        setEffDraft('')
        return
      }
      if (key.backspace || key.delete) { setError(undefined); setEffDraft(current => deleteLastGrapheme(current)); return }
      if (key.ctrl && input === 'u') { setError(undefined); setEffDraft(''); return }
      if (key.ctrl || key.meta || input.length === 0) return
      if (effDraft.length > 200) { setError('efforts draft is too long'); return }
      setError(undefined)
      setEffDraft(current => current + stripPasteMarkers(input))
      return
    }
    // Donor picker: one page, up/down move, enter copies verbatim.
    if (page === 'donor') {
      if (key.escape || input === 'q') { setPage('setup'); return }
      if (donorRows.length === 0) return
      if (key.upArrow) { setDonorCursor(current => current > 0 ? current - 1 : donorRows.length - 1); return }
      if (key.downArrow) { setDonorCursor(current => current < donorRows.length - 1 ? current + 1 : 0); return }
      if (key.return && donorRow !== undefined) {
        applyDeclaration(donorRow.efforts)
        setError(undefined)
        setPage('setup')
      }
      return
    }
    if (key.escape || input === 'q') { back(); return }
    if (key.tab) { setPage('discover'); return }
    if (key.return) { submit(); return }
    if (zone === 'key') {
      // Typing stays available even when the key cannot be written here (a
      // read-only env supply, or a describe failure): the draft is local, and
      // Enter refuses the save with one actionable line instead of silently
      // dropping what the user typed.
      if (key.downArrow) { setZone('url'); return }
      if (key.backspace || key.delete) { setError(undefined); setKeyDraft(current => [...current].slice(0, -1).join('')); return }
      if (key.ctrl && input === 'u') { setError(undefined); setKeyDraft(''); return }
      if (key.ctrl || key.meta || input.length === 0) return
      const next = keyDraft + stripPasteMarkers(input)
      if (next.length > 4096) { setError('API key input is too long'); return }
      setError(undefined)
      setKeyDraft(next)
      return
    }
    if (zone === 'url') {
      if (key.upArrow) { setZone('key'); return }
      if (key.downArrow) { setZone('models'); return }
      if (key.backspace || key.delete) setBaseURL(current => deleteLastGrapheme(current))
      else if (!key.ctrl && !key.meta && input !== '') setBaseURL(current => current + stripPasteMarkers(input))
      return
    }
    // Models zone: the explicit list plus the hand-add row below it.
    if (key.upArrow) {
      setError(undefined)
      if (cursor === 0) setZone('url')
      else { setCursor(current => current - 1); setField('none') }
      return
    }
    if (key.downArrow) {
      setError(undefined)
      if (!onAddRow) { setCursor(current => current + 1); setField('none') }
      return
    }
    if (key.leftArrow || key.rightArrow) {
      if (selected === undefined) return
      const cycle = key.rightArrow
        ? (current: 'none' | 'ctx' | 'out') => current === 'none' ? 'ctx' : current === 'ctx' ? 'out' : 'none'
        : (current: 'none' | 'ctx' | 'out') => current === 'none' ? 'out' : current === 'out' ? 'ctx' : 'none'
      setField(current => cycle(current))
      return
    }
    if (input === ' ') {
      if (selected === undefined) commitAddDraft()
      else {
        setError(undefined)
        setField('none')
        setModels(current => current.filter((_model, index) => index !== cursor))
        setCursor(current => Math.min(current, Math.max(0, models.length - 1)))
      }
      return
    }
    if (onAddRow) {
      if (key.backspace || key.delete) { setError(undefined); setAddDraft(current => deleteLastGrapheme(current)); return }
      if (key.ctrl || key.meta || input.length === 0) return
      setError(undefined)
      setAddDraft(current => current + stripPasteMarkers(input))
      return
    }
    if (input === 'e' && selected !== undefined) {
      setError(undefined)
      setEffDraft(serializeReasoningEfforts((selected.extras)?.reasoningEfforts))
      setEffEditing(true)
      return
    }
    if ((input === 'c' || input === 'C') && !key.ctrl && selected !== undefined) {
      setError(undefined)
      setDonorCursor(0)
      setPage('donor')
      return
    }
    if (field !== 'none' && selected !== undefined) {
      const name = field === 'ctx' ? 'contextWindow' : 'maxTokens'
      const current = String(selected[name] ?? '')
      if (key.backspace || key.delete) {
        const next = current.slice(0, -1)
        updateSelected({ [name]: next === '' ? undefined : Number(next) })
      } else {
        // A pasted number arrives as one multi-character chunk; accept the
        // whole digit run instead of the single-character path only.
        const digits = stripPasteMarkers(input)
        if (/^[0-9]+$/u.test(digits)) updateSelected({ [name]: Number(current + digits) })
      }
    }
  }, page !== 'discover')
  if (viewport.maxHeight === 0 || viewport.bodyRows < 3) {
    // Never hide a live input surface: one visible row keeps the escape
    // route honest on extremely short terminals (the three fixed rows - key,
    // url, add-by-id - cannot fit below a three-row body).
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(t('panel.setup.compact'), viewport.contentColumns))
  }
  if (page === 'donor') {
    const stateRow = donorRows.length === 0
      ? createElement(Text, { key: 'empty', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(`  ${t('panel.setup.noDonors')}`, viewport.contentColumns))
      : createElement(Text, { key: 'hint', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(`  ${t('panel.setup.copyInto', { id: displayText(selected?.id ?? '') })}`, viewport.contentColumns))
    const donorBudget = Math.max(0, viewport.bodyRows - 2)
    const donorFirst = selectionWindow(donorIndex, donorRows.length, donorBudget)
    const donorVisible = donorRows.slice(donorFirst, donorFirst + donorBudget)
    const accent = panelAccent('model-efforts', getPalette().brand)
    return createElement(
      Box,
      { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(accent.border) },
      createElement(Text, { color: inkColor(accent.title), bold: true, wrap: 'truncate-end' }, truncateColumns(t('panel.setup.copyTitle'), viewport.contentColumns)),
      createElement(PanelGap, { visible: viewport.gapRows > 0 }),
      stateRow,
      ...donorVisible.map((donor, index) => {
        const active = donorFirst + index === donorIndex
        const label = (active ? '>' : ' ') + ' ' + donor.provider + '/' + displayText(donor.id) + ' · ' + serializeReasoningEfforts(donor.efforts)
        return createElement(Text, { key: donor.provider + '/' + donor.id, color: active ? inkColor(getPalette().brandBright) : inkColor(getPalette().text), wrap: 'truncate-end' }, truncateColumns(label, viewport.contentColumns))
      }),
      createElement(PanelGap, { visible: viewport.gapRows > 0 }),
      createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(t('panel.setup.copyFooter'), viewport.contentColumns)),
    )
  }
  if (page === 'discover') {
    return createElement(ProviderDiscoveryPanel, {
      target,
      baseURL,
      apiKey: keyDraft,
      configured: models.map(model => model.id),
      discover,
      onAdopt: adopted => {
        const existing = new Set(models.map(model => model.id))
        const fresh = adopted.filter(model => !existing.has(model.id))
        if (fresh.length > 0) {
          setModels([...models, ...fresh.map(model => ({
            id: model.id,
            ...model.name === undefined ? {} : { name: model.name },
            ...model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow },
            ...model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens },
          }))])
          setCursor(models.length)
        }
        setPage('setup')
      },
      back: () => setPage('setup'),
      onExit,
    })
  }
  const stateRows = error === undefined ? [] : [createElement(Text, { key: 'error', color: inkColor(getPalette().error), wrap: 'truncate-end' }, truncateColumns('  ' + error, viewport.contentColumns))]
  const keyBullets = '•'.repeat(Math.min([...keyDraft].length, Math.max(1, viewport.contentColumns - 14)))
  const keyRow = createElement(Text, { key: 'key', color: zone === 'key' ? inkColor(getPalette().brandBright) : inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(('  ' + (zone === 'key' ? '>' : ' ') + ' key   ' + keyBullets + (zone === 'key' && !busy ? '▏' : '') + (keyDraft === '' ? ' (' + keyStatus + ')' : busy ? ' saving…' : '')).replace(/ +$/u, ''), viewport.contentColumns))
  const urlRow = createElement(Text, { key: 'url', color: zone === 'url' ? inkColor(getPalette().brandBright) : inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns('  ' + (zone === 'url' ? '>' : ' ') + ' url   ' + (baseURL === '' ? '(official default)' : baseURL) + (zone === 'url' ? '▏' : ''), viewport.contentColumns))
  // The fixed diagnostic row (present only with an adapter error) joins the
  // same height budget as the state rows — it must never overflow the panel.
  const rowBudget = Math.max(0, viewport.bodyRows - stateRows.length - (target.diagnostic === undefined ? 0 : 1) - 3)
  const first = selectionWindow(cursor, models.length + 1, rowBudget)
  const modelRows: ReactElement[] = []
  for (let index = first; index < first + Math.max(0, Math.min(models.length + 1 - first, rowBudget)); index += 1) {
    if (index >= models.length) {
      modelRows.push(createElement(Text, { key: 'add', color: cursor === index ? inkColor(getPalette().brandBright) : inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns('  ' + (cursor === index ? '>' : ' ') + ' + add by id' + (addDraft === '' ? '' : ' ' + addDraft + '▏'), viewport.contentColumns)))
      continue
    }
    const model = models[index]
    const active = index === cursor
    const context = model.contextWindow === undefined ? '-' : String(model.contextWindow)
    const output = model.maxTokens === undefined ? '-' : String(model.maxTokens)
    const editing = active && effEditing
    const tail = editing
      ? '  eff:' + effDraft + '▏'
      : '  in:' + (active && field === 'ctx' ? '[' + context + ']' : context) + ' out:' + (active && field === 'out' ? '[' + output + ']' : output) + ' eff:' + effortsSummary(model)
    modelRows.push(createElement(Text, { key: model.id, color: active ? inkColor(getPalette().brandBright) : inkColor(getPalette().success), wrap: 'truncate-end' }, truncateColumns('  ' + (active ? '>' : ' ') + ' [x] ' + displayText(model.id) + tail, viewport.contentColumns)))
  }
  const accent = panelAccent('model-configure', getPalette().brand)
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(accent.border) },
    createElement(Text, { color: inkColor(accent.title), bold: true, wrap: 'truncate-end' }, truncateColumns(t('panel.setup.title', { provider: target.displayName }), viewport.contentColumns)),
    // The adapter's configuration diagnostic heads the editor: the provider
    // is here precisely because it stayed listed for repair.
    ...(target.diagnostic === undefined ? [] : [createElement(
      Text,
      { key: 'diagnostic', color: inkColor(getPalette().warn), wrap: 'truncate-end' },
      truncateColumns('! ' + displayText(singleLineText(target.diagnostic)), viewport.contentColumns),
    )]),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    keyRow,
    urlRow,
    ...stateRows,
    ...modelRows,
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(t('panel.setup.footer'), viewport.contentColumns)),
  )
}

/**
 * The discovery stage of the provider setup page: interrogates the endpoint
 * the drafts describe (typed key wins over the stored credential) and offers
 * the advertised models as a checkable list. Already-configured ids render
 * verified but untoggleable; Enter adopts every checked model back into the
 * setup page's list — selective adoption, never a bulk import.
 */
function ProviderDiscoveryPanel({ target, baseURL, apiKey, configured, discover, onAdopt, back, onExit }: {
  target: ProviderTargetView
  baseURL: string
  apiKey: string
  configured: readonly string[]
  discover: (target: ProviderTargetView, request: { readonly apiKey?: string; readonly baseURL?: string }, signal?: AbortSignal) => Promise<readonly DiscoveredModelView[]>
  onAdopt: (models: readonly DiscoveredModelView[]) => void
  back: () => void
  /** Leave the whole /model flow (Ctrl+C). */
  onExit: () => void
}): ReactElement {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const [epoch, setEpoch] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [rows, setRows] = useState<readonly DiscoveredModelView[]>([])
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set())
  const [cursor, setCursor] = useState(0)
  useEffect(() => {
    // One probe per epoch (mount and explicit 'f'); leaving the page aborts.
    // The drafts are captured when the page opened — adopting unmounts this
    // stage, so re-renders must not re-interrogate the endpoint.
    const controller = new AbortController()
    setLoading(true)
    setError(undefined)
    discover(target, {
      ...(baseURL.trim() === '' ? {} : { baseURL: baseURL.trim() }),
      ...(apiKey.trim() === '' ? {} : { apiKey: apiKey.trim() }),
    }, controller.signal).then(discovered => {
      if (controller.signal.aborted) return
      setRows(discovered)
      const alreadyKnown = new Set(configured)
      const firstNew = discovered.findIndex(model => !alreadyKnown.has(model.id))
      setCursor(firstNew < 0 ? 0 : firstNew)
      setLoading(false)
    }, (reason: unknown) => {
      if (controller.signal.aborted) return
      setError(singleLineText(reason instanceof Error ? reason.message : String(reason)))
      setLoading(false)
    })
    return () => { controller.abort() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [epoch])
  const known = new Set(configured)
  useStableInput((input, key) => {
    if (key.escape || input === 'q') { back(); return }
    if (key.ctrl && input === 'c') { onExit(); return }
    if (input === 'f') { setChecked(new Set()); setEpoch(current => current + 1); return }
    if (loading || error !== undefined) return
    if (rows.length === 0) return
    if (key.upArrow) { setCursor(current => current > 0 ? current - 1 : rows.length - 1); return }
    if (key.downArrow) { setCursor(current => current < rows.length - 1 ? current + 1 : 0); return }
    const row = rows[cursor]
    if (row === undefined) return
    if (input === ' ') {
      if (known.has(row.id)) return
      setChecked(current => {
        const next = new Set(current)
        if (next.has(row.id)) next.delete(row.id)
        else next.add(row.id)
        return next
      })
      return
    }
    if (key.return) {
      onAdopt(rows.filter(model => checked.has(model.id)))
    }
  }, true)
  if (viewport.maxHeight === 0) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(t('panel.discovery.compact'), viewport.contentColumns))
  }
  const stateRows = loading
    ? [createElement(Text, { key: 'loading', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(`  ${t('panel.discovery.loading')}`, viewport.contentColumns))]
    : error !== undefined
      ? [createElement(Text, { key: 'error', color: inkColor(getPalette().error), wrap: 'truncate-end' }, truncateColumns('  ' + error, viewport.contentColumns))]
      : rows.length === 0
        ? [createElement(Text, { key: 'empty', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(`  ${t('panel.discovery.empty')}`, viewport.contentColumns))]
        : [createElement(Text, { key: 'summary', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(`  ${t('panel.discovery.summary', { advertised: rows.length, newCount: rows.filter(model => !known.has(model.id)).length, checked: checked.size })}`, viewport.contentColumns))]
  // One spare row keeps the panel strictly below maxHeight even with the
  // gap collapsed (the at-equality regime makes Ink rewrite Static).
  const rowBudget = Math.max(0, viewport.bodyRows - stateRows.length - 1)
  const first = selectionWindow(cursor, rows.length, rowBudget)
  const visible = rows.slice(first, first + rowBudget)
  const accent = panelAccent('model-discover', getPalette().brand)
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(accent.border) },
    createElement(Text, { color: inkColor(accent.title), bold: true, wrap: 'truncate-end' }, truncateColumns(t('panel.discovery.title', { provider: target.displayName }), viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    ...stateRows,
    ...visible.map((model, index) => {
      const absolute = first + index
      const active = absolute === cursor
      const added = known.has(model.id)
      const mark = added ? '✓' : checked.has(model.id) ? '☑' : '☐'
      const label = (active ? '>' : ' ') + ' ' + mark + ' ' + displayText(model.id) + (model.name === undefined || model.name === model.id ? '' : ' · ' + displayText(model.name))
      return createElement(Text, { key: model.id, color: added ? inkColor(getPalette().dim) : active ? inkColor(getPalette().brandBright) : inkColor(getPalette().text), wrap: 'truncate-end' }, truncateColumns(label, viewport.contentColumns))
    }),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(t('panel.discovery.footer'), viewport.contentColumns)),
  )
}

/** Bounded destructive-action confirmation for credential or provider removal. */
export function DscodeCompactionConfirmPanel({ preview, confirm, back }) {
  const stdout = useStdout().stdout;
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30);
  useStableInput((input, key) => {
    if (key.escape || input === "n") { back(); return; }
    if (input === "y") confirm();
  }, true);
  const palette = getPalette();
  const values = { model: singleLineText(preview.label), used: formatTokens(preview.used), threshold: formatTokens(preview.threshold), window: formatTokens(preview.contextWindow), ratio: Math.round(preview.thresholdRatio * 100) + "%" };
  const title = dscodeT("compaction.confirm.title", values);
  const hint = dscodeT("compaction.confirm.hint");
  if (viewport.maxHeight === 0 || viewport.compact) return createElement(Text, { wrap: "truncate-end" }, truncateColumns(title + " · " + hint, viewport.contentColumns));
  const body = [dscodeT("compaction.confirm.usage", values), dscodeT(preview.overflows ? "compaction.confirm.overflow" : "compaction.confirm.next", values)]
    .map((text, index) => createElement(Text, { key: "body" + index, color: index === 0 ? void 0 : inkColor(palette.dim), wrap: "truncate-end" }, truncateColumns("  " + text, viewport.contentColumns)))
    .slice(0, viewport.bodyRows);
  return createElement(Box, { flexDirection: "column", width: viewport.outerColumns, paddingX: 1, borderStyle: "round", borderColor: inkColor(palette.warn) },
    createElement(Text, { color: inkColor(palette.warn), bold: true, wrap: "truncate-end" }, truncateColumns(title, viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }), ...body, createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { color: inkColor(palette.dim), wrap: "truncate-end" }, truncateColumns(hint, viewport.contentColumns)));
}


function ProviderConfirmPanel({ target, kind, confirm, done, back }: {
  target: ProviderTargetView
  kind: 'credential' | 'provider'
  confirm: (target: ProviderTargetView) => Promise<void>
  done: () => void
  back: () => void
}): ReactElement {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const run = (): void => {
    if (busy) return
    setBusy(true)
    setError(undefined)
    Promise.resolve().then(() => confirm(target)).then(done, (reason: unknown) => {
      setError(singleLineText(reason instanceof Error ? reason.message : String(reason)))
      setBusy(false)
    })
  }
  useStableInput((input, key) => {
    if (busy) return
    if (key.escape || input === 'n') {
      back()
      return
    }
    if (input === 'y') run()
  }, true)

  const action = kind === 'credential' ? 'remove API key' : 'remove provider'
  if (viewport.maxHeight === 0 || viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(`${action} ${target.displayName}? · y confirm · n/esc back`, viewport.contentColumns))
  }
  const identity = target.displayName === target.provider ? target.provider : `${target.displayName} (${target.provider})`
  const identityRow = createElement(Text, { key: 'identity', wrap: 'truncate-end' }, truncateColumns(`  ${displayText(identity)}`, viewport.contentColumns))
  const descriptionRow = createElement(Text, { key: 'description', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(kind === 'credential' ? '  the provider profile and selected model stay available' : '  the user settings profile and its managed key will be removed', viewport.contentColumns))
  const errorRow = error === undefined
    ? undefined
    : createElement(Text, { key: 'error', color: inkColor(getPalette().error), wrap: 'truncate-end' }, truncateColumns(`  ${error}`, viewport.contentColumns))
  const bodyRows = errorRow === undefined
    ? [identityRow, descriptionRow].slice(0, viewport.bodyRows)
    : [identityRow, errorRow].slice(-viewport.bodyRows)
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(getPalette().warn) },
    createElement(Text, { color: inkColor(getPalette().warn), bold: true, wrap: 'truncate-end' }, truncateColumns(`/model — ${action}`, viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    ...bodyRows,
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(busy ? 'working…' : 'y confirm · n/esc back', viewport.contentColumns)),
  )
}

/**
 * The /help overlay: one scrolling card with the keyboard map, the TUI-local
 * commands, the live registry commands, and the user-invocable skills — the
 * real command surface, replacing the one-line notice.
 */
function HelpPanel({ descriptors, skills, commandError, skillError, onClose }: {
  descriptors: readonly CommandDescriptor[]
  skills: readonly SkillRow[]
  commandError: string | undefined
  skillError: string | undefined
  onClose: () => void
}): ReactElement {
  const stdout = useStdout().stdout
  const columns = stdout?.columns ?? 80
  const viewport = panelViewport(columns, stdout?.rows ?? 30)
  const [scroll, setScroll] = useState(0)
  const nameWidth = Math.min(18, Math.max(1, viewport.contentColumns - 2))
  const descBudget = Math.max(0, viewport.contentColumns - nameWidth - 2)
  const row = (label: string, description: string): ReactElement => createElement(
    Text,
    { color: inkColor(getPalette().dim), wrap: 'truncate-end' },
    `  ${padColumns(label, nameWidth)}${truncateColumns(displayText(description), descBudget)}`,
  )
  const content: ReactElement[] = [
    createElement(Text, { key: 'keys-title', bold: true, wrap: 'truncate-end' }, t('help.keysTitle')),
    createElement(Text, { key: 'key-submit', dimColor: true, wrap: 'truncate-end' }, `  ${t('help.key.submit')}`),
    createElement(Text, { key: 'key-mentions', dimColor: true, wrap: 'truncate-end' }, `  ${t('help.key.mentions')}`),
    createElement(Text, { key: 'key-inspector', dimColor: true, wrap: 'truncate-end' }, `  ${t('help.key.inspector')}`),
    createElement(Text, { key: 'key-cancel', dimColor: true, wrap: 'truncate-end' }, `  ${t('help.key.cancel')}`),
    createElement(Text, { key: 'key-queue', dimColor: true, wrap: 'truncate-end' }, `  ${t('help.key.queue')}`),
    createElement(Text, { key: 'key-edit', dimColor: true, wrap: 'truncate-end' }, `  ${t('help.key.edit')}`),
    createElement(Text, { key: 'commands-gap' }, ' '),
    createElement(Text, { key: 'commands-title', bold: true, wrap: 'truncate-end' }, t('help.commandsTitle')),
    ...(commandError === undefined
      ? []
      : [createElement(
        Text,
        { key: 'commands-error', color: inkColor(getPalette().error), wrap: 'truncate-end' },
        truncateColumns(`  command catalog unavailable: ${singleLineText(commandError)}`, viewport.contentColumns),
      )]),
    ...LOCAL_COMMANDS.map(command => createElement(
      Box,
      { key: `local-${command.label.slice(1)}` },
      row(command.label, t(command.descriptionKey)),
    )),
    ...descriptors.filter(descriptor => !LOCAL_COMMAND_NAMES.has(descriptor.name)).map(descriptor => createElement(
      Text,
      { key: `command-${descriptor.name}`, color: inkColor(getPalette().dim), wrap: 'truncate-end' },
      `  ${padColumns(`/${descriptor.name}`, nameWidth)}${truncateColumns(displayText(descriptor.description), descBudget)}`,
    )),
    ...(skills.length === 0 && skillError === undefined
      ? []
      : [
          createElement(Text, { key: 'skills-gap' }, ' '),
          createElement(Text, { key: 'skills-title', bold: true, wrap: 'truncate-end' }, t('help.skillsTitle')),
        ]),
    ...(skillError === undefined
      ? []
      : [createElement(
        Text,
        { key: 'skills-error', color: inkColor(getPalette().error), wrap: 'truncate-end' },
        truncateColumns(`  skill catalog unavailable: ${singleLineText(skillError)}`, viewport.contentColumns),
      )]),
    ...skills.map(skill => createElement(
      Text,
      { key: `skill-${skill.name}`, color: inkColor(getPalette().dim), wrap: 'truncate-end' },
      `  ${padColumns(`/${skill.name}`, nameWidth)}${truncateColumns(displayText(skill.description), descBudget)}`,
    )),
  ]
  const visibleScroll = clampScroll(scroll, content.length, viewport.bodyRows)
  const scrollBy = (delta: number): void => {
    setScroll(current => moveScroll(current, delta, content.length, viewport.bodyRows))
  }

  useEffect(() => {
    if (visibleScroll !== scroll) setScroll(visibleScroll)
  }, [visibleScroll, scroll])

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      onClose()
      return
    }
    if (key.upArrow) scrollBy(-1)
    else if (key.downArrow) scrollBy(1)
    else if (key.pageUp) scrollBy(-Math.max(1, viewport.bodyRows - 1))
    else if (key.pageDown) scrollBy(Math.max(1, viewport.bodyRows - 1))
    else if (input === 'g') setScroll(0)
    else if (input === 'G') setScroll(Math.max(0, content.length - viewport.bodyRows))
  })

  if (viewport.maxHeight === 0 || viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(t('help.compact'), viewport.contentColumns))
  }

  const accent = panelAccent('help', getPalette().brand)
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(accent.border) },
    createElement(Text, { color: inkColor(accent.title), bold: true, wrap: 'truncate-end' }, truncateColumns(`/help — keys and commands · rows ${content.length === 0 ? 0 : visibleScroll + 1}-${Math.min(content.length, visibleScroll + viewport.bodyRows)}/${content.length}`, viewport.contentColumns)),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    ...content.slice(visibleScroll, visibleScroll + viewport.bodyRows),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(Text, { wrap: 'truncate-end' }, dim(truncateColumns(t('help.footer'), viewport.contentColumns))),
  )
}

/** Collapse arbitrary metadata to one terminal row before verbose rendering. */
function verboseLine(text: string, columns: number): string {
  return truncateColumns(displayText(text).replace(/\n/gu, ' ↵ ').replace(/\t/gu, '  '), Math.max(1, columns))
}

/** The empty-composer placeholder text (shared by the static and wave paths). */
const composerPlaceholder = (mode: 'queue' | 'steer'): string =>
  t(mode === 'steer' ? 'composer.placeholderSteer' : 'composer.placeholder')

/** One physical cell of the wave-painted composer row: a char plus styles. */
interface ComposerCell {
  char: string
  width?: number
  color?: string
  backgroundColor?: string
  bold?: boolean
  inverse?: boolean
  dim?: boolean
}

/** Adjacent cells with identical styling merge into one styled Text span. */
function sameCellStyle(a: ComposerCell, b: ComposerCell): boolean {
  return a.color === b.color
    && a.backgroundColor === b.backgroundColor
    && a.bold === b.bold
    && a.inverse === b.inverse
    && a.dim === b.dim
}

/**
 * Render the wave row as one Text whose cells carry per-column
 * `backgroundColor` runs: the Codex Wave crest paints a smooth gradient
 * (one SGR run per sampled column) over the prompt, draft, cursor,
 * placeholder, and the trailing blank fill — the draft stays readable
 * because the tint blends at ≤ 0.55 toward the theme's blank-cell base.
 */
function waveRowSpans(cells: readonly ComposerCell[]): ReactElement[] {
  const spans: ReactElement[] = []
  let start = 0
  while (start < cells.length) {
    const cell = cells[start]
    let end = start + 1
    while (end < cells.length && sameCellStyle(cells[end], cell)) end += 1
    spans.push(createElement(
      Text,
      {
        key: start,
        color: cell.color,
        backgroundColor: cell.backgroundColor,
        bold: cell.bold,
        inverse: cell.inverse,
        dimColor: cell.dim,
      },
      cells.slice(start, end).map(c => c.char).join(''),
    ))
    start = end
  }
  return spans
}

/** Index of the cell STARTING at a display column, if one does. */
function cellIndexAtColumn(cells: readonly ComposerCell[], target: number): number | undefined {
  let column = 0
  for (let index = 0; index < cells.length; index += 1) {
    if (column === target) return index
    column += cells[index].width ?? visibleColumns(cells[index].char)
    if (column > target) return undefined
  }
  return undefined
}

/**
 * Wall-clock wave frames — strictly ONE sweep per MOUNT; the mount-spanning
 * one-shot latch (surviving modal unmounts) lives in Input as `wavePlayedKey`.
 * The first gate-off after the sweep has started (it completed, a turn went
 * busy, image preparation began, animations were toggled off) latches `done`
 * for this mount, so the same mount can never resume or replay. A trigger
 * that lands while the gate is already down stays pending until the gate
 * rises once, then plays.
 */
function useWaveFrames(active: boolean, durationMs: number): { tick: number; done: boolean } {
  const [tick, setTick] = useState(0)
  const [done, setDone] = useState(false)
  const startedRef = useRef(false)
  useEffect(() => {
    if (done) return
    if (!active) {
      // A sweep that already started is cancelled permanently, never resumed.
      if (startedRef.current) setDone(true)
      return
    }
    startedRef.current = true
    const startedAt = Date.now()
    const id = setInterval(() => {
      const elapsed = Date.now() - startedAt
      if (elapsed >= durationMs) {
        clearInterval(id)
        setDone(true)
        return
      }
      setTick(Math.max(0, Math.floor(elapsed / DEEPSEEK_WAVE_TICK_MS)))
    }, DEEPSEEK_WAVE_TICK_MS)
    return () => {
      clearInterval(id)
    }
  }, [active, durationMs, done])
  return { tick, done }
}

/** The wave-painted composer band: everything the sweep needs, as data. */
interface ComposerWaveProps {
  /** Wave tier of the applied route (flash / deepseek / unknown). */
  tier: DeepseekWaveTier
  /** Ignition style App picked for this trigger. */
  style: DeepseekWaveStyle
  /** False while busy, preparing images, or animations are off; the fallback
   * band renders instead (non-wave routes keep it false permanently). */
  active: boolean
  /** The static band to render before, after, and instead of the sweep. */
  fallback: ReactElement
  /** Composer band width in columns (terminal width minus the last column). */
  bandWidth: number
  /** Ink color of the static band background (the transparent-cell base). */
  bandBg: string
  /** The editor's visible physical rows (already windowed). */
  rows: readonly EditorRowModel[]
  /** Index of `rows[0]` in the full editor model (keying + caret row math). */
  windowStart: number
  /** Absolute caret row in the editor model. */
  caretRow: number
  /** The authoritative cursor offset. */
  cursor: number
  /** Caret blink visibility (shared with the static path). */
  caretVisible: boolean
  /** The draft text (placeholder detection on row 0). */
  value: string
  /** Tier prompt glyph and accent color (persistent, like Codex's charge). */
  promptGlyph: string
  /** Empty-composer placeholder for the delivery mode in force. */
  placeholder: string
  promptColor: string
  /** Fires EXACTLY ONCE when this sweep ends for any reason — completed,
   * cancelled by the gate, or unmounted (a modal panel froze the composer) —
   * so Input's played-key latch survives the leaf's unmount/remount cycle. */
  onSettled: () => void
}

/**
 * The self-contained wave leaf: it owns its 33ms tick, so the sweep
 * re-renders ONLY this component at ~30fps — Input's derived editor state
 * never re-runs per frame. Graphemes stay atomic and every background sample
 * advances by terminal display columns, so CJK and emoji cannot move the
 * caret or wrap the band. The duration gate renders the fallback band on the
 * frame the sweep completes.
 */
function ComposerWave(props: ComposerWaveProps): ReactElement {
  const { tier, style } = props
  const durationMs = deepseekWaveDuration(tier, style)
  const { tick, done } = useWaveFrames(props.active, durationMs)
  // Report the sweep's end exactly once — completion, gate cancellation, or
  // unmount (a modal opened and froze the composer) — latching Input's
  // played-key so this trigger can never replay after a remount.
  const settledRef = useRef(false)
  const onSettledRef = useRef(props.onSettled)
  onSettledRef.current = props.onSettled
  const settle = (): void => {
    if (settledRef.current) return
    settledRef.current = true
    onSettledRef.current()
  }
  useEffect(() => {
    if (done) settle()
  }, [done])
  useEffect(() => () => {
    settle()
  }, [])
  if (!props.active || done || tick * DEEPSEEK_WAVE_TICK_MS >= durationMs) return props.fallback
  const hues = deepseekWaveHues(tier)
  const bandRgb = getPalette().composerBand
  const totalBandRows = props.rows.length + 2
  const waveBg = (row: number, column: number): string => {
    const rgb = deepseekWaveColumnBg(tick, column, props.bandWidth, tier, style, hues, bandRgb, row, totalBandRows)
    return rgb === null ? props.bandBg : inkColor(rgb)
  }
  const blankBandRow = (row: number): ReactElement => {
    const blanks: ComposerCell[] = []
    for (let column = 0; column < props.bandWidth; column += 1) {
      blanks.push({ char: ' ', width: 1, backgroundColor: waveBg(row, column) })
    }
    return createElement(Text, { key: `blank-${row}` }, ...waveRowSpans(blanks))
  }
  const editorWaveRows = props.rows.map((row, visibleIndex) => {
    const sourceIndex = props.windowStart + visibleIndex
    const bandRow = visibleIndex + 1
    const parts = editorRowParts(row, sourceIndex, props.caretRow, props.cursor)
    const placeholder = sourceIndex === 0 && props.value === ''
    const cells: ComposerCell[] = []
    let usedColumns = 0
    const push = (char: string, extra: Omit<ComposerCell, 'char' | 'width' | 'backgroundColor'> = {}): void => {
      const width = visibleColumns(char)
      cells.push({ char, width, backgroundColor: waveBg(bandRow, usedColumns), ...extra })
      usedColumns += width
    }
    if (sourceIndex === 0) {
      push(props.promptGlyph, { color: props.promptColor, bold: true })
      push(' ', { color: props.promptColor })
    } else {
      push(' ')
      push(' ')
    }
    for (const span of splitGraphemes(parts.before)) push(span.text)
    if (parts.hasCaret) push(parts.caret, { inverse: props.caretVisible })
    const tail = placeholder ? props.placeholder : parts.after
    for (const span of splitGraphemes(tail)) push(span.text, placeholder ? { dim: true } : {})
    while (usedColumns < props.bandWidth) push(' ')

    const middleBandRow = Math.floor(totalBandRows / 2)
    if (bandRow === middleBandRow && deepseekWaveWordVisible(tick, tier, style)) {
      const word = tier === 'unknown' ? 'Into the Unknown' : 'deepseek'
      const start = Math.max(2, Math.floor((props.bandWidth - word.length) / 2))
      const indices = Array.from({ length: word.length }, (_, at) => cellIndexAtColumn(cells, start + at))
      if (indices.every(index => index !== undefined && (cells[index].char === ' ' || cells[index].dim === true))) {
        for (let at = 0; at < word.length; at += 1) {
          const cell = cells[indices[at]!]
          cell.char = word[at]!
          cell.width = 1
          cell.color = inkColor(deepseekWaveWordHue(at, hues))
          cell.bold = true
          cell.dim = false
        }
      }
    }
    if (bandRow === middleBandRow && (tier === 'deepseek' || tier === 'unknown') && style === 'wave') {
      const spark = deepseekWaveSpark(tick)
      const lastIndex = cellIndexAtColumn(cells, props.bandWidth - 1)
      if (spark !== null && lastIndex !== undefined && cells[lastIndex].char === ' ') {
        cells[lastIndex].char = spark
        cells[lastIndex].color = props.promptColor
        cells[lastIndex].bold = true
        cells[lastIndex].dim = false
      }
    }
    return createElement(Text, { key: `editor-${sourceIndex}`, wrap: 'truncate-end' }, ...waveRowSpans(cells))
  })
  return createElement(
    Box,
    { flexDirection: 'column', width: props.bandWidth },
    blankBandRow(0),
    ...editorWaveRows,
    blankBandRow(totalBandRows - 1),
  )
}

/**
 * The /rainbow celebration leaf: a FIXED seven-color ribbon that slides
 * across the three-row composer band. Same cell model as ComposerWave so
 * CJK/emoji stay atomic; no wordmark, no sparkles — the spectrum is the
 * show. Strictly one-shot per burst id (Input latches onSettled).
 */
function ComposerRainbowBurst(props: Omit<ComposerWaveProps, 'tier' | 'style'>): ReactElement {
  const durationMs = RAINBOW_BURST_DURATION_MS
  const { tick, done } = useWaveFrames(props.active, durationMs)
  const settledRef = useRef(false)
  const onSettledRef = useRef(props.onSettled)
  onSettledRef.current = props.onSettled
  const settle = (): void => {
    if (settledRef.current) return
    settledRef.current = true
    onSettledRef.current()
  }
  useEffect(() => {
    if (done) settle()
  }, [done])
  useEffect(() => () => {
    settle()
  }, [])
  if (!props.active || done || tick * RAINBOW_BURST_TICK_MS >= durationMs) return props.fallback
  const bandRgb = getPalette().composerBand
  const totalBandRows = props.rows.length + 2
  const burstBg = (row: number, column: number): string => {
    const rgb = rainbowBurstColumnBg(tick, column, props.bandWidth, bandRgb, row, totalBandRows)
    return rgb === null ? props.bandBg : inkColor(rgb)
  }
  const blankBandRow = (row: number): ReactElement => {
    const blanks: ComposerCell[] = []
    for (let column = 0; column < props.bandWidth; column += 1) {
      blanks.push({ char: ' ', width: 1, backgroundColor: burstBg(row, column) })
    }
    return createElement(Text, { key: `blank-${row}` }, ...waveRowSpans(blanks))
  }
  const editorBurstRows = props.rows.map((row, visibleIndex) => {
    const sourceIndex = props.windowStart + visibleIndex
    const bandRow = visibleIndex + 1
    const parts = editorRowParts(row, sourceIndex, props.caretRow, props.cursor)
    const placeholder = sourceIndex === 0 && props.value === ''
    const cells: ComposerCell[] = []
    let usedColumns = 0
    const push = (char: string, extra: Omit<ComposerCell, 'char' | 'width' | 'backgroundColor'> = {}): void => {
      const width = visibleColumns(char)
      cells.push({ char, width, backgroundColor: burstBg(bandRow, usedColumns), ...extra })
      usedColumns += width
    }
    if (sourceIndex === 0) {
      push(props.promptGlyph, { color: props.promptColor, bold: true })
      push(' ', { color: props.promptColor })
    } else {
      push(' ')
      push(' ')
    }
    for (const span of splitGraphemes(parts.before)) push(span.text)
    if (parts.hasCaret) push(parts.caret, { inverse: props.caretVisible })
    const tail = placeholder ? props.placeholder : parts.after
    for (const span of splitGraphemes(tail)) push(span.text, placeholder ? { dim: true } : {})
    while (usedColumns < props.bandWidth) push(' ')
    return createElement(Text, { key: `editor-${sourceIndex}`, wrap: 'truncate-end' }, ...waveRowSpans(cells))
  })
  return createElement(
    Box,
    { flexDirection: 'column', width: props.bandWidth },
    blankBandRow(0),
    ...editorBurstRows,
    blankBandRow(totalBandRows - 1),
  )
}

/** One-word kind label per entry, so the inspector's ←→ walk names what
 * each step is instead of leaving the reader to infer it from the body. */
function entryKindLabel(entry: TranscriptEntry | undefined): string {
  switch (entry?.kind) {
    case 'user': return 'user prompt'
    case 'pending': return 'queued prompt'
    case 'assistant': return 'reply'
    case 'tool': return 'tool call'
    case 'command': return 'command'
    case 'error': return 'turn error'
    case 'turn-marker': return 'turn end'
    case 'compaction': return 'compaction'
    case 'retry': return 'retry'
    case 'files': return 'files changed'
    case 'workflow': return 'workflow run'
    default: return 'empty'
  }
}

/**
 * The Ctrl+O transcript inspector: one selected durable entry at a time,
 * with independent history selection and content scrolling. The complete
 * retained entry is converted to physical rows, but only one viewport slice
 * reaches Ink, so even a huge reasoning block cannot grow the dynamic tree.
 */
function VerbosePanel({ entries, onClose }: { entries: readonly TranscriptEntry[]; onClose: () => void }): ReactElement {
  const stdout = useStdout().stdout
  const columns = stdout?.columns ?? 80
  const rows = stdout?.rows ?? 30
  const viewport = inspectorViewport(columns, rows)
  const [cursor, setCursor] = useState(() => Math.max(0, entries.length - 1))
  const [scroll, setScroll] = useState(0)
  const savedScroll = useRef(new Map<number, number>())
  const cursorRef = useRef(cursor)
  const previousLength = useRef(entries.length)
  const entry = entries[cursor]
  const allLines = useMemo(
    () => entry === undefined ? [] : transcriptEntryLines(entry, viewport.contentColumns),
    [entry, viewport.contentColumns],
  )
  const visibleScroll = clampScroll(scroll, allLines.length, viewport.bodyRows)

  useEffect(() => {
    cursorRef.current = cursor
  }, [cursor])

  useEffect(() => {
    const current = cursorRef.current
    const next = followInspectorCursor(current, previousLength.current, entries.length)
    if (next !== current) {
      savedScroll.current.set(current, visibleScroll)
      setCursor(next)
      setScroll(savedScroll.current.get(next) ?? 0)
    }
    previousLength.current = entries.length
  }, [entries.length])

  useEffect(() => {
    const clamped = clampScroll(scroll, allLines.length, viewport.bodyRows)
    if (clamped !== scroll) setScroll(clamped)
    savedScroll.current.set(cursor, clamped)
  }, [cursor, scroll, allLines.length, viewport.bodyRows])

  const selectEntry = (next: number): void => {
    if (entries.length === 0) return
    const selected = Math.max(0, Math.min(entries.length - 1, next))
    if (selected === cursor) return
    savedScroll.current.set(cursor, visibleScroll)
    setCursor(selected)
    setScroll(savedScroll.current.get(selected) ?? 0)
  }

  const scrollBy = (delta: number): void => {
    setScroll(current => moveScroll(current, delta, allLines.length, viewport.bodyRows))
  }

  useInput((input, key) => {
    if (key.escape || input === 'q' || (key.ctrl && input === 'o')) {
      onClose()
      return
    }
    if (entries.length === 0) return
    if (key.leftArrow) {
      selectEntry(cursor - 1)
      return
    }
    if (key.rightArrow) {
      selectEntry(cursor + 1)
      return
    }
    if (key.upArrow) {
      scrollBy(-1)
      return
    }
    if (key.downArrow) {
      scrollBy(1)
      return
    }
    if (key.pageUp) {
      scrollBy(-Math.max(1, viewport.bodyRows - 1))
      return
    }
    if (key.pageDown) {
      scrollBy(Math.max(1, viewport.bodyRows - 1))
      return
    }
    if (input === 'g') {
      setScroll(0)
      return
    }
    if (input === 'G') {
      setScroll(Math.max(0, allLines.length - viewport.bodyRows))
    }
  })

  if (viewport.maxHeight === 0 || viewport.compact) {
    return createElement(
      Text,
      { wrap: 'truncate-end' },
      truncateColumns(t('panel.verbose.compact'), viewport.contentColumns),
    )
  }

  const title = entries.length === 0
    ? 'history details · empty'
    : `history details · entry ${cursor + 1}/${entries.length} · ${entryKindLabel(entry)} · lines ${allLines.length === 0 ? 0 : visibleScroll + 1}-${Math.min(allLines.length, visibleScroll + viewport.bodyRows)}/${allLines.length}`
  const visible = allLines.slice(visibleScroll, visibleScroll + viewport.bodyRows)
  const accent = panelAccent('history-inspector', getPalette().brand)
  return createElement(
    Box,
    {
      flexDirection: 'column',
      width: viewport.outerColumns,
      paddingX: 1,
      borderStyle: 'round',
      borderColor: inkColor(accent.border),
    },
    createElement(
      Text,
      { color: inkColor(accent.title), bold: true, wrap: 'truncate-end' },
      truncateColumns(title, viewport.contentColumns),
    ),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(
      Box,
      { flexDirection: 'column' },
      entry === undefined
        ? createElement(Text, { dimColor: true }, '  no durable entries yet')
        : createElement(StyledRows, { lines: visible }),
    ),
    createElement(PanelGap, { visible: viewport.gapRows > 0 }),
    createElement(
      Text,
      { wrap: 'truncate-end' },
      dim(truncateColumns(t('panel.verbose.footer'), viewport.contentColumns)),
    ),
  )
}

/** Streaming chunks preserve `entries` identity, so the open inspector stays inert. */
const MemoVerbosePanel = memo(VerbosePanel)

/** Stable append-only boundary: modal updates must never revisit Static rows. */
function staticRow(item: unknown): ReactElement {
  return item as ReactElement
}

function StaticTranscript({ items }: { items: ReactElement[] }): ReactElement {
  return createElement(Static, { items, children: staticRow })
}

const MemoStaticTranscript = memo(StaticTranscript)

/** One completion candidate row. */
interface CompletionCandidate {
  /** Insertion text for the command name (with leading slash). */
  label: string
  /** Human-readable description shown beside the label. */
  description: string
  /** Candidate origin; skills land the same literal text but route through the prompt. */
  origin: 'command' | 'skill' | 'mention'
}

/**
 * Resolve completion candidates for the current input: TUI-local commands,
 * the live registry descriptors, and user-invocable skills, filtered by the
 * typed prefix. Command names win collisions (the dispatch tries the
 * registry first and only then falls through to the skill gesture), and a
 * later duplicate name never renders twice.
 *
 * A bare `/` returns the FULL merged list — Codex's command popup shows every
 * command inside a scroll window on an empty filter, and the menu's own
 * selection window bounds the visible rows, so no slice cap is needed.
 */
export function completionCandidates(
  value: string,
  descriptors: readonly CommandDescriptor[],
  skills: readonly SkillRow[],
): readonly CompletionCandidate[] {
  if (!value.startsWith('/')) return []
  const prefix = value.slice(1).split(' ')[0] ?? ''
  const local: CompletionCandidate[] = LOCAL_COMMANDS.map(command => ({ label: command.label, description: t(command.descriptionKey), origin: 'command' }))
  // Local commands shadow registry names (e.g. the TUI-local /permission works
  // before any session exists, while the registry child needs one), so
  // collisions cannot render two rows with the same key.
  const registry = descriptors
    .filter(descriptor => !LOCAL_COMMAND_NAMES.has(descriptor.name))
    .map((descriptor): CompletionCandidate => ({
      label: `/${descriptor.name}`,
      description: descriptor.description,
      origin: 'command',
    }))
  const taken = new Set([...local, ...registry].map(candidate => candidate.label.slice(1)))
  const skillRows = skills
    .filter(skill => !taken.has(skill.name))
    .map((skill): CompletionCandidate => ({
      label: `/${skill.name}`,
      description: skill.modelInvocable ? `skill · ${skill.description}` : `skill (user only) · ${skill.description}`,
      origin: 'skill',
    }))
  // One row per name, first occurrence wins: local before registry before
  // skills, which is exactly the shadowing precedence above (defensive
  // against duplicate registry names across scopes).
  const seen = new Set<string>()
  const all: CompletionCandidate[] = []
  for (const candidate of [...local, ...registry, ...skillRows]) {
    const name = candidate.label.slice(1)
    if (seen.has(name)) continue
    seen.add(name)
    all.push(candidate)
  }
  // Fuzzy ranking (the web menu's discovery feel): the query must be a
  // case-insensitive ordered subsequence of a name; prefix hits first, then
  // alignment score, then this composition order. An empty query keeps the
  // full list.
  return rankByName(all.map(candidate => ({ name: candidate.label.slice(1), candidate })), prefix)
    .map(entry => entry.candidate)
}

/**
 * Shared completion-menu geometry: the menu view and the App's dynamic-row
 * budget MUST derive the exact same physical height, or an open menu silently
 * overflows the terminal during streaming (the cursor creeps past the top and
 * the live region freezes). One helper, two consumers — never drift.
 */
function completionMenuMetrics(terminalRows: number): { limit: number; showFooter: boolean; verticalPadding: number } {
  const showFooter = terminalRows >= 12
  const verticalPadding = terminalRows >= 14 ? 1 : 0
  const limit = Math.max(1, Math.min(6, terminalRows - (showFooter ? 11 : 10) - verticalPadding * 2))
  return { limit, showFooter, verticalPadding }
}

/**
 * The menu's total physical row count at this terminal height: visible
 * candidates (or the single "searching…" row), the overflow marker, the
 * footer, and both padding rows.
 */
function completionMenuRowCount(terminalRows: number, rowCount: number): number {
  const { limit, showFooter, verticalPadding } = completionMenuMetrics(terminalRows)
  const visible = rowCount === 0 ? 1 : Math.min(rowCount, limit)
  const hidden = rowCount === 0 ? 0 : rowCount - visible
  return visible + (hidden > 0 ? 1 : 0) + (showFooter ? 1 : 0) + verticalPadding * 2
}

/**
 * The completion menu, rendered inside the composer's subtree directly above
 * the composer band — attached the way Claude-Code anchors its dropdown.
 * Its height is deducted from the live transcript budget so the menu covers
 * live rows instead of growing the tree and moving the composer/status.
 * Props-only (no lifted state): the menu is a pure view of the input
 * editor's live completion state, so no cross-component effect ever resyncs
 * it (a state lift here previously deadlocked the menu after a resize).
 */
function CompletionMenu({ active, mention, index, rows, error }: {
  active: boolean
  mention: boolean
  index: number
  rows: readonly CompletionCandidate[]
  /** Live mention-discovery failure; replaces the empty "searching…" row. */
  error?: string
}): ReactElement | undefined {
  // Hook order is unconditional: `active` toggling must not change the hook
  // count (the early return used to sit above useStdout).
  const stdout = useStdout().stdout
  const columns = stdout?.columns ?? 80
  const terminalRows = stdout?.rows ?? 30
  if (!active) return undefined
  const contentColumns = Math.max(1, columns - 4)
  // Geometry comes from the shared helper so the menu and the App's dynamic
  // budget always agree on its exact physical height.
  // File paths are the decision-making data in an @ menu. Give mentions the
  // full available line and sacrifice their repetitive kind label first.
  const nameWidth = mention
    ? Math.max(1, contentColumns - 2)
    : Math.min(18, Math.max(1, contentColumns - 2), Math.max(0, ...rows.map(row => visibleColumns(row.label))) + 2)
  const descBudget = Math.max(0, contentColumns - nameWidth - 2)
  const { limit, showFooter, verticalPadding } = completionMenuMetrics(terminalRows)
  const selected = rows.length === 0 ? 0 : index % rows.length
  const first = selectionWindow(selected, rows.length, limit)
  const visible = rows.slice(first, first + limit)
  const hidden = rows.length - visible.length
  return createElement(
    Box,
    { flexDirection: 'column', marginLeft: 2, paddingY: verticalPadding },
    ...(rows.length === 0
      ? [error === undefined
        ? createElement(Text, { key: 'loading', dimColor: true }, 'searching…')
        : createElement(
          Text,
          { key: 'error', color: inkColor(getPalette().error), wrap: 'truncate-end' },
          truncateColumns(`workspace search unavailable: ${singleLineText(error)} · keep typing to retry`, contentColumns),
        )]
      : visible.map((candidate, at) => {
        const absolute = first + at
        return createElement(
        Text,
        {
          key: candidate.label,
          color: absolute === selected ? inkColor(getPalette().brandBright) : inkColor(getPalette().dim),
          wrap: 'truncate-end',
        },
        `${absolute === selected ? '❯ ' : '  '}${padColumns(candidate.label, nameWidth)}${dim(truncateColumns(displayText(candidate.description), descBudget))}`,
        )
      })),
    // Scroll affordance: with the full merged catalog (commands + registry +
    // skills) the six-row window rarely shows the tail — count and hint keep
    // the rest discoverable without inflating the menu budget.
    hidden > 0 ? createElement(Text, { key: 'more', color: inkColor(getPalette().dim), wrap: 'truncate-end' }, `  … +${hidden} more`) : undefined,
    showFooter ? createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, dim(mention ? `↑↓ choose · ${rows.length} items · tab insert` : `↑↓ choose · ${rows.length} items · tab complete`)) : undefined,
  )
}

interface DraftImage extends ImagePathInspection {
  /** Visible draft token; deleting it also detaches the hidden path. */
  readonly marker: string
}

/** One attached non-image file held in the editor until submission persists it. */
interface DraftFile extends FilePathInspection {
  /** Visible draft token; deleting it also detaches the hidden path. */
  readonly marker: string
}

/**
 * The prompt box: TUI-local slash commands handled locally, other lines
 * dispatched; input editing keeps a cursor with history and completion.
 * While a modal (approval / question / model panel) owns the keys, the
 * box passes every key through untouched.
 */
/**
 * dscode: Ctrl+C is a two-press state machine. The first press stops whatever is
 * running (or clears a non-empty draft), and a second press inside the same window
 * exits even while an aborting tool keeps `busy` true. Ctrl+D still exits directly.
 */
function ctrlCAction(
  armed: boolean,
  state: { interrupt: () => boolean; busy: boolean; preparingImages: boolean; active: boolean; hasDraft: boolean },
): 'quit' | 'interrupt' | 'cancel-prepare' | 'wait' | 'clear-draft' {
  if (armed) return 'quit'
  if (state.interrupt() || state.busy) return 'interrupt'
  if (state.preparingImages) return 'cancel-prepare'
  if (!state.active) return 'wait'
  return state.hasDraft ? 'clear-draft' : 'quit'
}

function dscodeEffortCenter(label, width) {
  const left = Math.floor((width - label.length) / 2);
  return ' '.repeat(left) + label + ' '.repeat(width - left - label.length);
}

function dscodeRippleTone(position, center, frame, palette) {
  const distance = Math.abs(position - center);
  const radius = frame * 3;
  return Math.abs(distance - radius) < 3 ? palette.brandBright : distance < radius ? palette.brandMid : palette.brandDeep;
}

function DscodeUltraRipple({ columns }) {
  const palette = getPalette();
  const width = Math.max(1, columns - 5);
  const tick = useFrames(55, true);
  const center = (width - 1) / 2;
  const settled = tick > Math.ceil(width / 6) + 2;
  const label = dscodeEffortCenter(truncateColumns('✦  ULTRA  ·  max reasoning + focused collaboration', width), width);
  const rippleLine = (lag) => {
    const frame = Math.max(0, tick - lag);
    return createElement(Text, { wrap: 'truncate-end' },
      ...Array.from({ length: width }, (_, index) => createElement(Text, {
        key: index,
        color: inkColor(settled ? palette.brandDeep : dscodeRippleTone(index, center, frame, palette))
      }, !settled && (index === Math.floor(center - frame * 3) || index === Math.ceil(center + frame * 3)) ? '✦' : '─')));
  };
  return createElement(Box, {
    width: Math.max(1, columns - 1), paddingX: 2, flexDirection: 'column'
  }, rippleLine(0), createElement(Text, { wrap: 'truncate-end' },
    ...Array.from(label, (letter, index) => createElement(Text, {
      key: index,
      color: inkColor(settled ? palette.brandBright : dscodeRippleTone(index, center, Math.max(0, tick - 1), palette)),
      bold: settled || Math.abs(Math.abs(index - center) - Math.max(0, tick - 1) * 3) < 3
    }, letter))), rippleLine(2));
}

function DscodeUltraFocus({ width, animations }) {
  const palette = getPalette();
  const [frame, setFrame] = useState(0);
  const lastFrame = Math.ceil(width / 6) + 2;
  useEffect(() => {
    if (!animations) return;
    let step = 0;
    const timer = setInterval(() => {
      step++;
      setFrame(step);
      if (step >= lastFrame) clearInterval(timer);
    }, 55);
    return () => clearInterval(timer);
  }, [animations, lastFrame]);
  const label = dscodeEffortCenter(truncateColumns('✦  ULTRA  ✦', width), width);
  const center = (width - 1) / 2;
  const settled = !animations || frame >= lastFrame;
  const first = label.length - label.trimStart().length;
  const last = label.trimEnd().length - 1;
  return createElement(Text, { wrap: 'truncate-end' },
    ...Array.from(label, (letter, index) => {
      const outer = index < first || index > last;
      const burst = animations && !settled && outer &&
        (index === Math.floor(center - frame * 3) || index === Math.ceil(center + frame * 3));
      return createElement(Text, {
        key: index,
        color: inkColor(settled ? outer ? palette.brandDeep : palette.brandBright : dscodeRippleTone(index, center, frame, palette)),
        bold: burst || letter !== ' ' && (settled || Math.abs(Math.abs(index - center) - frame * 3) < 3)
      }, burst ? '✦' : outer ? '─' : letter);
    }));
}

export function DscodeEffortBar({ row, current, select, back, onExit, animations = true }) {
  const ids = ['low', 'high', 'max', 'ultra'];
  const advertised = row.reasoning.efforts;
  const defaultEffort = row.reasoning.defaultEffort;
  const initial = current || defaultEffort;
  const [cursor, setCursor] = useState(Math.max(0, ids.indexOf(initial)));
  useStableInput((input, key) => {
    if (key.ctrl && input === 'c') return onExit();
    if (key.escape || input === 'q') return back();
    if (key.leftArrow || key.upArrow) return setCursor(value => Math.max(0, value - 1));
    if (key.rightArrow || key.downArrow) return setCursor(value => Math.min(3, value + 1));
    if (input === 'g') return setCursor(0);
    if (input === 'G') return setCursor(3);
    if (input === 'o' && advertised.some(effort => effort.id === 'off')) return select('off');
    if (key.return) return select(ids[cursor]);
  }, true);
  const stdout = useStdout().stdout;
  const columns = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 30;
  const contentWidth = Math.max(1, columns - 5);
  const palette = getPalette();
  const selected = ids[cursor];
  const slot = Math.max(5, Math.min(14, Math.floor(contentWidth / 4)));
  const width = slot * 4;
  const barIndent = Math.max(0, Math.floor((contentWidth - width) / 2));
  const compact = rows < 16 || contentWidth < 24;
  const hasOff = advertised.some(effort => effort.id === 'off');
  if (compact) return createElement(Box, { flexDirection: 'column', paddingX: 2 },
    createElement(Text, { color: inkColor(palette.brandBright), wrap: 'truncate-end' },
      truncateColumns(ids.map(id => id === selected ? '[' + id + ']' : id).join('  '), contentWidth)),
    createElement(Text, { color: inkColor(palette.dim), wrap: 'truncate-end' },
      truncateColumns('←→ adjust · enter confirm · esc cancel', contentWidth)));
  const description = advertised.find(effort => effort.id === selected)?.description ?? '';
  const currentLabel = current || defaultEffort || 'default';
  const footer = '←/→ adjust · Enter confirm · Esc cancel' + (hasOff ? ' · o off' : '');
  const trackNode = Math.floor((slot - 1) / 2);
  const pointerColumn = barIndent + cursor * slot + trackNode;
  return createElement(Box, {
    width: Math.max(1, columns - 1),
    flexDirection: 'column',
    paddingX: 2
  },
  createElement(Text, { color: inkColor(palette.brandDeep) }, '─'.repeat(contentWidth)),
  createElement(Text, { color: inkColor(palette.dim) },
    'Faster' + ' '.repeat(Math.max(1, contentWidth - 6 - 7)) + 'Smarter'),
  createElement(Box, { flexDirection: 'row', width, marginLeft: barIndent }, ...ids.map((id, index) => {
    const node = index === cursor ? id === 'ultra' ? '✦' : '◆' : '●';
    const track = '━'.repeat(trackNode) + node + '━'.repeat(slot - trackNode - 1);
    const tone = index === cursor ? palette.brandBright : index < cursor ? palette.brandMid : palette.dim;
    return createElement(Text, { key: id, color: inkColor(tone) }, track);
  })),
  createElement(Text, { color: inkColor(palette.brandBright) }, ' '.repeat(pointerColumn) + '▲'),
  createElement(Box, { flexDirection: 'row', width, marginLeft: barIndent }, ...ids.map((id, index) =>
    createElement(Text, {
      key: id,
      color: inkColor(index === cursor ? palette.brandBright : palette.dim),
      bold: index === cursor
    }, dscodeEffortCenter(id, slot)))),
  selected === 'ultra' ? createElement(DscodeUltraFocus, { width: contentWidth, animations }) :
    createElement(Text, { color: inkColor(palette.text), wrap: 'truncate-end' },
      truncateColumns('current ' + currentLabel + ' · ' + description, contentWidth)),
  createElement(Text, { color: inkColor(palette.dim), wrap: 'truncate-end' },
    truncateColumns(footer, contentWidth)));
}

export function DscodeEffortPanel(props) {
  const reasoning = props.row.reasoning;
  const ids = reasoning?.efforts.map(effort => effort.id) ?? [];
  const barIds = ['low', 'high', 'max', 'ultra'];
  const barCatalog = reasoning?.defaultEffort !== undefined &&
    barIds.every(id => ids.includes(id)) && ids.every(id => id === 'off' || barIds.includes(id));
  return createElement(barCatalog ? DscodeEffortBar : NativeEffortPanel, props);
}


function Input({ effortSurface, ultraPulse, active, frozen, frozenHint, busy, descriptors, skills, dispatch, steer, submitMode, cycleSubmitMode, interrupt, quit, openEmail, openLogin, openProvider, openOpenRouter, openModel, openEffort, openHelp, openMode, openPermission, openResume, openSearch, openPlugin, openUpdate, openSchedule, openJobs, openStatusline, openTheme, openLanguage, saveLanguage, openHistory, openQueue, openAgents, openSubagent, openTodos, openUsage, openDelete, openDiff, openReviewPicker, reviewChanges, deleteConfirm, confirmDelete, cancelDelete, createSession, forkSession, cancelSessionSwitch, notify, applyEditorKeys, hasNotice, dismissNotice, toggleReasoning, openVerbose, clearView, refresh, loadMentions, inspectImages, prepareImages, inspectFiles, prepareFiles, readClipboardImage, cycleMode, exportTranscript, renameTitle, copyLastResponse, recallSpace, recordLocal, recordHistory, queued, updateQueued, historyFill, historyConsumed, animations, applyAnimations, applyRainbow, rainbowBurstId, waveTier, waveStyle, maxRows, anchorRowsBelow, tabTitle, onEditorRows, onMenuRows, sessionKey }: {
  active: boolean
  frozen: boolean
  /** Frozen-band hint naming the surface that owns the keyboard; an empty
   * draft otherwise advertises typing that the composer cannot accept. */
  frozenHint?: string
  busy: boolean
  descriptors: readonly CommandDescriptor[]
  skills: readonly SkillRow[]
  dispatch: (text: string, attachments?: readonly ContentBlock[], origin?: string) => void
  /** Submit as steering into the running turn (see {@link AppProps.steer}). */
  steer: (text: string, attachments?: readonly ContentBlock[], origin?: string) => void
  /** Delivery mode the next submission uses; Tab on an empty composer flips it. */
  submitMode: 'queue' | 'steer'
  /** Flip {@link submitMode} and report the new mode. */
  cycleSubmitMode: () => void
  /** The full current session identity ('' while pending); the delivery origin. */
  sessionKey: string
  interrupt: () => boolean
  quit: (fast?: boolean) => void
  /** dscode: store a provider API key locally (/login [deepseek|openrouter]). */
  openLogin: (provider?: string) => void
  /** dscode: switch the session between DeepSeek and OpenRouter. */
  openProvider: (provider?: string) => void
  /** dscode: open the OpenRouter account panel. */
  openOpenRouter: () => void
  /** dscode: open the email inbox panel. */
  openEmail: () => void
  openModel: () => void
  openEffort: () => void
  openHelp: () => void
  openMode: () => void
  openPermission: () => void
  openResume: () => void
  /** Open the /search panel with an optional seed query. */
  openSearch: (query: string) => void
  openPlugin: (query?: string) => void
  /** Open the /update panel (aligned upgrade surface). */
  openUpdate: () => void
  /** Open the /schedule reminder panel (read-only catalog). */
  openSchedule: () => void
  openJobs: () => void
  openStatusline: () => void
  openTheme: () => void
  /** Open the /language picker (bare /language). */
  openLanguage: () => void
  /** Apply and persist a language chosen by argument. */
  saveLanguage: (name: LanguageName) => void
  openHistory: () => void
  openQueue: () => void
  /** Open the /agents panel (live subagent feed + transcript entry). */
  openAgents: () => void
  /** Open the /subagent model panel. */
  openSubagent: () => void
  /** Open the /todos subpage (full todo list in one bounded panel). */
  openTodos: () => void
  openUsage: () => void
  /** Open the /resume picker in delete mode, optionally pre-armed on one id. */
  openDelete: (id?: string) => void
  openDiff: (argument: string) => void
  reviewChanges: (selection: ReviewSelection) => void
  /** Open the /review candidate picker (bare /review). */
  openReviewPicker: () => void
  /** The row id awaiting y/n in this box, when a deletion is pending. */
  deleteConfirm?: string
  /** Confirm the pending deletion (y in the box). */
  confirmDelete: () => void
  /** Cancel the pending deletion (any other key in the box). */
  cancelDelete: () => void
  createSession: (mode?: string) => void
  forkSession: (argument: string) => void
  cancelSessionSwitch: () => boolean
  notify: (text: string, tone?: NoticeTone) => void
  /** Apply the Ctrl+R passthrough to the detected editor (/vscode-keys); resolves to a one-line summary. */
  applyEditorKeys: () => Promise<string>
  hasNotice: boolean
  dismissNotice: () => void
  toggleReasoning: () => void
  openVerbose: () => void
  clearView: () => void
  refresh: () => void
  loadMentions: (query: string, signal?: AbortSignal) => Promise<readonly MentionCandidate[]>
  inspectImages: (paths: readonly string[]) => Promise<readonly ImagePathInspection[]>
  prepareImages: (paths: readonly string[], signal?: AbortSignal) => Promise<readonly ImageBlock[]>
  inspectFiles: (paths: readonly string[]) => Promise<readonly FilePathInspection[]>
  prepareFiles: (paths: readonly string[], signal?: AbortSignal) => Promise<readonly FileBlock[]>
  /** dscode: read the macOS clipboard as an image path for the next prompt. */
  readClipboardImage: () => Promise<string>
  cycleMode: () => string
  exportTranscript: (argument: string) => Promise<void>
  renameTitle: (argument: string) => string
  copyLastResponse: () => Promise<string>
  /** Newest-first recall space (persistent + in-session, deduped). */
  recallSpace: readonly string[]
  /** Record one in-session submission (deduped, local only). */
  recordLocal: (text: string) => void
  /** Persist one submission to the global history file. */
  recordHistory: (text: string) => void
  /** Next-turn inbox rows, ordered exactly as the durable inbox. */
  queued: readonly Extract<TranscriptEntry, { kind: 'pending' }>[]
  updateQueued?: (messageId: string, action: QueueMutation) => void
  /** Accepted /history entry waiting to be placed into the composer. */
  historyFill: { text: string; index: number } | undefined
  /** Marks the accepted entry consumed (called after the fill is applied). */
  historyConsumed: () => void
  /** Whether timed animations run (shimmer, chase, blink, wave). */
  animations: boolean
  /** Apply and report one /animation toggle (App persists through the runner). */
  applyAnimations: (enabled: boolean) => void
  /** Reroll or pin the rainbow palette (switches to rainbow if needed). */
  applyRainbow: (seed?: number) => void
  /** Monotonic id of the in-flight /rainbow composer burst; 0 means none. */
  rainbowBurstId: number
  /** DeepSeek easter-egg wave tier of the applied route (null otherwise):
   * official DeepSeek models drive their flash/pro tiers, non-DeepSeek
   * models running an effort above high drive the "Into the Unknown"
   * variant. Drives the persistent prompt glyph/accent and the sparkle
   * tier. */
  waveTier: DeepseekWaveTier | null
  /** The ignition style running, if any: Wave / Aurora / Pulse. */
  waveStyle: DeepseekWaveStyle | null
  /** Maximum physical editor rows the composer may occupy (see composerMaxRows). */
  maxRows: number
  /** Terminal rows below the composer the editor does not own: the status
   * footer and Ink's parked cursor row. The IME anchor adds these to the
   * caret's in-band offset to reach that parked position. */
  anchorRowsBelow: number
  /** The managed terminal tab label; re-asserted on terminal focus-in so a
   * background process sharing the console cannot keep it overwritten. */
  tabTitle: string
  /** Reports the editor's current physical row count so the live budget stays exact. */
  onEditorRows: (rows: number) => void
  /** Reports the open completion menu's physical row count (0 when closed)
   * for the same reason: the dynamic budget must reserve it, not overflow. */
  onMenuRows: (rows: number) => void
}): ReactElement {
  const { stdout: inputStdout } = useStdout()
  const columns = inputStdout?.columns ?? 80
  const inputTerminalRows = inputStdout?.rows ?? 30
  // The managed tab label, kept current for the focus-in re-assert below.
  const tabTitleRef = useRef(tabTitle)
  tabTitleRef.current = tabTitle
  const editorColumns = Math.max(1, columns - 6)
  const stdin = useStdin().stdin
  const focusReporting = isVsCodeTerminalEnv()
  const [value, setValue] = useState('')
  /** dscode: the draft is a shell command, so the composer is framed instead of filled. */
  const dscodeShellDraft = String(value ?? '').startsWith('!')
  const [cursor, setCursor] = useState(0)
  const valueRef = useRef(value)
  const cursorRef = useRef(cursor)
  const ctrlCArmedRef = useRef(false)
  // dscode: collapsed pastes, keyed by their marker.
  const pendingPastesRef = useRef(new Map<string, string>())
  valueRef.current = value
  cursorRef.current = cursor
  const [draftImages, setDraftImages] = useState<readonly DraftImage[]>([])
  const draftImagesRef = useRef(draftImages)
  draftImagesRef.current = draftImages
  const [draftFiles, setDraftFiles] = useState<readonly DraftFile[]>([])
  const draftFilesRef = useRef(draftFiles)
  draftFilesRef.current = draftFiles
  const [preparingImages, setPreparingImages] = useState(false)
  const prepareAbortRef = useRef<AbortController | undefined>(undefined)
  const prepareEpochRef = useRef(0)
  const { visible: cursorVisible, reset: resetCursorBlink } = useCursorBlink(active && !frozen && !preparingImages && animations)
  useEffect(() => () => {
    prepareEpochRef.current += 1
    prepareAbortRef.current?.abort()
  }, [])
  // Codex textarea editing state: a single-entry kill buffer, the vertical
  // move's preferred display column, the editor's scroll window, and the
  // bracketed-paste marker state. All of it is editor-local; nothing here
  // ever reaches the App.
  const killRef = useRef('')
  const preferredColumnRef = useRef<number | null>(null)
  const editorScrollRef = useRef(0)
  const pasteBracketRef = useRef(false)
  /** Cancels the pending lost-paste safety timer (undefined when disarmed). */
  const pasteBracketCancelRef = useRef<(() => void) | undefined>(undefined)
  /** Ordered editor tokens from the stdin chunk Ink is about to deliver. */
  const rawEditorTokens = useRef<readonly RawEditorToken[] | undefined>(undefined)
  /** VS Code focus state from xterm focus-report events; starts focused. */
  const terminalFocusedRef = useRef(true)
  // Codex shell-style recall: the navigation cursor, the saved draft restored
  // on Down past the newest entry, and the boundary-gate anchor.
  const recall = useRef<RecallState>(beginRecall([], ''))

  useEffect(() => {
    preferredColumnRef.current = null
  }, [editorColumns])

  // A /history panel acceptance lands as a fill: place the sanitized text at
  // the end of the composer and resume recall from that entry.
  useEffect(() => {
    if (historyFill === undefined) return
    const safe = sanitizeDraftText(historyFill.text)
    pendingPastesRef.current.clear()
    draftImagesRef.current = []
    setDraftImages([])
    draftFilesRef.current = []
    setDraftFiles([])
    valueRef.current = safe
    cursorRef.current = safe.length
    setValue(safe)
    setCursor(safe.length)
    resetCursorBlink()
    preferredColumnRef.current = null
    setDismissedMenuValue(undefined)
    recall.current = {
      entries: recallSpace,
      index: historyFill.index,
      savedDraft: safe,
      lastRecalled: safe,
    }
    historyConsumed()
  }, [historyFill, recallSpace, historyConsumed, resetCursorBlink])

  useEffect(() => {
    setDraftImages((current) => {
      const next = current.filter(image => value.includes(image.marker))
      draftImagesRef.current = next
      return next.length === current.length ? current : next
    })
    setDraftFiles((current) => {
      const next = current.filter(file => value.includes(file.marker))
      draftFilesRef.current = next
      return next.length === current.length ? current : next
    })
  }, [value])
  // A marker that no longer appears in the draft cannot be expanded again.
  useEffect(() => {
    for (const marker of pendingPastesRef.current.keys()) if (!value.includes(marker)) pendingPastesRef.current.delete(marker)
  }, [value])

  // Home/End and the Backspace-vs-Delete family never survive Ink's parser
  // as distinct keys, and kitty CSI-u forms parse as unnamed junk Ink would
  // insert as draft text.
  // Patch stdin.read — the single choke point Ink's input loop pulls every
  // chunk through — to first rewrite decodable CSI-u sequences to their
  // legacy bytes, then tokenize editor-only sequences before Ink emits the
  // matching input event. Batched Home/End/Delete/Backspace actions remain
  // ordered even though Ink invokes useInput only once for the whole chunk.
  useEffect(() => {
    if (stdin === undefined) return
    const originalRead = stdin.read.bind(stdin)
    const patchedRead = function patchedRead(this: typeof stdin, ...args: Parameters<typeof originalRead>) {
      // `Readable.read` is declared `any`; the assertion names its real result
      // union once so the normalization and the focus-event stripping below
      // stay type-checked. Node hands back a Buffer unless an encoding was set,
      // and null once the stream ends.
      const chunk = originalRead(...args) as string | Buffer | null
      if (chunk === null) return chunk
      const normalized = normalizeKeyboardChunk(typeof chunk === 'string' ? chunk : String(chunk))
      const input = focusReporting
        ? stripTerminalFocusEvents(normalized, focused => {
          terminalFocusedRef.current = focused
          // Focus-in re-asserts the managed tab label on both channels: a
          // background process sharing this console (a test-runner worker,
          // for example) may have overwritten the console title while the
          // terminal was unfocused.
          if (focused && inputStdout !== undefined) {
            inputStdout.write(terminalTitleSequence(tabTitleRef.current))
            process.title = sanitizeTerminalTitle(tabTitleRef.current)
          }
        })
        : normalized
      rawEditorTokens.current = tokenizeRawEditorChunk(input)
      return input
    } as typeof stdin.read
    stdin.read = patchedRead
    return () => {
      stdin.read = originalRead
    }
  }, [focusReporting, stdin])

  // Keep the navigation's recall space fresh while browsing state survives
  // (new local submissions extend the space; the index stays valid unless
  // the space shrank, in which case browsing ends at the current position).
  if (recall.current.entries !== recallSpace) {
    const index = recall.current.index === null || recall.current.index < recallSpace.length
      ? recall.current.index
      : null
    recall.current = { ...recall.current, entries: recallSpace, index }
  }
  const [completionIndex, setCompletionIndex] = useState(0)
  const [dismissedMenuValue, setDismissedMenuValue] = useState<string | undefined>(undefined)
  const candidates = completionCandidates(value, descriptors, skills)
  const slashActive = candidates.length > 0 && value.startsWith('/') && !value.includes(' ') && !value.includes('\n')

  // @mention token: the last `@word` on the cursor's line before the cursor.
  const beforeCursor = value.slice(0, cursor)
  const lastLine = beforeCursor.split('\n').at(-1) ?? ''
  const tokenMatch = /(^|\s)@([^\s]*)$/u.exec(lastLine)
  const mentionToken = tokenMatch === null
    ? undefined
    : { start: beforeCursor.length - lastLine.length + (tokenMatch.index ?? 0) + (tokenMatch[1]?.length ?? 0), query: tokenMatch[2] ?? '' }
  const mentionActive = mentionToken !== undefined
  const [mentionRows, setMentionRows] = useState<readonly MentionCandidate[]>([])
  /** Latest mention-discovery failure; shown in the menu instead of an empty list. */
  const [mentionError, setMentionError] = useState<string | undefined>(undefined)
  const mentionRequestRef = useRef(0)

  const sameImagePath = (left: string, right: string): boolean => (
    process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
  )

  const uniqueImageMarker = (name: string, source: 'mention' | 'drop', reserved: readonly string[] = [], kind: 'image' | 'file' = 'image'): string => {
    const safeName = singleLineText(sanitizeDraftText(name))
    const label = kind === 'file' ? 'file' : 'image'
    const base = source === 'mention' ? `@${safeName}` : kind === 'image' ? '[Image 1]' : `[${label}: ${safeName}]`
    let marker = base
    let suffix = 2
    const taken = (candidate: string): boolean =>
      valueRef.current.includes(candidate)
      || draftImagesRef.current.some(image => image.marker === candidate)
      || draftFilesRef.current.some(file => file.marker === candidate)
      || reserved.includes(candidate)
    while (taken(marker)) {
      marker = source === 'mention' ? `@${safeName} (${suffix})` : kind === 'image' ? `[Image ${suffix}]` : `[${label}: ${safeName} ${suffix}]`
      suffix += 1
    }
    return marker
  }

  const registerDraftImage = (inspection: ImagePathInspection, marker: string): boolean => {
    if (draftImagesRef.current.some(image => sameImagePath(image.path, inspection.path))) {
      notify(t('notice.attachmentAlready', { name: inspection.name }), 'warning')
      return false
    }
    const next = [...draftImagesRef.current, { ...inspection, marker }]
    draftImagesRef.current = next
    setDraftImages(next)
    return true
  }

  /**
   * Attach a paste/drop split into image and non-image paths: images ride the
   * durable image blocks, files ride the 0.1.5 file blocks, and both register
   * visible draft markers anchored at the drop point.
   */
  const insertDroppedAttachments = (imagePaths: readonly string[], filePaths: readonly string[], originalValue = valueRef.current, originalCursor = cursorRef.current): void => {
    const total = imagePaths.length + filePaths.length
    if (total === 0) return
    notify(t('notice.attachmentsChecking', { count: total, plural: total === 1 ? '' : 's' }))
    void Promise.all([
      imagePaths.length === 0 ? Promise.resolve([]) : inspectImages(imagePaths),
      filePaths.length === 0 ? Promise.resolve([]) : inspectFiles(filePaths),
    ]).then(([inspectedImages, inspectedFiles]) => {
      const imageAdditions: DraftImage[] = []
      const fileAdditions: DraftFile[] = []
      const markers: string[] = []
      for (const inspection of inspectedImages) {
        if ([...draftImagesRef.current, ...imageAdditions].some(image => sameImagePath(image.path, inspection.path))) continue
        const marker = uniqueImageMarker(inspection.name, 'drop', markers)
        imageAdditions.push({ ...inspection, marker })
        markers.push(marker)
      }
      for (const inspection of inspectedFiles) {
        if ([...draftFilesRef.current, ...fileAdditions].some(file => sameImagePath(file.path, inspection.path))) continue
        const marker = uniqueImageMarker(inspection.name, 'drop', markers, 'file')
        fileAdditions.push({ ...inspection, marker })
        markers.push(marker)
      }
      if (imageAdditions.length === 0 && fileAdditions.length === 0) {
        notify(t('notice.attachmentsAlready'), 'warning')
        return
      }
      const current = valueRef.current
      const anchor = remapStableRange(originalValue, current, { start: originalCursor, end: originalCursor })
      if (anchor === undefined) {
        notify(t('notice.attachmentDraftChanged'), 'warning')
        return
      }
      const at = anchor.start
      const insertion = `${at > 0 && !/\s$/u.test(current.slice(0, at)) ? ' ' : ''}${markers.join(' ')}${current.slice(at) === '' ? '' : ' '}`
      const edit = replaceRangePreservingCursor(current, cursorRef.current, anchor, insertion)
      const nextCursor = current === originalValue && cursorRef.current === originalCursor
        ? at + insertion.length
        : edit.cursor
      valueRef.current = edit.value
      cursorRef.current = nextCursor
      setValue(edit.value)
      setCursor(nextCursor)
      resetCursorBlink()
      const nextImages = [...draftImagesRef.current, ...imageAdditions]
      draftImagesRef.current = nextImages
      setDraftImages(nextImages)
      const nextFiles = [...draftFilesRef.current, ...fileAdditions]
      draftFilesRef.current = nextFiles
      setDraftFiles(nextFiles)
      const count = imageAdditions.length + fileAdditions.length
      notify(t('notice.attachmentsReady', { count, plural: count === 1 ? '' : 's' }))
    }, (reason: unknown) => {
      notify(t('notice.attachmentFailed', { message: reason instanceof Error ? reason.message : String(reason) }), 'error')
    })
  }

  useEffect(() => {
    const requestId = mentionRequestRef.current + 1
    mentionRequestRef.current = requestId
    if (!active || !mentionActive) {
      setMentionRows([])
      setMentionError(undefined)
      return
    }
    setMentionError(undefined)
    const controller = new AbortController()
    const query = mentionToken.query
    const timer = setTimeout(() => {
      void loadMentions(query, controller.signal).then(
        rows => {
          if (!controller.signal.aborted && mentionRequestRef.current === requestId) setMentionRows(rows)
        },
        (reason: unknown) => {
          if (!controller.signal.aborted && mentionRequestRef.current === requestId) {
            setMentionRows([])
            setMentionError(reason instanceof Error ? reason.message : String(reason))
          }
        },
      )
    }, 50)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [active, mentionActive, mentionToken?.query])

  // Codex routes keys to the topmost surface first. Completion therefore
  // remains available while a turn runs, and Esc dismisses it before the
  // same key is allowed to interrupt the turn.
  const menuActive = !preparingImages && (slashActive || mentionActive) && dismissedMenuValue !== value
  const visibleMentionRows = mentionToken !== undefined && isPathLikeMentionQuery(mentionToken.query)
    ? mentionRows.filter(row => row.kind !== 'session')
    : mentionRows
  // Fuzzy ordering over the upstream candidates (≤20 per page, cheaper than
  // the slash menu): rows whose name contains the typed query as an ordered
  // subsequence rise to the top by alignment, and every other upstream row
  // keeps its place after them — the upstream matcher has its own relevance
  // semantics (path segments), so ranking reorders but never drops rows. A
  // path-like query keeps the upstream order entirely.
  let rankedMentionRows = visibleMentionRows
  if (mentionToken !== undefined && !isPathLikeMentionQuery(mentionToken.query) && mentionToken.query !== '') {
    const hits = rankByName(visibleMentionRows.map(row => ({ name: row.label.replace(/^@/u, ''), row })), mentionToken.query)
      .map(entry => entry.row)
    const hitSet = new Set(hits)
    rankedMentionRows = [...hits, ...visibleMentionRows.filter(row => !hitSet.has(row))]
  }
  const menuRows: readonly CompletionCandidate[] = mentionActive
    ? rankedMentionRows.map(row => ({
      label: row.label.startsWith('@')
        ? row.label
        : `@${row.label}${row.kind === 'directory' ? '/' : ''}`,
      description: row.description,
      origin: 'mention',
    }))
    : candidates
  // Exact physical height of the open menu, derived from the same shared
  // geometry the menu view uses — reported one-way (onEditorRows pattern) so
  // the App's dynamic budget can reserve it instead of overflowing.
  const menuHeightRows = menuActive ? completionMenuRowCount(inputTerminalRows, menuRows.length) : 0

  /** Accept the highlighted completion-menu candidate into the draft. */
  const acceptMenuCandidate = (): void => {
    if (mentionActive && mentionToken !== undefined) {
      if (rankedMentionRows.length === 0) return
      const row = rankedMentionRows[completionIndex % rankedMentionRows.length]
      if (row !== undefined) {
        if (row.kind === 'file' && row.path !== undefined && looksLikeImagePath(row.path)) {
          const tokenText = value.slice(mentionToken.start, cursor)
          const start = mentionToken.start
          const originalValue = value
          notify(`checking image ${basename(row.path)}…`)
          void inspectImages([row.path]).then((inspected) => {
            const inspection = inspected[0]
            if (inspection === undefined) return
            const current = valueRef.current
            const anchor = remapStableRange(originalValue, current, { start, end: start + tokenText.length })
            if (anchor === undefined || current.slice(anchor.start, anchor.end) !== tokenText) {
              notify(t('notice.imageDraftChanged'), 'warning')
              return
            }
            if (draftImagesRef.current.some(image => sameImagePath(image.path, inspection.path))) {
              const edit = replaceRangePreservingCursor(current, cursorRef.current, anchor, '')
              valueRef.current = edit.value
              cursorRef.current = edit.cursor
              setValue(edit.value)
              setCursor(edit.cursor)
              resetCursorBlink()
              setDismissedMenuValue(edit.value)
              notify(t('notice.attachmentAlready', { name: inspection.name }), 'warning')
              return
            }
            const marker = uniqueImageMarker(inspection.name, 'mention')
            const edit = replaceRangePreservingCursor(current, cursorRef.current, anchor, marker)
            valueRef.current = edit.value
            cursorRef.current = edit.cursor
            setValue(edit.value)
            setCursor(edit.cursor)
            resetCursorBlink()
            setDismissedMenuValue(edit.value)
            registerDraftImage(inspection, marker)
            notify(t('notice.imageReady', { name: inspection.name }))
          }, (reason: unknown) => {
            notify(t('notice.imageFailed', { message: reason instanceof Error ? reason.message : String(reason) }), 'error')
          })
          setCompletionIndex(0)
          setDismissedMenuValue(undefined)
          return
        }
        // Session rows carry the canonical @[label](dsh-session:…) token;
        // file rows insert `@path` (directories keep their trailing slash).
        const insertion = row.label.startsWith('@')
          ? row.label
          : `@${row.label}${row.kind === 'directory' ? '/' : ''}`
        const nextValue = value.slice(0, mentionToken.start) + insertion + value.slice(cursor)
        const nextCursor = mentionToken.start + insertion.length
        valueRef.current = nextValue
        cursorRef.current = nextCursor
        setValue(nextValue)
        setCursor(nextCursor)
        resetCursorBlink()
      }
    } else {
      if (candidates.length === 0) return
      const candidate = candidates[completionIndex % candidates.length]
      if (candidate !== undefined) {
        const nextValue = `${candidate.label} `
        const nextCursor = candidate.label.length + 1
        valueRef.current = nextValue
        cursorRef.current = nextCursor
        setValue(nextValue)
        setCursor(nextCursor)
        resetCursorBlink()
      }
    }
    setCompletionIndex(0)
    setDismissedMenuValue(undefined)
  }

  /** Apply one editor edit: draft, cursor, kill buffer, menu reset. */
  const applyEdit = (edit: EditResult): void => {
    edit = pasteAtomicEdit(valueRef.current, edit, pendingPastesRef.current)
    if (edit.killed !== undefined && edit.killed !== '') killRef.current = edit.killed
    valueRef.current = edit.value
    cursorRef.current = edit.cursor
    setValue(edit.value)
    setCursor(edit.cursor)
    resetCursorBlink()
    preferredColumnRef.current = null
    setCompletionIndex(0)
    setDismissedMenuValue(undefined)
  }

  /** Move the cursor without editing; horizontal moves clear the column preference. */
  const moveCursorTo = (next: number): void => {
    resetCursorBlink()
    next = pasteCursorEdge(valueRef.current, cursorRef.current, next, pendingPastesRef.current)
    if (next === cursorRef.current) return
    cursorRef.current = next
    setCursor(next)
    preferredColumnRef.current = null
  }

  /** Apply an ordered raw-key batch against one current draft snapshot. */
  const applyRawEditorTokens = (tokens: readonly RawEditorToken[]): void => {
    let nextValue = valueRef.current
    let nextCursor = cursorRef.current
    for (const token of tokens) {
      if (token.kind === 'text') {
        const edit = pasteAtomicEdit(nextValue, insertText(nextValue, nextCursor, collapseLargePaste(token.text, nextValue, pendingPastesRef.current)), pendingPastesRef.current)
        nextValue = edit.value
        nextCursor = edit.cursor
        continue
      }
      if (token.kind === 'home') {
        nextCursor = pasteCursorEdge(nextValue, nextCursor, moveToLineStart(nextValue, nextCursor, false), pendingPastesRef.current)
        continue
      }
      if (token.kind === 'end') {
        nextCursor = pasteCursorEdge(nextValue, nextCursor, moveToLineEnd(nextValue, nextCursor, false), pendingPastesRef.current)
        continue
      }
      const edit = token.kind === 'delete-backward'
        ? deleteBackward(nextValue, nextCursor)
        : token.kind === 'delete-word-backward'
          ? deleteWordBackward(nextValue, nextCursor)
          : token.kind === 'delete-forward'
            ? deleteForward(nextValue, nextCursor)
            : deleteWordForward(nextValue, nextCursor)
      const atomic = pasteAtomicEdit(nextValue, edit, pendingPastesRef.current)
      if (atomic.killed !== undefined && atomic.killed !== '') killRef.current = atomic.killed
      nextValue = atomic.value
      nextCursor = atomic.cursor
    }
    valueRef.current = nextValue
    cursorRef.current = nextCursor
    setValue(nextValue)
    setCursor(nextCursor)
    resetCursorBlink()
    preferredColumnRef.current = null
    setCompletionIndex(0)
    setDismissedMenuValue(undefined)
  }

  const cancelImageSubmission = (): void => {
    prepareEpochRef.current += 1
    prepareAbortRef.current?.abort()
    prepareAbortRef.current = undefined
    setPreparingImages(false)
    dismissNotice()
    notify(t('notice.imageCancelled'), 'warning')
  }

  /** Cross history while an unchanged recalled draft rests its caret on
   * either text edge; between the edges (or inside ordinary drafts) the
   * arrows move through visual rows first. */
  const navigateVertical = (direction: -1 | 1): void => {
    const currentValue = valueRef.current
    const currentCursor = cursorRef.current
    // History owns the arrows while an unchanged recalled draft rests its
    // caret on either text edge (start or end). Everywhere else - edited
    // drafts, interior carets, ordinary typing - the arrows move through
    // visual rows as plain editing.
    if (recall.current.entries.length > 0
      && shouldRecallNavigate(currentValue, currentCursor, recall.current.lastRecalled, direction)) {
      const step = direction < 0 ? recallOlder(recall.current, currentValue) : recallNewer(recall.current)
      recall.current = step.state
      if (step.entry !== undefined) {
        const safe = sanitizeDraftText(step.entry)
        valueRef.current = safe
        cursorRef.current = safe.length
        setValue(safe)
        setCursor(safe.length)
        preferredColumnRef.current = null
        // Suppress the completion menu for the recalled text: a recalled
        // command would otherwise reopen the menu, whose Up/Down navigation
        // then traps the walk before it reaches older history entries. Any
        // edit re-opens the menu; submitting resets the dismissal.
        setDismissedMenuValue(safe)
      }
      resetCursorBlink()
      return
    }
    const model = editorModel(currentValue, editorColumns)
    const preferred = preferredColumnRef.current ?? caretSite(model, currentCursor).column
    const next = moveCursorVertically(model, currentCursor, preferred, direction)
    if (next !== currentCursor) {
      const edge = pasteCursorEdge(currentValue, currentCursor, next, pendingPastesRef.current)
      cursorRef.current = edge
      setCursor(edge)
      resetCursorBlink()
      preferredColumnRef.current = preferred
    }
  }

  useStableInput((input, key) => {
    // dscode: Ctrl+C stays live while a modal or an inactive composer owns the
    // keyboard, so the second press can still exit.
    if (!active && !(key.ctrl && input === 'c')) {
      ctrlCArmedRef.current = false
      return
    }
    // React may not have committed the previous Tab completion render before
    // the next terminal byte arrives. Read the synchronous editor refs so a
    // completion followed immediately by text edits never uses stale closure
    // state.
    const liveValue = valueRef.current
    const liveCursor = cursorRef.current
    if (key.ctrl && input === 'c') {
      const repeated = ctrlCArmedRef.current
      const action = ctrlCAction(ctrlCArmedRef.current, { interrupt, busy, preparingImages, active: active && deleteConfirm === undefined, hasDraft: liveValue !== '' })
      ctrlCArmedRef.current = action !== 'quit'
      if (action === 'quit') quit(repeated)
      else if (action === 'cancel-prepare') cancelImageSubmission()
      else if (action === 'wait' && deleteConfirm !== undefined) cancelDelete()
      else if (action === 'clear-draft') {
        pendingPastesRef.current.clear()
        valueRef.current = ''
        cursorRef.current = 0
        setValue('')
        setCursor(0)
        resetCursorBlink()
        draftImagesRef.current = []
        setDraftImages([])
        draftFilesRef.current = []
        setDraftFiles([])
        setCompletionIndex(0)
        setDismissedMenuValue(undefined)
      }
      return
    }
    ctrlCArmedRef.current = false
    if (preparingImages) {
      if (key.escape || (key.ctrl && input === 'c')) cancelImageSubmission()
      return
    }
    // Deletion confirm owns the box: y proceeds, anything else cancels.
    // Typed in the INPUT BOX (codex delete-confirm): the keystroke is echoed
    // as the box's own prompt, not an invisible panel keypress.
    if (deleteConfirm !== undefined) {
      if (input === 'y' || input === 'Y') {
        confirmDelete()
      } else {
        cancelDelete()
      }
      return
    }
    // Shift+Tab cycles the mode stations: permission presets, then the
    // plan station when the composition offers it (Claude-Code convention).
    if (key.tab && key.shift) {
      try {
        const label = cycleMode()
        if (label !== '') notify(label)
      } catch (error: unknown) {
        notify(t('notice.permissionChangeFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
      }
      return
    }
    // Tab on an EMPTY composer picks how the next submission is delivered:
    // queue for the next turn, or steer into the turn already running. With a
    // draft present Tab stays the completion key (handled with the menu
    // below), so this only claims the keypress when nothing is being typed.
    if (key.tab && liveValue === '' && !menuActive) {
      cycleSubmitMode()
      return
    }
    // Ctrl+R toggles the thinking display (Claude-Code reasoning fold).
    // Alt+R is the zero-config alias: VS Code never intercepts Alt chords,
    // so the toggle stays reachable before /vscode-keys has been applied.
    if ((key.ctrl || key.meta) && input === 'r') {
      if (focusReporting && !terminalFocusedRef.current) return
      toggleReasoning()
      return
    }
    // Ctrl+O opens the bounded transcript inspector (Claude-Code convention,
    // adapted to append-only static rows): one history entry at a time with
    // tool cards and reasoning expanded, Esc returns.
    if ((key.ctrl || key.meta) && input === 'v') {
      // dscode: paste the clipboard image into the draft at the caret that was
      // live when the key was pressed (the read is async).
      const atValue = liveValue
      const atCursor = liveCursor
      notify(t('notice.readingClipboard'))
      readClipboardImage().then(
        path => insertDroppedAttachments([path], [], atValue, atCursor),
        reason => notify(reason instanceof Error ? reason.message : String(reason), 'warning'),
      )
      return
    }
    if (key.ctrl && input === 'o') {
      openVerbose()
      return
    }
    if (key.ctrl && input === 'd') {
      // Codex: Ctrl+D deletes forward while a draft exists; the app-level
      // exit only fires from an empty composer.
      if (liveValue !== '') {
        applyEdit(deleteForward(liveValue, liveCursor))
        return
      }
      if (busy) notify(t('notice.cancelBeforeExit'), 'warning')
      else quit()
      return
    }
    if (key.escape) {
      if (menuActive) {
        setDismissedMenuValue(liveValue)
        return
      }
      if (liveValue.startsWith('!')) {
        // Dropping the bang shifts every character left: keep the caret on the same letter.
        applyEdit({ value: liveValue.slice(1), cursor: Math.max(0, liveCursor - 1) })
        return
      }
      if (hasNotice) {
        dismissNotice()
        return
      }
      if (busy) interrupt()
      return
    }
    // Delete on the empty composer cancels the newest queued message (the
    // web queue-mirror contract: the durable splice drops the pending row).
    if (key.delete && liveValue === '' && queued.length > 0) {
      // Ink gives Backspace (\x7f) and forward Delete the same `key.delete`
      // identity; only the raw editor tokens separate them. The destructive
      // queue cancel is Delete-only (the footer says "Delete on the empty
      // composer cancels") — a habitual Backspace must stay inert here.
      const forwardDelete = rawEditorTokens.current?.some(token =>
        token.kind === 'delete-forward' || token.kind === 'delete-word-forward') === true
      if (forwardDelete) {
        updateQueued?.(queued[queued.length - 1].messageId, { kind: 'remove' })
        return
      }
    }
    if (key.return) {
      // A newline inside an open bracketed paste inserts; it never submits.
      if (pasteBracketRef.current) {
        applyEdit(insertText(liveValue, liveCursor, '\n'))
        return
      }
      // Enter on an open completion menu accepts the highlighted candidate
      // (Codex list parity: Tab and Enter are both accept keys — many users
      // never discover Tab) — UNLESS the draft already spells one candidate
      // exactly, in which case Enter submits it (typing a full "/effort" and
      // pressing return must run the command, not re-accept its own text).
      // dscode: these commands open a picker, so Enter on the menu runs them
      // instead of completing the text and waiting for a second Enter.
      let dscodeRunValue: string | undefined
      if (menuActive) {
        const exactSlash = !mentionActive && candidates.some(candidate => candidate.label === liveValue)
        const picked = mentionActive || candidates.length === 0 ? undefined : candidates[completionIndex % candidates.length]
        if (picked !== undefined && ['/provider', '/login', '/openrouter'].includes(picked.label)) dscodeRunValue = picked.label
        if (dscodeRunValue === undefined && !exactSlash) {
          acceptMenuCandidate()
          return
        }
      }
      // Payload fidelity: trim() is a blank check, not a rewrite. Ordinary
      // prompts keep their exact indentation and trailing whitespace (pasted
      // code must reach the model verbatim); slash lines normalize so the
      // completion-inserted trailing space still routes `/quit ` correctly.
      // dscode: the draft may carry collapsed pastes; the model receives them expanded.
      const expandedValue = expandLargePastes(dscodeRunValue ?? liveValue, pendingPastesRef.current)
      // dscode: a bare \`!command\` line runs through the same shell handover as
      // /shell-exec; attachments keep it an ordinary prompt.
      if (expandedValue.startsWith('!') && draftImagesRef.current.length === 0 && draftFilesRef.current.length === 0) {
        valueRef.current = ''
        cursorRef.current = 0
        setValue('')
        setCursor(0)
        setCompletionIndex(0)
        setDismissedMenuValue(undefined)
        recall.current = beginRecall(recallSpace, '')
        dispatch('/shell-exec ' + expandedValue.slice(1))
        return
      }
      const trimmed = expandedValue.trim()
      // dscode: /login and /provider are intercepted before attachments, history,
      // queueing and model dispatch. An argument may be a pasted key, so the text
      // is never echoed back.
      if (trimmed === '/openrouter') {
        valueRef.current = ''
        cursorRef.current = 0
        setValue('')
        setCursor(0)
        setCompletionIndex(0)
        setDismissedMenuValue(undefined)
        recall.current = beginRecall(recallSpace, '')
        if (busy) { notify(t('notice.openrouterBusy'), 'warning'); return }
        openOpenRouter()
        return
      }
      if (/^\/login(?:\s|$)/.test(trimmed)) {
        valueRef.current = ''
        cursorRef.current = 0
        setValue('')
        setCursor(0)
        setCompletionIndex(0)
        setDismissedMenuValue(undefined)
        recall.current = beginRecall(recallSpace, '')
        const loginTarget = dscodeProviderArgument(trimmed.slice(6))
        if (loginTarget === null) { notify(t('notice.loginUsage'), 'warning'); return }
        if (busy) { notify(t('notice.loginBusy'), 'warning'); return }
        openLogin(loginTarget)
        return
      }
      if (trimmed === '/provider' || /^\/provider\s/.test(trimmed)) {
        valueRef.current = ''
        cursorRef.current = 0
        setValue('')
        setCursor(0)
        setCompletionIndex(0)
        setDismissedMenuValue(undefined)
        recall.current = beginRecall(recallSpace, '')
        const providerTarget = dscodeProviderArgument(trimmed.slice(9))
        if (providerTarget === null) { notify(t('notice.providerUsage'), 'warning'); return }
        if (busy) { notify(t('notice.providerBusy'), 'warning'); return }
        openProvider(providerTarget)
        return
      }
      if (/^\/email(?:\s|$)/.test(trimmed)) {
        if (trimmed !== '/email') { notify(t('notice.emailUsage'), 'warning'); return }
        valueRef.current = ''
        cursorRef.current = 0
        setValue('')
        setCursor(0)
        setCompletionIndex(0)
        setDismissedMenuValue(undefined)
        recall.current = beginRecall(recallSpace, '')
        openEmail()
        return
      }
      const text = submissionPayload(expandedValue)
      if (draftImagesRef.current.length > 0 || draftFilesRef.current.length > 0) {
        // Slash semantics with attachments are unchanged: commands cannot
        // carry attachments, so the line goes to the model as a prompt —
        // warn instead of surprising the user with a literal "/export".
        if (isSlashLine(text)) notify(t('notice.commandAttachments'), 'warning')
        // Attachment prepares resolve asynchronously; the app remounts onto
        // another session in the meantime, and this (old) instance's unmount
        // cleanup runs too late on the microtask timeline. Tag the delivery
        // with the composing session so the runner can drop the stale one.
        const originSession = sessionKey
        const controller = new AbortController()
        const epoch = prepareEpochRef.current + 1
        prepareEpochRef.current = epoch
        prepareAbortRef.current = controller
        setPreparingImages(true)
        const imageSnapshot = draftImagesRef.current
        const fileSnapshot = draftFilesRef.current
        const total = imageSnapshot.length + fileSnapshot.length
        notify(`processing ${total} attachment${total === 1 ? '' : 's'}…`)
        void Promise.all([
          imageSnapshot.length === 0 ? Promise.resolve([]) : prepareImages(imageSnapshot.map(image => image.path), controller.signal),
          fileSnapshot.length === 0 ? Promise.resolve([]) : prepareFiles(fileSnapshot.map(file => file.path), controller.signal),
        ]).then(([images, files]) => {
          if (controller.signal.aborted || prepareEpochRef.current !== epoch) return
          prepareAbortRef.current = undefined
          setPreparingImages(false)
          pendingPastesRef.current.clear()
          valueRef.current = ''
          cursorRef.current = 0
          setValue('')
          setCursor(0)
          draftImagesRef.current = []
          setDraftImages([])
          draftFilesRef.current = []
          setDraftFiles([])
          setCompletionIndex(0)
          setDismissedMenuValue(undefined)
          dismissNotice()
          if (trimmed !== '') {
            recordLocal(text)
            recordHistory(text)
          }
          recall.current = beginRecall(recallSpace, '')
          const blocks: readonly ContentBlock[] = [...images, ...files]
          if (submitMode === 'steer') steer(text, blocks, originSession)
          else dispatch(text, blocks, originSession)
        }, (reason: unknown) => {
          if (controller.signal.aborted || prepareEpochRef.current !== epoch) return
          prepareAbortRef.current = undefined
          setPreparingImages(false)
          notify(`attachment submission failed: ${reason instanceof Error ? reason.message : String(reason)}`, 'error')
        })
        return
      }
      valueRef.current = ''
      cursorRef.current = 0
      setValue('')
      setCursor(0)
      resetCursorBlink()
      setCompletionIndex(0)
      setDismissedMenuValue(undefined)
      if (trimmed === '') return
      dismissNotice()
      // Global recall records every submission - prompts and typed slash
      // commands share one history, so Up/Down and /history recall commands
      // exactly like prompts; the submission resets any active recall
      // browsing.
      recordLocal(text)
      recordHistory(text)
      recall.current = beginRecall(recallSpace, '')
      if (text === '/quit') {
        quit()
        return
      }
      if (text === '/help') {
        openHelp()
        return
      }
      if (text === '/verbose') {
        // dscode: the slash form of the Ctrl/Alt+R toggle, so a remote or
        // pasted session can still reach the verbose transcript.
        toggleReasoning()
        return
      }
      if (text === '/clear') {
        // A new context, not just a cleared screen: the existing session stays
        // resumable, and Ctrl+L keeps the screen-only behaviour above.
        if (busy) {
          notify(t('notice.clearBusy'), 'warning')
          return
        }
        createSession()
        return
      }
      if (text === '/export' || text.startsWith('/export ')) {
        void exportTranscript(text.slice(8))
        return
      }
      if (text === '/title' || text.startsWith('/title ')) {
        const outcome = renameTitle(text.slice(7))
        const tone: NoticeTone = outcome.startsWith('rename failed:')
          ? 'error'
          : outcome.startsWith('usage:') || outcome.includes('unavailable')
            ? 'warning'
            : 'info'
        notify(outcome, tone)
        return
      }
      if (text === '/copy') {
        void copyLastResponse().then(
          outcome => notify(outcome),
          error => notify(`copy failed: ${error instanceof Error ? error.message : String(error)}`, 'error'),
        )
        return
      }
      if (text === '/diff' || text.startsWith('/diff ')) {
        openDiff(text.slice(5))
        return
      }
      if (text === '/review' || text.startsWith('/review ')) {
        // dscode: DSCODE owns /review through its shared review service instead of
        // the native picker, so the whole upstream handler is claimed.
        dispatch(text)
        return
      }
      if (text === '/model' || text.startsWith('/model ')) {
        openModel()
        return
      }
      if (text === '/effort' || text.startsWith('/effort ')) {
        openEffort()
        return
      }
      if (text === '/permission') {
        openPermission()
        return
      }
      if (text.startsWith('/permission ')) {
        dispatch(text)
        return
      }
      if (text === '/mode' || text.startsWith('/mode ')) {
        const mode = text.slice(5).trim()
        if (mode === '') openMode()
        else dispatch(text)
        return
      }
      if (text === '/resume cancel') {
        notify(cancelSessionSwitch() ? 'pending session switch cancelled' : 'no pending session switch', 'info')
        return
      }
      if (text === '/resume' || text.startsWith('/resume ')) {
        const id = text.slice(7).trim()
        if (id === '') openResume()
        else dispatch(text)
        return
      }
      if (text === '/search' || text.startsWith('/search ')) {
        openSearch(text.slice(7).trim())
        return
      }
      if (text === '/new' || text.startsWith('/new ')) {
        createSession(text.slice(4).trim() || undefined)
        return
      }
      if (text === '/fork' || text.startsWith('/fork ')) {
        forkSession(text.slice(5))
        return
      }
      if (text === '/plugin' || text.startsWith('/plugin ')) {
        openPlugin(text.slice(7).trim())
        return
      }
      if (text === '/update') {
        openUpdate()
        return
      }
      if (text === '/schedule') {
        openSchedule()
        return
      }
      if (text === '/jobs' || text.startsWith('/jobs ')) {
        openJobs()
        return
      }
      if (text === '/statusline') {
        openStatusline()
        return
      }
      if (text === '/theme') {
        openTheme()
        return
      }
      if (text === '/language' || text.startsWith('/language ')) {
        const argument = text.slice('/language'.length).trim()
        if (argument === '') openLanguage()
        else if (argument === 'en' || argument === 'zh') {
          saveLanguage(parseLanguageName(argument))
          notify(t('notice.languageSaved', { name: argument }))
          refresh()
        } else notify(t('notice.usage.language'), 'warning')
        return
      }
      if (text === '/animation' || text.startsWith('/animation ')) {
        const parsed = parseAnimationsArgument(text.slice('/animation'.length))
        if (parsed === 'toggle') applyAnimations(!animations)
        else if (parsed === 'usage') notify(t('notice.usage.animation'), 'info')
        else applyAnimations(parsed.enabled)
        return
      }
      if (text === '/rainbow' || text.startsWith('/rainbow ')) {
        const parsed = parseRainbowArgument(text.slice('/rainbow'.length))
        if (parsed === 'usage') notify(t('notice.usage.rainbow'), 'warning')
        else applyRainbow(parsed === 'random' ? undefined : parsed.seed)
        return
      }
      if (text === '/history') {
        openHistory()
        return
      }
      if (text === '/queue') {
        openQueue()
        return
      }
      if (text === '/usage') {
        openUsage()
        return
      }
      if (text === '/agents') {
        openAgents()
        return
      }
      if (text === '/todos') {
        openTodos()
        return
      }
      if (text === '/vscode-keys' || text.startsWith('/vscode-keys ')) {
        void applyEditorKeys().then(
          summary => notify(summary),
          error => notify(`vscode-keys failed: ${error instanceof Error ? error.message : String(error)}`, 'error'),
        )
        return
      }
      if (text === '/subagent') {
        openSubagent()
        return
      }
      if (text === '/delete' || text.startsWith('/delete ')) {
        openDelete(text.slice(7).trim())
        return
      }
      // Delivery mode: everything above this point is a local command or a
      // panel opener and always runs out of band. A real prompt follows the
      // composer's Tab choice — `steer` joins the running turn, the default
      // queues it for the next one.
      if (submitMode === 'steer') steer(text)
      else dispatch(text)
      return
    }
    // The modified-Enter newline family: Ctrl+J arrives as a bare LF (Ink
    // names it 'enter', not 'return'), and the kitty layer normalizes
    // Ctrl/Shift+Enter to the same byte. Alt+Enter reaches here as a bare CR
    // with no flags — Ink's parser drops the escape and reports no meta, and
    // plain Enter always carries key.return — so a flagless CR is Alt+Enter.
    // Only plain Enter submits. app.spec's "modified-Enter family" test pins
    // this exact parser shape; an Ink upgrade that changes it fails there.
    if (input === '\n' || input === '\r') {
      applyEdit(insertText(liveValue, liveCursor, '\n'))
      return
    }
    // A fast Tab followed by text can arrive as one readable chunk in an
    // integrated terminal. Accept the candidate first, then apply the
    // remaining characters against the synchronously updated editor refs.
    if (menuActive && (key.tab || input.startsWith('\t'))) {
      const remainder = key.tab ? '' : input.slice(1)
      acceptMenuCandidate()
      if (remainder !== '') applyEdit(insertText(valueRef.current, cursorRef.current, remainder))
      return
    }
    if (menuActive && key.upArrow) {
      setCompletionIndex(index => (index + menuRows.length - 1) % menuRows.length)
      return
    }
    if (menuActive && key.downArrow) {
      setCompletionIndex(index => (index + 1) % menuRows.length)
      return
    }
    // Batched Home/End/Delete/Backspace sequences bypass Ink's one-key parser
    // and reduce against one current editor snapshot in their original order.
    const rawTokens = rawEditorTokens.current
    rawEditorTokens.current = undefined
    if (rawTokens !== undefined) {
      applyRawEditorTokens(rawTokens)
      return
    }
    if (key.upArrow || key.downArrow) {
      navigateVertical(key.upArrow ? -1 : 1)
      return
    }
    // Ctrl+P / Ctrl+N share the Up/Down contract (Codex binds them to
    // move_up/move_down, so the history gate applies first).
    if (key.ctrl && (input === 'p' || input === 'n')) {
      navigateVertical(input === 'p' ? -1 : 1)
      return
    }
    // Codex editor keymap: Alt/Ctrl+arrows and Alt+B/F move by word pieces;
    // plain arrows and Ctrl+B/F move by grapheme.
    if (key.leftArrow) {
      moveCursorTo(key.meta || key.ctrl ? moveWordLeft(liveValue, liveCursor) : moveCursorBy(liveValue, liveCursor, -1))
      return
    }
    if (key.rightArrow) {
      moveCursorTo(key.meta || key.ctrl ? moveWordRight(liveValue, liveCursor) : moveCursorBy(liveValue, liveCursor, 1))
      return
    }
    if (key.meta && input === 'b') {
      moveCursorTo(moveWordLeft(liveValue, liveCursor))
      return
    }
    if (key.meta && input === 'f') {
      moveCursorTo(moveWordRight(liveValue, liveCursor))
      return
    }
    if (key.ctrl && input === 'b') {
      moveCursorTo(moveCursorBy(liveValue, liveCursor, -1))
      return
    }
    if (key.ctrl && input === 'f') {
      moveCursorTo(moveCursorBy(liveValue, liveCursor, 1))
      return
    }
    // Ctrl+W and Alt+Backspace delete the previous word piece into the kill
    // buffer; Alt+D and the raw Ctrl/Alt+Delete variants kill forward.
    if (key.ctrl && input === 'w') {
      applyEdit(deleteWordBackward(liveValue, liveCursor))
      return
    }
    if (key.meta && input === 'd') {
      applyEdit(deleteWordForward(liveValue, liveCursor))
      return
    }
    // Un-annotated backspace/delete (Ink maps both  and  here):
    // delete the grapheme before the cursor.
    if (key.backspace || key.delete) {
      applyEdit(deleteBackward(liveValue, liveCursor))
      return
    }
    // Readline parity over the LOGICAL line: A/E to its ends, U/K kill to
    // them (filling the single kill buffer), Y yanks it back.
    if (key.ctrl && input === 'a') {
      moveCursorTo(moveToLineStart(liveValue, liveCursor, true))
      return
    }
    if (key.ctrl && input === 'e') {
      moveCursorTo(moveToLineEnd(liveValue, liveCursor, true))
      return
    }
    if (key.ctrl && input === 'u') {
      applyEdit(killToLineStart(liveValue, liveCursor))
      return
    }
    if (key.ctrl && input === 'k') {
      applyEdit(killToLineEnd(liveValue, liveCursor))
      return
    }
    if (key.ctrl && input === 'y') {
      if (killRef.current !== '') applyEdit(insertText(liveValue, liveCursor, killRef.current))
      return
    }
    // Ctrl+L refreshes the screen (readline convention): raw ANSI clear
    // plus a Static remount so the flushed transcript re-emits (a bare
    // console.clear() would desync Ink's ledger against the static rows).
    if (key.ctrl && input === 'l') {
      refresh()
      return
    }
    if (input !== '' && !key.ctrl && !key.meta) {
      // Bracketed-paste wrappers arrive as unknown escape sequences stripped
      // of their ESC. Markers may ride their own chunk or the edges of a
      // content chunk; strip every occurrence and track the open-paste flag
      // so a chunk that is exactly LF inserts instead of submitting.
      let text = input
      if (text.includes(PASTE_START_MARKER)) {
        pasteBracketRef.current = true
        // Arm the lost-marker safety net: one timer per open paste, re-armed
        // if a second start marker rides the same burst.
        pasteBracketCancelRef.current?.()
        const timer = setTimeout(() => {
          pasteBracketRef.current = false
          pasteBracketCancelRef.current = undefined
        }, PASTE_BRACKET_TIMEOUT_MS)
        pasteBracketCancelRef.current = () => {
          clearTimeout(timer)
          pasteBracketCancelRef.current = undefined
        }
        text = text.replaceAll(PASTE_START_MARKER, '')
      }
      if (text.includes(PASTE_END_MARKER)) {
        pasteBracketRef.current = false
        pasteBracketCancelRef.current?.()
        text = text.replaceAll(PASTE_END_MARKER, '')
      }
      if (text === '') return
      if (text.length > 1) {
        // A path-list paste splits into images and files; prose falls through
        // as ordinary text (the splitter returns empty groups for non-paths).
        const dropped = parsePastedAttachmentPaths(text)
        if (dropped.images.length > 0 || dropped.files.length > 0) {
          insertDroppedAttachments(dropped.images, dropped.files)
          return
        }
      }
      applyEdit(insertText(valueRef.current, cursorRef.current, collapseLargePaste(text, valueRef.current, pendingPastesRef.current)))
    }
  }, true)

  // The DeepSeek easter-egg wave renders through the ComposerWave leaf
  // below, which owns its 33ms tick: the sweep re-renders only that child at
  // 30fps — this component's editor model, menu, and derived state never
  // re-run per frame. App drives the tier/style pair on a model switch, and
  // the child remounts whenever that pair changes (App picks a NEW random
  // style for every replay, so the pair always differs when a wave should
  // run), resetting the timeline to frame 0 before the first paint.
  //
  // The sweep is strictly one-shot per trigger, and the latch lives HERE —
  // not in the leaf — because modal panels freeze the composer and UNMOUNT
  // ComposerWave; a mount-scoped latch would reset on every panel close and
  // replay a finished sweep. Keying `wavePlayedKey` by the tier:style pair
  // survives those unmounts: only a NEW trigger (which always changes the
  // pair) re-arms the sweep. Busy turns, image preparation, /animation
  // toggles, and panel open/close on an UNCHANGED model+effort pair never
  // fire it again.
  const waveKey = waveTier !== null && waveStyle !== null ? `${waveTier}:${waveStyle}` : null
  const [wavePlayedKey, setWavePlayedKey] = useState<string | null>(null)
  useEffect(() => {
    // While animations are off, any pending trigger is consumed silently:
    // re-enabling must never queue or replay a celebration the user opted
    // out of watching.
    if (!animations && waveKey !== null && waveKey !== wavePlayedKey) setWavePlayedKey(waveKey)
  }, [animations, waveKey, wavePlayedKey])
  const waveArmed = waveKey !== null && waveKey !== wavePlayedKey
  const burstKey = rainbowBurstId > 0 ? `rainbow:${rainbowBurstId}` : null
  const [burstPlayedKey, setBurstPlayedKey] = useState<string | null>(null)
  useEffect(() => {
    if (!animations && burstKey !== null && burstKey !== burstPlayedKey) setBurstPlayedKey(burstKey)
  }, [animations, burstKey, burstPlayedKey])
  const burstArmed = burstKey !== null && burstKey !== burstPlayedKey

  // Every exclusive panel keeps the composer as a stable visual anchor, but
  // freezes it to one row: no menu, multiline wrap, or animation.
  const tierActive = waveTier !== null
  const tierHues = waveTier === null ? null : deepseekWaveHues(waveTier)
  const promptColor = tierHues === null ? inkColor(getPalette().brand) : inkColor(tierHues[0])
  const waveGlyph = waveTier === 'flash' ? '›' : waveTier === 'deepseek' ? '»' : '❯'
  // Steer mode owns the prompt glyph in every paint path (static band, wave,
  // rainbow burst), so the mode is visible without reading the placeholder.
  // A shell draft hides its routing bang in the editor, so the glyph stays a
  // blank spacer and the shell line aligns with every other mode.
  const promptGlyph = dscodeShellDraft ? ' ' : submitMode === 'steer' ? '↳' : waveGlyph
  const placeholderText = composerPlaceholder(submitMode)
  // The multiline editor model: the sanitized draft hard-wrapped into
  // column-safe physical rows, with the caret mapped to its exact row and
  // column. Computed before the frozen path so the row report below runs
  // unconditionally.
  // A shell draft keeps its bang only as a routing prefix: the frame and the
  // hint row already announce the mode, so the editor renders the draft
  // without it and the caret sits one column to the left. Routing, submission
  // and the row budget keep reading the real value and cursor.
  const editorValue = dscodeShellDraft ? value.slice(1) : value
  const editorViewModel = editorModel(editorValue, editorColumns)
  const clampedCursor = clampCursor(editorValue, dscodeShellDraft ? Math.max(0, cursor - 1) : cursor)
  const caret = caretSite(editorViewModel, clampedCursor)
  const editorWindowRows = Math.min(editorViewModel.rows.length, Math.max(1, maxRows))
  const maxEditorScroll = Math.max(0, editorViewModel.rows.length - editorWindowRows)
  const currentEditorScroll = Math.min(Math.max(0, editorScrollRef.current), maxEditorScroll)
  // Codex effective_scroll: no scrolling while the rows fit; otherwise the
  // window follows the caret row with as little movement as possible.
  const editorWindowStart = caret.row < currentEditorScroll
    ? caret.row
    : caret.row >= currentEditorScroll + editorWindowRows
      ? caret.row - editorWindowRows + 1
      : currentEditorScroll
  editorScrollRef.current = editorWindowStart
  const editorRowCount = frozen ? 1 : editorWindowRows
  useEffect(() => {
    // The shell-mode hint is part of the composer, so it counts toward the row report.
    onEditorRows(editorRowCount + (dscodeShellDraft && !frozen ? 1 : 0))
  }, [editorRowCount, dscodeShellDraft, frozen, onEditorRows])
  // IME anchor: park the real terminal cursor on the caret cell while the
  // composer accepts input. IME composition and candidate windows anchor to
  // that real cursor cell, which otherwise sits below the status row where
  // Ink leaves it, so Chinese input never appears at the caret. Frozen bands
  // release the anchor; the wrapper keeps Ink's relative erase ledger exact.
  const caretRowInWindow = Math.max(0, Math.min(caret.row - editorWindowStart, editorWindowRows - 1))
  useImeCursorAnchor(
    !frozen,
    imeCursorRowsUp({ editorWindowRows, caretRowInWindow, rowsBelowComposer: anchorRowsBelow }),
    2 + caret.column,
  )
  // The menu's physical rows ride the same one-way report; the cleanup keeps
  // the reserve from outliving the menu (unmount or inactive handoff).
  useEffect(() => {
    onMenuRows(menuHeightRows)
    return () => onMenuRows(0)
  }, [menuHeightRows, onMenuRows])
  // The composer band: the old border's three-row footprint repainted as a
  // background-color band (the Codex-style shaded composer strip) — one
  // blank band row above and below the content rows, full width minus the
  // final column. Row counts are untouched, so every height budget stays
  // exact.
  const bandWidth = Math.max(1, columns - 1)
  const bandBg = inkColor(getPalette().composerBand)
  // A shell draft is FRAMED, not filled: its rows pad to the border's interior, so the
  // composer keeps the terminal width and the same row count as the band it replaces.
  const dscodeBandFillWidth = dscodeShellDraft ? Math.max(0, bandWidth - 2) : bandWidth
  const bandFill = (consumed: number): string => ' '.repeat(Math.max(0, dscodeBandFillWidth - consumed))
  const band = (content: ReactElement): ReactElement => dscodeShellDraft
    ? createElement(
      Box,
      { flexDirection: 'column', width: bandWidth, borderStyle: 'round', borderColor: inkColor(getPalette().brandBright) },
      content,
    )
    : createElement(
      Box,
      { flexDirection: 'column', width: bandWidth },
      createElement(Text, { backgroundColor: bandBg }, ' '.repeat(bandWidth)),
      content,
      createElement(Text, { backgroundColor: bandBg }, ' '.repeat(bandWidth)),
    )
  // dscode: the effort bar and the ultra ripple own the composer band while they run.
  if (effortSurface !== undefined) return effortSurface
  if (ultraPulse !== 0 && animations) return createElement(DscodeUltraRipple, { key: ultraPulse, columns })
  if (frozen) {
    // A pending deletion turns the band into the confirm prompt: the y/n is
    // typed HERE; without a border the warn color carries the warning.
    if (deleteConfirm !== undefined) {
      const warning = 'y delete · any other key cancels'
      return band(createElement(
        Text,
        { backgroundColor: bandBg, wrap: 'truncate-end' },
        createElement(Text, { color: inkColor(getPalette().warn), bold: true }, '❯ '),
        createElement(Text, { color: inkColor(getPalette().warn), bold: true }, warning),
        bandFill(2 + visibleColumns(warning)),
      ))
    }
    const frozenLine = value === ''
      ? frozenHint ?? 'type a message'
      : verboseLine(editorValue, Math.max(1, columns - 6))
    return band(createElement(
      Text,
      { backgroundColor: bandBg, wrap: 'truncate-end' },
      createElement(Text, { color: promptColor, bold: tierActive ? true : undefined }, dscodeShellDraft ? `${promptGlyph} ` : submitMode === 'steer' ? '↳ ' : busy ? '… ' : `${promptGlyph} `),
      frozenLine,
      bandFill(2 + visibleColumns(frozenLine)),
    ))
  }
  const menu = createElement(CompletionMenu, {
    active: menuActive,
    mention: mentionActive,
    index: completionIndex,
    rows: menuRows,
    error: mentionActive ? mentionError : undefined,
  })

  // Every state reuses this exact multiline editor window. Only the caret row
  // owns an inverse block; non-caret rows render their text without a hidden
  // spacer or a second blink timer.
  const editorRows: ReactElement[] = []
  for (let index = editorWindowStart; index < Math.min(editorViewModel.rows.length, editorWindowStart + editorWindowRows); index += 1) {
    const row = editorViewModel.rows[index]
    const parts = editorRowParts(row, index, caret.row, clampedCursor, !preparingImages)
    const placeholder = index === 0 && value === '' && !busy && !preparingImages
    const tail = placeholder ? placeholderText : parts.after
    const consumed = 2 + visibleColumns(parts.before) + visibleColumns(parts.caret) + visibleColumns(tail)
    editorRows.push(createElement(
      Text,
      { key: index, backgroundColor: bandBg, wrap: 'truncate-end' },
      index === 0
        ? preparingImages
          ? createElement(Text, { color: inkColor(getPalette().warn), bold: true }, '… ')
          : submitMode === 'steer'
            ? createElement(Text, { color: promptColor, bold: true }, '↳ ')
            : busy
              ? createElement(Text, { color: inkColor(getPalette().brandBright) }, '› ')
              : createElement(Text, { color: promptColor, bold: tierActive ? true : undefined }, `${promptGlyph} `)
        : '  ',
      parts.before,
      parts.hasCaret
        ? createElement(Text, { key: 'caret', inverse: cursorVisible || undefined }, parts.caret)
        : null,
      placeholder
        ? createElement(Text, { dimColor: true }, tail)
        : parts.after,
      bandFill(consumed),
    ))
  }
  const staticEditor = createElement(Box, { flexDirection: 'column' }, ...editorRows)

  // The wave paints the SAME visible rows and caret site as the static path
  // through the ComposerWave leaf (see its comment). The child remounts on
  // every tier/style change, so its timeline always starts at frame 0, and
  // its gate cancels — never freezes — the sweep while busy, preparing
  // images, or animations are off.
  return createElement(
    Box,
    { flexDirection: 'column' },
    menu,
    dscodeShellDraft
      ? createElement(Text, { color: inkColor(getPalette().brandBright), wrap: 'truncate-end' }, truncateColumns(dscodeT('composer.shellMode'), Math.max(1, columns - 2)))
      : null,
    burstArmed
      ? createElement(ComposerRainbowBurst, {
        key: burstKey,
        active: !busy && !preparingImages && animations,
        onSettled: () => {
          if (burstKey !== null) setBurstPlayedKey(burstKey)
        },
        fallback: band(staticEditor),
        bandWidth,
        bandBg,
        rows: editorViewModel.rows.slice(editorWindowStart, editorWindowStart + editorWindowRows),
        windowStart: editorWindowStart,
        caretRow: caret.row,
        cursor: clampedCursor,
        caretVisible: cursorVisible,
        value,
        promptGlyph,
        placeholder: placeholderText,
        promptColor,
      })
      : createElement(ComposerWave, {
        key: waveKey ?? 'static',
        tier: waveTier ?? 'deepseek',
        style: waveStyle ?? 'wave',
        active: false, // dscode keeps the input band stable
        onSettled: () => {
          if (waveKey !== null) setWavePlayedKey(waveKey)
        },
        fallback: band(staticEditor),
        bandWidth,
        bandBg,
        rows: editorViewModel.rows.slice(editorWindowStart, editorWindowStart + editorWindowRows),
        windowStart: editorWindowStart,
        caretRow: caret.row,
        cursor: clampedCursor,
        caretVisible: cursorVisible,
        value,
        promptGlyph,
        placeholder: placeholderText,
        promptColor,
      }),
  )
}

/** One cached settled row: the row Box plus its roomy-prompt spacers. */
interface SettledRowRecord {
  /** The row Box element (keyed by the entry's settled index). */
  box: ReactElement
  /** The roomy-prompt spacer BEFORE the row, or undefined. */
  before: ReactElement | undefined
  /** The roomy-prompt spacer AFTER the row, or undefined. */
  after: ReactElement | undefined
  /** Physical rows this record contributes (row body plus spacers) — the
   * unit of the rendered-history cap. */
  rows: number
}

/** The incremental settled-history cache (see `computeSettledRows`). */
interface SettledRowsCache {
  /** The exact settled entries the cache covers (the WINDOW: the newest
   * `entries.length` settled entries, oldest dropped entries excluded). */
  entries: TranscriptEntry[]
  /** Records keyed by entry identity; mutated in place so the append path
   * never copies the whole map. */
  records: Map<TranscriptEntry, SettledRowRecord>
  /** The header element (depends only on `resumed`). */
  header: ReactElement
  /** The `resumed` the header was built with. */
  resumed: boolean
  /** The toggle state the rows were built with. */
  showReasoning: boolean
  /** The refreshEpoch the rows was built for; a bump forces a full rebuild. */
  epoch: number
  /** The terminal width the rows were wrapped for; a change forces a rebuild. */
  columns: number
  /** The flat row list (header + optional hint + per-entry before/box/after). */
  flat: ReactElement[]
  /** Settled entries dropped from the window's head (rendering only — the
   * event log keeps everything; Ctrl+O and /export read it directly). */
  droppedEntries: number
  /** Physical rows the window's entries contribute (excludes header/hint). */
  totalRows: number
  /** The window overflowed the trim hysteresis; one source-backed replay
   * (epoch bump) will re-window the cache. The append path never mutates
   * flat's head, so <Static> only ever sees tail appends between remounts. */
  needsTrim: boolean
}

/** One step of `computeSettledRows`. */
interface SettledRowsResult {
  cache: SettledRowsCache
  /** How many rows had to be BUILT by this step (0 = pure reuse). */
  built: number
}

/** Build one settled row (row Box plus its roomy-prompt spacers and row count). */
function buildSettledRow(entry: TranscriptEntry, index: number, showReasoning: boolean, columns: number): SettledRowRecord {
  // The SAME physical-row pipeline as the live tail (settledEntryLines).
  // Every row carries its own two-column prefix (user ❯, reply body, tool
  // cards), which is the whole gutter: no extra container padding, so reply
  // text starts at the same column as the composer's input text and wrapped
  // continuations keep their hanging indent instead of resetting to column 0.
  const roomyPrompt = entry.kind === 'user' && !entry.notice
  const lines = dscodeChatLines(entry, Math.max(10, columns - 2), showReasoning)
  return {
    box: createElement(Box, { key: index }, createElement(StyledRows, { lines })),
    before: roomyPrompt
      ? createElement(Box, { key: `prompt-before-${index}`, paddingX: 1 }, createElement(Text, null, ' '))
      : undefined,
    after: roomyPrompt
      ? createElement(Box, { key: `prompt-after-${index}`, paddingX: 1 }, createElement(Text, null, ' '))
      : undefined,
    rows: lines.length + (roomyPrompt ? 2 : 0),
  }
}

/** The dim hint row placed under the header once the window has dropped entries. */
function settledTrimHint(droppedEntries: number, columns: number): ReactElement {
  return createElement(
    Text,
    { key: 'history-cap-hint', color: inkColor(getPalette().dim), wrap: 'truncate-end' },
    truncateColumns(`… +${droppedEntries} earlier messages hidden · ctrl+o browse · /export full transcript`, Math.max(10, columns - 2)),
  )
}

/**
 * The settled `<Static>` row set as a PURE incremental state machine (App
 * drives it from the memo; tests drive it directly and read `built`).
 *
 * The settled prefix is permanently final: the projection only APPENDS below
 * the flush boundary, removes pending rows at or beyond it, and replaces
 * running tool/retry/command rows there too. So extending the cache never
 * rescans the old prefix — a grown boundary builds ONLY the newly settled
 * suffix and reuses every cached element, letting React bail out of unchanged
 * rows and keeping long histories out of the per-durable-event path (no O(N)
 * rebuild of rows, Map, or MarkdownBody parses). `records` is mutated in place
 * on the append/toggle paths to stay O(delta).
 *
 * RENDERED-HISTORY CAP: the window holds at most `rowCap` physical rows of
 * settled transcript (header and hint reserved on top). The cap exists only
 * here — the event log, the store projection, /export, Ctrl+O, and /resume
 * keep the full history. Ink 5's <Static> is a consumption counter
 * (items.slice(index) keyed on length): deleting head items mid-stream while
 * appending tail items can permanently swallow new rows, so the append branch
 * NEVER drops the head — it only accounts rows and flags `needsTrim` once the
 * window overflows cap + margin. The flag fires one source-backed replay
 * (epoch bump = the existing clear + <Static> remount), whose rebuild branch
 * walks the settled entries BACKWARD from the newest, keeps whole entries
 * until the cap, and counts everything older as `droppedEntries` (those
 * entries never even reach settledEntryLines). Hysteresis bounds replays to
 * at most one per 25% growth; resize / Ctrl+L / idle Ctrl+R replays re-window
 * for free on the same path.
 *
 * Full rebuilds run only on the rare, deliberate paths: no cache yet, a
 * source-backed replay (`epoch` bump: resize / Ctrl+L / an idle Ctrl+R fold
 * toggle / a cap trim remounts `<Static>` and must re-flush the CURRENT rows
 * at the CURRENT fold state), a `resumed` change, or a shrink (`store.reset`).
 * While a turn is busy or streaming, Ctrl+R only flips the live region; rows
 * already emitted to native scrollback change exclusively through rebuilds.
 */
export function computeSettledRows(
  previous: SettledRowsCache | undefined,
  entries: readonly TranscriptEntry[],
  settled: number,
  showReasoning: boolean,
  resumed: boolean,
  epoch: number,
  columns = 80,
  rowCap = SETTLED_ROW_CAP,
  headerFacts: { cwd?: string; model?: string; effort?: string; animated?: boolean } = {},
): SettledRowsResult {
  if (previous === undefined || previous.epoch !== epoch || previous.resumed !== resumed
    || settled < previous.entries.length) {
    // Full rebuild at the CURRENT fold state, newest-first so the cap keeps
    // whole entries and never even parses dropped ones.
    const records = new Map<TranscriptEntry, SettledRowRecord>()
    const window: ReactElement[] = []
    let windowRows = 0
    let droppedEntries = 0
    let index = settled - 1
    for (; index >= 0; index--) {
      const entry = entries[index]
      if (entry === undefined) break
      const record = buildSettledRow(entry, index, showReasoning, columns)
      if (rowCap > 0 && windowRows + record.rows > rowCap - SETTLED_ROW_RESERVE) {
        // This whole entry (and everything older) falls out of the window.
        droppedEntries = index + 1
        break
      }
      records.set(entry, record)
      windowRows += record.rows
      if (record.after !== undefined) window.unshift(record.after)
      window.unshift(record.box)
      if (record.before !== undefined) window.unshift(record.before)
    }
    const header = createElement(Header, { key: 'header', ...headerFacts, resumed })
    const flat = droppedEntries > 0
      ? [header, settledTrimHint(droppedEntries, columns), ...window]
      : [header, ...window]
    return {
      cache: {
        entries: entries.slice(droppedEntries, settled),
        records,
        header,
        resumed,
        showReasoning,
        epoch,
        columns,
        flat,
        droppedEntries,
        totalRows: windowRows,
        needsTrim: false,
      },
      built: records.size,
    }
  }
  if (previous.showReasoning !== showReasoning) {
    // Native scrollback is immutable. Record only the mode future settled
    // entries will capture; the existing flat row identity stays untouched.
    return { cache: { ...previous, showReasoning }, built: 0 }
  }
  if (settled === previous.entries.length) {
    // Nothing below the boundary changed (a pending retirement above it, a
    // tool/result at the boundary): keep the SAME flat identity so the
    // memoized <Static> subtree does not re-render at all.
    return { cache: previous, built: 0 }
  }
  // The boundary grew: build ONLY the newly settled suffix. The head is never
  // dropped here (Ink's Static counter would swallow rows on a mixed frame);
  // overflow only flags the cache for one trimming replay.
  const records = previous.records
  const suffix: TranscriptEntry[] = []
  const added: ReactElement[] = []
  let deltaRows = 0
  for (let index = previous.entries.length + previous.droppedEntries; index < settled; index++) {
    const entry = entries[index]
    const record = buildSettledRow(entry, index, showReasoning, previous.columns)
    records.set(entry, record)
    suffix.push(entry)
    deltaRows += record.rows
    if (record.before !== undefined) added.push(record.before)
    added.push(record.box)
    if (record.after !== undefined) added.push(record.after)
  }
  const totalRows = previous.totalRows + deltaRows
  const needsTrim = rowCap > 0 && totalRows > rowCap + Math.floor(rowCap / 4)
  return {
    cache: {
      entries: previous.entries.concat(suffix),
      records,
      header: previous.header,
      resumed: previous.resumed,
      showReasoning,
      epoch: previous.epoch,
      columns: previous.columns,
      flat: previous.flat.concat(added),
      droppedEntries: previous.droppedEntries,
      totalRows,
      needsTrim,
    },
    built: suffix.length,
  }
}

/** The whole terminal app; state arrives via the store, output via Ink. */
export function App(props: AppProps): ReactElement {
  // dscode: the email inbox owns the surface while it is open; a picked message
  // steers into the running turn (or starts one) and closes the panel.
  const [emailOpen, setEmailOpen] = useState(false)
  const gmail = useMemo(() => dscodeCreateGmailConnector(), [])
  const imap = useMemo(() => dscodeCreateImapConnector(), [])
  useEffect(() => {
    const controller = new AbortController()
    const sync = (): void => {
      const connector = imap.status().connected ? imap : gmail
      connector.sync({ signal: controller.signal }).catch(() => {})
    }
    sync()
    const timer = setInterval(sync, 30000)
    return () => {
      clearInterval(timer)
      controller.abort()
    }
  }, [gmail, imap])
  // A session switch never leaves the previous session's inbox open.
  useEffect(() => { setEmailOpen(false) }, [props.sessionKey])
  // The stores are closure-backed singletons whose methods never touch `this`,
  // but a bare method reference still detaches it from its receiver. One stable
  // wrapper per store keeps both the receiver and the reference identity the
  // `useSyncExternalStore` contract requires.
  const subscribeTranscript = useCallback((listener: () => void) => props.store.subscribe(listener), [props.store])
  const readTranscript = useCallback(() => props.store.getView(), [props.store])
  const view = useSyncExternalStore(subscribeTranscript, readTranscript)
  // Terminal input anchor: Ink reference-counts raw mode across every active
  // `useInput` hook, so mutually exclusive surfaces (composer <-> approval
  // bar <-> panels) drop the count to zero inside each handoff commit — the
  // cooked-mode window on the real console strands keystrokes in the line
  // buffer until the next Enter, which intermittently wedged terminals after
  // approval answers. This always-active hook keeps the count >= 1 for the
  // app's whole lifetime; its handler consumes nothing (Ink broadcasts every
  // key to all active handlers, so real owners stay unaffected).
  useStableInput(() => {}, true)
  // getSnapshot must be a STABLE reference (the React contract): an inline
  // arrow here re-subscribes the store hook on every render and cascades
  // force-updates — during a fast reasoning stream that chain crossed React's
  // nested-passive-update limit and flooded "Maximum update depth exceeded"
  // warnings. The view objects are process-stable, so one callback per view
  // identity is enough.
  // getSnapshot should be a stable reference (the React contract): an inline
  // arrow re-subscribes the store hook on every render and forces the uETS
  // consistency check to re-run per commit. The view objects are
  // process-stable, so one callback per view identity is enough.
  const readDescriptors = useCallback(() => props.commands.descriptors, [props.commands])
  const readSkills = useCallback(() => props.skills.rows, [props.skills])
  const subscribeCommands = useCallback((listener: () => void) => props.commands.subscribe(listener), [props.commands])
  const subscribeSkills = useCallback((listener: () => void) => props.skills.subscribe(listener), [props.skills])
  const descriptors = useSyncExternalStore(subscribeCommands, readDescriptors)
  const skills = useSyncExternalStore(subscribeSkills, readSkills)
  const [modelLabel, setModelLabel] = useState(props.model)
  const [modelOpen, setModelOpen] = useState(false)
  /** Nested /model stages; only one owns terminal input at a time. */
  const [providerOpen, setProviderOpen] = useState(false)
  const [providerAction, setProviderAction] = useState<
    | { kind: 'configure' | 'unset' | 'remove'; target: ProviderTargetView }
    | { kind: 'login' | 'logout'; target: ProviderTargetView; authorization: ProviderAuthorizationRow }
    | { kind: 'dscode-key'; provider: string; then?: () => void }
    | { kind: 'dscode-provider' }
    | { kind: 'dscode-compaction'; row: ModelRow; effortId: string | undefined; preview: DscodeCompactionPreview }
    | { kind: 'dscode-openrouter' }
    | { kind: 'dscode-management-key'; optional?: boolean; then?: () => void }
    | undefined
  >(undefined)
  /** The model row whose effort levels the /model stage lists; undefined shows the model list. */
  const [effortFor, setEffortFor] = useState<ModelRow | undefined>(undefined)
  /** Effective reasoning effort, shown in the /model picker and switch notice. */
  const [effortLabel, setEffortLabel] = useState<string | undefined>(props.effort)
  /** DeepSeek easter egg: switching INTO an official DeepSeek route — or
   * onto a NON-DeepSeek model running a reasoning effort strictly above
   * high — plays one of Codex's three ignition styles (Wave / Aurora /
   * Pulse, picked at random without repeating) across the composer's
   * padded band (33ms tick, per-style durations), then the band returns
   * to static while the prompt marker keeps the tier accent. The trigger
   * follows the applied model label (what the status bar actually shows),
   * never the initial paint, and the tier is derived from the label and
   * cached at the switch. The 33ms tick itself lives inside the ComposerWave
   * leaf, so the sweep re-renders only the composer band, not the whole tree,
   * at 30fps; App owns the rarely-changing tier/style and the leaf plays the
   * sweep exactly ONCE per pair change — an unchanged model+effort pair
   * (ordinary turns, image preparation, /animation toggles) never replays. */
  const [waveTier, setWaveTier] = useState<DeepseekWaveTier | null>(null)
  const [waveStyle, setWaveStyle] = useState<DeepseekWaveStyle | null>(null)
  const [rainbowBurstId, setRainbowBurstId] = useState(0)
  const fireRainbowBurst = (): void => {
    setRainbowBurstId(id => id + 1)
  }
  // /animation toggle: applies immediately, persists through the runner, and
  // gates every timed leaf (shimmer, chase, blink, wave) for this render.
  const [animations, setAnimations] = useState(props.animations ?? true)
  // dscode: a short ripple plays in the composer when /effort lands on ultra.
  const [ultraPulse, setUltraPulse] = useState(0)
  useEffect(() => {
    if (ultraPulse === 0) return
    const timer = setTimeout(() => setUltraPulse(0), 1100)
    return () => clearTimeout(timer)
  }, [ultraPulse])
  const applyAnimations = (enabled: boolean): void => {
    setAnimations(enabled)
    props.saveAnimations?.(enabled)
    notify(t('notice.animationState', { state: enabled ? 'on' : 'off' }))
  }
  const previousModel = useRef<string | undefined>(undefined)
  const previousEffort = useRef<string | undefined>(props.effort)
  const previousStyle = useRef<DeepseekWaveStyle | undefined>(undefined)
  useEffect(() => {
    const previous = previousModel.current
    previousModel.current = modelLabel
    // The wave replays when the applied model changes OR its effort level
    // changes (Codex replays the ignition on effort changes too). Official
    // DeepSeek routes run their flash/pro tiers; a NON-DeepSeek model
    // running a reasoning effort STRICTLY above high runs the "Into the
    // Unknown" variant — the deepseek tier's exact motion with a different
    // wordmark. Any other non-DeepSeek route stays static.
    const effortChanged = previousEffort.current !== effortLabel
    previousEffort.current = effortLabel
    const modelChanged = previous !== undefined && previous !== modelLabel
    const official = isOfficialDeepSeekLabel(modelLabel)
    const unknownTrigger = !official && effortAboveHigh(effortLabel)
    if (!official && !unknownTrigger) {
      setWaveTier(null)
      setWaveStyle(null)
      return
    }
    if (modelChanged || effortChanged) {
      setWaveTier(official ? deepseekWaveTier(modelLabel) : 'unknown')
      const nextStyle = deepseekWaveStyleRandom(previousStyle.current)
      previousStyle.current = nextStyle
      setWaveStyle(nextStyle)
    }
  }, [modelLabel, effortLabel])
  const [directory, setDirectory] = useState<ModelDirectory | undefined>(undefined)
  const [modelError, setModelError] = useState<string | undefined>(undefined)
  const [providerDirectory, setProviderDirectory] = useState<ProviderSettingsDirectory | undefined>(undefined)
  const [providerError, setProviderError] = useState<string | undefined>(undefined)
  const [authorizationDirectory, setAuthorizationDirectory] = useState<ProviderAuthorizationDirectory | undefined>(undefined)
  const [authorizationError, setAuthorizationError] = useState<string | undefined>(undefined)
  const [modelLoadEpoch, setModelLoadEpoch] = useState(0)
  const [notice, setNotice] = useState<{ text: string; tone: NoticeTone } | undefined>(undefined)
  const notify = useCallback((text: string, tone: NoticeTone = 'info'): void => {
    setNotice({ text, tone })
  }, [])

  // dscode: one registry read at startup, at most eight seconds, silent on any
  // failure; a newer release is announced through the notice with the /update hint.
  useEffect(() => {
    if (process.env.DSCODE_UPDATE_CHECK === 'off') return
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    fetch(DSCODE_REGISTRY_URL, { headers: { accept: 'application/vnd.npm.install-v1+json' }, signal: controller.signal })
      .then(response => (response.ok ? response.json() : undefined))
      .then(data => {
        const latest = data?.version
        if (typeof latest === 'string' && dscodeNewerVersion(latest, DSCODE_VERSION)) notify(t('update.available', { version: latest }), 'warning')
      })
      .catch(() => {})
      .finally(() => clearTimeout(timer))
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [])

  useEffect(() => {
    props.onBridgeReady({ notify })
  }, [])
  useEffect(() => {
    if (!modelOpen) return
    let cancelled = false
    setDirectory(undefined)
    setModelError(undefined)
    // Enter the promise chain before invoking the loader so a provider that
    // throws synchronously becomes an in-panel error instead of escaping the
    // React effect and tearing down Ink.
    Promise.resolve().then(() => props.loadModels()).then((loaded) => {
      if (!cancelled) setDirectory(loaded)
    }, (error: unknown) => {
      if (!cancelled) setModelError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      cancelled = true
    }
  }, [modelOpen, modelLoadEpoch, props.loadModels])
  useEffect(() => {
    if (!modelOpen || props.loadModelProviders === undefined) return
    let cancelled = false
    setProviderDirectory(undefined)
    setProviderError(undefined)
    Promise.resolve().then(() => props.loadModelProviders!()).then((loaded) => {
      if (!cancelled) setProviderDirectory(loaded)
    }, (error: unknown) => {
      if (!cancelled) setProviderError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      cancelled = true
    }
  }, [modelOpen, modelLoadEpoch, props.loadModelProviders])
  useEffect(() => {
    if (!modelOpen || props.loadProviderAuthorizations === undefined) return
    let cancelled = false
    setAuthorizationDirectory(undefined)
    setAuthorizationError(undefined)
    Promise.resolve().then(() => props.loadProviderAuthorizations!()).then((loaded) => {
      if (!cancelled) setAuthorizationDirectory(loaded)
    }, (error: unknown) => {
      if (!cancelled) setAuthorizationError(error instanceof Error ? error.message : String(error))
    })
    return () => {
      cancelled = true
    }
  }, [modelOpen, modelLoadEpoch, props.loadProviderAuthorizations])
  useEffect(() => {
    const subscribe = props.subscribeModelProviders
    if (!modelOpen || subscribe === undefined) return
    try {
      return subscribe(() => setModelLoadEpoch(epoch => epoch + 1))
    } catch (error: unknown) {
      setProviderError(error instanceof Error ? error.message : String(error))
    }
  }, [modelOpen, props.subscribeModelProviders])
  useEffect(() => {
    const subscribe = props.subscribeProviderAuthorizations
    if (!modelOpen || subscribe === undefined) return
    try {
      return subscribe(() => setModelLoadEpoch(epoch => epoch + 1))
    } catch (error: unknown) {
      setAuthorizationError(error instanceof Error ? error.message : String(error))
    }
  }, [modelOpen, props.subscribeProviderAuthorizations])

  const busy = view.busy
  // dscode: the verbose transcript toggle survives a restart.
  const [showReasoning, setShowReasoning] = useState(() => loadFlag('verbose'))
  // Dedupe for the dynamic-budget tripwire: one warning per distinct shape.
  const budgetWarnRef = useRef<string | undefined>(undefined)
  const [verboseOpen, setVerboseOpen] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  /**
   * How the composer delivers its next submission: `queue` waits for the next
   * turn, `steer` joins the turn already running. Tab on an empty composer
   * flips it; the prompt glyph and the placeholder both name the current mode.
   */
  const [submitMode, setSubmitMode] = useState<'queue' | 'steer'>('steer')
  const [diffView, setDiffView] = useState<GitDiffView | undefined>(undefined)
  const [reviewPickerOpen, setReviewPickerOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  const [modeOpen, setModeOpen] = useState(false)
  const [permissionOpen, setPermissionOpen] = useState(false)
  const [resumeOpen, setResumeOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  /** /search seed: the query from `/search <text>` (cleared on open). */
  const [searchSeed, setSearchSeed] = useState('')
  const [pluginOpen, setPluginOpen] = useState(false)
  const [pluginQuery, setPluginQuery] = useState('')
  const [updateOpen, setUpdateOpen] = useState(false)
  const [scheduleOpen, setScheduleOpen] = useState(false)
  const [jobsOpen, setJobsOpen] = useState(false)
  const [statuslineOpen, setStatuslineOpen] = useState(false)
  const [statuslineItems, setStatuslineItems] = useState<readonly StatusItemId[]>(() => parseStatuslineItems(props.statusline))
  const [themeOpen, setThemeOpen] = useState(false)
  const [languageOpen, setLanguageOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [agentsOpen, setAgentsOpen] = useState(false)
  const [subagentOpen, setSubagentOpen] = useState(false)
  const [todosOpen, setTodosOpen] = useState(false)
  const [usageOpen, setUsageOpen] = useState(false)
  /** /delete state: delete-mode hint plus an optional pre-armed row id. */
  const [resumeDelete, setResumeDelete] = useState<{ mode: boolean; id?: string }>({ mode: false })
  /** The row id awaiting y/n in the COMPOSER (codex delete confirm): the
   * composer takes the keys, the resume panel yields until it settles. */
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | undefined>(undefined)
  /** Bumped after a deletion so the /resume listing reloads immediately. */
  const [deleteReloadToken, setDeleteReloadToken] = useState(0)
  const requestDelete = useCallback((row: SessionRow): void => {
    setDeleteConfirmId(row.id)
  }, [])
  const cancelDelete = useCallback((): void => {
    setDeleteConfirmId(undefined)
  }, [])
  const confirmDelete = useCallback((): void => {
    const id = deleteConfirmId
    if (id === undefined) return
    setDeleteConfirmId(undefined)
    void props.deleteSession(id).then(outcome => {
      notify(outcome)
      // Keep the picker open and reload: a successful deletion must vanish
      // from the list immediately, not look like a no-op.
      setDeleteReloadToken(token => token + 1)
    }, (reason: unknown) => {
      notify(t('notice.deleteFailed', { message: reason instanceof Error ? reason.message : String(reason) }), 'error')
    })
  }, [deleteConfirmId, props.deleteSession, notify])
  /** The /history panel's accepted entry: text plus its recall-space index. */
  const [historyFill, setHistoryFill] = useState<{ text: string; index: number } | undefined>(undefined)
  /** Submissions recorded in this process (Codex local history; persistent file stays in the runner). */
  const [localHistory, setLocalHistory] = useState<readonly string[]>([])
  const recordLocal = useCallback((text: string): void => {
    setLocalHistory(current => recordLocalEntry(current, text))
  }, [])
  /** Newest-first recall space shared by the composer and the /history panel. */
  const recallSpace = useMemo(
    () => recallEntries(props.history, localHistory),
    [props.history, localHistory],
  )
  const historyConsumed = useCallback((): void => {
    setHistoryFill(undefined)
  }, [])
  /** The append-only flush boundary (see `settledEntryCount`): entries below
   * this index are final and ride the `<Static>` scrollback; everything at or
   * beyond stays in the live tree. */
  const settled = useMemo(() => settledEntryCount(view.entries), [view.entries])
  /** Next-turn rows in durable inbox order: a running tool row can split the
   * pending rows, so this maps the inbox id list onto the folded entries
   * instead of scanning the mutable tail. */
  const queuedRows = useMemo(
    () => queuedInboxRows(view.entries, view.pending['next-turn']),
    [view.entries, view.pending],
  )
  const [refreshEpoch, setRefreshEpoch] = useState(0)
  const subscribeApproval = useCallback((listener: () => void) => props.approval.subscribe(listener), [props.approval])
  const readApprovalSnapshot = useCallback(() => props.approval.getSnapshot(), [props.approval])
  const subscribeQuestions = useCallback((listener: () => void) => props.questions.subscribe(listener), [props.questions])
  const readQuestionSnapshot = useCallback(() => props.questions.getSnapshot(), [props.questions])
  const subscribeSubagents = useCallback((listener: () => void) => props.subagents.subscribe(listener), [props.subagents])
  const readAgentRows = useCallback(() => props.subagents.getSnapshot(), [props.subagents])
  const approvalSnapshot = useSyncExternalStore(subscribeApproval, readApprovalSnapshot)
  const questionSnapshot = useSyncExternalStore(subscribeQuestions, readQuestionSnapshot)
  const agentRows = useSyncExternalStore(subscribeSubagents, readAgentRows)
  const approvalPending = approvalSnapshot.pending !== undefined
  const questionPending = questionSnapshot.pending !== undefined
  // While any modal owns the keys, the prompt box passes everything through.
  // While a deletion waits for y/n, the composer takes the keys (the resume
  // panel yields): the confirm is typed IN the input box, not as an invisible
  // panel keypress.
  const inputActive = deleteConfirmId !== undefined
    ? !approvalPending && !questionPending
    : !emailOpen && !modelOpen && !helpOpen && !modeOpen && !permissionOpen && !resumeOpen && !pluginOpen && !updateOpen && !scheduleOpen && !jobsOpen && !statuslineOpen && !themeOpen && !languageOpen && !historyOpen && !queueOpen && !agentsOpen && !subagentOpen && !todosOpen && !usageOpen && !verboseOpen && diffView === undefined && !reviewPickerOpen && !approvalPending && !questionPending
  const transcriptVisible = !emailOpen && !modelOpen && !helpOpen && !modeOpen && !permissionOpen && !resumeOpen && !pluginOpen && !updateOpen && !scheduleOpen && !jobsOpen && !statuslineOpen && !themeOpen && !languageOpen && !historyOpen && !queueOpen && !agentsOpen && !subagentOpen && !todosOpen && !usageOpen && !verboseOpen && diffView === undefined && !reviewPickerOpen && !approvalPending && !questionPending

  // Human questions outrank local inspectors. Close the lower modal instead
  // of leaving an approval/question visible but keyboard-locked behind it.
  useEffect(() => {
    if (!approvalPending && !questionPending) return
    setEmailOpen(false)
    setModelOpen(false)
    setProviderOpen(false)
    setProviderAction(undefined)
    setEffortFor(undefined)
    setHelpOpen(false)
    setModeOpen(false)
    setPermissionOpen(false)
    setResumeOpen(false)
    setPluginOpen(false)
    setUpdateOpen(false)
    setScheduleOpen(false)
    setStatuslineOpen(false)
    setThemeOpen(false)
    setHistoryOpen(false)
    setQueueOpen(false)
    setAgentsOpen(false)
    setSubagentOpen(false)
    setTodosOpen(false)
    setDeleteConfirmId(undefined)
    setVerboseOpen(false)
    setDiffView(undefined)
  }, [approvalPending, questionPending])

  // Append-only transcript: everything up to the first still-mutable entry
  // (a running tool/retry/command) flushes through Ink's `<Static>` into native
  // scrollback and is normally never rewritten — the Claude-Code stability
  // contract that lets arbitrarily long conversations scroll instead of
  // freezing when the live tree exceeds the terminal height. The dynamic
  // region below stays small: the streaming tail, modals, composer, and its
  // status footer. Live stream frames preserve `entries` identity.
  //
  // `computeSettledRows` extends the cached row set incrementally: the
  // settled prefix is permanently final, so a grown boundary builds ONLY the
  // newly settled suffix and reuses every cached element — long histories
  // stop re-creating rows (and re-parsing MarkdownBody) on every durable
  // event. A source-backed replay (`refreshEpoch` bump: resize / Ctrl+L)
  // rebuilds the CURRENT row set from index 0,
  // so the replay stays complete and never ghosts a pending/running tail.
  // Hook order is unconditional. Its dimensions drive every live-region
  // budget before any dynamic rows are constructed.
  const appStdout = useStdout().stdout
  const [terminalSize, setTerminalSize] = useState(() => ({
    columns: appStdout?.columns ?? 80,
    rows: appStdout?.rows ?? 30,
  }))
  const terminalSizeRef = useRef(terminalSize)
  const settledRowsCache = useRef<SettledRowsCache | undefined>(undefined)
  const settledRows = useMemo(() => {
    const result = computeSettledRows(
      settledRowsCache.current,
      view.entries,
      settled,
      showReasoning,
      props.resumed,
      refreshEpoch,
      terminalSize.columns,
      SETTLED_ROW_CAP,
      { cwd: props.workspaceRoot ?? props.cwd, model: modelLabel, effort: effortLabel, animated: animations },
    )
    settledRowsCache.current = result.cache
    return result.cache.flat
  }, [view.entries, settled, showReasoning, props.resumed, refreshEpoch, terminalSize.columns])

  // One pending synchronized frame covers a debounced resize or explicit
  // source-backed replay. It is closed after the corresponding React commit.
  const synchronizedReplayPending = useRef(false)
  const resizeBurstHeld = useRef(false)
  useEffect(() => {
    if (appStdout === undefined) return
    let replayTimer: ReturnType<typeof setTimeout> | undefined
    const handleResize = (): void => {
      const next = {
        columns: appStdout.columns ?? 80,
        rows: appStdout.rows ?? 30,
      }
      if (next.columns === terminalSizeRef.current.columns && next.rows === terminalSizeRef.current.rows) return
      terminalSizeRef.current = next

      // Hold the visible frame for the whole burst so intermediate Ink
      // relayouts (new width against still-old Static rows) never flash as
      // doubled borders. One clear + Static remount still runs after the
      // burst settles.
      if (!resizeBurstHeld.current) {
        resizeBurstHeld.current = true
        appStdout.write(SYNCHRONIZED_UPDATE_BEGIN)
      }
      setTerminalSize(next)
      if (replayTimer !== undefined) clearTimeout(replayTimer)
      replayTimer = setTimeout(() => {
        synchronizedReplayPending.current = true
        appStdout.write(RESIZE_REFLOW_CLEAR)
        setRefreshEpoch(epoch => epoch + 1)
        resizeBurstHeld.current = false
      }, RESIZE_REFLOW_DELAY_MS)
    }
    appStdout.on('resize', handleResize)
    return () => {
      appStdout.off('resize', handleResize)
      if (replayTimer !== undefined) clearTimeout(replayTimer)
      if (resizeBurstHeld.current) {
        appStdout.write(SYNCHRONIZED_UPDATE_END)
        resizeBurstHeld.current = false
      }
    }
  }, [appStdout])
  const terminalRows = terminalSize.rows
  const terminalColumns = terminalSize.columns
  const composerGutterRows = layoutGutterRows(terminalRows)
  // The composer's live row count, reported one-way by the editor itself
  // (frozen modals report 1). This keeps the live/streaming budget exact as
  // a multiline draft grows, without lifting any editor state into the App.
  const [composerRows, setComposerRows] = useState(1)
  const handleEditorRows = useCallback((rows: number): void => {
    setComposerRows(current => (current === rows ? current : rows))
  }, [])
  // The open completion menu's exact row count, reported one-way by the
  // composer (0 when closed). The menu rides ABOVE the composer band, so its
  // height must come out of the live budget exactly like editor growth —
  // before this report the menu drew from an unnamed 5-row slack and a tall
  // menu during streaming pushed the dynamic tree past the terminal edge.
  const [menuRows, setMenuRows] = useState(0)
  const handleMenuRows = useCallback((rows: number): void => {
    setMenuRows(current => (current === rows ? current : rows))
  }, [])
  // The status footer's exact row count, reported one-way by StatusLine (the
  // second row renders only while it has content). The IME cursor anchor
  // counts every row between the composer caret and Ink's parked cursor: the
  // status footer plus Ink's own below-frame row. The gutter rows sit ABOVE
  // the composer and never enter this distance.
  const [statusBarRows, setStatusBarRows] = useState<1 | 2>(1)
  const handleStatusRows = useCallback((rows: 1 | 2): void => {
    setStatusBarRows(current => (current === rows ? current : rows))
  }, [])
  const imeRowsBelowComposer = statusBarRows + 1
  const composerEditorCap = composerMaxRows(terminalRows)
  // Pin the composer and status at the bottom: every extra chrome row
  // (completion menu, notice, todos, agents, extra editor/status rows)
  // covers live transcript instead of growing the tree.
  const dynamicRows = liveRegionBudget({
    terminalRows,
    composerRows,
    statusBarRows,
    menuRows,
    gutterRows: composerGutterRows,
    notice: notice !== undefined,
    // dscode: the activity line occupies the todo slot while a turn runs.
    todo: transcriptVisible && (view.todos.length > 0 || busy),
    agents: transcriptVisible && agentRows.length > 0,
  })
  const streamingActive = view.streaming !== '' || view.streamingReasoning !== ''
  const dscodeCompacting = view.dscodeCompactingSince > 0
  // The board takes five rows when the terminal can seat it, one otherwise; the
  // rows come out of the live region's budget.
  const dscodeCompactionRows = !dscodeCompacting ? 0 : dynamicRows >= 12 ? 5 : 1
  const deepDivingVisible = busy || dscodeCompacting
  // Terminal tab label: "deepseek" until the session carries a name, then the
  // session title; cleared on unmount so the host shell regains its default.
  const tabTitle = view.title === '' ? DEFAULT_TERMINAL_TITLE : view.title
  useTerminalTitle(tabTitle)
  const allLiveLines = useMemo(
    () => view.entries.slice(settled).flatMap(
      // Width shrinks with the real terminal (no 10-column floor: on a
      // narrower terminal the floor silently overflowed every row).
      entry => dscodeChatLines(entry, Math.max(1, terminalColumns - 2), showReasoning),
    ),
    [view.entries, settled, terminalColumns, showReasoning],
  )
  // Reserve the same stream slice from the moment a turn becomes busy. This
  // keeps the first thinking frame from changing the dynamic-tree geometry
  // underneath Ink's cursor ledger and avoids a start-of-thinking flash.
  const liveBudget = busy || streamingActive
    ? Math.max(1, Math.floor((dynamicRows - dscodeCompactionRows) / 3))
    : Math.max(0, dynamicRows - (deepDivingVisible ? Math.max(1, dscodeCompactionRows) : 0))
  const visibleLiveLines = liveBudget === 0 ? [] : allLiveLines.slice(-liveBudget)

  // The screen refresh used by /clear and Ctrl+L: a raw ANSI clear (wipe
  // screen AND scrollback, home the cursor) then a Static remount via the
  // key change, which re-flushes the current items from index 0. NEVER
  // console.clear() — it desyncs Ink's internal line ledger against the
  // flushed static rows and garbles every frame after.
  // dscode: the compaction panel draws over the tail, so the tail gives those rows back.
  const streamRows = Math.max(1, dynamicRows - dscodeCompactionRows - visibleLiveLines.length)
  const reasoningRows = view.streamingReasoning === ''
    ? 0
    : view.streaming === ''
      ? streamRows
      : streamRows <= 1
        ? 0
        : showReasoning
          ? Math.max(1, Math.floor(streamRows / 3))
          : 1
  const answerRows = view.streaming === '' ? 0 : Math.max(1, streamRows - reasoningRows)
  // Dynamic-height tripwire: the allocation must fit dynamicRows by
  // construction; a future edit that breaks the derivation clamps here
  // (answer, then reasoning, then settled live rows) and warns once.
  const liveAudit = clampLiveAllocation(
    { live: visibleLiveLines.length, reasoning: reasoningRows, answer: answerRows },
    Math.max(0, dynamicRows - dscodeCompactionRows),
  )
  if (liveAudit.warning !== undefined && budgetWarnRef.current !== liveAudit.warning) {
    budgetWarnRef.current = liveAudit.warning
    // The budget tripwire is a last-resort diagnostic: it fires only when the
    // live/static allocation already broke its contract, and Ink owns/shadows
    // console output. Everywhere else the TUI must never write to stdout.
    // eslint-disable-next-line no-console -- see the tripwire note above
    console.warn(`[dsh-code] ${liveAudit.warning}`)
  }
  const auditedLiveLines = liveAudit.allocation.live === visibleLiveLines.length
    ? visibleLiveLines
    : visibleLiveLines.slice(-liveAudit.allocation.live)
  const auditedReasoningRows = liveAudit.allocation.reasoning
  const auditedAnswerRows = liveAudit.allocation.answer
  const inspectorVisible = verboseOpen && !approvalPending && !questionPending
  const modalVisible = emailOpen || modelOpen || helpOpen && modeOpen || permissionOpen || resumeOpen || pluginOpen || updateOpen || scheduleOpen || jobsOpen || statuslineOpen || themeOpen || languageOpen || historyOpen || queueOpen || agentsOpen || subagentOpen || todosOpen || usageOpen || inspectorVisible || diffView !== undefined || reviewPickerOpen || approvalPending || questionPending
  // The surface that currently owns the keyboard, named in the frozen band:
  // an empty composer under a panel must not advertise typing it cannot
  // accept — every key actually feeds the panel (which may or may not
  // filter with it), so the honest hint names the owner and the way out.
  const keyboardOwner = approvalPending
    ? 'the approval prompt'
    : questionPending
      ? 'the question'
      : diffView !== undefined
        ? 'the diff review'
        : reviewPickerOpen
          ? 'the review picker'
        : modelOpen
          ? '/model'
          : helpOpen
            ? '/help'
            : modeOpen
              ? '/mode'
              : permissionOpen
                ? '/permission'
                : resumeOpen
                  ? '/resume'
                  : pluginOpen
                    ? '/plugin'
                    : updateOpen
                      ? '/update'
                      : scheduleOpen
                        ? '/schedule'
                        : jobsOpen
                          ? '/jobs'
                        : statuslineOpen
                          ? '/statusline'
                          : themeOpen
                            ? '/theme'
                            : languageOpen
                              ? '/language'
                            : historyOpen
                              ? '/history'
                              : agentsOpen
                                ? '/agents'
                                : subagentOpen
                                  ? '/subagent'
                                  : todosOpen
                                    ? '/todos'
                                    : usageOpen
                                      ? '/usage'
                                      : inspectorVisible
                                        ? 'history details'
                                        : undefined
  const frozenHint = keyboardOwner === undefined
    ? undefined
    : `keys go to ${keyboardOwner} · esc ${approvalPending ? 'rejects' : questionPending ? 'cancels' : 'closes'}`
  const closeInspector = useCallback((): void => {
    setVerboseOpen(false)
  }, [])
  const refreshScreen = (): void => {
    // Same source-backed clear the resize path uses: reset the scroll region
    // (`\x1b[r`) before wiping screen AND scrollback, then home the cursor.
    // A bare `\x1b[2J\x1b[3J\x1b[H` leaves a previously set scroll region in
    // place, so Ink's next repaint positions against stale bounds — the
    // stale-position flicker where the screen keeps redrawing.
    if (appStdout !== undefined) {
      synchronizedReplayPending.current = true
      appStdout.write(SYNCHRONIZED_UPDATE_BEGIN + RESIZE_REFLOW_CLEAR)
    }
    setRefreshEpoch(epoch => epoch + 1)
  }
  const applyRainbow = (seed?: number): void => {
    // Replace the memoized roll, then setTheme so getPalette() and the
    // painters pick the new values; persist rainbow as the active theme
    // so a mid-session /rainbow from dark/light actually sticks. The
    // source-backed rebuild (same as /theme) repaints Static history too.
    rerollRainbow(seed)
    setTheme('rainbow')
    props.saveTheme?.('rainbow')
    notify(t('notice.rainbowRolled', { seed: rainbowSeedLabel() }))
    fireRainbowBurst()
    refreshScreen()
  }
  useEffect(() => {
    if (!synchronizedReplayPending.current || appStdout === undefined) return
    synchronizedReplayPending.current = false
    appStdout.write(SYNCHRONIZED_UPDATE_END)
  }, [appStdout, refreshEpoch])
  // An idle Ctrl+R fold toggle joins resize and explicit Ctrl+L as a deliberate
  // source-backed rebuild of native scrollback.

  // Rendered-history cap: when the settled window overflows the trim
  // hysteresis, one source-backed replay re-windows it (the rebuild branch
  // drops the oldest entries beyond the cap). Deferred while busy or
  // streaming so the clear never interrupts a visible stream; the flag
  // survives until the turn calms.
  const settledNeedsTrim = settledRowsCache.current?.needsTrim === true
  useEffect(() => {
    if (!settledNeedsTrim || busy || streamingActive) return
    refreshScreen()
  }, [settledNeedsTrim, busy, streamingActive])

  const sessionHasImages = useMemo(() => view.entries.some(entry =>
    (entry.kind === 'user' || entry.kind === 'pending') && (entry.images?.length ?? 0) > 0), [view.entries])

  /** Apply one /model pick: record the selection, close the panel, report via notice. */
  // dscode: a /model pick that would compact the current context asks first.
  const dscodeRequestModel = (row: ModelRow, effortId: string | undefined): void => {
    if (props.dscodeCompactionPreview === undefined || modelLabel === row.provider + '/' + row.model) { applyModel(row, effortId); return }
    Promise.resolve().then(() => props.dscodeCompactionPreview!(row)).then(preview => {
      if (preview?.compacts !== true) { applyModel(row, effortId); return }
      setEffortFor(undefined)
      setProviderOpen(false)
      setProviderAction({ kind: 'dscode-compaction', row, effortId, preview })
      setModelOpen(true)
    }, () => applyModel(row, effortId))
  }

  const applyModel = (row: ModelRow, effortId: string | undefined): void => {
    try {
      const label = props.selectModel(row, effortId)
      setModelLabel(label)
      setEffortLabel(effortId)
      setUltraPulse(effortId === 'ultra' && animations ? Date.now() : 0)
      const selected = `${label}${effortId === undefined || effortId === '' ? '' : `@${effortId}`}`
      if (sessionHasImages && row.inputModalities !== undefined && !row.inputModalities.includes('image')) {
        notify(t('notice.modelChangedPlaceholder', { model: selected }), 'warning')
      } else {
        notify(t('notice.modelNextStep', { model: selected }))
      }
      setModelOpen(false)
      setProviderOpen(false)
      setProviderAction(undefined)
      setEffortFor(undefined)
    } catch (error: unknown) {
      notify(t('notice.modelSwitchFailed', { message: error instanceof Error ? error.message : String(error) }), 'error')
    }
  }

  // dscode: a switch declares the route, asks for a missing key (then resumes),
  // and lands on the counterpart model.
  const dscodeSwitchProvider = (provider: string): void => {
    const spec = dscodeProviderSpec(provider)
    if (props.loadModelProviders === undefined) { notify(t('notice.providerUnavailable'), 'warning'); return }
    Promise.resolve().then(async () => {
      if (props.dscodeEnsureProviderRoute !== undefined && await props.dscodeEnsureProviderRoute(provider)) reloadModelSurfaces()
      const providers = await props.loadModelProviders!()
      const state = dscodeCredentialState(providers.rows.find(row => row.provider === provider))
      if (state === 'unavailable') { notify(spec.name + t('notice.providerUnavailableSuffix'), 'error'); return }
      if (state === 'missing') {
        setProviderOpen(false)
        setEffortFor(undefined)
        setProviderAction({ kind: 'dscode-key', provider, then: () => dscodeSwitchProvider(provider) })
        setModelOpen(true)
        return
      }
      if (state === 'error' || state === 'readonly') notify(t('notice.providerUnverified', { provider, name: spec.name }), 'warning')
      const models = await dscodeWaitForModels(props.loadModels, provider)
      const pick = dscodePickModel(models.rows, provider, modelLabel, effortLabel)
      if (pick === undefined) { notify(spec.name + t('notice.providerNoModels'), 'error'); return }
      dscodeRequestModel(pick.row, pick.effort)
    }).catch((error: unknown) => notify(t('notice.providerSwitchFailed', { error: error instanceof Error ? error.message : String(error) }), 'error'))
  }

  const reloadModelSurfaces = (): void => {
    setModelLoadEpoch(epoch => epoch + 1)
  }
  const closeModelSurface = (): void => {
    setModelOpen(false)
    setProviderOpen(false)
    setProviderAction(undefined)
    setEffortFor(undefined)
  }
  // Declarable effort donors: settings declarations first (verbatim, dialect
  // spellings preserved), then catalog-advertised levels as identity maps -
  // a newly added model copies a known family's mapping in one keystroke.
  const effortDonors = useMemo(() => {
    const donors: EffortDonor[] = []
    const seen = new Set<string>()
    for (const row of providerDirectory?.rows ?? []) {
      for (const model of row.configuration.models) {
        const raw = (model.extras)?.reasoningEfforts
        if (!isDeclaredReasoningEfforts(raw)) continue
        const key = row.provider + '/' + model.id
        if (seen.has(key)) continue
        seen.add(key)
        donors.push({ provider: row.provider, id: model.id, efforts: raw })
      }
    }
    for (const row of directory?.rows ?? []) {
      const levels = row.reasoning?.efforts.map(effort => effort.id) ?? []
      if (levels.filter(level => level !== 'off').length === 0) continue
      const key = row.provider + '/' + row.model
      if (seen.has(key)) continue
      seen.add(key)
      const efforts: Record<string, string | null> = {}
      for (const level of levels) efforts[level] = level === 'off' ? null : level
      donors.push({ provider: row.provider, id: row.model, efforts })
    }
    return donors
  }, [providerDirectory, directory])
  let modelSurface: ReactElement | undefined
  if (modelOpen && !approvalPending && !questionPending) {
    if (providerAction?.kind === 'dscode-compaction') {
      modelSurface = createElement(DscodeCompactionConfirmPanel, {
        preview: providerAction.preview,
        confirm: () => applyModel(providerAction.row, providerAction.effortId),
        back: () => setProviderAction(undefined),
      })
    } else if (providerAction?.kind === 'dscode-openrouter') {
      modelSurface = createElement(DscodeOpenRouterPanel, {
        load: () => props.dscodeLoadOpenRouterAccount === undefined
          ? Promise.reject(new Error(t('notice.accountUnavailable')))
          : props.dscodeLoadOpenRouterAccount(),
        setManagement: () => setProviderAction({ kind: 'dscode-management-key', then: () => setProviderAction({ kind: 'dscode-openrouter' }) }),
        back: closeModelSurface,
      })
    } else if (providerAction?.kind === 'dscode-management-key') {
      modelSurface = createElement(DscodeManagementKeyPanel, {
        optional: providerAction.optional === true,
        status: props.dscodeManagementKeyStatus,
        save: (key: string) => props.dscodeSaveManagementKey === undefined
          ? Promise.reject(new Error(t('notice.credentialsUnavailable')))
          : props.dscodeSaveManagementKey(key),
        done: (saved: boolean) => {
          if (saved) notify(t('notice.managementKeySaved'))
          const then = providerAction.then
          if (then !== undefined) then()
          else closeModelSurface()
        },
        back: () => {
          const then = providerAction.then
          if (then !== undefined) then()
          else closeModelSurface()
        },
      })
    } else if (providerAction?.kind === 'dscode-provider') {
      modelSurface = createElement(DscodeProviderPanel, {
        current: dscodeProviderOfLabel(modelLabel),
        load: props.loadModelProviders!,
        choose: dscodeSwitchProvider,
        back: closeModelSurface,
      })
    } else if (providerAction?.kind === 'dscode-key') {
      modelSurface = createElement(DscodeLoginPanel, {
        provider: providerAction.provider,
        load: async () => {
          await props.dscodeEnsureProviderRoute?.(providerAction.provider)
          return props.loadModelProviders!()
        },
        save: props.saveModelProviderCredential!,
        done: () => {
          const then = providerAction.then
          const provider = providerAction.provider
          reloadModelSurfaces()
          const finish = (): void => {
            closeModelSurface()
            if (then !== undefined) then()
            else notify(dscodeProviderSpec(provider).name + t('notice.keySaved'), 'info')
          }
          // Saving the OpenRouter key offers the optional management key first.
          if (provider === 'openrouter' && props.dscodeSaveManagementKey !== undefined) {
            setProviderAction({ kind: 'dscode-management-key', optional: true, then: finish })
            return
          }
          finish()
        },
        back: closeModelSurface,
      })
    } else if (providerAction?.kind === 'login'
      && props.beginProviderAuthorization !== undefined
      && props.cancelProviderAuthorization !== undefined
      && props.openAuthorizationUrl !== undefined
      && props.copyTextValue !== undefined) {
      modelSurface = createElement(ProviderAuthorizationPanel, {
        row: providerAction.authorization,
        begin: props.beginProviderAuthorization,
        cancel: () => props.cancelProviderAuthorization!(providerAction.authorization),
        openUrl: props.openAuthorizationUrl,
        copy: props.copyTextValue,
        done: () => {
          const authorization = providerAction.authorization
          setProviderAction(undefined)
          setProviderOpen(false)
          reloadModelSurfaces()
          notify(t('notice.loggedIn', { provider: authorization.label }))
        },
        back: () => {
          setProviderAction(undefined)
          setProviderOpen(true)
        },
      })
    } else if (providerAction?.kind === 'logout' && props.logoutProviderAuthorization !== undefined) {
      modelSurface = createElement(ProviderAuthorizationLogoutPanel, {
        row: providerAction.authorization,
        confirm: props.logoutProviderAuthorization,
        done: () => {
          const authorization = providerAction.authorization
          setProviderAction(undefined)
          setProviderOpen(true)
          reloadModelSurfaces()
          notify(t('notice.loggedOut', { provider: authorization.label }))
        },
        back: () => setProviderAction(undefined),
      })
    } else if (providerAction?.kind === 'configure' && props.saveModelProviderConfiguration !== undefined) {
      modelSurface = createElement(ProviderSetupPanel, {
        target: providerAction.target,
        effortDonors,
        save: props.saveModelProviderConfiguration,
        saveCredential: props.saveModelProviderCredential,
        discover: props.discoverModelProvider
          ?? (() => Promise.reject(new Error('model discovery is unavailable in this profile; enter models by hand'))),
        done: result => {
          const target = providerAction.target
          setProviderAction(undefined)
          setProviderOpen(true)
          reloadModelSurfaces()
          notify(t('notice.providerSaved', { provider: target.displayName, suffix: result.key ? ' · API key updated' : '' }))
        },
        back: () => setProviderAction(undefined),
        onExit: closeModelSurface,
      })
    } else if (providerAction?.kind === 'unset' && props.unsetModelProviderCredential !== undefined) {
      modelSurface = createElement(ProviderConfirmPanel, {
        target: providerAction.target,
        kind: 'credential',
        confirm: props.unsetModelProviderCredential,
        done: () => {
          const target = providerAction.target
          setProviderAction(undefined)
          setProviderOpen(true)
          reloadModelSurfaces()
          notify(t('notice.apiKeyRemoved', { provider: target.displayName }))
        },
        back: () => setProviderAction(undefined),
      })
    } else if (providerAction?.kind === 'remove' && props.removeModelProvider !== undefined) {
      modelSurface = createElement(ProviderConfirmPanel, {
        target: providerAction.target,
        kind: 'provider',
        confirm: props.removeModelProvider,
        done: () => {
          const target = providerAction.target
          setProviderAction(undefined)
          setProviderOpen(true)
          reloadModelSurfaces()
          notify(t('notice.providerRemoved', { provider: target.displayName }))
        },
        back: () => setProviderAction(undefined),
      })
    } else if (providerOpen) {
      modelSurface = createElement(ProviderPanel, {
        directory: providerDirectory,
        error: providerError,
        authorizations: authorizationDirectory,
        authorizationError,
        onConfigure: (target: ProviderTargetView) => {
          if (props.saveModelProviderConfiguration === undefined) {
            notify(t('notice.providerUnavailable'), 'warning')
            return
          }
          setProviderAction({ kind: 'configure', target })
        },
        onUnset: (target: ProviderTargetView) => {
          if (props.unsetModelProviderCredential === undefined) {
            notify(t('notice.apiKeyUnavailable'), 'warning')
            return
          }
          setProviderAction({ kind: 'unset', target })
        },
        onRemove: (target: ProviderTargetView) => {
          if (props.removeModelProvider === undefined) {
            notify(t('notice.providerRemovalUnavailable'), 'warning')
            return
          }
          setProviderAction({ kind: 'remove', target })
        },
        onLogin: (target: ProviderTargetView, authorization: ProviderAuthorizationRow) => {
          if (busy) {
            notify(t('notice.loginIdleOnly'), 'warning')
            return
          }
          if (props.beginProviderAuthorization === undefined
            || props.cancelProviderAuthorization === undefined
            || props.openAuthorizationUrl === undefined
            || props.copyTextValue === undefined) {
            notify(t('notice.loginUnavailable'), 'warning')
            return
          }
          setProviderAction({ kind: 'login', target, authorization })
        },
        onLogout: (target: ProviderTargetView, authorization: ProviderAuthorizationRow) => {
          if (props.logoutProviderAuthorization === undefined) {
            notify(t('notice.logoutUnavailable'), 'warning')
            return
          }
          setProviderAction({ kind: 'logout', target, authorization })
        },
        onRetry: reloadModelSurfaces,
        onBack: () => setProviderOpen(false),
        onExit: closeModelSurface,
      })
    } else if (effortFor !== undefined) {
      modelSurface = createElement(DscodeEffortPanel, {
        // Keyed per row: switching models remounts the stage so its cursor
        // initializes on the new model's effective effort.
        key: `${effortFor.provider}/${effortFor.model}`,
        row: effortFor,
        current: effortLabel,
        animations,
        select: (effortId: string) => dscodeRequestModel(effortFor, effortId),
        back: closeModelSurface,
        onExit: closeModelSurface,
      })
    } else {
      modelSurface = createElement(ModelPanel, {
        directory,
        error: modelError,
        current: modelLabel,
        onSelect: (row: ModelRow) => {
          // A model advertising several levels opens the effort stage first;
          // one advertised level is its only option, while no capability uses
          // the model default exactly as before.
          if (row.reasoning !== undefined && row.reasoning.efforts.length > 1) {
            setEffortFor(row)
            return
          }
          const effortId = row.reasoning?.efforts.length === 1 ? row.reasoning.efforts[0].id : undefined
          dscodeRequestModel(row, effortId)
        },
        ...(props.loadModelProviders === undefined || props.saveModelProviderConfiguration === undefined
          ? {}
          : { onProviders: () => setProviderOpen(true) }),
        onRetry: reloadModelSurfaces,
        onClose: closeModelSurface,
      })
    }
  }

  return createElement(
    Box,
    { flexDirection: 'column' },
    createElement(MemoStaticTranscript, {
      key: refreshEpoch,
      items: settledRows,
    }),
    emailOpen && !approvalPending && !questionPending
      ? createElement(DscodeEmailPanel, {
        gmail,
        imap,
        columns: terminalColumns,
        rows: Math.max(3, terminalRows - 8 - composerGutterRows - composerRows),
        close: () => setEmailOpen(false),
        pick: mail => {
          props.steer(dscodeEmailPrompt(mail), [], props.sessionKey)
          setEmailOpen(false)
        },
      })
      : undefined,
    transcriptVisible
      ? createElement(
        Box,
        // No container padding: every live row carries its own two-column
        // prefix, so streaming text lands exactly where the composer's input
        // text and the settled reply both render (Codex LIVE_PREFIX).
        { flexDirection: 'column' },
        auditedLiveLines.length === 0 ? undefined : createElement(StyledRows, { lines: auditedLiveLines }),
        view.streamingReasoning !== '' && auditedReasoningRows > 0
          ? showReasoning
            ? createElement(StreamTail, {
              text: view.streamingReasoning,
              prefix: '✻ ',
              continuationPrefix: '  ',
              dim: true,
              maxRows: auditedReasoningRows,
            })
            // The collapsed marker shimmers only while reasoning streams
            // alone: once answer text flows, a periodically re-rendered
            // animation component would race the store's frame-throttled
            // notifications and could defer the answer paint by tens to
            // hundreds of milliseconds (stream-burst contract), so the
            // marker falls back to the static dim row — same as Deep diving
            // always yields the live region to streaming content.
            : view.streaming === ''
              ? createElement(ShimmerLine, { text: '✻ ' + t('activity.working'), animated: animations })
              : createElement(StreamTail, {
                text: t('activity.working'),
                prefix: '✻ ',
                continuationPrefix: '  ',
                dim: true,
                maxRows: auditedReasoningRows,
              })
          : undefined,
        view.streaming !== '' && auditedAnswerRows > 0
          ? createElement(
            StreamTail,
            // The same two-column gutter as settled replies: streamed text
            // lands exactly where the assembled message will render.
            { text: view.streaming, dim: false, maxRows: auditedAnswerRows, prefix: '  ' },
            busy ? createElement(Caret, { animated: animations }) : undefined,
          )
          : undefined,
      )
      : undefined,
    transcriptVisible && dscodeCompacting
      ? createElement(DscodeCompactionLine, { since: view.dscodeCompactingSince, rows: dscodeCompactionRows, animated: animations })
      : transcriptVisible && busy
        ? createElement(DscodeActivityLine, { entries: view.entries, streaming: view.streaming !== '', since: view.busySince, animated: animations })
      : transcriptVisible ? createElement(TodoPanel, { todos: view.todos }) : undefined,
    transcriptVisible ? createElement(AgentsLine, { rows: agentRows, total: props.subagents.getTotalSeen() }) : undefined,
    usageOpen && !approvalPending && !questionPending
      ? createElement(UsagePanel, {
        key: props.sessionKey,
        load: props.loadUsage,
        close: () => setUsageOpen(false),
      })
      : undefined,
    todosOpen && !approvalPending && !questionPending
      ? createElement(MemoTodoListPanel, {
        todos: view.todos,
        onClose: () => {
          setTodosOpen(false)
        },
      })
      : undefined,
    queueOpen && !approvalPending && !questionPending
      ? createElement(QueuePanel, {
        rows: queuedRows,
        busy,
        update: props.updateQueued,
        onClose: () => setQueueOpen(false),
      })
      : undefined,
    createElement(QuestionBar, { store: props.questions, snapshot: questionSnapshot, locked: false }),
    createElement(ApprovalBar, { snapshot: approvalSnapshot, locked: questionPending, notify, interrupt: props.interrupt, summarize: questionPending }),
    effortFor !== undefined ? undefined : modelSurface,
    helpOpen && !approvalPending && !questionPending
      ? createElement(HelpPanel, {
        descriptors,
        skills,
        commandError: props.commands.error,
        skillError: props.skills.error,
        onClose: () => {
          setHelpOpen(false)
        },
      })
      : undefined,
    diffView !== undefined && !approvalPending && !questionPending
      ? createElement(DiffPanel, {
        view: diffView,
        onClose: () => setDiffView(undefined),
      })
      : undefined,
    reviewPickerOpen && !approvalPending && !questionPending && props.listReviewBranches !== undefined && props.listReviewCommits !== undefined
      ? createElement(ReviewPickerPanel, {
        loadBranches: props.listReviewBranches,
        loadCommits: props.listReviewCommits,
        choose: argument => {
          setReviewPickerOpen(false)
          props.reviewChanges(argument)
        },
        close: () => setReviewPickerOpen(false),
      })
      : undefined,
    verboseOpen && !approvalPending && !questionPending
      ? createElement(MemoVerbosePanel, {
        entries: view.entries,
        onClose: closeInspector,
      })
      : undefined,
    modeOpen && !approvalPending && !questionPending
      ? createElement(ModePanel, {
        current: props.mode,
        load: props.loadPresets,
        select: (id: string) => {
          void props.switchMode(id).then(label => {
            notify(t('notice.modeChangedSimple', { value: label }))
            setModeOpen(false)
          }, (reason: unknown) => notify(t('notice.modeSwitchFailed', { message: reason instanceof Error ? reason.message : String(reason) }), 'error'))
        },
        close: () => setModeOpen(false),
      })
      : undefined,
    permissionOpen && !approvalPending && !questionPending
      ? createElement(PermissionPanel, {
        current: props.permission,
        load: props.loadPermissions,
        select: (id: string) => {
          try {
            const selected = props.setPermission(id)
            notify(t('notice.permissionChangedSimple', { value: selected }))
            setPermissionOpen(false)
          } catch (reason: unknown) {
            notify(`permission change failed: ${reason instanceof Error ? reason.message : String(reason)}`, 'error')
          }
        },
        close: () => setPermissionOpen(false),
      })
      : undefined,
    resumeOpen && !approvalPending && !questionPending
      ? createElement(ResumePanel, {
        currentCwd: props.workspaceRoot,
        load: props.loadSessions,
        readTranscript: props.loadSessionTranscript,
        requestDelete,
        deleteConfirmId,
        reloadToken: deleteReloadToken,
        deleteMode: resumeDelete.mode,
        select: (row: SessionRow) => { props.switchSession(row); setResumeOpen(false) },
        close: () => setResumeOpen(false),
      })
      : undefined,
    searchOpen && !approvalPending && !questionPending && props.searchSessions !== undefined
      ? createElement(SearchPanel, {
        load: props.searchSessions,
        initialQuery: searchSeed,
        select: (row: SearchRow) => {
          setSearchOpen(false)
          props.switchSession({
            id: row.id,
            createdAt: row.updatedAt,
            updatedAt: row.updatedAt,
            cwd: '',
            workspace: '',
            subagent: row.subagent,
            resumable: row.resumable,
            live: false,
            persisted: true,
            preset: '',
          })
        },
        close: () => setSearchOpen(false),
      })
      : undefined,
    pluginOpen && !approvalPending && !questionPending
      ? createElement(PluginPanel, { load: props.loadPlugins, initialQuery: pluginQuery, close: () => setPluginOpen(false) })
      : undefined,
    updateOpen && !approvalPending && !questionPending
      ? createElement(UpdatePanel, {
        probe: props.probeUpdate,
        apply: props.applyUpdate,
        notify: (text: string, tone?: NoticeTone) => notify(text, tone),
        close: () => setUpdateOpen(false),
      })
      : undefined,
    scheduleOpen && !approvalPending && !questionPending
      ? createElement(SchedulePanel, { rows: () => view.schedules, close: () => setScheduleOpen(false) })
      : undefined,
    jobsOpen && !approvalPending && !questionPending
      ? createElement(JobsPanel, { load: props.loadJobs, close: () => setJobsOpen(false) })
      : undefined,
    statuslineOpen && !approvalPending && !questionPending
      ? createElement(StatuslinePanel, {
        enabled: statuslineItems,
        change: items => {
          setStatuslineItems(items)
          props.saveStatusline(items)
        },
        close: () => setStatuslineOpen(false),
      })
      : undefined,
    themeOpen && !approvalPending && !questionPending
      ? createElement(ThemePanel, {
        current: getTheme(),
        select: (name: ThemeName) => {
          // Apply immediately (module-level palette), persist through the
          // runner, then close: the close re-render paints with the new
          // palette. `auto` stores as requested; detection is a later step.
          setTheme(name)
          props.saveTheme?.(name)
          // Rainbow prints its roll seed so a lucky launch can be reproduced
          // with RAINBOW_SEED=<seed>.
          notify(name === 'rainbow'
            ? t('notice.themeRainbow', { seed: rainbowSeedLabel() })
            : t('notice.themeSaved', { name }))
          setThemeOpen(false)
          // The header whale and settled history live in the Static region,
          // which renders once and would keep the old palette's colors; the
          // same source-backed rebuild resize and Ctrl+L use repaints the
          // whole screen (scrollback included) from the new palette.
          if (name === 'rainbow') fireRainbowBurst()
          refreshScreen()
        },
        close: () => setThemeOpen(false),
      })
      : undefined,
    languageOpen && !approvalPending && !questionPending
      ? createElement(LanguagePanel, {
        current: getLanguage(),
        select: (name: LanguageName) => {
          props.saveLanguage(name)
          notify(t('notice.languageSaved', { name }))
          setLanguageOpen(false)
          // The Static region renders once; the same source-backed rebuild
          // the theme switch uses repaints translated text everywhere.
          refreshScreen()
        },
        close: () => setLanguageOpen(false),
      })
      : undefined,
    historyOpen && !approvalPending && !questionPending
      ? createElement(HistoryPanel, {
        entries: recallSpace,
        fill: (text: string, index: number) => {
          setHistoryFill({ text, index })
          setHistoryOpen(false)
        },
        close: () => setHistoryOpen(false),
      })
      : undefined,
    agentsOpen && !approvalPending && !questionPending
      ? createElement(AgentsPanel, {
        live: agentRows,
        load: props.loadSubagents,
        readTranscript: props.loadSessionTranscript,
        close: () => setAgentsOpen(false),
      })
      : undefined,
    subagentOpen && !approvalPending && !questionPending
      ? createElement(SubagentPanel, {
        current: props.subagentModel,
        load: props.loadModels,
        pick: (row: ModelRow, effortId?: string) => {
          try {
            // The runner's label already carries the effort suffix
            // (`provider/model@effort`), so no second append here.
            const label = props.setSubagentModel(row, effortId)
            notify(t('notice.subagentsChanged', { value: label }))
            setSubagentOpen(false)
          } catch (reason: unknown) {
            notify(t('notice.subagentChangeFailed', { message: reason instanceof Error ? reason.message : String(reason) }), 'error')
          }
        },
        inherit: () => {
          props.clearSubagentModel()
          notify(t('notice.subagentsInherited'))
          setSubagentOpen(false)
        },
        close: () => setSubagentOpen(false),
      })
      : undefined,
    notice === undefined
      ? undefined
      : createElement(NoticeLine, {
        text: notice.text,
        tone: notice.tone,
        columns: terminalColumns,
      }),
    // Persistent bottom chrome: every interface owns exactly the same
    // composer/status geometry. Panels may change above it, but can no longer
    // reorder the status or introduce mode-specific vertical margins.
    createElement(
      Box,
      { flexDirection: 'column', marginTop: composerGutterRows },
      createElement(Input, {
        effortSurface: modelOpen && effortFor !== undefined ? modelSurface : undefined,
        ultraPulse,
        active: inputActive,
        frozen: modalVisible,
        frozenHint,
        busy,
        descriptors,
        skills,
        dispatch: props.dispatch,
        steer: props.steer,
        submitMode,
        cycleSubmitMode: () => {
          const next = submitMode === 'queue' ? 'steer' : 'queue'
          setSubmitMode(next)
          notify(t(next === 'steer' ? 'notice.submitMode.steer' : 'notice.submitMode.queue'))
        },
        applyEditorKeys: props.applyEditorKeys,
        interrupt: props.interrupt,
        quit: props.quit,
        openEmail: () => setEmailOpen(true),
        openLogin: (provider?: string) => {
          setProviderOpen(false)
          setEffortFor(undefined)
          setProviderAction({ kind: 'dscode-key', provider: provider ?? dscodeProviderOfLabel(modelLabel) })
          setModelOpen(true)
        },
        openOpenRouter: () => {
          setProviderOpen(false)
          setEffortFor(undefined)
          setProviderAction({ kind: 'dscode-openrouter' })
          setModelOpen(true)
        },
        openProvider: (provider?: string) => {
          if (provider !== undefined) { dscodeSwitchProvider(provider); return }
          setProviderOpen(false)
          setEffortFor(undefined)
          setProviderAction({ kind: 'dscode-provider' })
          setModelOpen(true)
        },
        openModel: () => {
          setDirectory(undefined)
          setModelError(undefined)
          setProviderDirectory(undefined)
          setProviderError(undefined)
          setAuthorizationDirectory(undefined)
          setAuthorizationError(undefined)
          setProviderOpen(false)
          setProviderAction(undefined)
          setEffortFor(undefined)
          setModelOpen(true)
        },
        openEffort: () => {
          // /effort adjusts the CURRENT model's reasoning: resolve it from
          // the live catalog, then open the same effort stage the /model
          // picker would. Match on the applied label (what the status bar
          // shows) — `props.model` may still carry the deployment default
          // until the next request header lands. The model-id fallback
          // prefers a reasoning-capable row (several routes may serve the
          // same id), and a capability-lookup failure reads as "retry",
          // never as "the model has no efforts" — the adapter advertises
          // levels for every deepseek model, so "no efforts" is almost
          // always a failed resolveModelInfo, not a fact.
          void props.loadModels().then((loaded) => {
            const [provider, model] = modelLabel.split('/')
            const row = loaded.rows.find(candidate => candidate.provider === provider && candidate.model === model)
              ?? loaded.rows.find(candidate => candidate.model === model && candidate.reasoning !== undefined)
              ?? loaded.rows.find(candidate => candidate.model === model)
            if (row === undefined) {
              notify(t('notice.modelMissing'), 'warning')
              return
            }
            const rowTag = `${row.provider}/${row.model}`
            if (loaded.reasoningFailures?.includes(rowTag) === true) {
              notify(t('notice.effortUnavailable'), 'warning')
              return
            }
            if (row.reasoning === undefined || row.reasoning.efforts.length === 0) {
              // A model that advertises no levels still opens the stage: the
              // panel itself carries the empty state (the web effort pane's
              // "no levels" copy), instead of a bare notice that reads like
              // a failure.
              setEffortFor(row)
              setModelOpen(true)
              return
            }
            setEffortFor(row)
            setModelOpen(true)
          }, (error: unknown) => {
            notify(`model lookup failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
          })
        },
        openHelp: () => {
          setHelpOpen(true)
        },
        openMode: () => setModeOpen(true),
        openPermission: () => setPermissionOpen(true),
        openResume: () => { setResumeDelete({ mode: false }); setResumeOpen(true) },
        openSearch: (query: string) => {
          if (props.searchSessions === undefined) {
            notify(t('notice.sessionSearchUnavailable'), 'warning')
            return
          }
          setSearchSeed(query)
          setSearchOpen(true)
        },
        openPlugin: (query = '') => { setPluginQuery(query); setPluginOpen(true) },
        openUpdate: () => setUpdateOpen(true),
        openSchedule: () => setScheduleOpen(true),
        openJobs: () => setJobsOpen(true),
        openStatusline: () => setStatuslineOpen(true),
        openTheme: () => setThemeOpen(true),
        openLanguage: () => setLanguageOpen(true),
        saveLanguage: props.saveLanguage,
        openHistory: () => setHistoryOpen(true),
        openQueue: () => setQueueOpen(true),
        openAgents: () => setAgentsOpen(true),
        openSubagent: () => setSubagentOpen(true),
        openTodos: () => setTodosOpen(true),
        openUsage: () => setUsageOpen(true),
        openDelete: (id?: string) => {
          const armed = id === undefined || id === '' ? undefined : id
          setResumeDelete({ mode: true, ...armed === undefined ? {} : { id: armed } })
          setDeleteConfirmId(armed)
          setResumeOpen(true)
        },
        openDiff: (argument: string) => {
          void props.loadGitDiff(argument).then(setDiffView, (error: unknown) => {
            notify(`diff failed: ${error instanceof Error ? error.message : String(error)}`, 'error')
          })
        },
        reviewChanges: props.reviewChanges,
        openReviewPicker: () => setReviewPickerOpen(true),
        deleteConfirm: deleteConfirmId,
        confirmDelete,
        cancelDelete,
        createSession: props.createSession,
        forkSession: props.forkSession,
        cancelSessionSwitch: props.cancelSessionSwitch,
        notify,
        hasNotice: notice !== undefined,
        dismissNotice: () => {
          setNotice(undefined)
        },
        openVerbose: () => {
          setVerboseOpen(true)
        },
        clearView: () => {
          props.store.reset()
        },
        refresh: refreshScreen,
        // Ctrl+R flips the reasoning fold. Rows already emitted through
        // Static are native scrollback, so the fold state of past entries can
        // only change through the source-backed replay (one clear + rebuild,
        // wrapped in a synchronized frame). Every toggle replays globally and
        // immediately — including mid-turn — so the whole transcript stays at
        // one fold state; the resize path already proves replaying during a
        // stream is safe.
        toggleReasoning: () => {
          const next = !showReasoning
          setShowReasoning(next)
          saveFlag('verbose', next)
          refreshScreen()
        },
        loadMentions: props.loadMentions,
        readClipboardImage,
        inspectImages: props.inspectImages,
        prepareImages: props.prepareImages,
        inspectFiles: props.inspectFiles,
        prepareFiles: props.prepareFiles,
        sessionKey: props.sessionKey,
        cycleMode: props.cycleMode,
        exportTranscript: props.exportTranscript,
        renameTitle: props.renameTitle,
        copyLastResponse: props.copyLastResponse,
        recallSpace,
        recordLocal,
        recordHistory: props.recordHistory,
        queued: queuedRows,
        updateQueued: props.updateQueued,
        historyFill,
        historyConsumed,
        animations,
        applyAnimations,
        applyRainbow,
        rainbowBurstId,
        waveTier,
        waveStyle,
        maxRows: composerEditorCap,
        anchorRowsBelow: imeRowsBelowComposer,
        tabTitle,
        onEditorRows: handleEditorRows,
        onMenuRows: handleMenuRows,
      }),
      createElement(StatusLine, {
        facts: {
          fullSessionId: props.sessionKey,
          model: modelLabel,
          effort: effortLabel,
          mode: props.mode,
          cwd: props.cwd,
          branch: props.branch,
          sessionId: props.sessionId,
          title: view.title,
          plan: view.plan || props.pendingPlan === true,
          permission: view.permission !== '' ? view.permission : props.permission,
          sandbox: view.sandbox,
          goal: view.goal === undefined ? undefined : { phase: view.goal.phase, rounds: view.goal.rounds, max: view.goal.max },
        },
        stats: view.stats,
        busy,
        animated: animations,
        columns: terminalColumns,
        items: statuslineItems,
        onRows: handleStatusRows,
      }),
    ),
  )
}
