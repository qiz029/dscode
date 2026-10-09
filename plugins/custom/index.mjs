import z from '@deepseek-ai/schemastery';
import { watchFile, unwatchFile } from 'node:fs';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { createToolResultMessage, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm';
import { CustomStore, validateProfile, customId, keyRef, isCustomId } from './config.mjs';
import { CustomAdapter, authHeaders } from './adapter.mjs';

export const name = 'dscode-custom';
export const inject = ['llm', 'credentials'];
export const Config = z.object({ path: z.string().default('') });
export const getCustomProviders = ctx => ctx.get('dscodeCustom');

export class CustomProviders {
  constructor({ store = new CustomStore(), credentials, resolveAttachments, resolveImageAccess, fetch = globalThis.fetch, changed = () => {} }) {
    Object.assign(this, { store, credentials, fetch, changed });
    this.providers = [];
    this.adapter = new CustomAdapter({ profile: id => this.providers.find(p => p.id === id), resolveKey: p => this.resolveKey(p), resolveAttachments, resolveImageAccess, fetch });
  }
  async refresh() {
    const snapshot = await this.store.read();
    if (snapshot.revision !== this.revision) {
      this.providers = snapshot.providers; this.revision = snapshot.revision; this.changed(this.providers);
    }
    return snapshot;
  }
  async list() {
    const snapshot = await this.refresh();
    return { ...snapshot, providers: await Promise.all(snapshot.providers.map(async p => {
      const facts = await this.credentials.describe(credentialRef(keyRef(p.id)));
      return { ...p, credentialStatus: p.auth === 'none' ? 'No authentication' : facts.configured ? facts.source === 'env' ? 'Key from environment' : 'Key saved' : 'API key missing' };
    })) };
  }
  newProfile() { return { id: customId(), name: '', baseURL: '', api: 'chat-completions', auth: 'bearer', backend: 'generic', timeoutMs: 180000, models: [] }; }
  async resolveKey(profile, draftKey) {
    if (profile.auth === 'none') return undefined;
    if (draftKey) return draftKey;
    return (await this.credentials.resolve(credentialRef(keyRef(profile.id))))?.value;
  }
  async save(input, key, revision) {
    const profile = validateProfile(input);
    if (key && (/[\s\x00-\x1f]/.test(key) || key.length > 4096)) throw Error('Paste only the API key, without whitespace');
    await this.store.update(revision, async providers => {
      if (key) await this.credentials.set(credentialRef(keyRef(profile.id)), key);
      return [...providers.filter(p => p.id !== profile.id), profile];
    });
    return this.list();
  }
  async remove(id, revision) {
    if (!isCustomId(id)) throw Error('Invalid custom provider ID');
    await this.store.update(revision, async providers => {
      const ref = credentialRef(keyRef(id));
      const facts = await this.credentials.describe(ref);
      // Native credentials supplied by the environment are read-only. They
      // cannot keep a deleted route alive or prevent removing its configuration.
      if (facts.source !== 'env') await this.credentials.unset(ref);
      return providers.filter(p => p.id !== id);
    });
    return this.list();
  }
  async clearKey(id) { await this.credentials.unset(credentialRef(keyRef(id))); }
  async json(profile, path, key, signal) {
    const response = await this.fetch(profile.baseURL + path, { redirect: 'error', headers: authHeaders(profile, key), signal: AbortSignal.any([AbortSignal.timeout(10000), ...(signal ? [signal] : [])]) });
    if (!response.ok) { await response.body?.cancel(); throw Error(`Model discovery returned HTTP ${response.status}`); }
    return response.json();
  }
  async discover(input, draftKey, signal) {
    const profile = validateProfile(input), key = await this.resolveKey(profile, draftKey);
    let listing;
    try { listing = await this.json(profile, '/models', key, signal); }
    // Transport exceptions can carry request headers; do not retain their cause.
    // eslint-disable-next-line preserve-caught-error
    catch (error) { if (signal?.aborted) throw Error('Discovery cancelled'); throw Error(error.message?.startsWith('Model discovery returned HTTP') ? error.message : 'Could not discover models; check the address and key, or add a model manually'); }
    if (signal?.aborted) throw Error('Discovery cancelled');
    if (!Array.isArray(listing.data)) throw Error('Model listing has no data array; enter a model manually');
    const backend = listing.data.some(m => m.owned_by === 'omlx') ? 'omlx' : 'generic';
    let status = [];
    if (backend === 'omlx') {
      try {
        const metadata = await this.json(profile, '/models/status', key, signal);
        if (Array.isArray(metadata?.models)) status = metadata.models;
      } catch { /* Optional oMLX metadata; the standard listing still works. */ }
      if (signal?.aborted) throw Error('Discovery cancelled');
    }
    const positive = value => Number.isSafeInteger(value) && value > 0;
    const models = [];
    for (const entry of listing.data) {
      if (typeof entry.id !== 'string' || !entry.id.trim() || models.some(m => m.id === entry.id)) continue;
      const detail = status.find(m => m?.id === entry.id);
      const contextWindow = [detail?.max_context_window, entry.max_model_len, entry.context_length, entry.context_window].find(positive);
      const maxTokens = [detail?.max_tokens, entry.max_output_tokens].find(value => positive(value) && (!contextWindow || value < contextWindow));
      models.push({ id: entry.id, name: entry.name ?? entry.id, thinking: 'default',
        ...(positive(contextWindow) ? { contextWindow, contextSource: 'server' } : {}),
        ...(positive(maxTokens) && (!positive(contextWindow) || maxTokens < contextWindow) ? { maxTokens, outputSource: 'server' } : {}) });
    }
    return { backend, models };
  }
  /** Probe only this draft, without registering it or touching files. */
  async test(input, modelId, draftKey, signal) {
    const profile = validateProfile(input), model = profile.models.find(m => m.id === modelId);
    if (!model?.contextWindow) throw Error('Fill in the model context window before testing');
    const adapter = new CustomAdapter({ profile: () => profile, resolveKey: p => this.resolveKey(p, draftKey), fetch: this.fetch });
    const stages = [];
    const call = async (messages, tools) => {
      const chunks = [];
      for await (const chunk of adapter.stream({ provider: profile.id, model: model.id, messages, tools, maxTokens: 512, ...(profile.backend === 'omlx' ? { reasoningEffort: 'off' } : {}), signal })) chunks.push(chunk);
      const finish = chunks.find(c => c.type === 'finish');
      if (!finish || !['stop', 'tool-calls'].includes(finish.reason.kind)) throw Error('Probe did not complete normally');
      return { blocks: chunks.filter(c => c.type === 'block-end').map(c => c.block), replayState: finish.replayState };
    };
    try {
      const plain = await call([{ role: 'user', content: [{ type: 'text', text: 'Reply with exactly CUSTOM_OK.' }] }]);
      if (!plain.blocks.some(b => b.type === 'text' && b.text.trim() === 'CUSTOM_OK')) throw Error('Text probe returned an unexpected answer');
      stages.push({ name: 'Text and streaming', status: 'passed' });
      const tools = [{ name: 'lookup_probe', description: 'Look up a test value.', parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'], additionalProperties: false } }];
      const messages = [{ role: 'user', content: [{ type: 'text', text: 'Call lookup_probe with name studio. After the tool returns, reply with exactly its value.' }] }];
      const first = await call(messages, tools);
      const calls = first.blocks.filter(b => b.type === 'tool-call');
      if (calls.length !== 1 || calls[0].name !== 'lookup_probe' || JSON.parse(calls[0].arguments).name !== 'studio') throw Error('Tool probe returned an unexpected call');
      stages.push({ name: 'Streamed tool arguments', status: 'passed' });
      messages.push({ role: 'assistant', source: { provider: profile.id, model: model.id, replayState: first.replayState }, content: first.blocks });
      messages.push(createToolResultMessage({ callId: calls[0].id, content: [{ type: 'text', text: '{"value":"CUSTOM_TOOL_OK"}' }], isError: false }));
      const second = await call(messages, tools);
      if (second.blocks.some(b => b.type === 'tool-call') || !second.blocks.some(b => b.type === 'text' && b.text.trim() === 'CUSTOM_TOOL_OK')) throw Error('Tool result replay returned an unexpected answer');
      stages.push({ name: 'Tool result round trip', status: 'passed' }, { name: 'Images, thinking and long context', status: 'not tested' });
    } catch (error) { stages.push({ name: 'Probe', status: 'failed', message: signal?.aborted ? 'Cancelled' : error.message }); }
    return stages;
  }
}

export async function apply(ctx, config = {}) {
  let registration;
  const service = new CustomProviders({ store: new CustomStore(config.path || undefined), credentials: ctx.credentials,
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(attachments, hostPath => ctx.get('fs')?.processPathFromHostPath(hostPath), ref),
    changed: profiles => {
    const ids = profiles.map(p => p.id);
    if (registration) registration.replace(ids);
    else if (ids.length) registration = ctx.llm.registerAdapter(ids, service.adapter);
  } });
  ctx.provide('dscodeCustom', service);
  try { await service.refresh(); } catch { ctx.logger.warn('Could not read custom providers; repair ~/.dscode/providers.yaml'); }
  const refresh = () => { void service.refresh().catch(() => ctx.logger.warn('Invalid custom provider edit; retaining the last valid configuration')); };
  watchFile(service.store.path, { persistent: false, interval: 1000 }, refresh);
  ctx.effect(() => () => unwatchFile(service.store.path, refresh));
}
