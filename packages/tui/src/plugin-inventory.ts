/** Read-only projection of Cordis Loader entries for /plugin. */

import type { Context, FiberState } from '@deepseek-ai/cordis'

export type PluginPhase = 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null

export interface PluginRow {
  readonly entryId: string
  readonly moduleName: string
  readonly enabled: boolean
  readonly phase: PluginPhase
}

const PHASES: Record<number, PluginPhase> = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: null,
  5: 'unloading',
}

interface LoaderEntry {
  readonly id: string
  readonly disabled: boolean
  readonly options: { readonly group?: boolean; readonly name: string }
  readonly fiber?: { readonly state: FiberState }
}

/** Snapshot the live Loader; group-only rows are composition containers, not plugins. */
export function listPluginRows(ctx: Context): PluginRow[] {
  const loader = (ctx as unknown as { get(name: string): unknown }).get('loader') as
    | { entries(): Iterable<LoaderEntry> }
    | undefined
  if (loader === undefined) return []
  const rows: PluginRow[] = []
  for (const entry of loader.entries()) {
    if (entry.options.group === true) continue
    rows.push({
      entryId: entry.id,
      moduleName: entry.options.name,
      enabled: !entry.disabled,
      phase: entry.fiber === undefined ? null : PHASES[entry.fiber.state] ?? null,
    })
  }
  return rows
}
