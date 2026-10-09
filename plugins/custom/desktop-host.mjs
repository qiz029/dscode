import { clientRequestSchema } from '@deepseek-ai/dsh-client-connection';

/** UI-only configuration transport; never registers an Agent tool or command. */
export async function customRequest(service, payload, signal) {
  if (!service) throw Error('Custom model configuration is unavailable.');
  if (!payload || typeof payload !== 'object') throw Error('Invalid custom model request.');
  const key = payload.key ?? '';
  if (typeof key !== 'string' || key.length > 4096) throw Error('Invalid API key.');
  if (['save', 'remove'].includes(payload.action) && typeof payload.revision !== 'string') throw Error('Reload the saved providers before making changes.');
  switch (payload.action) {
    case 'list': return service.list();
    case 'new': return service.newProfile();
    case 'save': return service.save(payload.profile, key, payload.revision);
    case 'remove': return service.remove(payload.id, payload.revision);
    case 'discover': return service.discover(payload.profile, key, signal);
    case 'test': return service.test(payload.profile, payload.model, key, signal);
    default: throw Error('Unknown custom model action.');
  }
}

export function apply(ctx) {
  ctx.inject(['connection'], scope => {
    // Electron's application-protocol proxy may keep its upstream HTTP request
    // alive after renderer fetch aborts. Explicit cancellation covers that hop.
    const operations = new Map();
    const operation = id => {
      if (typeof id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(id)) throw Error('Invalid request ID.');
      for (const [key, entry] of operations) if (entry.expires <= Date.now()) operations.delete(key);
      let entry = operations.get(id);
      if (!entry) {
        if (operations.size >= 128) throw Error('Too many model requests; try again shortly.');
        entry = { controller: new AbortController(), started: false, expires: Date.now() + 60000 };
        operations.set(id, entry);
      }
      return entry;
    };
    scope.effect(() => {
      const unregister = scope.connection.fetch.register({ path: '/api/dscode-custom', methods: ['POST'], requestBody: 'buffered',
        fetch: async request => {
          let body;
          try { body = await request.json(); } catch { return new Response('Invalid JSON', { status: 400 }); }
          const parsed = clientRequestSchema.safeParse(body);
          if (!parsed.success || parsed.data.method !== 'dscode-custom') return new Response('Invalid custom model request', { status: 400 });
          const { rpcId, payload } = parsed.data;
          let result, tracked;
          try {
            // Discovery and inference enforce their own timeouts. A transport-wide
            // deadline would cut short a valid cold start or active streamed test.
            if (payload?.action === 'cancel') {
              operation(payload.requestId).controller.abort();
              result = { ok: true, value: null };
            } else {
              if (payload?.requestId !== undefined) {
                if (!['discover', 'test'].includes(payload.action)) throw Error('Only discovery and tests support cancellation.');
                const entry = operation(payload.requestId);
                entry.controller.signal.throwIfAborted();
                if (entry.started) throw Error('Request ID already used.');
                tracked = entry; tracked.started = true; tracked.expires = Infinity;
              }
              const signal = tracked ? AbortSignal.any([request.signal, tracked.controller.signal]) : request.signal;
              result = { ok: true, value: await customRequest(ctx.get('dscodeCustom'), payload, signal) };
            }
          } catch (error) {
            const secret = typeof payload?.key === 'string' ? payload.key : '';
            const message = String(error.message ?? 'Custom model request failed.');
            result = { ok: false, error: { code: 'dscode-custom', message: secret ? message.replaceAll(secret, '[redacted]') : message, details: {} } };
          }
          finally { if (tracked) tracked.expires = Date.now() + 60000; }
          return Response.json({ type: 'server-response', rpcId, result }, { headers: { 'Cache-Control': 'no-store' } });
        },
      });
      return () => {
        for (const entry of operations.values()) entry.controller.abort();
        operations.clear(); unregister();
      };
    }, 'dscode-custom.rpc');
  }).then(undefined, error => { ctx.logger.error(`Custom model transport failed: ${error.message}`); });
}
