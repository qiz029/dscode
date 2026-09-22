// Human slash commands share the same durable management service as agent tools.
import { randomUUID } from 'node:crypto';
import { formatTrigger } from './config.mjs';
import { formatJob } from './jobs.mjs';
import { formatRun, readRuns } from './log.mjs';
import { formatEvent, listEvents } from './spool.mjs';

export const TRIGGER_HELP = `Usage: /trigger (or /triggers)
  list                              Definitions, registrations and scheduler status
  show <id>                         Definition and last run
  new <id>                          Create a disabled, project-local starter
  create|update <id> <JSON>          Create or edit definition fields
  enable|disable <id>                Enable or pause a trigger
  register|unregister <id>           Register or remove its recurring source
  run <id> [text]                    Queue one event for the scheduler
  schedule <id> <delay|ISO> [text]   Queue a delayed event, e.g. 30m
  jobs [id]                         Jobs and waiting reasons in this workspace
  cancel <jobId>                     Cancel a pending job
  events <id>                       Queued events and legacy spool entries
  runs <id>                         Recent run outcomes
  source <id> [action]               status | start | stop | restart | logs
  scheduler [action]                 status | install

A queued event needs a running scheduler. Disabling retains pending jobs;
stopping a source retains accepted events. Scheduler install starts the shared
service for all registered projects. Changes require a writable, non-plan session.`;

const ok = text => ({ kind: 'success', text });
const word = input => {
  const match = input.trim().match(/^(\S+)(?:\s+([\s\S]*))?$/u);
  return match ? [match[1], match[2] ?? ''] : ['', ''];
};
const usage = text => { throw new Error(`Usage: /trigger ${text}`); };
const exactId = (input, syntax) => { const [id, rest] = word(input); if (!id || rest) usage(syntax); return id; };
const schedulerText = state => `Scheduler: ${state.running ? 'running' : 'stopped — pending work waits; use /trigger scheduler install (macOS), or run dscode trigger scheduler start under a service manager'}`;

