/** Installed dsh-code version exposed by the terminal header. */

import { readFileSync, realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'

/** Read one package manifest version without making terminal startup depend on it. */
function readPackageVersion(manifest = new URL('../package.json', import.meta.url)): string {
  try {
    const parsed = JSON.parse(readFileSync(manifest, 'utf8')) as { version?: unknown }
    return typeof parsed.version === 'string' && parsed.version.length > 0 ? parsed.version : '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/** Version of the installed dsh-code package. */
export const DSH_CODE_VERSION = readPackageVersion()

/** The harness host package: the dsh CLI whose process runs the TUI plugin. */
const DSH_HOST_PACKAGE_NAME = '@deepseek-ai/dsh'

/** Parent levels above the host entry allowed to hold its package manifest. */
const DSH_HOST_WALK_LIMIT = 4

/** Read `@deepseek-ai/dsh`'s version from a directory's package.json, or undefined. */
function readHostVersion(directory: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as {
      name?: unknown
      version?: unknown
    }
    if (parsed.name === DSH_HOST_PACKAGE_NAME && typeof parsed.version === 'string' && parsed.version.length > 0) {
      return parsed.version
    }
  } catch {
    // No readable host manifest at this level.
  }
  return undefined
}

/** Climb from an entry file toward a host package.json. */
function walkFrom(entry: string): string | undefined {
  let directory = dirname(resolve(entry))
  for (let depth = 0; depth < DSH_HOST_WALK_LIMIT; depth += 1) {
    const version = readHostVersion(directory)
    if (version !== undefined) return version
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
  return undefined
}

/**
 * Resolve the host package via Node's module lookup from an entry file.
 * Covers global `bin/dsh` shims that are not inside the package tree.
 */
function resolveFromNode(from: string): string | undefined {
  try {
    const manifest = createRequire(from).resolve(`${DSH_HOST_PACKAGE_NAME}/package.json`)
    return readHostVersion(dirname(manifest))
  } catch {
    return undefined
  }
}

/**
 * Resolve the running dsh CLI host's version from its entry file
 * (`process.argv[1]`, e.g. `.../@deepseek-ai/dsh/lib/bin.js` or a PATH
 * symlink `.../bin/dsh` → that file). Only a manifest literally named
 * `@deepseek-ai/dsh` counts, so an unrelated entry (vitest, a plain node
 * script) resolves to undefined instead of faking a kernel version.
 */
export function resolveDshHostVersion(entry: string | undefined = process.argv[1]): string | undefined {
  if (entry === undefined || entry === '') return undefined
  const fromWalk = walkFrom(entry)
  if (fromWalk !== undefined) return fromWalk
  try {
    const real = realpathSync(entry)
    if (real !== resolve(entry)) {
      const fromReal = walkFrom(real)
      if (fromReal !== undefined) return fromReal
    }
  } catch {
    // Broken or missing symlink: fall through to Node resolution.
  }
  return resolveFromNode(resolve(entry))
}

let cachedDshKernelVersion: string | undefined
let dshKernelVersionResolved = false

/**
 * The dsh kernel version the TUI runs on, memoized after the first probe: the
 * host process never changes within a run, and the header reads this on every
 * Static replay.
 */
export function dshKernelVersion(): string | undefined {
  if (!dshKernelVersionResolved) {
    cachedDshKernelVersion = resolveDshHostVersion()
    dshKernelVersionResolved = true
  }
  return cachedDshKernelVersion
}

/** Test-only: forget the memoized kernel version so a new argv can be probed. */
export function _resetDshKernelVersionForTests(): void {
  cachedDshKernelVersion = undefined
  dshKernelVersionResolved = false
}
