/**
 * dscode: small UI preferences that must survive a restart (the verbose
 * transcript toggle). They live beside the launcher's other state, one JSON file
 * per flag, and a read or write that fails never breaks the render path.
 *
 * @module dsh-code/dscode/flags
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The directory DSCODE keeps its own terminal state in. */
function stateDirectory(): string {
  return join(homedir(), '.dsh', 'dsh-code')
}

/** One persisted boolean; a missing or corrupt file falls back. */
export function loadFlag(name: string, fallback = false): boolean {
  try {
    const value = JSON.parse(readFileSync(join(stateDirectory(), name + '.json'), 'utf8'))[name]
    return typeof value === 'boolean' ? value : fallback
  } catch {
    return fallback
  }
}

/** Persist one boolean; a failed write is ignored so the UI never blocks. */
export function saveFlag(name: string, value: boolean): void {
  try {
    mkdirSync(stateDirectory(), { recursive: true })
    writeFileSync(join(stateDirectory(), name + '.json'), JSON.stringify({ [name]: value }, null, 2) + '\n')
  } catch {}
}