export function triggerCommand({ management, mutationProblem }) {
  return async ({ agent, rawInput = '', commandId, signal }) => {
    try {
      signal?.throwIfAborted();
      const [verb, input] = word(rawInput), action = verb || 'list';
      if (['help', '--help', '-h'].includes(action)) return ok(TRIGGER_HELP);
      const project = management.workspace(agent);
      const mutate = () => {
        signal?.throwIfAborted();
        const problem = mutationProblem(agent);
        if (problem) throw new Error(problem);
      };
      if (action === 'list') {
        if (input) usage('list');
        const result = await management.manage({ action: 'list' }, agent);
        const rows = result.definitions.map(definition => {
          const registration = result.sources.find(s => s.triggerId === definition.id) ?? result.schedules.find(s => s.triggerId === definition.id);
          const source = registration?.desired ? `source ${registration.desired} (${registration.status})` : registration ? 'registered' : definition.source.kind === 'external' ? 'external event ingress' : 'not registered';
          return `${formatTrigger(definition, { lastRun: readRuns(management.home, { triggerId: definition.id, limit: 1 })[0] })}\n    scheduler: ${source}`;
        });
        return ok([schedulerText(result.scheduler), ...rows, ...(result.problems.length ? ['Unreadable definitions:'] : []), ...result.problems.map(p => `${p.path}: ${p.message}`),
          ...(!rows.length ? ['No triggers defined. Use /trigger new <id> to create a disabled starter in .dsh/triggers/.'] : []),
          'Use /trigger help for management commands.'].join('\n'));
      }
      if (['show', 'runs', 'events'].includes(action)) {
        const id = exactId(input, `${action} <id>`);
        const definition = management.definition(project, id);
        if (action === 'show') return ok(formatTrigger(definition, { lastRun: readRuns(management.home, { triggerId: id, limit: 1 })[0] }));
        if (action === 'runs') {
          const runs = readRuns(management.home, { triggerId: id, limit: 0 }).filter(r => !r.cwd || r.cwd === project).slice(0, 20);
          return ok(runs.length ? runs.map(formatRun).join('\n') : `No runs recorded for ${id}.`);
        }
        const pending = listEvents(management.home, id);
        management.withStore(store => {
          for (const job of store.list(id).filter(j => j.project === project && j.workspace === project && j.kind === 'event' && ['pending', 'running'].includes(j.state))) {
            pending.push({ ...JSON.parse(job.payload), eventId: store.eventIdentity(job.id), receivedAt: job.createdAt });
          }
        });
        pending.sort((a, b) => a.receivedAt - b.receivedAt);
        return ok(pending.length ? pending.map(formatEvent).join('\n') : `No pending events for ${id}.`);
      }
      if (action === 'jobs') {
        const id = input ? exactId(input, 'jobs [id]') : undefined;
        const result = await management.jobs({ action: 'list', trigger_id: id, limit: 100 }, agent);
        return ok([result.jobs.length ? result.jobs.map(formatJob).join('\n') : 'No jobs scheduled in this workspace.', schedulerText(result.scheduler)].join('\n'));
      }
      if (action === 'source') {
        const [id, rest] = word(input), operation = rest || 'status';
        if (!id || !['status', 'start', 'stop', 'restart', 'logs'].includes(operation)) usage('source <id> [status|start|stop|restart|logs]');
        if (!['status', 'logs'].includes(operation)) mutate();
        const result = await management.source({ trigger_id: id, action: operation }, agent);
        if (operation === 'logs') return ok(result.log || 'No source output recorded.');
        const s = result.source;
        return ok([`${id}: desired ${s.desired ?? 'unregistered'}; observed ${s.status}${s.pid ? `; pid ${s.pid}` : ''}`,
          ...(s.error ? [`Last error: ${s.error}`] : []), ...(s.nextAt ? [`Next attempt: ${new Date(s.nextAt).toISOString()}`] : []),
          schedulerText(result.scheduler), ...(!['status'].includes(operation) ? ['Saved desired state; the scheduler applies it asynchronously. Accepted jobs remain queued.'] : [])].join('\n'));
      }
      if (action === 'scheduler') {
        const operation = input || 'status';
        if (!['status', 'install'].includes(operation)) usage('scheduler [status|install]');
        if (operation === 'install') mutate();
        const result = await management.scheduler({ action: operation });
        return ok([...(result.messages ?? []), schedulerText(result.scheduler ?? result)].join('\n'));
      }
      if (['new', 'create', 'update', 'enable', 'disable', 'register', 'unregister'].includes(action)) {
        let id, definition;
        if (['create', 'update'].includes(action)) {
          let json; [id, json] = word(input);
          if (!id || !json) usage(`${action} <id> <JSON definition fields>`);
          try { definition = JSON.parse(json); } catch { throw new Error('Definition fields must be a JSON object; see /trigger help.'); }
        } else id = exactId(input, `${action} <id>`);
        mutate();
        if (action === 'new') definition = { enabled: false, source: { kind: 'external' }, prompt: 'Describe the task for this trigger.', goal: { objective: 'Describe the outcome to complete.' } };
        const result = await management.manage({ action: action === 'new' ? 'create' : action, trigger_id: id, definition }, agent);
        return ok([`${action}: ${id}`, formatTrigger(result.definition), schedulerText(result.scheduler),
          ...(action === 'new' ? ['Starter is disabled. Edit its prompt, goal and source with /trigger update <id> <JSON>, or ask the agent to configure it, then enable it.'] : []),
          ...(action === 'disable' ? ['Pending jobs are retained; cancel them separately if needed.'] : []),
          ...(action === 'unregister' ? ['Pending recurring jobs were cancelled. Delay and emitted jobs are retained.'] : [])].join('\n'));
      }
      if (action === 'cancel') {
        const id = exactId(input, 'cancel <jobId>'); mutate();
        const result = await management.jobs({ action: 'cancel', job_id: id }, agent);
        return ok(formatJob(result.job));
      }
      if (action === 'schedule' || action === 'run') {
        const [id, rest] = word(input);
        if (!id) usage(action === 'run' ? 'run <id> [text]' : 'schedule <id> <delay|ISO> [text]');
        const identity = `slash-${commandId ?? randomUUID()}`;
        let result;
        if (action === 'schedule') {
          const [when, text] = word(rest);
          if (!when) usage('schedule <id> <delay|ISO> [text]');
          mutate();
          result = await management.jobs({ action: 'schedule', trigger_id: id, ...(/^\d+(?:\.\d+)?[smhd]$/u.test(when) ? { after: when } : { at: when }), event: { source: 'tui', text }, idempotency_key: identity }, agent);
        } else {
          mutate();
          result = await management.emit({ trigger_id: id, eventId: identity, event: { source: 'tui', text: rest } }, agent);
        }
        return ok([formatJob(result.job), schedulerText(result.scheduler), 'Queued durably; this command does not wait for the agent run.'].join('\n'));
      }
      return { kind: 'error', text: `Unknown action "${action}".\n${TRIGGER_HELP}` };
    } catch (error) { return { kind: 'error', text: error.message }; }
  };
}
