import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import { DesktopTriggerControl, DesktopTriggerManagement } from './desktop-management.mjs';
import { registerTriggerTools } from './tools.mjs';
import { triggerCommand } from './commands.mjs';
import { mutationProblem } from './unattended.mjs';

export const inject = ['agents', 'commands', 'jobs', 'agentPresets', 'agentDefaultModel', 'sessions', 'goals', 'permissionPresets'];
const isDscode = (ctx, agent) => agent && ctx.agentPresets.composedPreset(agent.ctx) === 'dscode';

/** UI requests select a live session, never a client-supplied workspace path. */
export async function triggerDesktopRequest(ctx, { control, management }, payload, signal) {
  signal?.throwIfAborted();
  if (!payload || typeof payload !== 'object') throw Error('Invalid scheduling request');
  if (['status', 'start', 'stop'].includes(payload.action)) {
    if (payload.action !== 'status') await control.setEnabled(payload.action === 'start');
    return { scheduler: await control.status(), sessions: ctx.agents.roots().filter(agent => isDscode(ctx, agent)).map(agent => ({
      id: agent.id, workspace: management.workspace(agent), writable: !mutationProblem(ctx, agent),
    })) };
  }
  if (typeof payload.sessionId !== 'string') throw Error('Choose an open DSCODE session');
  const agent = ctx.agents.get(payload.sessionId);
  if (!isDscode(ctx, agent)) throw Error('The DSCODE session is no longer open');
  if (payload.action === 'workspace') return { ...(await management.manage({ action: 'list' }, agent)),
    ...(await management.jobs({ action: 'list', limit: 50 }, agent)), writable: !mutationProblem(ctx, agent) };
  if (!['manage', 'jobs', 'source'].includes(payload.action)) throw Error('Unknown scheduling action');
  const action = payload.args?.action;
  const reading = payload.action === 'manage' ? ['list', 'get'].includes(action) : payload.action === 'jobs' ? action === 'list' : ['status', 'logs'].includes(action);
  if (!reading) {
    const problem = mutationProblem(ctx, agent);
    if (problem) throw Error(problem);
  }
  return management[payload.action](payload.args ?? {}, agent);
}

export function apply(ctx) {
  const home = process.env.DSH_HOME;
  if (!home) throw Error('Desktop scheduling requires DSH_HOME');
  const control = new DesktopTriggerControl(ctx, { home });
  const management = new DesktopTriggerManagement({ home, control });
  const service = { control, management };
  const toolScopes = new Set();
  ctx.provide('dscodeTriggers', service);
  ctx.effect(() => async () => {
    await control.dispose();
    await Promise.all([...toolScopes].map(fiber => fiber.dispose()));
  }, 'dscode desktop scheduling drain');
  void control.initialize(ctx.get('loader').await());

  ctx.on('agent/created', async ({ agent }) => {
    if (!isDscode(ctx, agent) || control.closed) return;
    const fiber = agent.ctx.inject(['tools', 'systemPrompt', 'permissionPresets'], scope => {
      if (!control.closed) registerTriggerTools(scope, { home, management });
    });
    toolScopes.add(fiber);
    agent.ctx.effect(() => () => { toolScopes.delete(fiber); });
    await fiber;
    if (control.closed) await fiber.dispose();
  });
  const handler = triggerCommand({ management, mutationProblem: agent => mutationProblem(ctx, agent) });
  for (const name of ['trigger', 'triggers']) ctx.commands.register({ name, description: 'Manage DSCODE schedules; /trigger help',
    input: { hint: '[list|create|update|schedule|jobs|source|scheduler|help]' },
    handler: args => isDscode(ctx, args.agent) ? handler(args) : { kind: 'error', text: 'Choose a DSCODE session to manage its schedules.' },
  });
  // An unattended run must not use generic job_kill to stop every other
  // project's scheduler after its own trigger_scheduler mutation was denied.
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    if (decision.kind !== 'allow' || exec.name !== 'job_kill' || exec.arguments?.job_id !== control.owner.status().job_id) return decision;
    const problem = mutationProblem(ctx, exec.agent);
    return problem ? { kind: 'deny', reason: problem } : { kind: 'ask', reason: 'Stopping the DSCODE scheduler interrupts scheduled work for every registered project.' };
  }, { prepend: true });

  ctx.inject(['connection'], scope => {
    scope.effect(() => scope.connection.fetch.register({ path: '/api/dscode-triggers', methods: ['POST'], requestBody: 'buffered',
      fetch: async request => {
        let body;
        try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
        const parsed = clientRequestSchema.safeParse(body);
        if (!parsed.success || parsed.data.method !== 'dscode-triggers') return new Response('Invalid scheduling request', { status: 400 });
        const { rpcId, payload } = parsed.data;
        let result;
        try { result = { ok: true, value: await triggerDesktopRequest(ctx, service, payload, request.signal) }; }
        catch (error) { result = { ok: false, error: { code: 'dscode-triggers', message: error.message, details: {} } }; }
        return Response.json({ type: 'server-response', rpcId, result }, { headers: { 'Cache-Control': 'no-store' } });
      },
    }), 'dscode scheduling rpc');
  }).then(undefined, error => { ctx.logger.error(`Scheduling transport failed: ${error.message}`); });
}
