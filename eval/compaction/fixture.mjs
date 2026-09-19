import { createHash } from 'node:crypto';

export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export const categories = ['recall', 'artifact', 'decision', 'continuation', 'constraint'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
function keys(value, allowed, label) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw Error(`Unknown ${label} field`);
}
export function integer(value, name, min = 1, max = 1000000) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw Error(`${name} must be an integer in [${min}, ${max}]`);
  return value;
}
function unique(items, label) {
  if (new Set(items).size !== items.length) throw Error(`Duplicate ${label}`);
}

// Eval-only input format. It deliberately rejects unsupported roles/media instead
// of silently flattening them into text and changing the experiment.
export function validateDataset(input) {
  if (!object(input) || ![1, 2].includes(input.version) || !nonempty(input.id) || !Array.isArray(input.cases) || !input.cases.length) throw Error('Expected a version 1 or 2 dataset with id and cases');
  keys(input, ['version', 'id', 'cases'], 'dataset');
  let expandedChars = 0;
  unique(input.cases.map(item => item.id), 'case id');
  for (const item of input.cases) {
    if (!nonempty(item.id) || !nonempty(item.system) || !Array.isArray(item.stages) || !item.stages.length) throw Error('Case needs id, system and stages');
    keys(item, ['id', 'system', 'stages'], 'case');
    unique(item.stages.map(stage => stage.id), 'stage id');
    for (const stage of item.stages) {
      if (!nonempty(stage.id) || !Array.isArray(stage.messages) || !stage.messages.length || !Array.isArray(stage.probes) || !stage.probes.length) throw Error('Stage needs id, messages and probes');
      keys(stage, ['id', 'messages', 'probes'], 'stage');
      for (const message of stage.messages) {
        if (!object(message) || !['user', 'assistant', 'tool'].includes(message.role) || !nonempty(message.text)) throw Error('Only nonempty user, assistant and paired tool text messages are supported');
        keys(message, ['role', 'text', 'name', 'repeat'], 'message');
        if (message.role === 'tool' && !nonempty(message.name)) throw Error('Tool message needs a name');
        if (message.repeat !== undefined) integer(message.repeat, 'repeat', 1, 10000);
        expandedChars += message.text.length * (message.repeat ?? 1);
        if (expandedChars > 64000000) throw Error('Expanded dataset exceeds 64 million characters; split the dataset');
      }
      unique(stage.probes.map(probe => probe.id), 'probe id');
      for (const probe of stage.probes) {
        if (!nonempty(probe.id) || !nonempty(probe.question) || !categories.includes(probe.category) || !Array.isArray(probe.accept) || !probe.accept.length || !probe.accept.every(nonempty)) throw Error('Probe needs id, category, question and nonempty accepted answers');
        keys(probe, input.version === 1 ? ['id', 'category', 'question', 'accept'] : ['id', 'category', 'question', 'accept', 'grading', 'evidence'], 'probe');
        if (input.version === 2) {
          if (!object(probe.grading) || !['exact', 'semantic'].includes(probe.grading.kind)) throw Error('v2 probe needs an exact or semantic grading contract');
          keys(probe.grading, probe.grading.kind === 'exact' ? ['kind'] : ['kind', 'required', 'forbidden'], 'grading');
          if (probe.grading.kind === 'semantic' && (!Array.isArray(probe.grading.required) || !probe.grading.required.length || !probe.grading.required.every(nonempty) || !Array.isArray(probe.grading.forbidden) || !probe.grading.forbidden.every(nonempty))) throw Error('Semantic grading needs required and forbidden facts');
          if (!Array.isArray(probe.evidence) || !probe.evidence.length) throw Error('v2 probe needs source evidence');
          for (const evidence of probe.evidence) {
            keys(evidence, ['stage', 'message', 'quote'], 'evidence');
            const sourceStage = item.stages.findIndex(value => value.id === evidence.stage);
            if (sourceStage < 0 || sourceStage > item.stages.indexOf(stage) || !Number.isInteger(evidence.message) || evidence.message < 0 || !nonempty(evidence.quote) || !item.stages[sourceStage].messages[evidence.message]?.text.includes(evidence.quote)) throw Error('Evidence must quote an existing message at or before the checkpoint');
          }
        }
      }
    }
  }
  return structuredClone(input);
}

