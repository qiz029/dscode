// Reasoning levels differ per model: DeepSeek offers low/high/max, GPT models
// minimal through high, and many OpenRouter models none at all. Auxiliary calls
// name the level they would like and send the nearest one the model offers, or no
// effort when the model offers no levels.

/** Standard reasoning levels, lowest first. */
export const EFFORT_LEVELS = Object.freeze(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

/**
 * The level to request from a model.
 * @param offered - the model's effort ids, or `undefined` when its capability is unknown.
 * @param wanted - the level the caller would like.
 * @returns `wanted` when offered or when the capability is unknown; otherwise the nearest
 *   offered level at or above it, else the highest below; `undefined` when the model offers
 *   no standard level.
 */
export function chooseEffort(offered, wanted) {
  if (wanted === undefined || offered === undefined || offered.includes(wanted)) return wanted;
  const rank = EFFORT_LEVELS.indexOf(wanted);
  const levels = EFFORT_LEVELS.filter(level => offered.includes(level));
  if (rank < 0 || levels.length === 0) return undefined;
  return levels.find(level => EFFORT_LEVELS.indexOf(level) >= rank) ?? levels.at(-1);
}

/**
 * {@link chooseEffort} for a route, reading the model's levels from the LLM service.
 * A service without model metadata, or a failed lookup, keeps `wanted`.
 */
export async function effortFor(llm, route, wanted, signal) {
  if (wanted === undefined || typeof llm?.resolveModelInfo !== 'function' || !route?.provider || !route?.model) return wanted;
  let info;
  try { info = await llm.resolveModelInfo(route.provider, route.model, signal); }
  catch { return wanted; }
  return chooseEffort(info?.reasoning?.efforts?.map(effort => effort.id) ?? [], wanted);
}
