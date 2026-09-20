/**
 * Workspace @mention support: file and directory candidates from the
 * `fileReferences` service (dsh-file-reference-local), session candidates
 * from the opt-in `sessionReferenceResolver` service, and submission
 * preparation through its `prepare()` API. Picked session mentions land as
 * canonical `@[label](dsh-session:…)` tokens; on submit the text is parsed
 * back into readable `@label` text plus structured references, snapshots are
 * injected via `agent.inject()` before the readable message wakes the driver
 * (`followup`, which queues the next turn whether or not one is running) —
 * exactly the upstream README's wiring. Steering the current turn is a
 * deliberate user action through the `/queue` panel, never an implicit
 * consequence of submitting while busy.
 *
 * File discovery lives entirely in the Harness service (per-agent bounded
 * index, `@dir/` listing, symlink guards, tool/result invalidation); this
 * module only maps candidates to menu rows and never re-implements scanning.
 * The service is agent-scoped (the agent supplies the session cwd and the
 * cache key), so before the first session creates an agent the SAME official
 * search class runs against the launch cwd — @ file completion works on a
 * bare launch, model- and session-independent, and the agent-scoped service
 * takes over once a session exists.
 *
 * @module @deepseek-ai/dsh-code/mentions
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { UserMessage } from '@deepseek-ai/dsh-session'
import { isAbsolute, resolve } from 'node:path'
import {
  DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES,
  DEFAULT_FILE_SEARCH_MAX_ENTRIES,
  DEFAULT_FILE_SEARCH_MAX_RESULTS,
  WorkspaceFileSearch,
} from '@deepseek-ai/dsh-file-reference-local'
import {
  formatSessionReferenceMention,
  parseSessionReferenceText,
  type SessionReferenceCandidate,
  type SessionReferenceInput,
} from '@deepseek-ai/dsh-session-reference'

/** Parsed submission text: readable text plus structured references. */
type ParsedSessionReferenceText = ReturnType<typeof parseSessionReferenceText>

/** One merged menu candidate (files and sessions, already ranked). */
export interface MentionCandidate {
  /** Text inserted after the `@` (directories carry a trailing slash). */
  label: string
  /** Human-readable origin shown beside the label. */
  description: string
  /** Origin kind for icon/coloring decisions. */
  kind: 'file' | 'directory' | 'session'
  /** Absolute path for file candidates; never rendered or persisted directly. */
  path?: string
}

/** Prepared submission: readable content plus optional injected context. */
export interface PreparedMention {
  /** Readable text with mention tokens normalized to `@label`. */
  text: string
  /** Structured source sessions in appearance order (empty when none). */
  references: SessionReferenceInput[]
  /** Aggregated snapshot for `agent.inject()`, undefined without references. */
  additionalContext?: UserMessage
}

/** One path candidate the `ctx.fileReferences` service returns. */
interface ServiceFileCandidate {
  readonly path: string
  readonly kind: 'file' | 'directory'
}

/** The `ctx.fileReferences` service face (dsh-file-reference-local). */
interface FileReferenceServiceLike {
  list(agent: Agent, query: string, signal: AbortSignal): Promise<readonly ServiceFileCandidate[]>
}

/** Menu cap on file rows; the service owns ranking and default rows. */
const MAX_FILE_ROWS = 20

/** Whether a mention token is already navigating a filesystem path. */
export function isPathLikeMentionQuery(query: string): boolean {
  return /[\\/]/u.test(query)
}

/** The mention API the input editor and the runner share. */
export interface MentionsApi {
  /** Ranked menu candidates for the typed `@` query. */
  candidates: (query: string, signal?: AbortSignal) => Promise<readonly MentionCandidate[]>
  /** Parse submission text into readable text plus structured references. */
  parse(text: string): ParsedSessionReferenceText
  /**
   * Snapshot references and build the injected context. Throws the service's
   * typed error on failure — the caller restores the draft and notifies.
   */
  prepare(parsed: ParsedSessionReferenceText, signal?: AbortSignal): Promise<PreparedMention>
  /** Canonical mention token for a picked session candidate. */
  sessionMention(candidate: SessionReferenceCandidate): string
}

/**
 * Create the mention API for one agent's workspace. A missing
 * `fileReferences` service (with an agent present) or `sessionReferenceResolver`
 * degrades that half to empty rows; `prepare` passes text through untouched
 * without references. An undefined agent (a bare launch before any session
 * exists) runs the official WorkspaceFileSearch over the launch cwd — the
 * same class the mounted service uses per agent — so `@` file completion
 * works from the first keystroke; session references wait for the session.
 *
 * `candidates` never reaches for `this` — the runner hands it to the input
 * editor as a detached callback, and a `this`-bound method would throw on
 * every `@` key.
 * @param ctx - context carrying the optional `fileReferences` and
 * `sessionReferenceResolver` services.
 * @param agent - the session owner; excluded from its own session candidates.
 * @param cwd - launch working directory; bounds the pre-session search.
 */
