/**
 * Read-only Git inspection used by /diff and /review. Every diff
 * invocation carries --no-ext-diff and --no-textconv, so configured
 * external diff drivers and text converters can never execute as a
 * side effect of reading a diff.
 */

import { execFile } from 'node:child_process'
import { t } from './i18n.ts'

export interface GitDiffSpec {
  readonly label: string
  readonly args: readonly string[]
}

/** One file section from a unified diff, retained in source order. */
export interface GitDiffFile {
  readonly path: string
  readonly lines: readonly string[]
}

/** A parsed diff ready for a file-oriented terminal viewport. */
export interface GitDiffView {
  readonly title: string
  readonly files: readonly GitDiffFile[]
}

/** Split Git's stable `diff --git` framing without interpreting patch content. */
export function parseGitDiffFiles(text: string): readonly GitDiffFile[] {
  if (text === '') return []
  const chunks = text.split(/(?=^diff --git )/mu).filter(chunk => chunk !== '')
  return chunks.map((chunk, index) => {
    const lines = chunk.replace(/\n$/u, '').split('\n')
    const plus = lines.find(line => line.startsWith('+++ b/'))
    const minus = lines.find(line => line.startsWith('--- a/'))
    const header = /^diff --git a\/(.+) b\/(.+)$/u.exec(lines[0] ?? '')
    const path = plus?.slice(6) || minus?.slice(6) || header?.[2] || header?.[1] || `file ${index + 1}`
    return { path, lines }
  })
}

/** Parse the intentionally small, option-safe /diff argument vocabulary. */
export function parseGitDiffSpec(argument: string): GitDiffSpec {
  const value = argument.trim()
  if (value === '') return { label: 'working tree vs HEAD', args: ['diff', '--no-ext-diff', '--no-textconv', '--unified=3', 'HEAD', '--'] }
  if (value === '--staged' || value === '--cached') {
    return { label: 'staged changes', args: ['diff', '--no-ext-diff', '--no-textconv', '--unified=3', '--cached', '--'] }
  }
  if (value.startsWith('-') || /\s/u.test(value)) throw new Error('usage: /diff [--staged|git-ref]')
  return { label: `changes since ${value}`, args: ['diff', '--no-ext-diff', '--no-textconv', '--unified=3', value, '--'] }
}

function executeGit(cwd: string, args: readonly string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', [...args], { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, windowsHide: true, signal }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(stderr.trim() || error.message))
        return
      }
      resolve(stdout.replace(/\r\n/gu, '\n'))
    })
  })
}

/** Arguments for the unstaged-only fallback below. */
const UNSTAGED_DIFF_ARGS = ['diff', '--no-ext-diff', '--no-textconv', '--unified=3', '--'] as const

/** Whether the repository has at least one commit (a HEAD revision). */
function hasHeadRevision(cwd: string, signal?: AbortSignal): Promise<boolean> {
  return executeGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], signal)
    .then(() => true)
    .catch(() => false)
}

/**
 * Load one complete textual diff without invoking external programs.
 * @param signal - aborted by the caller on session switches/quit, killing the
 * git subprocess instead of letting a stale repository's diff land later.
 */
export async function loadGitDiff(cwd: string, argument: string, signal?: AbortSignal): Promise<GitDiffView> {
  const spec = parseGitDiffSpec(argument)
  try {
    const text = await executeGit(cwd, spec.args, signal)
    return { title: `git diff - ${spec.label}`, files: parseGitDiffFiles(text) }
  } catch (error: unknown) {
    // Only a repository without commits (no HEAD to diff against) may
    // narrow the default form to the unstaged fallback. Every other
    // failure — output past the buffer limit, a corrupt index, a missing
    // repository, or the caller aborting between the two calls — must
    // surface, not silently shrink what /diff and /review end up seeing
    // (an aborted probe would otherwise masquerade as an unborn repo).
    if (argument.trim() !== '' || signal?.aborted === true || (await hasHeadRevision(cwd, signal))) throw error
    const text = await executeGit(cwd, UNSTAGED_DIFF_ARGS, signal)
    return { title: 'git diff - working tree (no commits yet)', files: parseGitDiffFiles(text) }
  }
}

/** One /review run's selection: what to review plus an optional user note. */
export type ReviewSelection =
  | { readonly kind: 'uncommitted' }
  | { readonly kind: 'base-branch'; readonly branch: string; readonly mergeBase?: string }
  | { readonly kind: 'commit'; readonly sha: string }
  | { readonly kind: 'custom'; readonly instructions: string }

