import { randomUUID } from 'node:crypto';
import { digest, redact, rollout, extraction, consolidation, EXTRACT_PROMPT, CONSOLIDATE_PROMPT } from './content.mjs';

export const defaults = Object.freeze({ generate: true, use: true, minIdleHours: 6, maxAgeDays: 30,
  maxPerRun: 16, maxCandidates: 32, maxUnusedDays: 30, maxInputChars: 48000,
  maxConsolidationChars: 100000, timeoutMs: 90000, extractEffort: 'low', consolidationEffort: 'high' });

export async function runPipeline({ store, persistence, generate, route, config, signal }) {
  const owner = randomUUID();
  const ttl = Math.max(60000, config.timeoutMs * 2);
  if (!store.acquire('pipeline', owner, ttl)) return { busy: true };
  const controller = new AbortController();
  const combined = AbortSignal.any([signal, controller.signal]);
  const heartbeat = setInterval(() => {
    if (!store.owns('pipeline', owner)) controller.abort();
    else store.acquire('pipeline', owner, ttl);
  }, Math.min(10000, ttl / 3));
  heartbeat.unref();
  const check = () => { combined.throwIfAborted(); if (!store.owns('pipeline', owner)) throw Error('Memory lease lost'); };
  let extracted = 0, failures = 0, lastError;
  try {
    const now = Date.now();
    const stored = (await persistence.list({ signal: combined })).filter(s =>
      s.header.origin !== 'subagent' && s.header.agentPreset === 'dscode' &&
      s.header.createdAt >= now - config.maxAgeDays * 86400000 &&
      s.header.createdAt > store.get('clearedAt', 0) && store.enabled(s.header.id) && !store.active(s.header.id) &&
      (!s.sizeBytes || s.sizeBytes <= 4 * 1024 * 1024))
      .sort((a, b) => b.header.createdAt - a.header.createdAt).slice(0, 128);
    for (const item of stored) {
      check();
      if (extracted + failures >= config.maxPerRun) break;
      const { id } = item.header;
      const revision = String(item.revision);
      if (!store.pending(id, revision)) continue;
      let handle;
      try {
        handle = await persistence.open(id, 'read', { signal: combined });
        const { events } = await handle.read(0, 100001, { signal: combined });
        if (events.length > 100000) continue;
        // reduce, not a spread: a 100k-event session passes the guard above but sits near V8's argument limit.
        const latest = events.reduce((newest, event) => Math.max(newest, event.time), item.header.createdAt);
        if (latest > now - config.minIdleHours * 3600000) continue;
        const input = rollout(item.header, events, config.maxInputChars);
        if (!input.messages.some(m => m.role === 'user')) continue;
        const value = extraction(await generate(EXTRACT_PROMPT, input, route, config.extractEffort, combined), input);
        check();
        // A resumed/changed or disabled session must not commit a stale result.
        const current = (await persistence.list({ signal: combined })).find(s => s.header.id === id);
        check();
        if (!current || String(current.revision) !== revision || store.active(id) || !store.enabled(id)) continue;
        store.save(id, revision, input.cwd, value); extracted++;
      } catch (error) {
        check(); store.failed(id, revision); failures++; lastError = redact(String(error.message)).slice(0, 300);
      } finally { await handle?.close(); }
    }
    check();
    store.prune(config.maxUnusedDays);
    const candidates = [];
    let size = 0;
    for (const candidate of store.candidates(config.maxUnusedDays, config.maxCandidates)) {
      const length = JSON.stringify(candidate).length;
      if (size + length > config.maxConsolidationChars) continue;
      candidates.push(candidate); size += length;
    }
    const notes = store.notes();
    const input = { candidates: candidates.map(c => ({ id: c.id, cwd: c.cwd, ...c.value })), notes };
    const fingerprint = digest(JSON.stringify(input));
    if (fingerprint === store.get('fingerprint')) { store.materialize(); return { extracted, failures, unchanged: true }; }
    let result = { summary: '', entries: [], skills: [] };
    if (candidates.length || notes.length) result = consolidation(
      await generate(CONSOLIDATE_PROMPT, input, route, config.consolidationEffort, combined),
      new Set([...candidates, ...notes].map(c => c.id)));
    check();
    // User changes during the model call invalidate the whole publication.
    if (candidates.some(c => !store.enabled(c.id)) || JSON.stringify(store.notes()) !== JSON.stringify(notes)) return { extracted, failures, deferred: true };
    store.publish({ ...result, candidates, notes, updatedAt: Date.now() }, fingerprint);
    return { extracted, failures, consolidated: true, ...(lastError ? { lastError } : {}) };
  } finally { clearInterval(heartbeat); store.release('pipeline', owner); }
}
