globalThis.__ModuleLoader__.load({
  id: '@toddzheng024/dscode-desktop',
  factory: require => {
    const { createElement: h, useState, useEffect, useRef } = require('react');
    const money = (cost, partial = false) => cost === null || partial && cost === 0 ? 'Unknown' : `$${cost.toFixed(4)}${partial ? '+' : ''}`;
    const percent = value => value === null ? 'Unknown' : `${value.toFixed(1)}%`;
    const speed = value => value === null ? 'Unknown' : `${value.toFixed(1)} tokens/s`;
    const control = { padding: '7px 10px', border: '1px solid #8886', borderRadius: 6, background: 'transparent', color: 'inherit', font: 'inherit' };
    function Usage({ execute }) {
      const [state, setState] = useState(null), [error, setError] = useState('');
      const active = useRef(false), alive = useRef(true);
      const refresh = async () => {
        if (active.current) return; active.current = true;
        try { const next = await execute(); if (alive.current) { setState(next); setError(''); } }
        catch (error) { if (alive.current) { setState(null); setError(error.message); } }
        finally { active.current = false; }
      };
      useEffect(() => { alive.current = true; void refresh(); const timer = setInterval(refresh, 1000);
        return () => { alive.current = false; clearInterval(timer); }; }, []);
      const fact = (label, value) => h('div', { key: label, style: { padding: 10, border: '1px solid #8884', borderRadius: 6 } },
        h('dt', { style: { fontSize: 12, marginBottom: 5 } }, label), h('dd', { style: { margin: 0, fontVariantNumeric: 'tabular-nums' } }, value));
      return h('section', { 'aria-label': 'DSCODE session usage', style: { padding: 16, height: '100%', overflow: 'auto', boxSizing: 'border-box' } },
        h('h2', { style: { marginTop: 0 } }, 'Session usage'),
        h('p', { style: { fontSize: 12 } }, 'Recorded model usage for this DSCODE session, including attributed child and background calls. Costs are estimates, not an invoice.'),
        h('button', { type: 'button', style: control, onClick: refresh }, 'Refresh usage'),
        error && h('p', { role: 'alert' }, error),
        !state && !error && h('p', { role: 'status' }, 'Loading usage…'),
        state && h('div', null,
          h('p', { style: { overflowWrap: 'anywhere', fontSize: 12 } }, `${state.provider} / ${state.model}`),
          h('p', { role: 'status' }, state.requestActive ? 'Model request in progress' : 'No active model request'),
          h('dl', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 } },
            fact('Recorded cost', money(state.cost, state.partial)), fact('Model calls', state.calls ?? 'Unknown'),
            fact('Pending calls', state.pending ?? 'Unknown'), fact('Context estimate', percent(state.contextPercent)),
            fact('Input cache share', percent(state.cachePercent)), fact('Smoothed request speed', speed(state.currentTps)),
            fact('Session average speed', speed(state.averageTps)),
            state.balance !== null && fact('Cached provider balance', money(state.balance)),
            state.subscription && fact('Cached subscription usage', state.subscription),
            state.budget && fact('Configured cost budget', `${money(state.budget.spent)} / ${money(state.budget.limit)} · ${state.budget.state}`)),
          h('p', { style: { fontSize: 12 } }, 'Unknown means a reading or price is unavailable. + marks a partial cost. Pending calls have not settled. Cached account figures may lag the provider.'),
          h('h3', null, 'Cost by turn'),
          state.turns.length ? h('table', { style: { width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontVariantNumeric: 'tabular-nums' } },
            h('thead', null, h('tr', null, ...['Turn', 'Calls', 'Cost'].map(label => h('th', { key: label, style: { padding: 6 } }, label)))),
            h('tbody', null, ...state.turns.map(row => h('tr', { key: row.turn }, h('td', { style: { padding: 6 } }, row.turn), h('td', { style: { padding: 6 } }, row.calls), h('td', { style: { padding: 6 } }, money(row.cost, row.partial))))))
            : h('p', null, 'No turn costs recorded yet.'),
          state.totalTurns > 50 && h('p', { style: { fontSize: 12 } }, `Showing the latest 50 of ${state.totalTurns} turns.`),
          h('p', { style: { fontSize: 12 } }, `Cost outside recorded turn windows: ${money(state.unattributed, state.unattributedPartial)}`),
          h('p', { style: { fontSize: 12 } }, 'Refreshes once per second while visible. Reading usage does not start the agent or request new account data.')));
    }
    function UsagePane({ sessionId, execute, useTabInfo }) { const { tab } = useTabInfo(); return tab.visible ? h(Usage, { key: sessionId, execute }) : null; }
    const id = '@toddzheng024/dscode-metrics-desktop';
    return { inject: ['slots', 'sidebarRightTabs', 'connection'], apply(ctx) {
      ctx.effect(() => ctx.sidebarRightTabs.register({ id, kind: 'dscode-metrics', multiple: false, title: () => 'Session usage',
        guide: [{ id: 'open', order: 33, title: () => 'Session usage', description: () => 'Inspect DSCODE cost, context, cache and request speed.' }] }), 'dscode-metrics.type');
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id,
        inject: sessionId => ({ sessionId, execute: async () => {
          const response = await ctx.connection.rpc.call('/api', 'dscode-metrics', { action: 'status', sessionId });
          if (!response.ok) throw Error(response.error.message); return response.value;
        } }),
      }, UsagePane)), 'dscode-metrics.body');
    } };
  },
});
