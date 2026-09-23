/** Agent-preset policy kept independent from the Ink surface. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentPreset, AgentPresetRegistry } from '@deepseek-ai/dsh-agent-preset-registry'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'

/** One discoverable agent composition. */
export type PresetRow = AgentPreset

/** Public compatibility alias for the official upstream service type. */
export type AgentPresetsService = AgentPresetRegistry

/** Read an optional Cordis service without requiring its package at build time. */
export function agentPresetsFrom(ctx: Context): AgentPresetsService | undefined {
  return ctx.get('agentPresets')
}

/** A preset may change only before the first durable turn begins. */
export function isBlankSession(events: readonly SessionEvent[]): boolean {
  return !events.some(event => event.type === 'turn/start')
}

/** Upstream renamed the shipped `code` preset to `ptc` in 0.1.2-rc.1; sessions
 * and CLI choices recorded before the rename keep resolving through this map. */
const LEGACY_PRESET_IDS: Readonly<Record<string, string>> = { code: 'ptc' }

/** Translate a preset id recorded before an upstream rename to its current id. */
export function normalizePresetId(id: string): string
export function normalizePresetId(id: string | undefined): string | undefined
export function normalizePresetId(id: string | undefined): string | undefined {
  return id === undefined ? undefined : LEGACY_PRESET_IDS[id] ?? id
}

/** Latest logged selection wins; legacy sessions deliberately fall back to standard. */
export function resolvePreset(session: Pick<Session, 'header' | 'snapshotEvents'>): string {
  const events = session.snapshotEvents()
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as unknown as { type: string; data?: { agentPreset?: string } }
    if (event.type === 'agent-preset/selected' && event.data?.agentPreset !== undefined) {
      return normalizePresetId(event.data.agentPreset)
    }
  }
  return normalizePresetId(session.header.agentPreset) ?? 'standard'
}

/** Resolve a pre-session choice, or recompose an active blank Agent. */
export async function selectPreset(
  service: AgentPresetsService,
  agent: Agent | undefined,
  presetId: string,
): Promise<PresetRow> {
  presetId = normalizePresetId(presetId)
  if (agent !== undefined) return switchPreset(service, agent, presetId)
  const preset = await service.resolve(presetId)
  if (preset.broken !== undefined) throw new Error(preset.broken)
  return preset
}

/** Recompose atomically from the caller's perspective, logging only success. */
export async function switchPreset(
  service: AgentPresetsService,
  agent: Agent,
  presetId: string,
): Promise<PresetRow> {
  if (!isBlankSession(agent.session.snapshotEvents())) {
    throw new Error('mode is locked after the first turn; use /new <mode>')
  }
  const preset = await service.recompose(agent.ctx, presetId)
  const writable = agent.session as unknown as { append(type: string, data: unknown): void }
  writable.append('agent-preset/selected', { agentPreset: preset.id })
  return preset
}
