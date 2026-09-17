/**
 * Slash-command bridge: forwards terminal command lines into the shared
 * `ctx.commands` registry (the same surface the web composer dispatches
 * through) and exposes the live descriptor list as completion candidates.
 * The runner keeps only its own TUI-local commands (`/help`, `/quit`,
 * `/clear`, `/model`) ahead of the registry dispatch.
 *
 * @module @deepseek-ai/dsh-tui/commands
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CommandDescriptor } from '@deepseek-ai/dsh-commands'

/** Descriptor list snapshot the completion menu renders from. */
export interface CommandsView {
  /** Name-sorted descriptors after scoped shadowing. */
  readonly descriptors: readonly CommandDescriptor[]
  /** Latest descriptor-read failure; the help panel exposes it in place. */
  readonly error?: string
  /** Subscribe to list changes (`commands/change`); returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Retarget the agent whose scoped view the list is read through. */
  setAgent(agent: Agent): void
}

/**
 * Watch the live command registry. Reads the current list immediately and
 * re-reads on every registry mutation or agent retarget; notification
 * failures are contained by the registry itself, so this watcher only ever
 * re-reads. Without a `commands` service the view stays empty and all lines
 * fall through to normal prompts.
 * @param ctx - context carrying the `commands` service (optional).
 * @returns the view the completion menu subscribes to.
 */
export function watchCommands(ctx: Context): CommandsView {
  const commands = ctx.get('commands')
  let agent: Agent | undefined
  let descriptors: readonly CommandDescriptor[] = []
  let error: string | undefined
  // The agent whose scoped view the current descriptors were read for: a
  // failure before this agent ever loaded clears the list instead of keeping
  // another session's commands completable here.
  let loadedFor: Agent | undefined
  const listeners = new Set<() => void>()
  // Content gate: the host registry allocates a fresh array on every list()
  // call and 0.1.5 emits commands/change for every scoped register AND
  // dispose (a startup registration wave lands inside React's commit
  // windows). A fresh identity per event chains nested passive updates past
  // React's 50-deep limit ("Maximum update depth exceeded"), so an unchanged
  // catalog keeps the previous array identity and notifies nobody — the same
  // discipline the skills gate and the store's frame throttle established.
  const descriptorFingerprint = (list: readonly CommandDescriptor[]): string =>
    JSON.stringify(list.map(descriptor => [descriptor.name, descriptor.description, descriptor.input?.hint ?? '', descriptor.input?.attachments === true]))
  let lastFingerprint = '[]'
  let lastNotifiedError: string | undefined
  const changed = (next: readonly CommandDescriptor[], nextError: string | undefined): boolean =>
    descriptorFingerprint(next) !== lastFingerprint || nextError !== lastNotifiedError
  // Frame throttle: coalesce a same-tick event storm into one notification
  // (the transcript store's NOTIFY_FRAME_MS contract).
  let notifyScheduled = false
  const notify = (): void => {
    if (notifyScheduled) return
    notifyScheduled = true
    setImmediate(() => {
      notifyScheduled = false
      for (const listener of listeners) listener()
    })
  }
  const refresh = (): void => {
    if (commands === undefined || agent === undefined) return
    let next: readonly CommandDescriptor[]
    let nextError: string | undefined
    try {
      next = commands.list(agent)
      loadedFor = agent
    } catch (cause: unknown) {
      // Keep the last good catalog for the SAME agent, but change its identity
      // so subscribers can render the recoverable failure in /help; an agent
      // that never loaded starts from empty.
      next = loadedFor === agent ? [...descriptors] : []
      nextError = cause instanceof Error ? cause.message : String(cause)
    }
    if (!changed(next, nextError)) return
    descriptors = next
    error = nextError
    lastFingerprint = descriptorFingerprint(next)
    lastNotifiedError = nextError
    notify()
  }
  if (commands !== undefined) {
    ctx.on('commands/change', () => refresh())
  }
  return {
    get descriptors(): readonly CommandDescriptor[] {
      return descriptors
    },
    get error(): string | undefined {
      return error
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    setAgent(next: Agent): void {
      agent = next
      refresh()
    },
  }
}

/**
 * Whether one command line is a syntactically valid slash command.
 * @param line - the complete candidate line.
 * @returns true when the line parses as `/name` or `/name input`.
 */
export function isSlashLine(line: string): boolean {
  return /^\/[a-z][a-z0-9_-]*(?=$|[\t ])/u.test(line)
}

/**
 * The submission payload for one composer line. Trim is a blank check, not a
 * rewrite: an ordinary prompt keeps its exact leading indentation, inner
 * layout, and trailing spaces (pasted code must reach the model verbatim).
 * Only trailing line terminators are stripped — a draft's final newline is a
 * paste/Enter artifact (an open bracketed paste turns Enter into an inserted
 * newline), never deliberate content. A syntactic slash line still normalizes
 * fully so command routing stays stable (completion inserts a trailing space
 * after `/name`).
 * @param line - the complete draft text.
 * @returns the text to submit verbatim.
 */
export function submissionPayload(line: string): string {
  const withoutTrailingNewlines = line.replace(/[\r\n]+$/u, '')
  const trimmed = withoutTrailingNewlines.trim()
  return isSlashLine(trimmed) ? trimmed : withoutTrailingNewlines
}
