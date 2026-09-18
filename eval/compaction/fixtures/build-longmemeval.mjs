import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { validateDataset } from '../fixture.mjs';

// Converts LongMemEval_S (https://github.com/xiaowu0162/LongMemEval, ICLR 2025) into the
// replay fixture this harness evaluates, and normalizes every history into the band where a
// single compaction is both reachable and avoidable:
//   - above `thresholdRatio * window` so `compact` policies actually compact;
//   - below `window - probe reserve` so the `full` policy still fits the same window.
// Only filler sessions are dropped or repeated; every session that carries evidence survives.
const WINDOW = 131072;
const THRESHOLD_RATIO = 0.9;
const PROBE_RESERVE_TOKENS = 8192;
const MIN_TOKENS = Math.ceil(THRESHOLD_RATIO * WINDOW) + 2000;
const MAX_TOKENS = WINDOW - PROBE_RESERVE_TOKENS;
const TOKENS_PER_CHAR = 1 / 4;

const SYSTEM = [
  'You are a helpful assistant with a long history of dated sessions with this user.',
  'The conversation history above is everything you remember; there is no other source.',
  'Answer the final question using only that history.',
].join(' ');

// The fixture only accepts its own five categories, so each LongMemEval ability maps onto the
// closest one and the original type stays readable in the case id.
const CATEGORY = {
  'single-session-user': 'recall',
  'single-session-assistant': 'recall',
  'single-session-preference': 'constraint',
  'temporal-reasoning': 'recall',
  'knowledge-update': 'decision',
  'multi-session': 'recall',
};
const PLAN = [['single-session-user', 13], ['single-session-assistant', 11], ['single-session-preference', 6], ['temporal-reasoning', 25], ['knowledge-update', 14], ['multi-session', 23]];
const ABSTENTION = 8;

const tokensOf = chars => Math.ceil(chars * TOKENS_PER_CHAR);
const charsOf = sessions => sessions.reduce((total, session) => total + session.chars, 0);
const evenly = (list, count) => count >= list.length ? [...list] : Array.from({ length: count }, (_, index) => list[Math.floor(index * list.length / count)]);

/** A quote that appears verbatim inside one emitted message text. */
function quoteFrom(text) {
  const line = text.split('\n').map(value => value.trim()).find(value => value.length >= 24);
  return (line ?? text.trim()).slice(0, 160);
}

/** Normalize one history into the compaction band by dropping or repeating filler sessions. */
function fitBand(sessions, minTokens, maxTokens) {
  const kept = [...sessions];
  while (tokensOf(charsOf(kept)) > maxTokens) {
    const index = kept.findLastIndex(session => !session.evidence);
    if (index < 0) break;
    kept.splice(index, 1);
  }
  const filler = sessions.filter(session => !session.evidence);
  let cursor = 0;
  while (tokensOf(charsOf(kept)) < minTokens && filler.length > 0) {
    kept.push(filler[cursor % filler.length]);
    cursor += 1;
  }
  return kept;
}

