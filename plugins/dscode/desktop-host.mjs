import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import { scopeOf } from '@deepseek-ai/dsh-scope';
import { COLUMNS, delegateBoardFor } from './board.mjs';

export function desktopBoardRequest(ctx, payload) {
  if (payload?.action !== 'status' || typeof payload.sessionId !== 'string') throw Error('Choose a DSCODE main session to view its delegation board.');
  const agent = ctx.agents.get(payload.sessionId);
  if (!agent || ctx.agentPresets.composedPreset(agent.ctx) !== 'dscode' || agent.session.header.origin === 'subagent') {
    throw Error('The delegation board is available for an open DSCODE main session.');
  }
  const board = delegateBoardFor(agent.id, scopeOf(agent.ctx));
  if (!board) throw Error('The delegation policy is unavailable for this session.');
  return { sessionId: agent.id, running: board.running, limit: board.limit,
    columns: Object.fromEntries(COLUMNS.map(column => [column, board.columns[column].map(task => ({
      id: task.id, title: task.title, child: task.child, priority: task.priority,
      dependsOn: task.dependsOn ?? [], blockedBy: task.blockedBy ?? [], waiting: task.waiting === true,
      detail: task.detail ?? '', note: task.note ?? '', verification: task.verification ?? '', worktree: task.worktree ?? '',
    }))])),
  };
}

export const inject = ['agents', 'agentPresets', 'connection'];
export function apply(ctx) {
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/dscode-delegation', methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      let body;
      try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
      const parsed = clientRequestSchema.safeParse(body);
      if (!parsed.success || parsed.data.method !== 'dscode-delegation') return new Response('Invalid delegation request', { status: 400 });
      const { rpcId, payload } = parsed.data;
      let result;
      try { result = { ok: true, value: desktopBoardRequest(ctx, payload) }; }
      catch (error) { result = { ok: false, error: { code: 'dscode-delegation', message: error.message, details: {} } }; }
      return Response.json({ type: 'server-response', rpcId, result }, { headers: { 'Cache-Control': 'no-store' } });
    },
  }), 'dscode delegation rpc');
}
