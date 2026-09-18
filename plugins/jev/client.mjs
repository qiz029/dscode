// OpenRouter's alpha Decisions endpoint: one POST carries the state plus every
// typed question, and the model answers them in a single pass. This is not the
// chat-completions shape our llm provider uses, so it is a separate client.
export const DEFAULT_ENDPOINT = 'https://openrouter.ai';
export const DECISIONS_PATH = '/api/alpha/decisions';
export const DEFAULT_MODEL = '~typesafe/jev-latest';
export const QUESTION_TYPES = Object.freeze(['noul', 'choice', 'score']);
export const MAX_CHOICE_OPTIONS = 255;
export const SCORE_LEVELS = Object.freeze({ min: 2, max: 10 });

export function decisionsUrl(endpoint = DEFAULT_ENDPOINT) {
  const base = String(endpoint).replace(/\/+$/, '');
  if (!URL.canParse(base)) throw new Error(`jev: endpoint must be a URL, got ${endpoint}`);
  return base + DECISIONS_PATH;
}

// The request shape is validated here rather than trusted to the caller: a
// malformed question set is rejected locally instead of burning a round trip.
export function validateQuestions(questions) {
  if (!questions || typeof questions !== 'object' || Array.isArray(questions)) throw new Error('jev: questions must be an object');
  for (const [key, question] of Object.entries(questions)) {
    if (!question || typeof question !== 'object') throw new Error(`jev: ${key} must be a question object`);
    if (!QUESTION_TYPES.includes(question.type)) throw new Error(`jev: ${key} has unsupported type ${question.type}`);
    if (typeof question.instructions !== 'string' || !question.instructions.trim()) throw new Error(`jev: ${key} needs instructions`);
    if (question.type === 'noul') continue;
    if (question.type === 'choice') {
      const criteria = question.criteria;
      if (!criteria || typeof criteria !== 'object' || Array.isArray(criteria)) throw new Error(`jev: ${key} choice needs a criteria map`);
      const count = Object.keys(criteria).length;
      if (count === 0) throw new Error(`jev: ${key} choice needs at least one option`);
      if (count > MAX_CHOICE_OPTIONS) throw new Error(`jev: ${key} choice has ${count} options, the limit is ${MAX_CHOICE_OPTIONS}`);
      continue;
    }
    const criteria = question.criteria;
    if (!Array.isArray(criteria)) throw new Error(`jev: ${key} score needs an ordered criteria array`);
    if (criteria.length < SCORE_LEVELS.min || criteria.length > SCORE_LEVELS.max) throw new Error(`jev: ${key} score needs ${SCORE_LEVELS.min}-${SCORE_LEVELS.max} ordered levels`);
  }
  return questions;
}

export function buildBody({ model = DEFAULT_MODEL, state, questions, sessionId }) {
  validateQuestions(questions);
  if (state === undefined || state === null) throw new Error('jev: state is required');
  return { model, state, questions, ...(sessionId ? { session_id: String(sessionId).slice(0, 256) } : {}) };
}

export function readAnswers(body) {
  if (!body || typeof body !== 'object') throw new Error('jev: response is not an object');
  if (!body.answers || typeof body.answers !== 'object' || Array.isArray(body.answers)) throw new Error('jev: response is missing answers');
  return { id: body.id, model: body.model, provider: body.provider, answers: body.answers, usage: body.usage ?? null };
}

export async function requestDecisions({
  endpoint = DEFAULT_ENDPOINT, model = DEFAULT_MODEL, apiKey, state, questions, sessionId,
  timeoutMs = 8000, signal, fetchImpl = globalThis.fetch,
} = {}) {
  if (!apiKey) throw new Error('jev: no API key resolved');
  if (typeof fetchImpl !== 'function') throw new Error('jev: no fetch implementation available');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('jev: request timed out')), timeoutMs);
  const composed = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const response = await fetchImpl(decisionsUrl(endpoint), {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody({ model, state, questions, sessionId })),
      signal: composed,
    });
    if (!response.ok) throw new Error(`jev: HTTP ${response.status}`);
    return readAnswers(await response.json());
  } finally {
    clearTimeout(timer);
  }
}
