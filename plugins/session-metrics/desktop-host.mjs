import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';
import { footerFor, goFooterFact, grokFooterFact } from './view.mjs';
import { balanceNow } from './balance.mjs';
import { canonicalProvider } from '../providers/catalog.mjs';
import { grokSubscriptionNow } from '../grok/billing.mjs';
import { goUsageNow } from '../opencode-go/usage.mjs';

const finite = value => Number.isFinite(value) ? value : null;
/** Explicit metadata projection: no raw ledger, history, prompts or credentials. */
export function desktopMetricsRequest(ctx, payload) {
  if (payload?.action !== 'status' || typeof payload.sessionId !== 'string') throw Error('Choose a DSCODE session to view usage.');
  const agent = ctx.agents.get(payload.sessionId);
  if (!agent || ctx.agentPresets.composedPreset(agent.ctx) !== 'dscode') throw Error('Usage is available for an open DSCODE session.');
  const route = agent.session.requestHeader()?.config ?? agent.options;
  const provider = canonicalProvider(route.provider);
  return footerFor(agent.id, {}, 0, provider, 'en', (summary, context, _columns, rates) => ({
    sessionId: agent.id, provider: route.provider, model: route.model,
    cost: finite(summary.cost), partial: summary.unknown === true, calls: finite(summary.calls), pending: finite(summary.pending),
    contextPercent: finite(context), cachePercent: finite(summary.cache),
    currentTps: finite(rates.current), averageTps: finite(rates.average), requestActive: rates.active === true,
    balance: finite(balanceNow(provider)),
    subscription: provider === 'grok' ? grokFooterFact(grokSubscriptionNow()) : provider === 'opencode-go' ? goFooterFact(goUsageNow()) : null,
    turns: (summary.turns ?? []).slice(-50).reverse().map(turn => ({ turn: turn.turn, cost: finite(turn.cost), calls: turn.calls, partial: turn.unknown })),
    totalTurns: summary.turns?.length ?? 0, unattributed: finite(summary.unattributed),
    unattributedPartial: summary.unattributedUnknown === true,
    budget: summary.budget ? { limit: finite(summary.budget.limit), spent: finite(summary.budget.spent), state: summary.budget.state } : null,
    updatedAt: new Date().toISOString(),
  }));
}

export const inject = ['agents', 'agentPresets', 'connection'];
export function apply(ctx) {
  ctx.effect(() => ctx.connection.fetch.register({ path: '/api/dscode-metrics', methods: ['POST'], requestBody: 'buffered',
    fetch: async request => {
      let body;
      try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
      const parsed = clientRequestSchema.safeParse(body);
      if (!parsed.success || parsed.data.method !== 'dscode-metrics') return new Response('Invalid usage request', { status: 400 });
      const { rpcId, payload } = parsed.data;
      let result;
      try { result = { ok: true, value: desktopMetricsRequest(ctx, payload) }; }
      catch (error) { result = { ok: false, error: { code: 'dscode-metrics', message: error.message, details: {} } }; }
      return Response.json({ type: 'server-response', rpcId, result }, { headers: { 'Cache-Control': 'no-store' } });
    },
  }), 'dscode metrics rpc');
}
