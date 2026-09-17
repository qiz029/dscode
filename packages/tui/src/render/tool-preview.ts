/**
 * Bounded preview line for a tool invocation's raw JSON arguments: the first
 * human-meaningful string among the well-known keys (command, path, query, …)
 * with a fallback to the bounded raw JSON. Shared by the tool card in the
 * transcript and the approval bar's command preview. Arguments longer than
 * {@link MAX_PARSE_CHARS} are never parsed: the preview is a display concern,
 * and a synchronous `JSON.parse` plus string copies of an unbounded model
 * payload must not run on the approval or projection paths.
 *
 * @module @deepseek-ai/dsh-code/render/tool-preview
 */

/** Keys searched in declaration order when building a preview. */
const PREVIEW_KEYS = ['command', 'cmd', 'description', 'path', 'pattern', 'query'] as const

/**
 * Raw arguments longer than this are skipped without parsing and fall back
 * to the bounded raw preview. Well above any realistic command/path/query
 * string while keeping the synchronous parse cost negligible.
 */
const MAX_PARSE_CHARS = 4096

/** Bounded raw-arguments fallback shared by the skip-parse and parse-failure paths. */
function boundedRawPreview(args: string): string {
  return args.length > 80 ? `${args.slice(0, 77)}...` : args
}

/**
 * Resolve one bounded preview for raw tool arguments.
 * @param args - raw JSON arguments string as the model produced it.
 * @param toolName - the tool the arguments belong to (fallback label).
 * @returns the preview line; empty when nothing useful resolves.
 */
export function toolArgumentsPreview(args: string, toolName: string): string {
  if (args === '') return toolName
  if (args.length > MAX_PARSE_CHARS) return boundedRawPreview(args)
  try {
    const parsed: unknown = JSON.parse(args)
    if (parsed !== null && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>
      for (const key of PREVIEW_KEYS) {
        const value = record[key]
        if (typeof value === 'string' && value !== '') return value
      }
    }
  } catch {
    // Raw JSON parse failed: fall through to the bounded raw arguments.
  }
  return boundedRawPreview(args)
}

/** Visible budget for one delegation prompt row on the tool card. */
const MAX_PROMPT_CHARS = 160

/**
 * Bounded prompt preview for delegation-style tools (`subagent`): the
 * `prompt` argument rendered as the card's second row, so the transcript
 * shows what the child agent was asked — not just its description label —
 * while it runs (Codex's SpawnAgent card preview). Anything else returns ''.
 * @param toolName - the tool the arguments belong to.
 * @param args - raw JSON arguments string as the model produced it.
 * @returns the one-line prompt preview, or '' when none applies.
 */
export function toolPromptPreview(toolName: string, args: string): string {
  if (toolName !== 'subagent' || args === '' || args.length > MAX_PARSE_CHARS) return ''
  try {
    const parsed: unknown = JSON.parse(args)
    if (parsed === null || typeof parsed !== 'object') return ''
    const prompt = (parsed as Record<string, unknown>)['prompt']
    if (typeof prompt !== 'string' || prompt === '') return ''
    const flat = prompt.replace(/\s+/gu, ' ').trim()
    return flat.length > MAX_PROMPT_CHARS ? `${flat.slice(0, MAX_PROMPT_CHARS - 1)}…` : flat
  } catch {
    // Malformed arguments degrade to no prompt row, never a thrown parse.
    return ''
  }
}
