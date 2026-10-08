globalThis.__ModuleLoader__.load({
  id: '@toddzheng024/dscode-desktop-preset-probe',
  factory: require => {
    const { createElement: h, useState, useEffect, useRef } = require('react');
    const control = { padding: '8px 10px', border: '1px solid #8886', borderRadius: 6, background: 'transparent', color: 'inherit', font: 'inherit' };
    function Accounts({ execute }) {
      const [state, setState] = useState(null), [key, setKey] = useState(''), [busy, setBusy] = useState(false);
      const [error, setError] = useState(''), [notice, setNotice] = useState(''), [confirm, setConfirm] = useState(null);
      const [refreshError, setRefreshError] = useState('');
      const pending = useRef(null), foreground = useRef(false), alive = useRef(true);
      const run = async (action, args = {}, background = false) => {
        if (background ? pending.current : foreground.current) return;
        if (!background) { foreground.current = true; setBusy(true); setError(''); }
        const previous = pending.current;
        const operation = (async () => {
          if (previous) await previous;
          if (!alive.current) return;
          try {
            const value = await execute(action, args);
            if (!alive.current) return;
            setState(value); setRefreshError('');
            if (action === 'status' && !value.opencode.pending) setNotice('');
            if (action !== 'status') { setNotice(value.notice ?? ''); setConfirm(null); }
            if (action === 'save-openrouter' || action === 'remove-openrouter') setKey('');
          } catch (error) {
            if (alive.current) {
              if (background) setRefreshError(`Unable to refresh accounts: ${error.message}`);
              else setError(error.message);
            }
          }
        })();
        pending.current = operation;
        try { await operation; } finally {
          if (pending.current === operation) pending.current = null;
          if (!background) { foreground.current = false; if (alive.current) setBusy(false); }
        }
      };
      useEffect(() => { alive.current = true; void run('status'); return () => { alive.current = false; }; }, []);
      useEffect(() => {
        if (!state?.opencode.pending) return;
        const timer = setInterval(() => { void run('status', {}, true); }, 2000);
        return () => clearInterval(timer);
      }, [state?.opencode.pending]);
      const button = (text, action, disabled = false) => h('button', { type: 'button', style: control, disabled: busy || disabled, onClick: action }, text);
      const destructive = (id, label) => button(confirm === id ? `Confirm ${label.toLowerCase()}` : label, () => confirm === id ? run(id) : setConfirm(id));
      return h('section', { 'aria-label': 'DSCODE account settings', style: { padding: 20, display: 'grid', gap: 16, maxWidth: 720 } },
        h('h2', { style: { margin: 0 } }, 'DSCODE accounts'),
        error && h('div', { role: 'alert' }, error),
        refreshError && h('div', { role: 'alert' }, refreshError),
        notice && h('div', { role: 'status', style: { whiteSpace: 'pre-wrap' } }, notice),
        button('Refresh account status', () => run('status')),
        state && h('fieldset', { disabled: busy, style: { border: '1px solid #8886', borderRadius: 8, padding: 16 } },
          h('legend', null, 'DSCODE OpenRouter'),
          h('p', null, state.openrouter.configured ? `Configured (${state.openrouter.source ?? 'saved'})` : 'No API key saved'),
          h('p', null, 'The key is shared with DSCODE terminal sessions and native routes using the same credential. Select DSCODE OpenRouter in the model picker for DSCODE reasoning controls.'),
          h('label', null, 'OpenRouter API key', h('input', { 'aria-label': 'OpenRouter API key', type: 'password', autoComplete: 'new-password', style: { ...control, display: 'block', width: '100%', boxSizing: 'border-box' },
            value: key, disabled: !state.openrouter.writable, onChange: event => { setKey(event.target.value); setConfirm(null); } })),
          h('div', { style: { display: 'flex', gap: 8, marginTop: 12 } },
            button('Save OpenRouter key', () => run('save-openrouter', { key }), !state.openrouter.writable || !key.trim()),
            state.openrouter.configured && state.openrouter.writable && destructive('remove-openrouter', 'Remove OpenRouter key'))),
        state && h('fieldset', { disabled: busy, style: { border: '1px solid #8886', borderRadius: 8, padding: 16 } },
          h('legend', null, 'Grok'),
          h('p', null, state.grok.configured ? 'Local Grok CLI login available' : 'No usable local Grok CLI login'),
          h('p', null, 'Run grok login in a terminal, then refresh this status. DSCODE reads ~/.grok/auth.json without changing or refreshing its tokens.')),
        state && h('fieldset', { disabled: busy, style: { border: '1px solid #8886', borderRadius: 8, padding: 16 } },
          h('legend', null, 'OpenCode Go'),
          h('p', { style: { whiteSpace: 'pre-wrap' } }, state.opencode.lines.join('\n')),
          h('p', null, 'Sign in opens the OpenCode consent page in your browser. It identifies the OpenCode CLI client used for this login.'),
          h('div', { style: { display: 'flex', gap: 8 } },
            button('Sign in to OpenCode Go', () => run('login-opencode'), state.opencode.pending),
            state.opencode.pending && button('Cancel OpenCode login', () => run('cancel-opencode')),
            state.opencode.configured && destructive('logout-opencode', 'Sign out of OpenCode Go'))));
    }
    return { inject: ['slots', 'connection'], apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dscode-accounts', order: 12, label: () => 'DSCODE accounts',
        inject: () => ({ execute: async (action, args = {}) => {
          const response = await ctx.connection.rpc.call('/api', 'dscode-accounts', { action, ...args });
          if (!response.ok) throw Error(response.error.message);
          return response.value;
        } }),
      }, Accounts));
    } };
  },
});
