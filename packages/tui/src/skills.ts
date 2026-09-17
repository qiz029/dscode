/**
 * User-invocable skill watch for the `/` completion menu: the in-process
 * equivalent of the web ui-skill trigger source. Skills are NOT commands —
 * picking one lands the literal `/name ` text in the input, and submitting
 * it as a normal prompt lets the host's tool-skill pre-step inject the body
 * (the only entry point for model-disabled skills). Command descriptors win
 * on a name collision; see the runner's dispatch.
 *
 * @module @deepseek-ai/dsh-code/skills
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isUserInvocable } from '@deepseek-ai/dsh-skill'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'

/** One completion-menu row derived from a user-invocable skill. */
export interface SkillRow {
  /** Skill name; the literal `/name` text is what a pick lands. */
  name: string
  /** Human-readable description (suffixed when model-invocation is off). */
  description: string
  /** Whether the model may also invoke this skill by name. */
  modelInvocable: boolean
}

/** The skill-catalog snapshot the completion menu subscribes to. */
export interface SkillsView {
  /** Name-sorted user-invocable rows; empty until the first load lands. */
  readonly rows: readonly SkillRow[]
  /** Latest catalog-read failure; the help panel exposes it in place. */
  readonly error?: string
  /** Subscribe to catalog changes; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Retarget the agent whose workspace the catalog is read for. */
  setAgent(agent: Agent): void
}

/** Internal shape shared by {@link watchSkills} and its test doubles. */
interface SkillsWatch extends SkillsView {
  setAgent(agent: Agent): void
}

function toRows(skills: readonly SkillSummary[]): readonly SkillRow[] {
  return skills
    .filter(skill => isUserInvocable(skill))
    .map(skill => ({
      name: skill.name,
      description: skill.description,
      modelInvocable: skill.invocation.modelInvocable === true,
    }))
    .sort((left, right) => left.name < right.name ? -1 : 1)
}

/**
 * Watch the user-invocable skill catalog for one agent's workspace. The first
 * load starts when the owning agent is known (`setAgent`); `skills/change`
 * and agent retargets re-read. Read failures keep the last good rows (the
 * next change notification is the retry surface) — a missing `skills`
 * service leaves the view permanently empty.
 * @param ctx - context carrying the `skills` service (optional).
 * @returns the view the completion menu subscribes to.
 */
export function watchSkills(ctx: Context, fallbackCwd?: string): SkillsWatch {
  const skills = ctx.get('skills')
  let agent: Agent | undefined
  let rows: readonly SkillRow[] = []
  let error: string | undefined
  // The agent whose workspace the current rows were last successfully read
  // from: a failure for an agent that never loaded must clear the rows, not
  // keep another workspace's catalog answerable in this session.
  let loadedFor: Agent | undefined
  const listeners = new Set<() => void>()

  const reload = (): void => {
    const target = agent
    if (skills === undefined) return
    Promise.resolve().then(() => skills.list(target === undefined
      // No session exists yet (a bare launch keeps the agent unset until the
      // first message): read the global skill layer for the working directory.
      // The upstream contract makes `scope` optional — omitted reads the
      // global layer alone — so the menu offers skills before a session does.
      ? { cwd: fallbackCwd }
      : {
        cwd: target.session.header.cwd ?? fallbackCwd,
        scope: target,
      })).then((summaries: readonly SkillSummary[]) => {
      // A retarget landed while this catalog was loading: the rows belong to
      // another agent's workspace and must never overwrite the current view.
      if (agent !== target) return
      const next = toRows(summaries)
      // Description and invocation-flag edits must surface too: a name-only
      // comparison silently dropped those change notifications.
      const unchanged = next.length === rows.length && next.every((row, index) =>
        row.name === rows[index]?.name
        && row.description === rows[index]?.description
        && row.modelInvocable === rows[index]?.modelInvocable)
      rows = next
      loadedFor = target
      const recovered = error !== undefined
      error = undefined
      if (unchanged && !recovered) return
      for (const listener of listeners) listener()
    }).catch((cause: unknown) => {
      if (agent !== target) return
      // Discovery failure keeps the last good rows for the SAME target (the
      // next skills/change notification is the retry surface, mirroring the
      // web directory); a target that never loaded starts from empty rows —
      // stale rows from a previous workspace must not keep completing here.
      // The rows array keeps its identity unless the failure text itself
      // changed: a repeated identical error on the 0.1.5 event storm must not
      // churn fresh identities into React's update chain.
      const nextError = cause instanceof Error ? cause.message : String(cause)
      if (loadedFor !== target) rows = []
      const errorChanged = nextError !== error
      error = nextError
      if (!errorChanged) return
      for (const listener of listeners) listener()
    })
  }

  if (skills !== undefined) {
    ctx.on('skills/change', reload)
    // Read the global layer immediately: a bare launch has no agent yet, and
    // waiting for the first skills/change would leave the menu empty.
    reload()
  }

  const view: SkillsWatch = {
    get rows(): readonly SkillRow[] {
      return rows
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
      reload()
    },
  }
  return view
}
