import { homedir } from 'node:os';
import { join } from 'node:path';
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local';
import { Context, Service } from '@deepseek-ai/cordis';
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment';
import { PROVIDERS } from '../providers/catalog.mjs';

// The `/provider` keys (DeepSeek, OpenRouter and its management key) live in the shared store.
const SHARED = new Set(PROVIDERS.flatMap(provider => [provider.credentialRef, provider.managementRef].filter(Boolean)));

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
    if (SHARED.has(ref)) {
      const stored = await this.shared.resolve(ref);
      if (stored?.source === 'env' || stored?.source === 'file') return stored;
    }
    return super.resolve(ref);
  }
  async describe(ref) {
    if (SHARED.has(ref)) {
      const facts = await this.shared.describe(ref);
      if (facts.source === 'env' || facts.source === 'file') return facts;
    }
    return super.describe(ref);
  }
  set(ref, value) {
    return SHARED.has(ref) ? this.shared.set(ref, value) : super.set(ref, value);
  }
  async unset(ref) {
    // Explicit removal must not uncover a previously configured legacy key.
    if (SHARED.has(ref)) await this.shared.unset(ref);
    await super.unset(ref);
  }
}