/**
 * The /review argument is always a free-form note applied to the uncommitted
 * working tree (`/review 使用中文` reviews the uncommitted diff in Chinese);
 * branch and commit targets come from the candidate picker, never from
 * argument guessing.
 */
export function parseReviewArgument(argument: string): ReviewSelection {
  const value = argument.trim()
  if (value === '') return { kind: 'uncommitted' }
  if (value.startsWith('-')) throw new Error('usage: /review [note]')
  if (value.length > 4000) throw new Error('review note is too long')
  return { kind: 'custom', instructions: value }
}

/** The merge base of HEAD and one branch, or undefined when git cannot compute one. */
export function mergeBaseWith(cwd: string, branch: string, signal?: AbortSignal): Promise<string | undefined> {
  return executeGit(cwd, ['merge-base', 'HEAD', branch, '--'], signal)
    .then(output => output.trim() === '' ? undefined : output.trim())
    .catch(() => undefined)
}

/** One commit's own patch (parent..commit), falling back to `git show` for root commits. */
export async function loadCommitDiff(cwd: string, sha: string, signal?: AbortSignal): Promise<GitDiffView> {
  const args = ['diff', '--no-ext-diff', '--no-textconv', '--unified=3', `${sha}~1`, sha, '--']
  try {
    const text = await executeGit(cwd, args, signal)
    return { title: `git diff - commit ${sha.slice(0, 7)}`, files: parseGitDiffFiles(text) }
  } catch (error: unknown) {
    // A root commit has no parent to diff against; show its full patch.
    if (signal?.aborted === true) throw error
    const text = await executeGit(cwd, ['show', '--format=', '--no-ext-diff', '--no-textconv', '--unified=3', sha, '--'], signal)
    return { title: `git diff - commit ${sha.slice(0, 7)}`, files: parseGitDiffFiles(text) }
  }
}

/**
 * Build the in-session review prompt: the diff is pasted whole (truncated at
 * the character cap with an explicit marker the model can see), the rubric's
 * essentials ride along — P0-P3 priorities, file/line anchors, only defects
 * this change introduced — and an optional user note (language, focus)
 * prefixes everything as the user's explicit instruction.
 */
export function buildReviewPrompt(diff: string, label: string, note?: string, maxChars = 200_000): string {
  const truncated = diff.length > maxChars
  const body = truncated ? diff.slice(0, maxChars) : diff
  return [
    'Review the following Git changes. Do not modify files or run write operations.',
    'Lead with concrete bugs, regressions, security risks, and missing tests, ordered by severity.',
    'Tag every finding [P0]-[P3] (P0 drop everything · P1 urgent · P2 normal · P3 nice to have) and anchor it to file paths with line ranges from the diff; only report defects this change introduced, and prefer reporting nothing over speculation.',
    `Scope: ${label}${truncated ? ' (diff truncated by CLI — later files are not visible)' : ''}`,
    ...(note === undefined || note.trim() === '' ? [] : [`User note: ${note.trim()}`]),
    '',
    '```diff',
    body,
    '```',
  ].join('\n')
}

/** One branch candidate for the review picker. */
export interface ReviewBranch {
  readonly name: string
}

/** One commit candidate for the review picker. */
export interface ReviewCommit {
  readonly sha: string
  readonly title: string
  /** Committer timestamp in Unix epoch milliseconds. */
  readonly at: number
}

/**
 * Local branch names for the review picker, newest activity first and with
 * the current branch excluded (reviewing against it is always empty).
 */
export async function listReviewBranches(cwd: string, signal?: AbortSignal): Promise<readonly ReviewBranch[]> {
  const text = await executeGit(cwd, ['branch', '--sort=-committerdate', '--format=%(HEAD)%(refname:short)'], signal)
  return text.split('\n')
    .map(line => line.trim())
    .filter(line => line !== '' && !line.startsWith('*'))
    .map(name => ({ name }))
}

/** Recent commits on the current branch for the review picker. */
export async function listReviewCommits(cwd: string, signal?: AbortSignal, limit = 30): Promise<readonly ReviewCommit[]> {
  const text = await executeGit(cwd, ['log', `-n${limit}`, '--format=%H%x09%s%x09%ct'], signal)
  const commits: ReviewCommit[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    const [sha, title, seconds] = line.split('\t')
    if (sha === undefined || title === undefined) continue
    commits.push({ sha, title, at: Number(seconds ?? 0) * 1000 })
  }
  return commits
}


/** One finished review, ready for the terminal's result panel. */
export interface ReviewResultView {
  /** Panel header naming what was reviewed. */
  readonly title: string
  /** The reviewer's reply markdown (the findings list). */
  readonly body: string
  /** Compact summary: finding counts per priority plus the verdict. */
  readonly summary: string
  /** The review session id, so follow-ups can @-reference its context. */
  readonly sessionId: string
}