export function createMentions(ctx: Context, agent: Agent | undefined, cwd: string): MentionsApi {
  const resolver = ctx.get('sessionReferenceResolver')
  const fileReferences = (ctx as unknown as { get(name: string): unknown }).get('fileReferences') as
    | FileReferenceServiceLike
    | undefined
  const sessionCapable = agent !== undefined && resolver !== undefined
  // Pre-session fallback: one lazily built search over the launch cwd with
  // the official defaults — pure in-memory index, no handles to release.
  // The mounted service invalidates its per-agent index after every tool
  // result; nothing drives that for this bare instance, so a time window
  // refreshes it instead — without it, files created or deleted before the
  // first session never appear in (or never leave) the fuzzy @ menu.
  const PRE_SESSION_INDEX_TTL_MS = 30_000
  let preSessionSearch: WorkspaceFileSearch | undefined
  let preSessionIndexedAt = 0
  const preSessionFiles = (query: string, signal?: AbortSignal): Promise<readonly ServiceFileCandidate[]> => {
    if (preSessionSearch === undefined || Date.now() - preSessionIndexedAt > PRE_SESSION_INDEX_TTL_MS) {
      preSessionSearch?.invalidate()
      preSessionSearch = new WorkspaceFileSearch(cwd, {
        maxResults: DEFAULT_FILE_SEARCH_MAX_RESULTS,
        maxEntries: DEFAULT_FILE_SEARCH_MAX_ENTRIES,
        excludedDirectories: [...DEFAULT_FILE_SEARCH_EXCLUDED_DIRECTORIES],
      })
      preSessionIndexedAt = Date.now()
    }
    return preSessionSearch.list(query, signal ?? new AbortController().signal)
  }

  return {
    async candidates(query: string, signal?: AbortSignal): Promise<readonly MentionCandidate[]> {
      const needle = query.trim()
      // A failed discovery half is remembered, never masked: when NOTHING came
      // back the rejection tells the menu "search unavailable" instead of a
      // silent empty list that reads as "no matches". A half that still
      // returned rows shows them — partial results beat an error wall.
      let fileFailure: unknown
      let sessionFailure: unknown
      const [files, sessions] = await Promise.all([
        agent !== undefined && fileReferences !== undefined
          ? fileReferences
            .list(agent, needle, signal ?? new AbortController().signal)
            .catch((error: unknown) => {
              fileFailure = error
              return [] as readonly ServiceFileCandidate[]
            })
          : agent === undefined
            ? preSessionFiles(needle, signal).catch((error: unknown) => {
              fileFailure = error
              return [] as readonly ServiceFileCandidate[]
            })
            : Promise.resolve([] as readonly ServiceFileCandidate[]),
        sessionCapable && needle !== '' && !isPathLikeMentionQuery(needle) && agent !== undefined
          ? resolver.listCandidates(agent, needle, 10, signal).catch((error: unknown) => {
            sessionFailure = error
            return [] as readonly SessionReferenceCandidate[]
          })
          : Promise.resolve([] as readonly SessionReferenceCandidate[]),
      ])
      // The service owns ranking (and the bare-@ default rows); the menu caps
      // file rows and always places sessions after files — `@` is a file
      // mention first (Codex's semantics), session references second.
      const fileRows: MentionCandidate[] = files.slice(0, MAX_FILE_ROWS).map(candidate => ({
        label: candidate.path,
        description: candidate.kind === 'directory' ? 'Folder' : 'File',
        kind: candidate.kind,
        ...candidate.kind === 'file'
          ? { path: isAbsolute(candidate.path) ? candidate.path : resolve(cwd, candidate.path) }
          : {},
      }))
      const sessionRows: MentionCandidate[] = sessions.map((candidate): MentionCandidate => ({
        label: formatSessionReferenceMention(candidate),
        description: `Session · ${candidate.cwd ?? '(no cwd)'}`,
        kind: 'session',
      }))
      const rows = [...fileRows, ...sessionRows]
      if (rows.length === 0 && (fileFailure !== undefined || sessionFailure !== undefined)) {
        throw fileFailure instanceof Error
          ? fileFailure
          : sessionFailure instanceof Error
            ? sessionFailure
            : new Error(String(fileFailure ?? sessionFailure))
      }
      return rows
    },
    parse(text: string): ParsedSessionReferenceText {
      return parseSessionReferenceText(text)
    },
    async prepare(parsed: ParsedSessionReferenceText, signal?: AbortSignal): Promise<PreparedMention> {
      if (parsed.references.length === 0 || resolver === undefined || agent === undefined) {
        return { text: parsed.text, references: parsed.references }
      }
      const prepared = await resolver.prepare(
        agent,
        [{ type: 'text', text: parsed.text }],
        parsed.references,
        signal,
      )
      return {
        text: prepared.content.filter(block => block.type === 'text').map(block => block.text).join(''),
        references: parsed.references,
        additionalContext: prepared.additionalContext,
      }
    },
    sessionMention(candidate: SessionReferenceCandidate): string {
      return formatSessionReferenceMention({ sessionId: candidate.sessionId, label: candidate.label })
    },
  }
}
