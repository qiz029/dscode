import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fingerprint, userRequest, selectRequests, validateTopics, detectProject } from './content.mjs';

export const defaults = { enabled: true, topicCount: 5, minMessages: 3, debounceMs: 1500, cooldownMs: 60000, timeoutMs: 30000, maxMessages: 32, maxInputChars: 16000 };
export function resolveConfig(options = {}) {
  const config = { ...defaults, ...options };
  if (typeof config.enabled !== 'boolean') throw Error('Invalid session card enabled switch');
  for (const [key, min, max] of [['topicCount', 1, 10], ['minMessages', 1, 100], ['debounceMs', 0, 60000], ['cooldownMs', 0, 3600000], ['timeoutMs', 1000, 120000], ['maxMessages', 5, 100], ['maxInputChars', 1000, 64000]]) {
    if (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max) throw Error(`Invalid session card ${key}`);
  }
  if (config.minMessages > config.maxMessages) throw Error('Session card minMessages exceeds maxMessages');
  if (!!config.provider !== !!config.model) throw Error('Session card provider and model must be configured together');
  return config;
}

// One bounded background request per Host. Session ownership, input admission
// and the model driver remain native Harness responsibilities.
export class SessionCards {
  constructor({ root, config = {}, generate, project = detectProject }) {
    this.root = root; this.config = resolveConfig(config); this.generate = generate; this.project = project;
    this.states = new Map(); this.projects = new Map(); this.projectTasks = new Set(); this.closed = false;
    this.stop = new AbortController(); this.running = null; this.timer = null;
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  path(session) { return join(this.root, fingerprint(session.id) + '.json'); }
  input(state) { return selectRequests(state.requests, this.config.maxMessages, this.config.maxInputChars); }
  hash(state) { return fingerprint({ topicCount: this.config.topicCount, messages: this.input(state) }); }
  track(session) {
    if (this.closed || session.header.agentPreset !== 'dscode' || session.header.origin === 'subagent') return null;
    if (this.states.has(session.id)) return this.states.get(session.id);
    const requests = session.snapshotEvents().map(userRequest).filter(Boolean);
    const state = { session, requests: requests.slice(-this.config.maxMessages).map(m => ({ ...m, text: m.text.slice(0, 4000) })),
      project: null, topics: [], hash: '', updatedAt: null, coveredUserSeq: null, status: 'empty', failures: 0,
      nextAt: Date.now() + this.config.debounceMs, lastAttempt: 0, route: session.requestHeader()?.config, usage: { calls: 0, inputTokens: 0, outputTokens: 0, unknown: 0 } };
    try {
      const raw = readFileSync(this.path(session), 'utf8');
      if (raw.length > 128000) throw Error('Oversized card');
      const saved = JSON.parse(raw);
      if (saved.version !== 1 || saved.sessionId !== session.id || saved.workspace !== (session.header.cwd ?? null)) throw Error('Different session');
      state.topics = validateTopics({ topics: saved.topics }, requests, this.config.topicCount);
      state.hash = saved.hash; state.updatedAt = saved.updatedAt; state.coveredUserSeq = saved.coveredUserSeq;
      if (saved.usage && ['calls', 'inputTokens', 'outputTokens', 'unknown'].every(k => Number.isFinite(saved.usage[k]) && saved.usage[k] >= 0)) state.usage = saved.usage;
    } catch { /* Missing/corrupt derived cache is regenerated from user input. */ }
    this.states.set(session.id, state);
    if (!this.projects.has(session.header.cwd)) this.projects.set(session.header.cwd, this.project(session.header.cwd, this.stop.signal));
    const task = Promise.resolve(this.projects.get(session.header.cwd)).then(project => {
      if (!this.closed && this.states.get(session.id) === state) { state.project = project; this.save(state); }
    }).catch(() => {}).finally(() => this.projectTasks.delete(task));
    this.projectTasks.add(task);
    this.updateStatus(state); this.arm(); return state;
  }
  updateStatus(state) {
    state.status = !this.config.enabled ? 'disabled' : !state.requests.length ? 'empty' : state.hash === this.hash(state) ? 'ready' : state.requests.length < this.config.minMessages ? 'insufficient' : 'pending';
  }
  observe(session, event) {
    const state = this.track(session); if (!state) return;
    const request = userRequest(event);
    if (request && !state.requests.some(m => m.seq === request.seq)) {
      state.requests.push({ ...request, text: request.text.slice(0, 4000) });
      state.requests = state.requests.slice(-this.config.maxMessages);
      state.nextAt = Math.max(Date.now() + this.config.debounceMs, state.lastAttempt + this.config.cooldownMs);
      state.failures = 0;
      state.controller?.abort(); this.updateStatus(state);
    }
    if (event.type === 'request/header') state.route = event.data.header.config;
    if (request || event.type === 'request/header') this.arm();
  }
  get(session) {
    const state = this.track(session);
    if (!state) return null;
    return Object.freeze({ card: Object.freeze({ project: state.project ? Object.freeze({ ...state.project }) : null, workspace: session.header.cwd ?? null,
      topics: Object.freeze(state.topics.map(t => Object.freeze({ ...t, sourceSeqs: Object.freeze([...t.sourceSeqs]) }))) }),
      cardState: Object.freeze({ status: state.status, updatedAt: state.updatedAt, coveredUserSeq: state.coveredUserSeq,
        latestUserSeq: state.requests.at(-1)?.seq ?? null }) });
  }
  save(state) {
    const path = this.path(state.session), tmp = path + '.' + randomUUID() + '.tmp';
    writeFileSync(tmp, JSON.stringify({ version: 1, sessionId: state.session.id, workspace: state.session.header.cwd ?? null,
      project: state.project, topics: state.topics, hash: state.hash, updatedAt: state.updatedAt, coveredUserSeq: state.coveredUserSeq, usage: state.usage }), { mode: 0o600 });
    renameSync(tmp, path);
  }
  candidates() {
    return [...this.states.values()].filter(s => this.config.enabled && s.requests.length >= this.config.minMessages && s.hash !== this.hash(s) &&
      (this.config.provider || s.route?.provider && s.route?.model));
  }
  arm() {
    if (this.closed || this.running) return;
    clearTimeout(this.timer); this.timer = null;
    const next = this.candidates().sort((a, b) => a.nextAt - b.nextAt)[0];
    if (!next) return;
    this.timer = setTimeout(() => this.pump(), Math.max(0, next.nextAt - Date.now())); this.timer.unref();
  }
  pump() {
    if (this.closed || this.running) return;
    const state = this.candidates().filter(s => s.nextAt <= Date.now()).sort((a, b) => a.nextAt - b.nextAt)[0];
    if (!state) { this.arm(); return; }
    this.running = this.extract(state).finally(() => { this.running = null; this.arm(); });
  }
  async extract(state) {
    const messages = this.input(state), hash = this.hash(state), controller = new AbortController();
    state.controller = controller; state.status = 'updating'; state.lastAttempt = Date.now();
    state.usage.calls++; let usage;
    try {
      const signal = AbortSignal.any([this.stop.signal, controller.signal, AbortSignal.timeout(this.config.timeoutMs)]);
      const result = await this.generate({ messages, topicCount: this.config.topicCount },
        { provider: this.config.provider ?? state.route.provider, model: this.config.model ?? state.route.model }, signal, state.session.id);
      usage = result.usage;
      signal.throwIfAborted();
      if (this.states.get(state.session.id) !== state || hash !== this.hash(state)) return;
      const topics = validateTopics(result.value, messages, this.config.topicCount);
      const updated = { topics, hash, updatedAt: Date.now(), coveredUserSeq: messages.at(-1)?.seq ?? null };
      this.save({ ...state, ...updated });
      Object.assign(state, updated); state.failures = 0; state.status = 'ready';
    } catch {
      if (this.closed || this.states.get(state.session.id) !== state) return;
      if (controller.signal.aborted) this.updateStatus(state);
      else {
        state.status = 'error'; state.failures++;
        state.nextAt = Date.now() + Math.min(900000, 30000 * 2 ** Math.min(state.failures - 1, 5));
      }
    } finally {
      if (usage) { state.usage.inputTokens += usage.inputTokens ?? 0; state.usage.outputTokens += usage.outputTokens ?? 0; } else state.usage.unknown++;
      if (!this.closed && this.states.get(state.session.id) === state) { try { this.save(state); } catch {} }
      state.controller = null;
    }
  }
  remove(session) { const state = this.states.get(session.id); state?.controller?.abort(); this.states.delete(session.id); this.arm(); }
  async close() { this.closed = true; clearTimeout(this.timer); this.stop.abort(); await this.running; await Promise.allSettled([...this.projectTasks]); }
}