export function buildLongMemEval(records, { minTokens = MIN_TOKENS, maxTokens = MAX_TOKENS, abstention = ABSTENTION } = {}) {
  const plain = records.filter(record => !record.question_id.endsWith('_abs'));
  const abstained = records.filter(record => record.question_id.endsWith('_abs'));
  const selected = [];
  for (const [type, count] of PLAN) {
    selected.push(...evenly(plain.filter(record => record.question_type === type).sort((a, b) => a.question_id.localeCompare(b.question_id)), count));
  }
  selected.push(...evenly(abstained.sort((a, b) => a.question_id.localeCompare(b.question_id)), abstention));

  const manifest = [];
  const cases = selected.map(record => {
    const abstains = record.question_id.endsWith('_abs');
    const evidenceIds = new Set(record.answer_session_ids);
    // The fixture rejects empty text; LongMemEval carries a handful of empty user turns.
    const sessions = record.haystack_sessions.map((turns, index) => {
      const charset = turns.filter(turn => ['user', 'assistant'].includes(turn.role) && typeof turn.content === 'string' && turn.content.trim().length > 0);
      return {
        id: record.haystack_session_ids[index],
        date: record.haystack_dates[index]?.slice(0, 10) ?? 'unknown-date',
        evidence: evidenceIds.has(record.haystack_session_ids[index]),
        charset,
        chars: charset.reduce((total, turn) => total + turn.content.length, 0),
      };
    }).filter(session => session.charset.length > 0);
    const kept = fitBand(sessions, minTokens, maxTokens);

    const messages = [];
    const sessionStart = new Map();
    let evidenceIndex = -1;
    for (const session of kept) {
      sessionStart.set(session, messages.length);
      session.charset.forEach((turn, turnIndex) => {
        const prefix = turnIndex === 0 ? `[${session.date}] ` : '';
        messages.push({ role: turn.role, text: `${prefix}${turn.content}` });
        if (evidenceIndex < 0 && turn.has_answer === true) evidenceIndex = messages.length - 1;
      });
    }
    if (evidenceIndex < 0) {
      const fallback = kept.find(session => session.evidence) ?? kept[0];
      evidenceIndex = sessionStart.get(fallback) ?? 0;
    }
    const quote = quoteFrom(messages[evidenceIndex].text);

    const answer = String(record.answer);
    const caseId = `${record.question_type}${abstains ? '-abstention' : ''}/${record.question_id}`;
    manifest.push({ case: caseId, questionType: record.question_type, abstention: abstains, sessions: kept.length, tokens: tokensOf(charsOf(kept)) });
    return {
      id: caseId,
      system: SYSTEM,
      stages: [{
        id: 'checkpoint',
        messages,
        probes: [{
          id: record.question_id,
          category: CATEGORY[record.question_type],
          question: record.question,
          accept: [answer],
          grading: abstains
            ? { kind: 'semantic', required: [`The candidate states the history never provides this information (reference reply: ${answer}).`], forbidden: [] }
            : { kind: 'semantic', required: [`The candidate means: ${answer}.`], forbidden: [] },
          evidence: [{ stage: 'checkpoint', message: Math.max(0, evidenceIndex), quote }],
        }],
      }],
    };
  });
  return { dataset: { version: 2, id: 'longmemeval-s-tier1', cases }, manifest };
}

export function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    input: { type: 'string', default: '.runtime/datasets/longmemeval/longmemeval_s.json' },
    output: { type: 'string', default: 'eval/private/longmemeval/tier1.json' },
    manifest: { type: 'string', default: 'eval/private/longmemeval/tier1-manifest.json' },
    'min-tokens': { type: 'string', default: String(MIN_TOKENS) },
    'max-tokens': { type: 'string', default: String(MAX_TOKENS) },
    abstention: { type: 'string', default: String(ABSTENTION) },
  } });
  const records = JSON.parse(readFileSync(resolve(values.input), 'utf8'));
  const { dataset, manifest } = buildLongMemEval(records, {
    minTokens: Number(values['min-tokens']), maxTokens: Number(values['max-tokens']), abstention: Number(values.abstention),
  });
  validateDataset(dataset);
  for (const path of [values.output, values.manifest]) mkdirSync(dirname(resolve(path)), { recursive: true });
  writeFileSync(resolve(values.output), JSON.stringify(dataset) + '\n');
  writeFileSync(resolve(values.manifest), JSON.stringify({ window: WINDOW, thresholdRatio: THRESHOLD_RATIO, minTokens: Number(values['min-tokens']), maxTokens: Number(values['max-tokens']), cases: manifest }, null, 2) + '\n');
  const byType = manifest.reduce((groups, item) => ({ ...groups, [item.questionType + (item.abstention ? '-abstention' : '')]: (groups[item.questionType + (item.abstention ? '-abstention' : '')] ?? 0) + 1 }), {});
  console.log(`cases ${dataset.cases.length}; tokens ${Math.min(...manifest.map(item => item.tokens))}-${Math.max(...manifest.map(item => item.tokens))}; ${JSON.stringify(byType)}`);
  return { output: resolve(values.output), manifest: resolve(values.manifest) };
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(import.meta.filename)) main();
