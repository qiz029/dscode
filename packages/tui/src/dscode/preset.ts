/** DSCODE's interactive surface has one composition, including resumed sessions. */
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { resolvePreset, type AgentPresetsService, type PresetRow } from '../presets.ts'

export const DSCODE_PRESET = 'dscode'

export function requireDscodePreset(id?: string): typeof DSCODE_PRESET {
  if (id !== undefined && id !== DSCODE_PRESET) throw new Error('DSCODE is locked to the dscode preset; use /new to start a DSCODE session.')
  return DSCODE_PRESET
}

/** Mount before recording a migration; failed composition must leave history intact. */
export async function mountDscodePreset(service: AgentPresetsService, ctx: Context, session: Session): Promise<PresetRow> {
  const mounted = await service.mount(ctx, DSCODE_PRESET)
  if (mounted.id !== DSCODE_PRESET) throw new Error('The dscode preset did not resolve to DSCODE.')
  if (resolvePreset(session) !== DSCODE_PRESET) {
    const writable = session as unknown as { append(type: string, data: unknown): void }
    writable.append('agent-preset/selected', { agentPreset: DSCODE_PRESET })
  }
  return mounted
}
