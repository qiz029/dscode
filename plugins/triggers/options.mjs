// The run spec and run result: the two files that cross the process boundary
// between `dscode trigger run` (which owns the lock, the limits and the record)
// and the Host it spawns (which owns the agent, the goal and the transcript).
// Keeping them small and validated is what lets either half be tested alone.

import { readFileSync, writeFileSync } from 'node:fs';

const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

class TriggerIoError extends Error {}

const fail = message => { throw new TriggerIoError(message); };

/** Write one JSON file atomically enough for a spawned child to read it once. */
function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  return path;
}

/** Read a JSON file that must exist and must be an object. */
function readJson(path, label) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    fail(`${label} is unreadable: ${error?.code ?? error?.message ?? error}`);
  }
  try {
    const value = JSON.parse(raw);
    if (!isPlainObject(value)) fail(`${label} must be an object`);
    return value;
  } catch (error) {
    fail(`${label} is not valid JSON: ${error?.message ?? error}`);
  }
}

/**
 * Render the prompt one run sends: the definition's template with the event's
 * values substituted. A template that never mentions the event text gets it
 * appended, so an event can never be silently dropped by a forgetting template.
 * @param template - the definition's prompt.
 * @param event - the event that fired the run, when there is one.
 * @returns the prompt text.
 */
export function renderPrompt(template, event) {
  const text = typeof template === 'string' ? template : '';
  if (event === undefined || event === null) return text;
  let rendered = text
    .replace(/\{\{event\.text\}\}/gu, event.text ?? '')
    .replace(/\{\{event\.title\}\}/gu, event.title ?? '')
    .replace(/\{\{event\.source\}\}/gu, event.source ?? '')
    .replace(/\{\{event\.eventId\}\}/gu, event.eventId ?? '')
    .replace(/\{\{event\.fields\.([A-Za-z0-9_.-]+)\}\}/gu, (_whole, key) => {
      const value = isPlainObject(event.fields) ? event.fields[key] : undefined;
      return value === undefined ? '' : String(value);
    });
  if (!/\{\{event\./u.test(text) && String(event.text ?? '').trim() !== '') {
    const title = event.title === undefined ? '' : `${event.title}: `;
    const block = `Event (${event.source ?? 'unspecified'}): ${title}${event.text}`;
    rendered = [rendered.trimEnd(), block].filter(part => part !== '').join('\n\n');
  }
  return rendered;
}

/**
 * Write the spec the spawned Host reads.
 * @param path - where to write it.
 * @param spec - `{ triggerId, runId, workspace, prompt, preset, permission, model?, effort?, goal, limits }`.
 * @returns the path.
 */
export function writeRunSpec(path, spec) {
  if (!isPlainObject(spec)) fail('a run spec must be an object');
  for (const field of ['triggerId', 'runId', 'workspace', 'prompt', 'goal']) {
    if (spec[field] === undefined) fail(`a run spec needs ${field}`);
  }
  if (!isPlainObject(spec.goal) || typeof spec.goal.objective !== 'string' || spec.goal.objective.trim() === '') fail('a run spec needs goal.objective');
  if (!Number.isSafeInteger(spec.goal.maxRounds) || spec.goal.maxRounds <= 0) fail('a run spec needs a positive goal.maxRounds');
  return writeJson(path, spec);
}

/** Read a run spec written by {@link writeRunSpec}. */
export function readRunSpec(path) {
  const spec = readJson(path, 'the run spec');
  for (const field of ['triggerId', 'runId', 'workspace', 'prompt', 'goal']) {
    if (spec[field] === undefined) fail(`the run spec is missing ${field}`);
  }
  return spec;
}

/** Write the result the Host reports back, which the parent turns into a record. */
export function writeRunResult(path, result) {
  if (!isPlainObject(result)) fail('a run result must be an object');
  if (typeof result.outcome !== 'string') fail('a run result needs an outcome');
  if (!Number.isSafeInteger(result.exitCode)) fail('a run result needs an exitCode');
  return writeJson(path, result);
}

/**
 * Read the Host's result.
 * @param path - the result file.
 * @returns the result, or undefined when the child died before writing one.
 */
export function readRunResult(path) {
  try {
    return readJson(path, 'the run result');
  } catch {
    return undefined;
  }
}
