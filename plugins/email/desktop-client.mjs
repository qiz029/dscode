globalThis.__ModuleLoader__.load({
  id: '@toddzheng024/dscode-desktop',
  factory: require => {
    const { createElement: h, useState, useEffect, useRef } = require('react');
    const control = { padding: '7px 10px', border: '.5px solid var(--dsw-alias-border-l3, #8886)', borderRadius: 'var(--dsw-radius-md, 6px)', background: 'transparent', color: 'inherit', font: 'inherit' };
    function Inbox({ execute }) {
      const [state, setState] = useState(null), [mail, setMail] = useState(null), [offset, setOffset] = useState(0);
      const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [sent, setSent] = useState(false);
      const [form, setForm] = useState({ account: '', host: 'imap.gmail.com', port: '993', mailbox: 'INBOX', password: '' });
      const [path, setPath] = useState('');
      const active = useRef(null), foreground = useRef(false), alive = useRef(true), requestId = useRef(''), formTouched = useRef(false);
      const run = async (work, background = false) => {
        if (background ? active.current : foreground.current) return;
        if (!background) { foreground.current = true; setBusy(true); setError(''); }
        const previous = active.current;
        const operation = (async () => {
          if (previous) await previous;
          if (!alive.current) return;
          try { await work(); } catch (error) { if (alive.current) setError(error.message); }
        })();
        active.current = operation;
        try { await operation; } finally {
          if (active.current === operation) active.current = null;
          if (!background) { foreground.current = false; if (alive.current) setBusy(false); }
        }
      };
      const refresh = async page => {
        const result = await execute('list', { offset: page });
        if (!alive.current) return;
        setState(result); setOffset(page);
        if (!formTouched.current && result.imap.connected) setForm(old => ({ ...old, account: result.imap.account ?? '',
          host: result.imap.host ?? 'imap.gmail.com', port: String(result.imap.port ?? 993), mailbox: result.imap.mailbox ?? 'INBOX' }));
      };
      useEffect(() => { alive.current = true; void run(() => refresh(0)); return () => { alive.current = false; }; }, []);
      useEffect(() => {
        const timer = setInterval(() => { void run(() => refresh(offset), true); }, 2000);
        return () => clearInterval(timer);
      }, [offset]);
      const action = (name, args = {}) => run(async () => {
        await execute(name, args);
        if (alive.current) await refresh(offset);
      });
      const button = (text, click, disabled = false) => h('button', { type: 'button', style: control, disabled: busy || disabled, onClick: click }, text);
      const field = (name, label, type = 'text') => h('label', { style: { display: 'grid', gap: 4 } }, label,
        h('input', { 'aria-label': label, type, autoComplete: type === 'password' ? 'new-password' : 'off', style: { ...control, width: '100%', boxSizing: 'border-box' },
          value: form[name], onChange: event => { formTouched.current = true; setForm(old => ({ ...old, [name]: event.target.value })); } }));
      const select = key => run(async () => {
        setMail(null); setSent(false); setNotice('');
        const value = await execute('read', { key });
        if (alive.current) { setMail(value); requestId.current = crypto.randomUUID(); }
      });
      return h('section', { className: 'dscode-ui', 'aria-label': 'DSCODE email inbox', style: { padding: 16, overflow: 'auto', height: '100%', boxSizing: 'border-box', display: 'flex', flexDirection: 'column', gap: 12 } },
        h('strong', null, 'Email inbox'),
        h('p', { style: { margin: 0, fontSize: 12 } }, 'Shared local inbox. Reading mail does not start the agent. Add only the message you want this session to use as external context.'),
        error && h('div', { role: 'alert' }, error),
        notice && h('div', { role: 'status' }, notice),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
          button('Refresh inbox', () => run(() => refresh(offset))),
          button('Sync now', () => action('sync'), !!state?.pending || !(state?.imap.connected || state?.gmail.connected)),
          state?.pending && button('Cancel email operation', () => action('cancel'))),
        state && h('div', { style: { fontSize: 12 } }, state.pending ? `Running: ${state.pending}`
          : state.last?.message ?? (state.imap.connected ? `IMAP · ${state.imap.account} · ${state.imap.mailbox}` : state.gmail.connected ? `Gmail · ${state.gmail.account}` : 'No mailbox connected')),
        state?.rejected > 0 && h('div', { role: 'alert' }, `${state.rejected} unreadable local records were skipped.`),
        h('details', null, h('summary', null, 'Mailbox connection'),
          h('div', { style: { display: 'grid', gap: 10, marginTop: 10 } },
            h('label', null, h('input', { type: 'checkbox', checked: state?.enabled ?? false, disabled: busy || !state,
              onChange: event => action('background', { enabled: event.target.checked }) }), ' Sync in the background while Desktop is open'),
            h('p', { style: { fontSize: 12, margin: 0 } }, 'IMAP takes precedence over Gmail OAuth. Only new [ToAgent] plain-text mail is imported. The first connection records a starting point without importing old mail.'),
            h('form', { onSubmit: event => { event.preventDefault(); void run(async () => {
              try { await execute('connect-imap', { config: { ...form, port: Number(form.port) } }); }
              finally { if (alive.current) setForm(old => ({ ...old, password: '' })); }
              if (alive.current) await refresh(offset);
            }); } }, h('fieldset', { disabled: busy || !!state?.pending, style: { display: 'grid', gap: 8, border: '.5px solid var(--dsw-alias-border-l3, #8886)', borderRadius: 'var(--dsw-radius-md, 6px)' } },
              h('legend', null, 'IMAP with an application password'),
              field('account', 'Mailbox login'), field('host', 'IMAP host'), field('port', 'TLS port'), field('mailbox', 'Mailbox folder'), field('password', 'Application password', 'password'),
              h('p', { style: { margin: 0, fontSize: 12 } }, 'Uses verified TLS and reads the selected folder without changing flags. The password is saved locally after a successful connection and never enters the conversation. Reconnect the same account and folder to update it.'),
              h('button', { style: control, type: 'submit', disabled: !form.account.trim() || !form.password }, 'Connect IMAP'))),
            h('fieldset', { disabled: busy || !!state?.pending, style: { display: 'grid', gap: 8, border: '.5px solid var(--dsw-alias-border-l3, #8886)', borderRadius: 'var(--dsw-radius-md, 6px)' } },
              h('legend', null, 'Optional Gmail OAuth'),
              h('label', null, 'Google Desktop client JSON path', h('input', { 'aria-label': 'Google Desktop client JSON path', value: path,
                onChange: event => setPath(event.target.value), style: { ...control, width: '100%', boxSizing: 'border-box' } })),
              button('Import OAuth client', () => action('configure-gmail', { path }), !path.trim()),
              h('p', { style: { margin: 0, fontSize: 12 } }, 'Authorization opens Google in your browser and requests mail read access plus label and filter management. It creates or reuses the ToAgent label and subject filter. Use your Google account settings to revoke access.'),
              button('Authorize Gmail', () => action('connect-gmail'), !state?.gmail.configured)))),
        h('div', { 'aria-label': 'Received emails', style: { display: 'grid', gap: 6, maxHeight: '26vh', overflow: 'auto' } },
          ...(state?.emails ?? []).map(row => h('button', { key: row.key, type: 'button', style: { ...control, textAlign: 'left', overflowWrap: 'anywhere', borderColor: mail?.key === row.key ? 'var(--dsw-alias-state-business-primary)' : 'var(--dsw-alias-border-l3)' },
            disabled: busy, onClick: () => select(row.key) }, h('strong', null, row.subject), h('div', { style: { fontSize: 12 } }, `${row.from} · ${new Date(row.updatedAt).toLocaleString()}`))),
          state?.emails.length === 0 && h('p', null, 'No emails received.')),
        state && h('div', { style: { display: 'flex', gap: 8 } },
          button('Previous emails', () => run(() => refresh(Math.max(0, offset - 50))), offset === 0),
          button('Next emails', () => run(() => refresh(offset + 50)), offset + 50 >= state.total)),
        mail && h('article', { 'aria-label': 'Email preview', style: { overflowWrap: 'anywhere' } },
          h('h3', null, mail.subject), h('p', null, `From: ${mail.from}`), h('p', { style: { fontSize: 12 } }, `${mail.account} · ${mail.connector}`),
          h('pre', { style: { whiteSpace: 'pre-wrap', font: 'inherit', maxHeight: '32vh', overflow: 'auto' } }, mail.body),
          button(sent ? 'Added to this session' : 'Add email to this session', () => run(async () => {
            const result = await execute('inject', { key: mail.key, revision: mail.revision, requestId: requestId.current });
            if (alive.current) { setSent(true); setNotice(result.message); }
          }), sent)));
    }
    function EmailPane({ sessionId, execute, useTabInfo }) {
      const { tab } = useTabInfo();
      return tab.visible ? h(Inbox, { key: sessionId, execute }) : null;
    }
    const id = '@toddzheng024/dscode-email-desktop';
    return { inject: ['slots', 'sidebarRightTabs', 'connection'], apply(ctx) {
      ctx.effect(() => ctx.sidebarRightTabs.register({ id, kind: 'dscode-email', multiple: false, title: () => 'Email inbox',
        guide: [{ id: 'open', order: 32, title: () => 'Email inbox', description: () => 'Read local mail and add a chosen message to this session.' }] }), 'dscode-email.type');
      ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id,
        inject: sessionId => ({ sessionId, execute: async (action, args = {}) => {
          const response = await ctx.connection.rpc.call('/api', 'dscode-email', { sessionId, action, ...args });
          if (!response.ok) throw Error(response.error.message);
          return response.value;
        } }),
      }, EmailPane)), 'dscode-email.body');
    } };
  },
});
