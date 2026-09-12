import { hash, validatePolicies } from '../compaction/fixture.mjs';

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const slug = value => typeof value === 'string' && /^[a-z][a-z0-9-]*$/u.test(value);
const filePath = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/u.test(value) && !value.split('/').includes('..');

export function validateContinuationDataset(dataset) {
  if (!plain(dataset) || dataset.version !== 1 || !slug(dataset.id) || !Array.isArray(dataset.cases) || !dataset.cases.length || Object.keys(dataset).some(key => !['version', 'id', 'cases'].includes(key))) throw Error('Invalid continuation dataset');
  const ids = new Set();
  for (const item of dataset.cases) {
    if (!plain(item) || Object.keys(item).some(key => !['id', 'system', 'history', 'latest', 'pressureRatio', 'files', 'writable'].includes(key)) || !slug(item.id) || ids.has(item.id) || typeof item.system !== 'string' || !item.system.trim() || typeof item.history !== 'string' || !item.history.trim() || typeof item.latest !== 'string' || !item.latest.trim() || !Number.isFinite(item.pressureRatio) || item.pressureRatio < 0 || item.pressureRatio > .88 || !plain(item.files) || !Object.keys(item.files).length || !Array.isArray(item.writable) || !item.writable.length) throw Error(`Invalid continuation case: ${item?.id}`);
    ids.add(item.id);
    for (const [path, content] of Object.entries(item.files)) if (!filePath(path) || typeof content !== 'string' || content.length > 100000) throw Error(`Invalid fixture file: ${path}`);
    for (const path of item.writable) if (!filePath(path) || !Object.hasOwn(item.files, path)) throw Error(`Invalid writable path: ${path}`);
    if (!Object.hasOwn(item.files, 'visible.mjs') || item.writable.includes('visible.mjs')) throw Error('A read-only visible.mjs check is required');
  }
  return structuredClone(dataset);
}

export { hash, validatePolicies };

// Generate neutral history at the chosen policy window. It carries no answer,
// source code or hidden check and is identical for every policy in a case.
export function replayMessages(item, contextWindow) {
  const note = `Routine synthetic inspection for ${item.id}: formatting and generated checksums were checked; no task requirement, decision, constraint, source file, or test result changed.\n`;
  const chunkChars = Math.max(1000, Math.min(40000, Math.floor(contextWindow * .04)));
  const repeat = Math.ceil(chunkChars / note.length);
  const chunkTokens = Math.ceil(note.length * repeat / 4) + 8;
  const desired = Math.floor(contextWindow * item.pressureRatio);
  const baseline = Math.ceil((item.system.length + item.history.length + item.latest.length) / 4) + 200;
  const chunks = Math.max(0, Math.ceil((desired - baseline) / chunkTokens));
  if (chunks > 150 || chunks * note.length * repeat > 5000000) throw Error('Continuation pressure fixture exceeds bounds');
  return [{ role: 'user', text: item.history }, ...Array.from({ length: chunks }, () => ({ role: 'assistant', text: note, repeat })), { role: 'user', text: item.latest }];
}
