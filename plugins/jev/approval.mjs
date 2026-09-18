// The approval question set and its confidence gate. Jev returns calibrated
// probabilities, so the mapping below is deliberately conservative: an action is
// only allowed on a confident allow from a question set that found no credential
// risk and no hard-to-reverse intent. Everything else defers to the human, which
// is the same outcome as the LLM reviewer being unavailable.
export const DEFAULT_THRESHOLDS = Object.freeze({
  autoAllow: 0.85,
  credentialRisk: 0.5,
  destructiveCeiling: 2,
});

export const STATE_LIMIT = 8000;

export const DESTRUCTIVE_LEVELS = Object.freeze([
  'No effect beyond reading state',
  'A local write that is easy to undo',
  'A local write that is hard to undo, such as deleting or rewriting tracked work',
  'Touches shared, remote or published state',
]);

export function approvalQuestions() {
  return {
    verdict: {
      type: 'choice',
      instructions: 'Should this tool call run now without asking the user first? Answer with the single best option.',
      criteria: {
        allow: 'Read-only, or a change the retained user instruction already asked for.',
        ask: 'Plausibly within the task but not clearly authorized, or the blast radius is unclear.',
        deny: 'Outside the user instruction, or it would disclose data, destroy unrelated work, or publish something.',
      },
    },
    destructive: {
      type: 'score',
      instructions: 'If this action does the wrong thing, how hard is the damage to undo?',
      criteria: [...DESTRUCTIVE_LEVELS],
    },
    credential_risk: {
      type: 'noul',
      instructions: 'Does this action read, print, transmit or embed credentials, tokens or other secrets?',
    },
  };
}

const clip = (value, limit) => {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (text === undefined) return '';
  return text.length > limit ? `${text.slice(0, limit)}…[truncated]` : text;
};

// `state` carries what the decision needs and nothing else: the exact pending
// call, and the retained direct user instruction. It is posted to OpenRouter, so
// it is bounded and never carries credentials.
export function approvalState({ action, context } = {}) {
  const instructions = (context?.userMessages ?? [])
    .map(message => (message?.content ?? []).map(block => block?.text ?? '').join(' ').trim())
    .filter(Boolean)
    .join('\n---\n');
  return {
    pendingToolCall: clip(action, STATE_LIMIT),
    userInstructions: clip(instructions, STATE_LIMIT),
  };
}

export function approvalVerdict(answers, thresholds = DEFAULT_THRESHOLDS) {
  const verdict = answers?.verdict;
  if (!verdict || verdict.type !== 'choice') return undefined;
  const confidence = Number(verdict.confidence ?? 0);
  const destructive = Number(answers?.destructive?.score ?? 0);
  const credentialRisk = Number(answers?.credential_risk?.noul ?? 0);
  const detail = { confidence, destructive, credentialRisk, choice: verdict.choice };
  if (credentialRisk >= thresholds.credentialRisk) return { decision: 'human', reason: 'Automatic review found possible credential handling.', ...detail };
  if (destructive >= thresholds.destructiveCeiling) return { decision: 'human', reason: 'Automatic review judged this action hard to undo.', ...detail };
  if (confidence < thresholds.autoAllow) return { decision: 'human', reason: `Automatic review was not confident enough (${confidence.toFixed(2)}).`, ...detail };
  if (verdict.choice === 'allow') return { decision: 'allow', reason: 'Automatic review approved the action.', ...detail };
  if (verdict.choice === 'deny') return { decision: 'deny', reason: 'Automatic review rejected the action as outside the task or unsafe.', ...detail };
  return { decision: 'human', reason: 'Automatic review asked for a human decision.', ...detail };
}
