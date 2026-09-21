// The read-only half of the trigger mechanism: `/triggers` lists the definitions
// this machine and this project carry, and `/triggers show <id>` prints one.
// Nothing here starts a run — the ingress, the runner and the source installers
// are separate work (docs/triggers-design.md).
import { loadTriggerDefinitions, formatTrigger } from './config.mjs';
import { formatRun, readRuns } from './log.mjs';
import { formatEvent, listEvents } from './spool.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'dscode-triggers';
export const inject = ['commands'];

/** The state directory the launcher hands the child, as the other plugins read it. */
const stateHome = () => process.env.DSH_HOME ?? process.env.DSCODE_HOME ?? join(homedir(), '.local/share/dscode-hub');

export function apply(ctx) {
  ctx.commands.register({
    name: 'triggers',
    description: 'List trigger definitions, or show one by id',
    handler({ agent, rawInput }) {
      const [action, id, extra] = rawInput.trim().split(/\s+/u);
      const workspace = agent?.session?.header?.cwd;
      const { definitions, problems } = loadTriggerDefinitions({ home: stateHome(), workspace });
      const problemsText = problems.length === 0 ? [] : ['', 'Unreadable definitions:', ...problems.map(problem => `  ${problem.path}: ${problem.message}`)];
      const lastRun = id => readRuns(stateHome(), { triggerId: id, limit: 1 })[0];
      if (action === 'events') {
        if (id === undefined || id === '' || extra !== undefined) return { kind: 'error', text: 'Usage: /triggers events <id>' };
        const pending = listEvents(stateHome(), id);
        return pending.length === 0
          ? { kind: 'success', text: `No pending events for ${id}.` }
          : { kind: 'success', text: pending.map(formatEvent).join('\n') };
      }
      if (action === 'runs') {
        if (id === undefined || id === '' || extra !== undefined) return { kind: 'error', text: 'Usage: /triggers runs <id>' };
        const runs = readRuns(stateHome(), { triggerId: id, limit: 20 });
        return runs.length === 0
          ? { kind: 'success', text: `No runs recorded for ${id}.` }
          : { kind: 'success', text: runs.map(formatRun).join('\n') };
      }
      if (action !== undefined && action !== '' && action !== 'list' && action !== 'show') {
        return { kind: 'error', text: `Unknown action "${action}". Usage: /triggers [list|show <id>|events <id>|runs <id>]` };
      }
      if (action === 'show') {
        if (id === undefined || id === '') return { kind: 'error', text: `Usage: /triggers show <id>\nKnown ids: ${definitions.map(definition => definition.id).join(', ') || '(none)'}` };
        const found = definitions.find(definition => definition.id === id);
        if (found === undefined) return { kind: 'error', text: `No trigger "${id}" in ${stateHome()}/triggers or ${workspace ?? '(no workspace)'}/.dsh/triggers` };
        if (extra !== undefined) return { kind: 'error', text: `Usage: /triggers show <id>` };
        return { kind: 'success', text: formatTrigger(found, { lastRun: lastRun(found.id) }) };
      }
      if (definitions.length === 0 && problems.length === 0) {
        return { kind: 'success', text: `No triggers defined.\nAdd one as ${stateHome()}/triggers/<id>.yml, or per project as <workspace>/.dsh/triggers/<id>.yml.\nThe definition format is in docs/triggers-design.md; running them is not implemented yet.` };
      }
      return { kind: 'success', text: [...definitions.map(definition => formatTrigger(definition, { lastRun: lastRun(definition.id) })), ...problemsText].join('\n') };
    },
  });
}
