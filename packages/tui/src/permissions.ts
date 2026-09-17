/** Permission-preset policy for pending and active TUI sessions. */

import type { Context } from '@deepseek-ai/cordis'
import type { PermissionPresetService } from '@deepseek-ai/dsh-permission-presets'
import type { Session } from '@deepseek-ai/dsh-session'

/** One selectable permission preset row for the /permission panel. */
export interface PermissionRow {
  readonly id: string
  readonly description?: string
}

/** Public compatibility alias for the official upstream permission service. */
export type PermissionPresetsService = PermissionPresetService

/** Read the optional Harness service without importing its runtime package. */
export function permissionPresetsFrom(ctx: Context): PermissionPresetsService | undefined {
  return ctx.get('permissionPresets')
}

/** Effective label for either an active session or the not-yet-created first one. */
export function effectivePermission(
  service: PermissionPresetsService,
  session: Session | undefined,
  pending: string | undefined,
): string {
  return session === undefined ? pending ?? service.defaultPreset : service.current(session)
}

/** Validate a preset and write it only when a durable session already exists. */
export function selectPermission(
  service: PermissionPresetsService,
  session: Session | undefined,
  preset: string,
): string {
  service.resolve(preset)
  if (session !== undefined) service.set(session, preset)
  return preset
}

/** Cycle table order from the active, pending, or configured-default value. */
export function cyclePermission(
  service: PermissionPresetsService,
  session: Session | undefined,
  pending: string | undefined,
): string {
  if (service.names.length === 0) return ''
  const at = service.names.indexOf(effectivePermission(service, session, pending))
  const next = service.names[(at + 1) % service.names.length] ?? ''
  return next === '' ? '' : selectPermission(service, session, next)
}

/** Materialize a pre-session choice after Harness creates the first session. */
export function applyPendingPermission(
  service: PermissionPresetsService,
  session: Session,
  pending: string | undefined,
): void {
  if (pending !== undefined && effectivePermission(service, session, undefined) !== pending) {
    selectPermission(service, session, pending)
  }
}

/**
 * List every switchable preset for the /permission panel, table order kept.
 * Description lookup failures degrade to an undocumented row, never a failed
 * panel load — `optionOf` rejects names its table no longer knows.
 */
export function listPermissionRows(service: PermissionPresetsService): readonly PermissionRow[] {
  return service.names.map((id) => {
    try {
      return { id, description: service.optionOf(id)?.description }
    } catch {
      return { id }
    }
  })
}
