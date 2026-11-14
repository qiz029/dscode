import { LlmError } from '@deepseek-ai/dsh-llm';

const INPUT_MODALITIES = Object.freeze(['text', 'image', 'video']);

export const MODELS = Object.freeze([
  Object.freeze({ id: 'MiniMax-M3.1-Flash', name: 'MiniMax M3.1 Flash', contextWindow: 1_000_000,
    maxTokens: 131_072, maxOutputTokens: 524_288, inputModalities: INPUT_MODALITIES,
    efforts: Object.freeze(['low', 'medium', 'high', 'xhigh', 'max']), defaultEffort: 'max', thinking: 'adaptive', serviceTier: false }),
  Object.freeze({ id: 'MiniMax-M3', name: 'MiniMax M3', contextWindow: 1_000_000,
    maxTokens: 131_072, maxOutputTokens: 524_288, inputModalities: INPUT_MODALITIES,
    efforts: Object.freeze([]), thinking: 'disabled', serviceTier: true }),
]);

export function getModel(id) {
  const model = MODELS.find(model => model.id === id);
  if (!model) throw new LlmError('Unknown MiniMax model; select one with /model', 'INVALID_REQUEST');
  return model;
}
