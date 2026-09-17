/**
 * Child-process adapter for the launcher update pipeline. The launcher
 * (bin/deepseek.mjs) stays the single owner of update semantics — plan,
 * guards, and the aligned install sequence — so the TUI only spawns
 * `update --json` (read-only probe) and `update --apply` (streamed run)
 * and never re-implements version-line decisions.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { fileURLToPath } from 'node:url'

/** Spawn double acceptable to the adapter (tests inject an EventEmitter). */
export type SpawnLike = (command: string, args: readonly string[], options: { readonly stdio: readonly string[]; readonly windowsHide: boolean }) => ChildProcess

/** Structured `update --json` payload; mirrors the launcher buildUpdateStatus. */
export interface LauncherUpdateStatus {
  readonly code: { readonly running: string; readonly latest: string | null }
  readonly host: { readonly installed: string | null; readonly targetLine: string | null }
  readonly profile: { readonly spec: string | null; readonly mounted: string | null; readonly localCheckout: boolean }
  readonly plan: { readonly dshSpec: string; readonly codeSpec: string; readonly pluginSpecs: readonly string[] }
  readonly blockers: { readonly registry: string | null; readonly downgrade: boolean; readonly localCheckout: readonly string[] | null }
  readonly upToDate: boolean
  /** True when this install is newer than npm latest (apply would downgrade). */
  readonly aheadOfRegistry?: boolean
}

/** Exact specs the TUI confirmed; apply must install these, not re-query latest. */
export interface LauncherUpdatePlan {
  readonly dshSpec: string
  readonly codeSpec: string
  readonly pluginSpecs: readonly string[]
}

/** The launcher entrypoint that ships beside this bundle (lib/../bin). */
export function launcherUpdateCommand(args: readonly string[], moduleUrl: string = import.meta.url): { readonly command: string; readonly args: string[] } {
  return { command: process.execPath, args: [fileURLToPath(new URL('../bin/deepseek.mjs', moduleUrl)), ...args] }
}

/**
 * Split a streamed chunk sequence into complete display lines: CR is
 * stripped, a chunk boundary may split a line, and the trailing partial
 * stays pending until its newline arrives (npm writes whole lines, but a
 * pipe may cut anywhere). Blank lines carry no progress information and
 * are dropped so the panel budget is not spent on gaps.
 */
export function createLineSplitter(onLine: (line: string) => void): (chunk: string) => void {
  let pending = ''
  return chunk => {
    pending += chunk
    for (let index = pending.indexOf('\n'); index >= 0; index = pending.indexOf('\n')) {
      const line = pending.slice(0, index).replace(/\r$/u, '')
      pending = pending.slice(index + 1)
      if (line !== '') onLine(line)
    }
  }
}

/**
 * Probe the aligned update status. Read-only: `update --json` never
 * installs anything. The probe is bounded (npm view may hang on a broken
 * network) and resolves with the parsed status.
 */
export async function probeLauncherUpdate(spawnProcess: SpawnLike = spawn as SpawnLike): Promise<LauncherUpdateStatus> {
  const command = launcherUpdateCommand(['update', '--json'])
  return await new Promise((resolve, reject) => {
    const child = spawnProcess(command.command, command.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('update probe timed out'))
    }, 30_000)
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString() })
    child.once('error', error => {
      clearTimeout(timer)
      reject(new Error(`update probe failed to start: ${error.message}`))
    })
    child.once('exit', code => {
      clearTimeout(timer)
      if (code === 0) {
        try {
          resolve(JSON.parse(stdout) as LauncherUpdateStatus)
        } catch {
          reject(new Error('update probe returned an unreadable status'))
        }
        return
      }
      const tail = stderr.trim().split(/\r?\n/u).pop() ?? ''
      reject(new Error(`update probe failed${tail === '' ? '' : `: ${tail}`}`))
    })
  })
}

/**
 * Run the aligned update (`update --apply`) as a child process and stream
 * its sanitized progress lines to the caller. Resolves with the child
 * exit code (0 success); rejects only when the process could not start.
 * No timeout: an npm install may legitimately take minutes.
 */
export function applyPlanArgs(plan: LauncherUpdatePlan): string[] {
  const args = ['update', '--apply', '--dsh', plan.dshSpec, '--code', plan.codeSpec]
  for (const plugin of plan.pluginSpecs) args.push('--plugin', plugin)
  return args
}

export function applyLauncherUpdate(onLine: (line: string) => void, spawnProcess?: SpawnLike, plan?: LauncherUpdatePlan): Promise<number> {
  const spawnFn = spawnProcess ?? (spawn as SpawnLike)
  const command = launcherUpdateCommand(plan === undefined ? ['update', '--apply'] : applyPlanArgs(plan))
  return new Promise((resolve, reject) => {
    const child = spawnFn(command.command, command.args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const split = createLineSplitter(onLine)
    child.stdout?.on('data', (chunk: Buffer) => { split(chunk.toString()) })
    child.stderr?.on('data', (chunk: Buffer) => { split(chunk.toString()) })
    child.once('error', error => {
      reject(new Error(`update failed to start: ${error.message}`))
    })
    // 'close' fires once the stdio streams have ended, so a final line the
    // child left without its newline still reaches the panel; a bare '\n'
    // flushes any pending partial without adding a blank row.
    child.once('close', (code, signal) => {
      split('\n')
      resolve(code ?? (signal === null ? 0 : 1))
    })
  })
}
