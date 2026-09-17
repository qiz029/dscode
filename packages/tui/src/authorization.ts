/** Terminal adapter over the Harness provider-authorization and credential-record seams. */

import { spawn } from 'node:child_process'
import type { Context } from '@deepseek-ai/cordis'
import type {
  AuthorizationEntry,
  AuthorizationInteraction,
  AuthorizationMethod,
  AuthorizationStatus,
} from '@deepseek-ai/dsh-authorization'
import {
  credentialKeyId,
  credentialKeyScope,
  type CredentialKey,
  type CredentialRecordInfo,
} from '@deepseek-ai/dsh-credentials'

/** Record scope used by the upstream pi-ai adapter for provider logins. */
const PI_AI_RECORD_SCOPE = 'llm-pi-ai'

/** One provider login flow joined with its value-free stored-record facts. */
export interface ProviderAuthorizationRow {
  readonly key: CredentialKey
  readonly provider: string
  readonly label: string
  readonly methods: readonly AuthorizationMethod[]
  readonly inFlight: boolean
  readonly record: CredentialRecordInfo
}

/** The provider-login directory plus non-fatal record lookup failures. */
export interface ProviderAuthorizationDirectory {
  readonly rows: readonly ProviderAuthorizationRow[]
  readonly failures: readonly string[]
}

/** Load only model-provider flows; unrelated future authorization domains stay out of `/model`. */
export async function loadProviderAuthorizations(ctx: Context): Promise<ProviderAuthorizationDirectory> {
  const authorization = ctx.get('authorization')
  const credentials = ctx.get('credentials')
  if (authorization === undefined || credentials === undefined) return { rows: [], failures: [] }
  const entries = authorization.list().filter(entry => credentialKeyScope(entry.key) === PI_AI_RECORD_SCOPE)
  const failures: string[] = []
  const rows = await Promise.all(entries.map(async (entry): Promise<ProviderAuthorizationRow> => {
    let record: CredentialRecordInfo
    try {
      record = await credentials.describeRecord(entry.key)
    } catch (error: unknown) {
      failures.push(`${entry.label}: ${error instanceof Error ? error.message : String(error)}`)
      record = { configured: false, writable: false }
    }
    return {
      key: entry.key,
      provider: credentialKeyId(entry.key),
      label: entry.label,
      methods: entry.methods,
      inFlight: entry.inFlight,
      record,
    }
  }))
  return { rows, failures }
}

/** Subscribe to login settlement and credential-record changes. */
export function subscribeProviderAuthorizations(ctx: Context, listener: () => void): () => void {
  const settled = ctx.on('authorization/settled', (key) => {
    if (credentialKeyScope(key) === PI_AI_RECORD_SCOPE) listener()
  })
  const records = ctx.on('credentials/record-updated', (key) => {
    if (credentialKeyScope(key) === PI_AI_RECORD_SCOPE) listener()
  })
  return () => {
    settled()
    records()
  }
}

/** Begin one provider login through the interaction surface owned by the caller. */
export async function beginProviderAuthorization(
  ctx: Context,
  row: Pick<ProviderAuthorizationRow, 'key'>,
  method: string,
  interaction: AuthorizationInteraction,
  signal?: AbortSignal,
): Promise<AuthorizationStatus> {
  const authorization = ctx.get('authorization')
  if (authorization === undefined) throw new Error('provider login is unavailable in this profile')
  return (await authorization.begin({ key: row.key, method, interaction, signal })).status
}

/** Cancel the attempt currently serving this provider, if any. */
export function cancelProviderAuthorization(ctx: Context, key: CredentialKey): void {
  ctx.get('authorization')?.cancel(key)
}

/** Remove an authorization record without changing the provider's settings profile. */
export async function logoutProviderAuthorization(ctx: Context, row: ProviderAuthorizationRow): Promise<void> {
  const credentials = ctx.get('credentials')
  if (credentials === undefined) throw new Error('credential storage is unavailable in this profile')
  const current = await credentials.describeRecord(row.key)
  if (!current.configured) return
  if (!current.writable) throw new Error('this login record is read-only')
  await credentials.deleteRecord(row.key)
}

/** Open an authorization URL with the platform default browser, without invoking a shell. */
export function openAuthorizationUrl(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
  const target = url.toString()
  try {
    const child = process.platform === 'win32'
      ? spawn('explorer.exe', [target], { detached: true, stdio: 'ignore' })
      : process.platform === 'darwin'
        ? spawn('/usr/bin/open', [target], { detached: true, stdio: 'ignore' })
        : spawn('xdg-open', [target], { detached: true, stdio: 'ignore' })
    child.once('error', () => {})
    child.unref()
    return true
  } catch {
    return false
  }
}

/** Compact value-free status for the provider list. */
export function providerAuthorizationStatus(row: ProviderAuthorizationRow | undefined): string {
  if (row === undefined) return 'login unavailable'
  if (row.inFlight) return 'login in progress'
  if (!row.record.configured) return 'not logged in'
  return row.record.kind === 'grant' ? 'OAuth' : 'interactive API key'
}

/** Find a provider's login flow from a previously loaded directory. */
export function authorizationForProvider(
  directory: ProviderAuthorizationDirectory | undefined,
  provider: string,
): ProviderAuthorizationRow | undefined {
  return directory?.rows.find(row => row.provider === provider)
}

/** Preserve the upstream entry type in declarations without leaking service internals into the TUI. */
export type { AuthorizationEntry }