/** One parsed review finding from the reviewer's closing JSON block. */
export interface ReviewFinding {
  /** Priority 0-3 for P0-P3; undefined when the reviewer omitted it. */
  readonly priority?: number
  /** Finding title, already free of the [P#] prefix when present. */
  readonly title: string
  /** File path the finding anchors to, when stated. */
  readonly path?: string
  /** Line range as written, when stated. */
  readonly range?: string
}

/** The parsed conclusion of one review reply. */
export interface ReviewConclusion {
  readonly findings: readonly ReviewFinding[]
  readonly overall?: 'correct' | 'incorrect'
  readonly explanation?: string
}

/** Extract the first balanced {...} substring (the Codex fallback parse). */
function firstJsonObject(text: string): string | undefined {
  const start = text.indexOf('{')
  if (start < 0) return undefined
  let depth = 0
  let insideString = false
  let escaped = false
  for (let at = start; at < text.length; at += 1) {
    const ch = text[at]
    if (escaped) {
      escaped = false
      continue
    }
    if (ch === '\\') {
      if (insideString) escaped = true
      continue
    }
    if (ch === '"') insideString = !insideString
    if (insideString) continue
    if (ch === '{') depth += 1
    if (ch === '}') {
      depth -= 1
      if (depth === 0) return text.slice(start, at + 1)
    }
  }
  return undefined
}

function coercePriority(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isInteger(value)) return undefined
  return value >= 0 && value <= 3 ? value : undefined
}

/**
 * Parse the reviewer's reply into a conclusion: whole-text JSON first, then
 * the first balanced JSON object anywhere in the text, then undefined (the
 * reply renders as plain markdown with no summary line). Malformed fields
 * are dropped, never thrown.
 */
export function parseReviewConclusion(text: string): ReviewConclusion | undefined {
  const candidates = [text.trim(), firstJsonObject(text)]
  for (const candidate of candidates) {
    if (candidate === undefined || !candidate.startsWith('{')) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(candidate)
    } catch {
      continue
    }
    if (typeof parsed !== 'object' || parsed === null) continue
    const record = parsed as Record<string, unknown>
    const findings: ReviewFinding[] = []
    if (Array.isArray(record['findings'])) {
      for (const item of record['findings']) {
        if (typeof item !== 'object' || item === null) continue
        const finding = item as Record<string, unknown>
        const title = typeof finding['title'] === 'string' ? finding['title'].replace(/^\s*\[P[0-3]\]\s*/u, '').trim() : ''
        if (title === '') continue
        findings.push({
          priority: coercePriority(finding['priority']),
          title,
          ...(typeof finding['path'] === 'string' && finding['path'] !== '' ? { path: finding['path'] } : {}),
          ...(typeof finding['range'] === 'string' && finding['range'] !== '' ? { range: finding['range'] } : {}),
        })
      }
    }
    const overall = record['overall'] === 'incorrect' ? 'incorrect' as const : record['overall'] === 'correct' ? 'correct' as const : undefined
    return {
      findings,
      ...(overall === undefined ? {} : { overall }),
      ...(typeof record['explanation'] === 'string' && record['explanation'].trim() !== '' ? { explanation: record['explanation'].trim() } : {}),
    }
  }
  return undefined
}

/**
 * One compact summary line for a finished review: finding counts per
 * priority plus the overall verdict, or a no-findings phrasing.
 */
export function reviewSummaryLine(conclusion: ReviewConclusion): string {
  const counts = [0, 0, 0, 0]
  let untagged = 0
  for (const finding of conclusion.findings) {
    if (finding.priority === undefined) untagged += 1
    else counts[finding.priority] += 1
  }
  const total = conclusion.findings.length
  const parts: string[] = []
  for (let level = 0; level <= 3; level += 1) {
    if (counts[level] > 0) parts.push(`P${level}×${counts[level]}`)
  }
  if (untagged > 0) parts.push(t('review.summary.untagged', { n: untagged }))
  const verdict = conclusion.overall === 'incorrect'
    ? t('review.summary.incorrect')
    : conclusion.overall === 'correct'
      ? (total === 0 ? t('review.summary.correctClean') : t('review.summary.correct'))
      : undefined
  if (total === 0) {
    return verdict === undefined ? t('review.summary.noConclusion') : t('review.summary.zero', { verdict })
  }
  const params = { count: total, parts: parts.join(' ') }
  return verdict === undefined ? t('review.summary.count', params) : t('review.summary.countVerdict', { ...params, verdict })
}
