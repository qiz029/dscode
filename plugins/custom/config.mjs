import { randomUUID, createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { parse, stringify } from 'yaml';

export const PROTOCOLS = ['chat-completions', 'responses', 'anthropic'];
export const customId = () => `custom-${randomUUID()}`;
export const isCustomId = id => typeof id === 'string' && /^custom-[a-zA-Z0-9-]+$/.test(id);
export const keyRef = id => `DSCODE_CUSTOM_${id.replaceAll('-', '_').toUpperCase()}_API_KEY`;
export const isCustomKey = ref => /^DSCODE_CUSTOM_CUSTOM_[A-Z0-9_]+_API_KEY$/.test(ref);
const positive = value => Number.isSafeInteger(value) && value > 0;
const cleanText = value => typeof value === 'string' && value.trim() && !/[\x00-\x1f\x7f]/.test(value);

export function endpoint(profile) {
  return profile.baseURL + ({ 'chat-completions': '/chat/completions', responses: '/responses', anthropic: '/messages' })[profile.api];
}

/** Validate persisted data and drafts with the same rules; never persist a key. */
export function validateProfile(input) {
  if (!isCustomId(input?.id)) throw Error('Invalid custom provider ID');
  if (!cleanText(input.name)) throw Error('Enter a provider name');
  let url;
  try { url = new URL(input.baseURL); } catch { throw Error('Enter an HTTP or HTTPS API base URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw Error('Base URL must use HTTP(S), without credentials, query or fragment');
  if (!PROTOCOLS.includes(input.api)) throw Error('Choose a supported API format');
  if (!['none', 'bearer', 'x-api-key'].includes(input.auth)) throw Error('Choose an authentication method');
  const models = (input.models ?? []).map(model => {
    if (!cleanText(model.id)) throw Error('Enter a model ID');
    for (const field of ['contextWindow', 'maxTokens']) if (model[field] !== undefined && !positive(model[field])) throw Error(`${field} must be a positive integer`);
    if (model.maxTokens && model.contextWindow && model.maxTokens >= model.contextWindow) throw Error('Output budget must be smaller than the context window');
    if (!['default', 'off', 'on'].includes(model.thinking ?? 'default')) throw Error('Invalid thinking setting');
    const inputModalities = model.inputModalities ?? ['text'];
    if (!Array.isArray(inputModalities) || !inputModalities.includes('text') || inputModalities.some(m => !['text', 'image'].includes(m)) || new Set(inputModalities).size !== inputModalities.length) throw Error('Model input must be text or text and image');
    return {
      id: model.id.trim(), name: cleanText(model.name) ? model.name.trim() : model.id.trim(),
      ...(model.contextWindow ? { contextWindow: model.contextWindow, contextSource: model.contextSource === 'server' ? 'server' : 'user' } : {}),
      // A deliberately blank output budget selects the calculated default and
      // remains a user override when the service is discovered again.
      ...(model.maxTokens ? { maxTokens: model.maxTokens, outputSource: model.outputSource === 'server' ? 'server' : 'user' }
        : model.outputSource === 'user' ? { outputSource: 'user' } : {}),
      thinking: model.thinking ?? 'default',
      inputModalities: inputModalities.includes('image') ? ['text', 'image'] : ['text'],
    };
  });
  if (new Set(models.map(m => m.id)).size !== models.length) throw Error('Model IDs must be unique within a provider');
  const timeoutMs = input.timeoutMs ?? 180000;
  if (!positive(timeoutMs)) throw Error('Request idle timeout must be positive');
  return { id: input.id, name: input.name.trim(), baseURL: url.href.replace(/\/+$/, ''), api: input.api, auth: input.auth,
    backend: input.backend === 'omlx' ? 'omlx' : 'generic', timeoutMs, models };
}

/** Whole-file revision + cross-process lock: stale editors never overwrite another Host. */
export class CustomStore {
  constructor(path = join(homedir(), '.dscode', 'providers.yaml')) { this.path = path; }
  async read() {
    let raw;
    try { raw = await readFile(this.path, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; raw = ''; }
    const doc = raw ? parse(raw) : { version: 1, providers: [] };
    if (doc?.version !== 1 || !Array.isArray(doc.providers)) throw Error('Unsupported custom provider configuration');
    const providers = doc.providers.map(validateProfile);
    if (new Set(providers.map(p => p.id)).size !== providers.length) throw Error('Duplicate custom provider IDs');
    return { providers, revision: createHash('sha256').update(raw).digest('hex') };
  }
  async update(revision, change) {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    const lock = this.path + '.lock', temporary = this.path + '.' + randomUUID() + '.tmp';
    const deadline = Date.now() + 3000;
    for (;;) {
      try { await mkdir(lock, { mode: 0o700 }); break; } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (Date.now() >= deadline) throw Error('Custom provider configuration is locked by another process', { cause: error });
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
    try {
      const current = await this.read();
      if (current.revision !== revision) throw Error('Custom providers changed in another window; reopen this editor');
      const providers = (await change(current.providers)).map(validateProfile);
      await writeFile(temporary, stringify({ version: 1, providers }), { mode: 0o600, flag: 'wx' });
      await rename(temporary, this.path);
      return await this.read();
    } finally { await rm(temporary, { force: true }); await rm(lock, { recursive: true, force: true }); }
  }
}
