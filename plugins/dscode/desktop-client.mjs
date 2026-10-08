globalThis.__ModuleLoader__.load({
  id: '@toddzheng024/dscode-desktop',
  factory: require => {
    const { createElement: h, useState, useEffect, useRef } = require('react');
    const columns = [['pending', 'Pending'], ['running', 'Running'], ['verifying', 'Verifying'], ['complete', 'Complete']];
    const control = { padding: '7px 10px', border: '1px solid #8886', borderRadius: 6, background: 'transparent', color: 'inherit', font: 'inherit' };
    function Board({ execute }) {
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
      const card = (task, column) => h('li', { key: task.id, style: { listStyle: 'none', border: '1px solid #8885', borderRadius: 6, padding: 10, marginTop: 8, overflowWrap: 'anywhere' } },
        h('strong', null, `${task.id} · ${task.title}`),
        h('p', { style: { margin: '6px 0', fontSize: 12 } }, `/${task.child} · ${task.priority} priority`),
        task.waiting && h('p', null, 'Waiting for the coordinator’s answer'),
        task.blockedBy.length > 0 ? h('p', null, `Blocked by ${task.blockedBy.join(', ')}`) : column === 'pending' && h('p', null, 'Ready to launch'),
        column === 'verifying' && h('p', null, 'Awaiting coordinator verification'),
        task.dependsOn.length > 0 && h('p', { style: { fontSize: 12 } }, `Depends on ${task.dependsOn.join(', ')}`),
        (task.detail || task.note || task.verification || task.worktree) && h('details', null, h('summary', null, 'Task details'),
          ...[['Scope and checks', task.detail], ['Reopened because', task.note], ['Verification evidence', task.verification], ['Worktree', task.worktree]]
            .filter(([, value]) => value).map(([label, value]) => h('div', { key: label, style: { marginTop: 8 } }, h('strong', null, label), h('p', { style: { whiteSpace: 'pre-wrap', margin: '4px 0' } }, value)))));
      return h('section', { 'aria-label': 'DSCODE delegation board', style: { padding: 16, height: '100%', overflow: 'auto', boxSizing: 'border-box' } },
        h('h2', { style: { marginTop: 0 } }, 'Delegation board'),
        h('p', { style: { fontSize: 12 } }, 'Use /delegate <task> in the main session to coordinate work in isolated Git worktrees. The coordinator plans tasks and records verified results.'),
        h('button', { type: 'button', style: control, onClick: refresh }, 'Refresh board'),
        error && h('p', { role: 'alert' }, error),
        !state && !error && h('p', { role: 'status' }, 'Loading delegation board…'),
        state && h('div', null,
          h('p', { role: 'status' }, `${state.running} of ${state.limit} child slots running`),
          !columns.some(([key]) => state.columns[key].length) && h('p', null, 'No delegated tasks yet.'),
          h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 } },
            ...columns.map(([key, label]) => h('section', { key, 'aria-label': label }, h('h3', null, `${label} (${state.columns[key].length})`),
              state.columns[key].length ? h('ul', { style: { padding: 0, margin: 0 } }, ...state.columns[key].map(task => card(task, key))) : h('p', { style: { fontSize: 12 } }, 'None')))),
          h('p', { style: { fontSize: 12 } }, 'Refreshes once per second while visible. Reading the board does not launch children, change tasks or merge work.')));
    }
    function BoardPane({ sessionId, execute, useTabInfo }) { const { tab } = useTabInfo(); return tab.visible ? h(Board, { key: sessionId, execute }) : null; }
    const id = '@toddzheng024/dscode-delegation-desktop';
    return { inject: ['slots', 'sidebarRightTabs', 'connection'], apply(ctx) {
      ctx.effect(() => ctx.sidebarRightTabs.register({ id, kind: 'dscode-delegation', multiple: false, title: () => 'Delegation board',
        guide: [{ id: 'open', order: 34, title: () => 'Delegation board', description: () => 'Follow DSCODE delegated tasks, dependencies and verification.' }] }), 'dscode-delegation.type');
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id,
        inject: sessionId => ({ sessionId, execute: async () => {
          const response = await ctx.connection.rpc.call('/api', 'dscode-delegation', { action: 'status', sessionId });
          if (!response.ok) throw Error(response.error.message); return response.value;
        } }),
      }, BoardPane)), 'dscode-delegation.body');
    } };
  },
});
