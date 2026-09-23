/**
 * One plain snapshot of a Cordis plugin configuration.
 *
 * Two shapes make a foreign entry's `config` unusable as a plain object. DSH 0.1.7 hands
 * a `.volatile()` field to its own plugin as a reference rather than a value, and the
 * Loader keeps a YAML `!!js` scalar as an unevaluated `{ __jsExpr }` node until the entry
 * activates — which a reader inspecting another entry's row (the skills conflict report
 * walks every `skill-filesystem` entry, and a preset's rows carry such expressions) sees
 * instead of the value. References are read; an expression cannot be evaluated outside the
 * Loader's own scope, so it reads as absent and the caller applies its own fallback.
 *
 * @param config - a configuration object whose fields may be references or expressions.
 * @returns a shallow copy carrying only plainly readable values.
 */
export function plainConfig(config) {
  if (config === null || typeof config !== 'object') return {};
  const entries = Object.entries(config)
    .map(([key, value]) => [key, isReference(value) ? value.get() : value])
    .filter(([, value]) => !isExpression(value));
  return Object.fromEntries(entries);
}

/** Whether a configuration field is a Cordis value reference rather than a plain value. */
function isReference(value) {
  return value !== null && typeof value === 'object' && typeof value.get === 'function';
}

/** Whether a configuration field is still an unevaluated Loader expression node. */
function isExpression(value) {
  return value !== null && typeof value === 'object' && '__jsExpr' in value;
}
