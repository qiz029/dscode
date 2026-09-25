import { homedir } from 'node:os';
import { join } from 'node:path';
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local';
import { Context, Service } from '@deepseek-ai/cordis';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { PROVIDERS } from '../providers/catalog.mjs';
import { GROK_TOKEN_REF, grokAuthState } from '../grok/auth.mjs';

// The `/provider` credentials (DeepSeek, OpenRouter and its management key, the OpenCode Go
// login) live in the shared store.
const SHARED = new Set(PROVIDERS.flatMap(provider => [provider.credentialRef, provider.managementRef].filter(Boolean)));
// Credentials a login command writes (the OpenCode Go account login): described as read-only
// so no key form is offered, while the owning plugin still stores them through `set`.
const LOGINS = new Set(PROVIDERS.filter(provider => provider.login).map(provider => provider.credentialRef));

// Use the native locked, watched, owner-only store. Keep this independent of
// the installed profile so upgrades and different projects share credentials.
export default class DscodeCredentials extends LocalCredentialProvider {
  shared;
  sharedConfig;
  constructor(ctx, config = {}) {
    // Retain the old profile store, including other providers and OAuth records.
    super(ctx, { ...config, path: undefined });
    this.sharedConfig = { ...config, path: config.path ?? join(homedir(), '.dscode', 'credentials.yaml') };
  }
  async *[Service.init]() {
    const sharedContext = new Context();
    yield () => sharedContext.fiber.dispose();
    sharedContext.provide('launchEnvironment', launchEnvironmentOf(this.ctx));
    sharedContext.on('credentials/reference-updated', ref => this.notifyUpdated(ref));
    await sharedContext.plugin(LocalCredentialProvider, this.sharedConfig);
    this.shared = sharedContext.credentials;
    yield* super[Service.init]();
  }
  async resolve(ref) {
    // dscode: the Grok subscription rail is the official CLI login, read-only. DSCODE never
    // writes that file: the CLI owns refresh-token rotation, and two writers log the other out.
    if (ref === GROK_TOKEN_REF) {
      const state = grokAuthState();
      return state.kind === 'ready' ? { value: state.credential.token, source: 'file' } : undefined;
    }
    if (SHARED.has(ref)) {
      const stored = await this.shared.resolve(ref);
      if (stored?.source === 'env' || stored?.source === 'file') return stored;
    }
    return super.resolve(ref);
  }
  async describe(ref) {
    if (ref === GROK_TOKEN_REF) {
      const state = grokAuthState();
      return state.kind === 'ready' ? { configured: true, source: 'file', writable: false } : { configured: false, writable: false };
    }
    if (LOGINS.has(ref)) {
      return (await this.shared.resolve(ref))?.value ? { configured: true, source: 'account', writable: false } : { configured: false, writable: false };
    }
    if (SHARED.has(ref)) {
      const facts = await this.shared.describe(ref);
      if (facts.source === 'env' || facts.source === 'file') return facts;
    }
    return super.describe(ref);
  }
  set(ref, value) {
    // The CLI file is not a DSCODE store: saving here would go somewhere nothing reads.
    if (ref === GROK_TOKEN_REF) throw new Error('GROK_CLI_TOKEN comes from ~/.grok/auth.json; run grok login instead');
    return SHARED.has(ref) ? this.shared.set(ref, value) : super.set(ref, value);
  }
  async unset(ref) {
    // Explicit removal must not uncover a previously configured legacy key.
    if (SHARED.has(ref)) await this.shared.unset(ref);
    await super.unset(ref);
  }
}
