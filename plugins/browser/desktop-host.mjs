import { browserForAgent } from './review.mjs';
import { BrowserPreview } from './preview.mjs';
import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';

// Reuse the Host's authenticated, origin-checked Connection carrier, including
// Electron's transport. Preview bytes never enter command lifecycle history.
export const inject = ['agents', 'commands'];
export function apply(ctx) {
  const previews = new WeakMap();
  ctx.inject(['connection'], scope => {
    const dispatch = async (action, payload, signal) => {
      try {
        if (!payload || typeof payload !== 'object' || typeof payload.sessionId !== 'string') throw Error('Choose a live session.');
        const agent = ctx.agents.get(payload.sessionId);
        if (!agent) throw Error('The session is no longer active. Open it before using Browser preview.');
        const available = !ctx.get('dscodeDesktop') || agent.session.header.agentPreset === 'dscode';
        if (action === 'availability') return { ok: true, value: { available } };
        if (!available) {
          throw Error('Browser preview belongs to DSCODE. Create a new session with the DSCODE preset; this session keeps its original browser tools.');
        }
        if (action === 'start' || action === 'stop' || action === 'resume') {
          if (action === 'resume') {
            const browser = browserForAgent(agent);
            if (browser && previews.has(browser)) previews.get(browser).frame = undefined;
          }
          // Commands persist their result in conversation history before returning.
          // Sidebar controls should leave the same readable status as typed commands.
          const result = (await ctx.commands.execute(agent, `/browser ${action}`, [], signal))?.result;
          if (result?.kind !== 'success') throw Error(result?.text ?? `Browser ${action} is unavailable.`);
          return { ok: true, value: { message: result.text } };
        }
        const browser = browserForAgent(agent);
        if (action === 'handoff') {
          const permissions = browser?.status().connected ? await browser.access.status() : undefined;
          // Reading grants can yield while the transport closes or enters handoff.
          const state = browser?.status();
          return { ok: true, value: { connected: state?.connected ?? false, handoff: state?.connected ? state.handoff ?? null : null,
            ...(state?.connected ? { permissions } : {}) } };
        }
        if (!browser) throw Error('Start this session’s browser first.');
        if (action === 'permission') {
          if (!['once', 'allow', 'block', 'forget', 'developer-mode', 'developer-allow', 'developer-block'].includes(payload.change)) throw Error('Unknown browser permission change.');
          const permissions = await browser.access.update(payload.change, payload.value);
          if (previews.has(browser)) previews.get(browser).frame = undefined;
          return { ok: true, value: { permissions } };
        }
        if (action === 'tabs') {
          const result = await browser.call('list_pages', {}, signal);
          if (result.isError) throw Error('Could not refresh browser tabs.');
          return { ok: true, value: { ...browser.status(), permissions: await browser.access.status() } };
        }
        if (!previews.has(browser)) previews.set(browser, new BrowserPreview(browser));
        const preview = previews.get(browser);
        if (action === 'capture') {
          const frame = await preview.capture(payload.pageId, signal);
          const permissions = await browser.access.status();
          browser.assertAgentControl();
          await browser.access.checkUrl(frame.url);
          browser.assertAgentControl();
          if (preview.frame !== frame || !preview.isCurrent(frame)) throw Error('The browser page changed. Refresh the preview.');
          return { ok: true, value: { ...frame, permissions } };
        }
        if (action === 'annotate') return { ok: true, value: await preview.annotate(payload.annotation, ctx, agent, signal) };
        throw Error('Unknown browser preview action.');
      } catch (error) { return { ok: false, error: { code: 'browser-preview', message: error.message, details: {} } }; }
    };
    scope.effect(() => scope.connection.fetch.register({ path: '/api/dscode-browser', methods: ['POST'], requestBody: 'buffered',
      fetch: async request => {
        let body;
        try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
        const parsed = clientRequestSchema.safeParse(body);
        if (!parsed.success || parsed.data.method !== 'dscode-browser') return new Response('Invalid preview request', { status: 400 });
        const { rpcId, payload } = parsed.data;
        const result = await dispatch(payload?.action, payload, request.signal);
        return Response.json({ type: 'server-response', rpcId, result }, { headers: { 'Cache-Control': 'no-store' } });
      },
    }), 'dscode-browser-preview.rpc');
  }).then(undefined, error => { ctx.logger.error(`Browser preview transport failed: ${error.message}`); });
}
