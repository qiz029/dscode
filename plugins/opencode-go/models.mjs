// The OpenCode Go catalog DSCODE serves. Go's `/models` listing names ids only, with no
// context size, modalities or reasoning controls, and Go passes request fields through to
// each upstream, so every fact below was probed against the live gateway (2026-09): which
// `reasoning_effort` values each model accepts, whether it can switch thinking off, and
// whether it accepts image input (a text-only model answers an image with HTTP 404).
// Context windows follow each lab's published figure. DeepSeek needs the workspace's
// Global region, so its rows follow DeepSeek's own API rather than a probe.

/** Context assumed for a model the catalog does not size. */
export const DEFAULT_CONTEXT_WINDOW = 262144;

// Reasoning shapes: the harness efforts a model offers. `off` sends `none`; Ultra rides `max`.
const SWITCHABLE = Object.freeze(['off', 'low', 'high', 'max', 'ultra']);
const MANDATORY = Object.freeze(['low', 'high', 'max', 'ultra']);
const NO_MAX = Object.freeze(['off', 'low', 'high']);
const DEEPSEEK = Object.freeze(['high', 'max', 'ultra']);

const model = (id, name, contextWindow, efforts, image = false) => [id, Object.freeze({ name, contextWindow, efforts, inputModalities: image ? ['text', 'image'] : ['text'] })];

/** Chat-completions models in picker order. */
export const GO_MODELS = new Map([
  model('deepseek-v4-pro', 'DeepSeek V4 Pro', 1048576, DEEPSEEK),
  model('deepseek-v4-flash', 'DeepSeek V4 Flash', 1048576, DEEPSEEK),
  model('deepseek-v4.1-flash', 'DeepSeek V4.1 Flash', 1048576, DEEPSEEK, true),
  model('deepseek-v4-flash-vision-exp', 'DeepSeek V4 Flash Vision Exp', 1048576, DEEPSEEK, true),
  // GLM is thinking-only: `none` is refused.
  model('glm-5.3', 'GLM-5.3', 1048576, MANDATORY),
  model('glm-5.3-flash', 'GLM-5.3-Flash', 1048576, MANDATORY, true),
  model('glm-5.2', 'GLM-5.2', 1048576, MANDATORY),
  model('glm-5.1', 'GLM-5.1', 204800, MANDATORY),
  model('kimi-k3', 'Kimi K3', 1048576, SWITCHABLE, true),
  model('kimi-k2.7-code', 'Kimi K2.7 Code', 262144, MANDATORY, true),
  model('kimi-k2.6', 'Kimi K2.6', 262144, SWITCHABLE, true),
  // MiMo V2.6 refuses `max`.
  model('mimo-v2.6-pro', 'MiMo-V2.6-Pro', 1048576, NO_MAX, true),
  model('mimo-v2.6-flash', 'MiMo-V2.6-Flash', 1048576, NO_MAX, true),
  model('mimo-v2.5-pro', 'MiMo-V2.5-Pro', 1048576, SWITCHABLE),
  model('mimo-v2.5', 'MiMo-V2.5', 1048576, SWITCHABLE, true),
  // LongCat accepts `none` but keeps thinking, so it offers no Off.
  model('longcat-2.0', 'LongCat-2.0', 1048576, MANDATORY),
  model('hy4-preview', 'Hy4 preview', 1048576, SWITCHABLE),
  model('hy3', 'Hy3', 262144, SWITCHABLE),
  model('space-bunny-free', 'Space Bunny Free', DEFAULT_CONTEXT_WINDOW, MANDATORY, true),
]);

/**
 * Go models served over another protocol (Anthropic messages or OpenAI responses), which
 * this route does not speak yet; asking for one fails before any request.
 */
export const OTHER_PROTOCOL_MODELS = Object.freeze(new Map([
  ...['grok-4.7', 'grok-4.6', 'gpt-6-luna', 'gpt-5.6-luna', 'muse-spark-1.3-contributor', 'muse-spark-1.2-contributor'].map(id => [id, 'responses']),
  ...['minimax-m3', 'minimax-m2.7', 'minimax-m2.5', 'qwen3.8-max', 'qwen3.8-flash', 'qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-plus'].map(id => [id, 'messages']),
]));

/** One model's catalog entry, or undefined for an id the catalog does not describe. */
export function goModel(id) {
  return GO_MODELS.get(id);
}
