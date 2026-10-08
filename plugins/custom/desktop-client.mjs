// Shared Web/Desktop client. Draft keys live only in this mounted form.
globalThis.__ModuleLoader__.load({
  id: '@toddzheng024/dscode-desktop',
  factory: require => {
    const { createElement: h, useState, useEffect, useRef } = require('react');
    const control = { padding: '8px 10px', border: '1px solid #8886', borderRadius: 6, background: 'transparent', color: 'inherit', font: 'inherit', boxSizing: 'border-box' };
    const row = { display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' };
    const resetModel = model => {
      const next = { ...model, thinking: 'default', inputModalities: ['text'] };
      for (const [field, source] of [['contextWindow', 'contextSource'], ['maxTokens', 'outputSource']]) {
        if (next[source] === 'server') { delete next[field]; delete next[source]; }
      }
      return next;
    };
    function Settings({ execute }) {
      const [snapshot, setSnapshot] = useState(null), [draft, setDraft] = useState(null), [key, setKey] = useState('');
      const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState(''), [report, setReport] = useState(null), [removing, setRemoving] = useState(false);
      const pending = useRef(false), alive = useRef(true), request = useRef(null);
      const run = async (task, cancellable = false) => {
        if (pending.current) return;
        const controller = cancellable ? new AbortController() : null;
        request.current = controller;
        pending.current = true; setBusy(true); setError(''); setNotice('');
        let cancellationFailed = false;
        try { await task(controller?.signal); }
        catch (error) {
          cancellationFailed = error.cancellationFailed === true;
          if (alive.current && (!controller?.signal.aborted || cancellationFailed)) setError(error.message);
        }
        finally {
          request.current = null; pending.current = false;
          if (alive.current) {
            setBusy(false);
            if (controller?.signal.aborted) setNotice(cancellationFailed ? 'Cancellation could not be confirmed.' : 'Request cancelled.');
          }
        }
      };
      const select = profile => { setDraft(profile ? { ...profile, models: profile.models.map(model => ({ ...model })) } : null); setKey(''); setReport(null); setRemoving(false); setNotice(''); };
      const accept = value => { if (!alive.current) return; setSnapshot(value); select(value.providers.find(p => p.id === draft?.id) ?? value.providers[0]); };
      useEffect(() => {
        alive.current = true;
        void run(async () => { accept(await execute('list')); });
        return () => { alive.current = false; request.current?.abort(); };
      }, []);
      const change = values => { setDraft({ ...draft, ...values }); setReport(null); setRemoving(false); setNotice('Unsaved changes'); };
      const modelChange = (index, values) => change({ models: draft.models.map((model, i) => i === index ? { ...model, ...values } : model) });
      const button = (text, action, disabled = false, cancellable = false) => h('button', { type: 'button', style: { ...control, cursor: 'pointer' }, disabled: busy || disabled, onClick: () => run(action, cancellable) }, text);
      const input = (label, value, onChange, options = {}) => h('label', { style: { display: 'grid', gap: 5, minWidth: 180, flex: 1 } }, label,
        h('input', { 'aria-label': label, style: { ...control, width: '100%' }, value: value ?? '', onChange: event => onChange(event.target.value), ...options }));
      const choice = (label, value, choices, onChange) => h('label', { style: { display: 'grid', gap: 5, flex: 1 } }, label,
        h('select', { 'aria-label': label, value, onChange: event => onChange(event.target.value), style: control }, ...choices.map(([id, text]) => h('option', { key: id, value: id }, text))));
      return h('section', { 'aria-label': 'DSCODE model settings', style: { padding: 20, display: 'grid', gap: 16, maxWidth: 850, color: 'inherit' } },
        h('h2', { style: { margin: 0 } }, 'DSCODE models'),
        h('p', { style: { margin: 0 } }, 'Connect a private or self-hosted model service. Saved models appear in the model picker.'),
        error && h('div', { role: 'alert', style: { color: '#d85b5b', whiteSpace: 'pre-wrap' } }, error),
        notice && h('div', { role: 'status' }, notice),
        busy && request.current && h('button', { type: 'button', style: control, disabled: request.current.signal.aborted,
          onClick: () => { request.current?.abort(); setNotice('Cancelling request…'); },
        }, 'Cancel request'),
        h('div', { style: row },
          button('Reload (discard draft)', async () => accept(await execute('list'))),
          button('Add provider', async () => { const value = await execute('new'); if (alive.current) select(value); }, !snapshot)),
        h('fieldset', { disabled: busy || !snapshot, style: { border: 0, padding: 0, margin: 0, display: 'grid', gap: 16 } },
          choice('Saved provider', snapshot?.providers.some(p => p.id === draft?.id) ? draft.id : '', [['', 'Choose a provider'], ...(snapshot?.providers ?? []).map(p => [p.id, p.name])], id => select(snapshot.providers.find(p => p.id === id))),
          draft && h('div', { style: { display: 'grid', gap: 16 } },
            h('div', { style: row }, input('Provider name', draft.name, name => change({ name })),
              input('API base URL', draft.baseURL, baseURL => change({ baseURL, backend: 'generic', models: draft.models.map(resetModel) }), { placeholder: 'https://example.com/v1', type: 'url' })),
            h('div', { style: row }, choice('API format', draft.api, [['chat-completions', 'Chat Completions'], ['responses', 'Responses'], ['anthropic', 'Anthropic Messages']], api => change({ api, auth: api === 'anthropic' ? 'x-api-key' : 'bearer', models: draft.models.map(resetModel) })),
              choice('Authentication', draft.auth, [['bearer', 'Bearer token'], ['x-api-key', 'API key header'], ['none', 'None']], auth => change({ auth }))),
            draft.auth !== 'none' && input('API key', key, value => { setKey(value); setReport(null); setRemoving(false); setNotice('Unsaved changes'); }, { type: 'password', autoComplete: 'off', spellCheck: false, placeholder: 'Leave blank to keep the saved key' }),
            h('small', null, draft.credentialStatus ?? 'Not saved'),
            h('div', { style: row }, button('Discover models', async signal => {
              const found = await execute('discover', { profile: draft, key }, signal);
              if (!alive.current || signal.aborted) return;
              const models = [...draft.models];
              for (const model of found.models) {
                const index = models.findIndex(previous => previous.id === model.id), previous = models[index];
                if (index < 0) models.push(model);
                else models[index] = {
                  ...previous, ...model, thinking: previous.thinking,
                  ...(previous.contextSource === 'user' ? { contextWindow: previous.contextWindow, contextSource: 'user' } : {}),
                  ...(previous.outputSource === 'user' ? { maxTokens: previous.maxTokens, outputSource: 'user' } : {}),
                };
              }
              change({ backend: found.backend, models });
              setNotice(`Found ${found.models.length} models. Confirm the context size and image support before saving.`);
            }, false, true), button('Add model', async () => change({ models: [...draft.models, { id: '', thinking: 'default', inputModalities: ['text'] }] }))),
            ...draft.models.map((model, index) => h('fieldset', { key: index, style: { border: '1px solid #8886', borderRadius: 8, padding: 14, display: 'grid', gap: 12 } },
              h('legend', null, `Model ${index + 1}`),
              h('div', { style: row }, input(`Model ${index + 1} ID`, model.id, id => change({ models: draft.models.map((entry, i) => i === index ? { ...resetModel(entry), id } : entry) })),
                input(`Model ${index + 1} context`, model.contextWindow, value => modelChange(index, { contextWindow: value ? Number(value) : undefined, contextSource: 'user' }), { type: 'number', min: 1, step: 1 }),
                input(`Model ${index + 1} output limit`, model.maxTokens, value => modelChange(index, { maxTokens: value ? Number(value) : undefined, outputSource: 'user' }), { type: 'number', min: 1, step: 1 })),
              h('div', { style: row }, choice(`Model ${index + 1} thinking`, model.thinking ?? 'default', [['default', 'Provider default'], ['off', 'Off'], ['on', 'On']], thinking => modelChange(index, { thinking })),
                h('label', null, h('input', { type: 'checkbox', 'aria-label': `Model ${index + 1} accepts images`, checked: model.inputModalities?.includes('image') ?? false,
                  onChange: event => modelChange(index, { inputModalities: event.target.checked ? ['text', 'image'] : ['text'] }) }), ' Accepts images')),
              h('div', { style: row }, button(`Test model ${index + 1}`, async signal => {
                setReport(null);
                const stages = await execute('test', { profile: draft, model: model.id, key }, signal);
                if (alive.current && !signal.aborted) setReport({ model: model.id, stages });
              }, !model.id || !model.contextWindow, true),
                button(`Remove model ${index + 1}`, async () => change({ models: draft.models.filter((_, i) => i !== index) }))))),
            h('p', { style: { margin: 0, fontSize: 13 } }, 'Tests send text and tool calls to this service and may incur usage. Image support is a manual setting; the test does not verify vision.'),
            report && h('div', null,
              h('h3', { style: { margin: 0 } }, `Test results: ${report.model}`),
              h('ul', { 'aria-label': 'Model test results' }, ...report.stages.map((stage, index) => h('li', { key: index }, `${stage.name}: ${stage.status}${stage.message ? ` — ${stage.message}` : ''}`)))),
            h('div', { style: row }, button('Save provider', async () => {
              const saved = await execute('save', { profile: draft, key, revision: snapshot.revision });
              if (alive.current) { accept(saved); setNotice('Provider saved. Select its model in a session.'); }
            }, draft.models.length === 0 || draft.models.some(model => !model.contextWindow)),
            snapshot?.providers.some(p => p.id === draft.id) && button(removing ? 'Confirm remove provider and key' : 'Remove provider', async () => {
              if (!removing) { setRemoving(true); return; }
              const saved = await execute('remove', { id: draft.id, revision: snapshot.revision });
              if (alive.current) { accept(saved); setNotice('Provider removed.'); }
            })))));
    }
    return {
      inject: ['slots', 'connection'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dscode-models', order: 11, label: () => 'DSCODE models',
          inject: () => ({ execute: async (action, args = {}, signal) => {
            signal?.throwIfAborted();
            const requestId = signal ? crypto.randomUUID() : undefined;
            let cancellation;
            const cancel = () => {
              cancellation ??= ctx.connection.rpc.call('/api', 'dscode-custom', { action: 'cancel', requestId }, AbortSignal.timeout(10000))
                .then(response => response.ok ? null : response.error.message, error => error.message);
            };
            signal?.addEventListener('abort', cancel, { once: true });
            let response, requestError;
            try {
              response = await ctx.connection.rpc.call('/api', 'dscode-custom', { action, ...args, ...(requestId ? { requestId } : {}) }, signal);
            } catch (error) { requestError = error; }
            finally { signal?.removeEventListener('abort', cancel); }
            if (cancellation) {
              const failure = await cancellation;
              if (failure) {
                const error = Error('Could not confirm server cancellation. The request may still be running: ' + failure);
                error.cancellationFailed = true;
                throw error;
              }
            }
            if (requestError) throw requestError;
            if (!response.ok) throw Error(response.error.message);
            return response.value;
          } }),
        }, Settings));
      },
    };
  },
});