export function validatePolicies(input) {
  if (!Array.isArray(input) || !input.length) throw Error('Policies must be a nonempty array');
  unique(input.map(policy => policy.id), 'policy id');
  for (const policy of input) {
    if (!nonempty(policy.id) || typeof policy.compact !== 'boolean') throw Error('Policy needs id and compact');
    keys(policy, ['id', 'compact', 'thresholdRatio', 'retainRatio', 'summaryInstruction'], 'policy');
    if (policy.summaryInstruction !== undefined && !nonempty(policy.summaryInstruction)) throw Error('summaryInstruction must be a nonempty string');
    if (policy.compact && !(Number.isFinite(policy.thresholdRatio) && policy.thresholdRatio > 0 && policy.thresholdRatio < 1 && Number.isFinite(policy.retainRatio) && policy.retainRatio >= 0 && policy.retainRatio < policy.thresholdRatio)) throw Error('Policy requires 0 <= retainRatio < thresholdRatio < 1');
  }
  return structuredClone(input);
}

// Gold answers never enter this projection or the compressor's input. The
// optional correction is an eval-side retry hint: it never names a gold answer
// and is only appended after a reply failed the answer protocol.
export function probePrompt(probes, { correction } = {}) {
  const instruction = 'Answer using only the supplied conversation. Return exactly a JSON object {"answers":{"probe-id":"answer"}}. Use concise literal values, paths or phrases; no explanation. If unknown, answer "UNKNOWN".';
  const hint = correction ? `\nYour previous reply was rejected (${correction}) and was not recorded as an answer. Reply with ONLY that JSON object: no prose, no markdown fences, no extra keys.` : '';
  return instruction + hint + '\n' + JSON.stringify(probes.map(({ id, question }) => ({ id, question })));
}
// Preserve case: file paths, identifiers and error strings may be case-sensitive.
const normalize = text => text.normalize('NFKC').trim().replace(/\s+/gu, ' ');
export function gradeResponse(text, probes) {
  let answers, parseError = null;
  let format = 'json';
  // v2 measures factual recall. Accept one complete fenced JSON block while
  // recording the format deviation; v1's original strict parser is unchanged.
  if (probes.every(probe => probe.grading) && /^```(?:json)?\r?\n[\s\S]*\r?\n```$/u.test(text.trim())) {
    text = text.trim().replace(/^```(?:json)?\r?\n/u, '').replace(/\r?\n```$/u, '');
    format = 'markdown-fence';
  }
  try {
    const parsed = JSON.parse(text);
    if (!object(parsed) || Object.keys(parsed).length !== 1 || !object(parsed.answers)) throw Error('Expected an answers object');
    answers = parsed.answers;
    if (Object.keys(answers).some(id => !probes.some(probe => probe.id === id))) throw Error('Unexpected answer id');
  } catch { parseError = 'invalid-answer-json'; answers = {}; }
  const scores = probes.map(probe => {
    const answer = Object.hasOwn(answers, probe.id) && typeof answers[probe.id] === 'string' ? answers[probe.id] : null;
    const method = probe.grading?.kind ?? 'exact';
    // Exact agreement with a pre-approved semantic reference is a safe
    // deterministic pass. Paraphrases still go to the isolated judge.
    const accepted = answer !== null && probe.accept.some(expected => method === 'semantic' ? normalize(expected).toLocaleLowerCase() === normalize(answer).toLocaleLowerCase() : normalize(expected) === normalize(answer));
    const pending = method === 'semantic' && !accepted && answer !== null && answer.trim() && answer.trim().toUpperCase() !== 'UNKNOWN';
    const passed = accepted;
    return { id: probe.id, category: probe.category, answer, method, status: pending ? 'pending' : passed ? 'pass' : 'fail', passed };
  });
  return { parseError, format, scores, passed: scores.filter(score => score.passed).length, total: scores.length };
}
