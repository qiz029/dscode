/**
 * Serialized, crash-atomic persistence for the small user-level JSON files
 * under the DSH home (statusline.json, theme.json). Two guarantees the bare
 * floating `writeFile` path could not give:
 *
 * 1. Every save is appended to ONE chain, so rapid consecutive edits land
 *    in submission order and the last snapshot is the one on disk (parallel
 *    floating writes let an older snapshot finish last and win).
 * 2. Each write goes to a sibling temp file first and is renamed into
 *    place, so a crash mid-write can never leave a half-written JSON
 *    document behind.
 *
 * The chain itself never rejects: a failed write is reported to that
 * save's caller while later saves keep their turn.
 *
 * @module @deepseek-ai/dsh-code/settings-file
 */

import { randomUUID } from 'node:crypto'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Run one file operation with a bounded retry: one initial try plus at
 * most `retries` more. Creating or replacing a file can fail transiently
 * with EPERM/EACCES while an antivirus scanner or search indexer holds
 * it — the standard graceful-fs remedy, not a workaround for a
 * persistent permission problem. A save that still fails leaves its
 * uniquely named temp file behind, so repeated crashed saves accumulate
 * distinct leftovers rather than corrupting a shared one.
 */
async function withTransientRetry(operation: () => Promise<void>, retries = 5): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await operation()
      return
    } catch (error: unknown) {
      const code = (error as NodeJS.ErrnoException).code
      if (attempt >= retries || (code !== 'EPERM' && code !== 'EACCES')) throw error
      await new Promise(resolve => setTimeout(resolve, 30 * (attempt + 1)))
    }
  }
}

/**
 * Write one file atomically: create the parent directory, write to a
 * uniquely named temp file, and rename it into place. A crash midway
 * can never leave a half-written document behind. Unique temp names
 * keep concurrent writers (two terminals, two chains in one process)
 * from sharing one temp path.
 */
export async function writeFileAtomically(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  await withTransientRetry(() => writeFile(temp, text, 'utf8'))
  await withTransientRetry(() => rename(temp, path))
}

/** The serialized persistence surface; flush() is handed to the quit sequence. */
export interface UserSettingsPersistence {
  /**
   * Queue one file snapshot. Resolves when the chain reaches (and renames)
   * it; rejects only to THIS caller when its own write failed.
   */
  save(path: string, text: string): Promise<void>
  /** Wait for every queued write; safe to call repeatedly. */
  flush(): Promise<void>
}

/**
 * Create the shared settings-write chain. One instance per process keeps
 * every user-level JSON file mutually serialized.
 * @returns the persistence handle.
 */
export function createUserSettingsPersistence(): UserSettingsPersistence {
  let chain: Promise<void> = Promise.resolve()
  return {
    save(path: string, text: string): Promise<void> {
      const write = chain.then(() => writeFileAtomically(path, text))
      // A failed write must not break the chain for later saves.
      chain = write.catch(() => {})
      return write
    },
    flush(): Promise<void> {
      return chain
    },
  }
}
