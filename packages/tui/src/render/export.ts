/**
 * Markdown export of one transcript view: the /export command's pure
 * formatter. Deterministic and side-effect free — the runner owns the file
 * write, so tests drive the builder with folded views directly.
 *
 * @module @deepseek-ai/dsh-code/render/export
 */

import { assertNever } from '@deepseek-ai/dsh-util-values'
import { fileLabels, imageLabels, type TranscriptView } from './projection.ts'
import { t } from '../i18n.ts'

/**
 * Render the transcript as a standalone markdown document.
 * @param view - the folded transcript view to export.
 * @param sessionId - the full session identity for the header.
 * @returns the complete markdown text.
 */
/** Both user and queued rows export the same attachment label block. */
const attachmentLabels = (entry: { images?: readonly unknown[]; files?: readonly unknown[] }): string =>
  [imageLabels(entry.images as never), fileLabels(entry.files as never)].filter(label => label !== '').join('\n')

export function buildExportMarkdown(view: TranscriptView, sessionId: string): string {
  const out: string[] = [
    view.title === ''
      ? `# dsh session ${sessionId}`
      : `# ${view.title}`,
    `> session ${sessionId}`,
    '',
  ]
  // The effective system prompt (v3 surface nodes) heads the export in a
  // collapsed block: visible when audited, out of the way when scrolled.
  if (view.systemPrompt !== '') {
    out.push('<details><summary>system prompt</summary>', '', view.systemPrompt, '', '</details>', '')
  }
  for (const entry of view.entries) {
    switch (entry.kind) {
      case 'user':
        if (entry.notice) {
          out.push(`> ⤷ context: ${entry.text}`, '')
        } else {
          const attachments = attachmentLabels(entry)
          // How the prompt was delivered is part of the record: a queued or
          // steered message reads differently from one typed into an idle
          // composer. Ordinary prompts keep the bare heading.
          const marker = entry.delivery === undefined ? '' : ` (${t(entry.delivery === 'queued' ? 'entry.delivery.queued' : 'entry.delivery.steered')})`
          out.push(`## user${marker}`, '', entry.text, ...(attachments === '' ? [] : [attachments]), '')
        }
        break
      case 'assistant':
        if (entry.reasoning !== '') {
          out.push('<details><summary>thinking</summary>', '', entry.reasoning, '', '</details>', '')
        }
        out.push('## assistant', '', entry.text, '')
        break
      case 'tool':
        out.push(`### tool \`${entry.name}\``, '')
        if (entry.preview !== '') out.push(`- args: ${entry.preview}`)
        if (entry.subs.length > 0) {
          for (const sub of entry.subs) {
            const label = sub.preview === '' ? sub.name : `${sub.name} ${sub.preview}`
            out.push(`- dispatch: ${sub.state === 'error' ? 'error' : sub.state === 'running' ? 'running' : 'ok'} · ${label}${sub.summary === '' ? '' : ` · ${sub.summary}`}`)
          }
          if (entry.subsDropped > 0) out.push(`- dispatch: … ${entry.subsDropped} earlier dispatch${entry.subsDropped === 1 ? '' : 'es'}`)
        }
        if (entry.summary !== '') out.push(`- ${entry.state === 'error' ? 'error' : 'result'}: ${entry.summary}`)
        out.push('')
        break
      case 'command':
        out.push(`### /${entry.name}${entry.args === '' ? '' : ` ${entry.args}`}`, '')
        if (entry.summary !== '') out.push(`- ${entry.state === 'error' ? 'error' : 'result'}: ${entry.summary}`)
        out.push('')
        break
      case 'error':
        out.push(`> ⨯ ${entry.text}`, '')
        break
      case 'turn-marker':
        out.push(`> ${entry.text}`, '')
        break
      case 'compaction':
        out.push(entry.ok
          ? `> compacted ~${entry.tokens} tokens`
          : `> compaction failed: ${entry.error}`, '')
        break
      case 'retry':
        out.push(`> retry ${entry.attempt}/${entry.max} (${entry.code})`, '')
        break
      case 'files':
        out.push(`> files changed: ${entry.paths.join(', ')}`, '')
        break
      case 'workflow':
        out.push(`### workflow \`${entry.name}\` (${entry.state})`, '')
        for (const member of entry.members) {
          const phase = member.phase === '' ? '' : ` [${member.phase}]`
          out.push(`- ${member.outcome}: ${member.label}${phase}`)
        }
        if (entry.membersDropped > 0) out.push(`- … ${entry.membersDropped} earlier member${entry.membersDropped === 1 ? '' : 's'}`)
        out.push('')
        break
      case 'pending':
        // Codex PendingSteer: queued prompts export like ordinary user rows.
        out.push('## user', '', entry.text, ...(attachmentLabels(entry) === '' ? [] : [attachmentLabels(entry)]), '')
        break
      default:
        assertNever(entry, 'transcript entry kind')
    }
  }
  if (view.streaming !== '') out.push('## assistant (streaming)', '', view.streaming, '')
  const { stats } = view
  out.push('---', '')
  out.push(`- model: ${view.model === '' ? '(none yet)' : view.model}`)
  out.push(`- turns: ${stats.turns} · steps: ${stats.steps}`)
  out.push(`- tokens: ↑${stats.usage.uncachedInputTokens} ↓${stats.usage.outputTokens} · cache read ${stats.usage.cacheReadTokens} · cache write ${stats.usage.cacheWriteTokens}`)
  out.push(`- todos: ${view.todos.length}`)
  return out.join('\n')
}
