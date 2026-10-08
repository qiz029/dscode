globalThis.__ModuleLoader__.load({
  id: '@toddzheng024/dscode-desktop-preset-probe',
  factory: require => {
    const { createElement: h, useState, useEffect, useRef } = require('react');
    const control = { padding: '8px 10px', border: '1px solid #8886', borderRadius: 6, background: 'transparent', color: 'inherit', font: 'inherit', boxSizing: 'border-box', minWidth: 0, maxWidth: '100%' };
    const row = { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' };
    const initial = () => ({ id: '', prompt: '', objective: '', kind: 'interval', seconds: '3600', cron: '0 9 * * 1-5', timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      command: '[]', scriptMode: 'poll', persistent: true, permission: 'read-only', enabled: true });
    function Schedules({ execute }) {
      const [snapshot, setSnapshot] = useState(null), [session, setSession] = useState(''), [workspace, setWorkspace] = useState(null);
      const [draft, setDraft] = useState(initial), [editing, setEditing] = useState(null), [busy, setBusy] = useState(false), [error, setError] = useState(''), [log, setLog] = useState('');
      const [refreshError, setRefreshError] = useState('');
      const pending = useRef(null), foreground = useRef(false), alive = useRef(true), selected = useRef(''), eventKeys = useRef(new Map()), actionError = useRef(null);
      // Foreground failures must be visible even after submitting a long form.
      // Polling errors use separate state and must not steal the user's focus.
      useEffect(() => { if (error) actionError.current?.focus(); }, [error]);
      const refresh = async () => {
        const value = await execute('status');
        if (!alive.current) return;
        setSnapshot(value);
        const id = value.sessions.some(item => item.id === selected.current) ? selected.current : value.sessions[0]?.id ?? '';
        if (id !== selected.current) { setWorkspace(null); setEditing(null); setDraft(initial()); setLog(''); }
        selected.current = id; setSession(id);
        if (id) {
          const result = await execute('workspace', { sessionId: id });
          if (alive.current && selected.current === id) setWorkspace(result);
        } else setWorkspace(null);
        if (alive.current) setRefreshError('');
      };
      const run = async (task, background = false) => {
        if (background ? pending.current : foreground.current) return;
        if (!background) { foreground.current = true; setBusy(true); setError(''); }
        const previous = pending.current;
        const operation = (async () => {
          if (previous) await previous;
          if (!alive.current) return;
          try { await task(); } catch (error) {
            if (alive.current) {
              if (background) setRefreshError(`Unable to refresh schedules: ${error.message}`);
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
      useEffect(() => {
        alive.current = true; void run(refresh);
        const timer = setInterval(() => { void run(refresh, true); }, 5000);
        return () => { alive.current = false; clearInterval(timer); };
      }, []);
      const mutate = (action, args) => run(async () => {
        await execute(action, { sessionId: selected.current, args }); await refresh();
      });
      const button = (label, action, disabled = false) => h('button', { type: 'button', style: control, disabled: busy || disabled, onClick: action }, label);
      const field = (label, key, type = 'text') => h('label', { style: { display: 'grid', gap: 4 } }, label,
        h('input', { 'aria-label': label, style: control, type, value: draft[key], disabled: key === 'id' && !!editing,
          onChange: event => setDraft(previous => ({ ...previous, [key]: event.target.value })) }));
      const select = (label, key, values) => h('label', null, label, h('select', { 'aria-label': label, style: control, value: draft[key],
        onChange: event => setDraft(previous => ({ ...previous, [key]: event.target.value })) }, ...values.map(([value, label]) => h('option', { key: value, value }, label))));
      const edit = definition => {
        setEditing(definition);
        setDraft({ ...initial(), id: definition.id, prompt: definition.prompt, objective: definition.goal.objective, kind: definition.source.kind,
          seconds: String(definition.source.seconds ?? definition.source.everySeconds ?? 3600), cron: definition.source.cron ?? '0 9 * * 1-5',
          timezone: definition.source.timezone ?? initial().timezone, command: JSON.stringify(definition.source.command ?? []),
          scriptMode: definition.source.mode ?? 'poll', persistent: definition.session.mode === 'persistent', permission: definition.permission, enabled: definition.enabled });
      };
      const save = () => run(async () => {
        const source = draft.kind === 'calendar' ? { kind: 'calendar', cron: draft.cron, timezone: draft.timezone }
          : draft.kind === 'interval' ? { kind: 'interval', seconds: Number(draft.seconds) }
            : draft.kind === 'script' ? { kind: 'script', mode: draft.scriptMode, command: JSON.parse(draft.command),
              ...(draft.scriptMode === 'poll' ? { everySeconds: Number(draft.seconds) } : {}) } : { kind: 'external' };
        const previousSource = editing?.source.kind === draft.kind ? { ...editing.source } : {};
        if (draft.kind === 'script' && draft.scriptMode === 'daemon') { delete previousSource.everySeconds; delete previousSource.timeoutSeconds; }
        await execute('manage', { sessionId: selected.current, args: { action: editing ? 'update' : 'create', trigger_id: draft.id,
          definition: { prompt: draft.prompt, source: { ...previousSource, ...source },
            goal: { ...(editing?.goal ?? {}), objective: draft.objective.trim() || draft.prompt }, session: { mode: draft.persistent ? 'persistent' : 'new' },
            permission: draft.permission, enabled: draft.enabled } } });
        if (alive.current) { setEditing(null); setDraft(initial()); }
        await refresh();
      });
      const runIdentity = definition => JSON.stringify([definition.workspace, definition.id]);
      const runOnce = definition => run(async () => {
        const identity = runIdentity(definition);
        if (!eventKeys.current.has(identity)) eventKeys.current.set(identity, crypto.randomUUID());
        await execute('jobs', { sessionId: selected.current, args: { action: 'schedule', trigger_id: definition.id, after: '1s', idempotency_key: eventKeys.current.get(identity) } });
        // Keep this task's key through a lost reply or failed refresh, even if
        // the user runs another task or changes workspace before retrying.
        await refresh(); eventKeys.current.delete(identity);
      });
      return h('section', { 'aria-label': 'DSCODE scheduling settings', style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gap: 16, padding: 20, maxWidth: 960, minWidth: 0, boxSizing: 'border-box', overflowWrap: 'anywhere' } },
        h('h2', { style: { margin: 0 } }, 'DSCODE schedules'),
        h('p', null, 'Enabling delivery runs due tasks for every registered project and remembers this choice when Desktop opens again. Keep the application open. Stopping delivery interrupts active tasks and script sources; pending jobs stay queued.'),
        error && h('div', { role: 'alert', tabIndex: -1, ref: actionError }, error),
        refreshError && h('div', { role: 'alert' }, refreshError),
        snapshot && h('div', { role: 'status' }, `Delivery: ${snapshot.scheduler.running ? 'running' : snapshot.scheduler.stopping ? 'stopping' : 'stopped'} · Resume on launch: ${snapshot.scheduler.enabled ? 'on' : 'off'}${snapshot.scheduler.owner === 'external' ? ' · controlled by another process' : ''}`),
        snapshot?.scheduler.error && h('div', { role: 'alert' }, snapshot.scheduler.error),
        h('div', { style: row },
          button('Enable delivery and resume on launch', () => run(async () => { await execute('start'); await refresh(); }), !snapshot || snapshot.scheduler.owner === 'external' || snapshot.scheduler.running || snapshot.scheduler.stopping),
          button('Stop delivery and disable resume', () => run(async () => { await execute('stop'); await refresh(); }), !snapshot || (!snapshot.scheduler.enabled && !snapshot.scheduler.running)),
          button('Refresh schedules', () => run(refresh))),
        snapshot?.scheduler.owner === 'external' && h('p', null, snapshot.scheduler.next_step),
        h('label', null, 'Workspace session', h('select', { 'aria-label': 'Workspace session', style: { ...control, display: 'block', width: '100%' }, value: session, disabled: busy,
          onChange: event => { selected.current = event.target.value; setSession(event.target.value); setWorkspace(null); setEditing(null); setDraft(initial()); setLog(''); void run(refresh); } },
        h('option', { value: '' }, 'Choose an open DSCODE session'), ...(snapshot?.sessions ?? []).map(item => h('option', { key: item.id, value: item.id }, `${item.workspace} · ${item.id.slice(0, 8)}`)))),
        !session && h('p', null, 'Open a DSCODE session in the project you want to schedule.'),
        workspace && h('div', null,
          !workspace.writable && h('p', null, 'This session can inspect schedules. Use a writable, non-plan session to change them.'),
          ...workspace.problems.map(problem => h('div', { role: 'alert', key: problem.path }, `${problem.path}: ${problem.message}`)),
          h('h3', null, 'Tasks'),
          ...workspace.definitions.map(item => h('article', { key: item.id, style: { padding: '12px 0', borderBottom: '1px solid #8884' } },
            h('strong', null, item.id), h('p', null, `${item.enabled ? 'Enabled' : 'Paused'} · ${item.source.kind} · ${item.permission}`), h('p', { style: { whiteSpace: 'pre-wrap' } }, item.prompt),
            h('div', { style: row }, button(`Edit ${item.id}`, () => edit(item), !workspace.writable || item.origin !== 'project'),
              button(`${item.enabled ? 'Pause' : 'Enable'} ${item.id}`, () => mutate('manage', { action: item.enabled ? 'disable' : 'enable', trigger_id: item.id }), !workspace.writable || item.origin !== 'project'),
              button(`${eventKeys.current.has(runIdentity(item)) ? 'Retry' : 'Run'} ${item.id} once`, () => runOnce(item), !workspace.writable || !item.enabled)),
            item.source.kind === 'script' && h('div', { style: row },
              h('span', null, `Source: ${workspace.sources.find(source => source.triggerId === item.id)?.status ?? 'unregistered'}`),
              ...['start', 'stop', 'restart'].map(action => button(`${action} ${item.id} source`, () => mutate('source', { action, trigger_id: item.id }), !workspace.writable)),
              button(`Read ${item.id} source log`, () => run(async () => { const result = await execute('source', { sessionId: selected.current, args: { action: 'logs', trigger_id: item.id } }); if (alive.current) setLog(result.log || 'No source output recorded.'); }))))),
          log && h('pre', { 'aria-label': 'Source log', style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, log),
          !workspace.definitions.length && h('p', null, 'No tasks in this workspace.'),
          h('fieldset', { disabled: busy || !workspace.writable, style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', minWidth: 0, gap: 12, border: '1px solid #8886', borderRadius: 8, padding: 16 } },
            h('legend', null, editing ? `Edit ${editing.id}` : 'Create task'), field('Task ID', 'id'),
            h('label', null, 'Task instructions', h('textarea', { 'aria-label': 'Task instructions', style: { ...control, display: 'block', width: '100%', minHeight: 90 }, value: draft.prompt,
              onChange: event => setDraft(previous => ({ ...previous, prompt: event.target.value })) })),
            field('Goal (defaults to task instructions)', 'objective'),
            select('Schedule', 'kind', [['interval', 'Interval'], ['calendar', 'Calendar'], ['external', 'Manual or external event'], ['script', 'Script events']]),
            draft.kind === 'calendar' && h('div', { style: { display: 'grid', gap: 8 } }, field('Cron expression', 'cron'), field('Timezone', 'timezone')),
            draft.kind === 'script' && h('div', { style: { display: 'grid', gap: 8 } }, field('Script command (JSON argument array)', 'command'), select('Script mode', 'scriptMode', [['poll', 'Poll'], ['daemon', 'Daemon']])),
            (draft.kind === 'interval' || (draft.kind === 'script' && draft.scriptMode === 'poll')) && field('Interval seconds', 'seconds', 'number'),
            select('Run permission', 'permission', [['read-only', 'Read only'], ['workspace-write', 'Write in this workspace']]),
            ...[['persistent', 'Continue the task’s own session'], ['enabled', 'Enable this task']].map(([key, label]) => h('label', { key }, h('input', { type: 'checkbox', checked: draft[key],
              onChange: event => setDraft(previous => ({ ...previous, [key]: event.target.checked })) }), label)),
            h('div', { style: row }, button(editing ? 'Save task changes' : 'Create task', save, !draft.id.trim() || !draft.prompt.trim()),
              editing && button('Cancel editing', () => { setEditing(null); setDraft(initial()); }))),
          h('h3', null, 'Recent jobs'),
          ...workspace.jobs.map(job => h('div', { key: job.id, style: { ...row, padding: '8px 0' } },
            h('span', { style: { flex: 1 } }, `${job.triggerId}: ${job.state}${job.reason ? ` (${job.reason})` : ''} · ${new Date(job.dueAt).toLocaleString()}`),
            job.state === 'pending' && button(`Cancel ${job.triggerId} job`, () => mutate('jobs', { action: 'cancel', job_id: job.id }), !workspace.writable))),
          !workspace.jobs.length && h('p', null, 'No jobs in this workspace.')));
    }
    return { inject: ['slots', 'connection'], apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dscode-schedules', order: 13, label: () => 'DSCODE schedules',
        inject: () => ({ execute: async (action, args = {}) => {
          const response = await ctx.connection.rpc.call('/api', 'dscode-triggers', { action, ...args });
          if (!response.ok) throw Error(response.error.message);
          return response.value;
        } }),
      }, Schedules));
    } };
  },
});
