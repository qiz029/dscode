globalThis.__ModuleLoader__.load({
  id: '@toddzheng024/dscode-desktop',
  factory: require => {
    const { createElement: h, useState, useEffect, useRef } = require('react');
    const control = { padding: '8px 10px', border: '1px solid #8886', borderRadius: 6, background: 'transparent', color: 'inherit', font: 'inherit' };
    const box = { border: '1px solid #8886', borderRadius: 8, padding: 16 };
    function Hub({ execute, manage, close }) {
      const [query, setQuery] = useState(''), [category, setCategory] = useState(''), [categories, setCategories] = useState([]);
      const [results, setResults] = useState(null), [detail, setDetail] = useState(null), [preview, setPreview] = useState(null);
      const [operation, setOperation] = useState(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
      const alive = useRef(true), locked = useRef(false), pageQuery = useRef({ query: '', category: '' });
      const run = async fn => {
        if (locked.current) return;
        locked.current = true; setBusy(true); setError('');
        try { await fn(); } catch (error) { if (alive.current) setError(error.message); }
        finally { locked.current = false; if (alive.current) setBusy(false); }
      };
      const search = async (more = false) => {
        const input = more ? pageQuery.current : { query, category };
        if (!more) { setDetail(null); setPreview(null); setResults(null); }
        const value = await execute('search', { ...input, ...(more ? results.nextPage ? { page: results.nextPage } : { cursor: results.nextCursor } : {}) });
        if (!alive.current) return;
        pageQuery.current = input;
        setResults(more ? { ...value, items: [...results.items, ...value.items.filter(item => !results.items.some(previous => previous.packageName === item.packageName))] } : value);
      };
      const load = () => run(async () => {
        const [list, initial, status] = await Promise.all([execute('categories'), execute('search', { query: '', category: '' }), execute('status')]);
        if (alive.current) { setCategories(list.items); setResults(initial); setOperation(status.operation); pageQuery.current = { query: '', category: '' }; }
      });
      useEffect(() => { alive.current = true; void load(); return () => { alive.current = false; }; }, []);
      useEffect(() => {
        if (operation?.status !== 'running') return;
        let stopped = false, polling = false;
        const timer = setInterval(async () => {
          if (polling) return; polling = true;
          try {
            const value = await execute('operation', { requestId: operation.requestId });
            if (!stopped && alive.current) setOperation(value);
          } catch (error) { if (!stopped && alive.current) setError(`Could not refresh installation: ${error.message}`); }
          finally { polling = false; }
        }, 1000);
        return () => { stopped = true; clearInterval(timer); };
      }, [operation?.requestId, operation?.status]);
      const installing = operation?.status === 'running';
      const button = (label, action, disabled = false) => h('button', { type: 'button', style: control, disabled: busy || disabled, onClick: action }, label);
      const openManagement = packageName => run(async () => { manage(packageName); close?.(); });
      const show = name => run(async () => {
        setDetail(null); setPreview(null);
        const value = await execute('detail', { packageName: name }); if (alive.current) setDetail(value);
      });
      const installed = detail?.installed || (operation?.packageName === detail?.packageName && operation?.result?.application === 'applied' && operation.result.bundle === detail?.packageName);
      const security = item => `Hub scan: ${item.security?.status ?? 'not reported'}`;
      const result = operation?.result;
      return h('section', { 'aria-label': 'Plugin Hub', style: { padding: 20, display: 'grid', gap: 16, maxWidth: 900 } },
        h('h2', { style: { margin: 0 } }, 'Plugin Hub'),
        h('p', null, 'Discover community plugins from DSH Plugin Hub. Install here, then enable and configure in Settings → Plugins.'),
        h('form', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 }, onSubmit: event => { event.preventDefault(); void run(() => search()); } },
          h('input', { type: 'search', 'aria-label': 'Search plugins', placeholder: 'Search plugins or describe a capability', value: query, maxLength: 300, style: { ...control, flex: 1 }, disabled: busy || installing, onChange: event => setQuery(event.target.value) }),
          h('select', { 'aria-label': 'Plugin category', value: category, style: control, disabled: busy || installing, onChange: event => setCategory(event.target.value) },
            h('option', { value: '' }, 'All categories'), ...categories.map(item => h('option', { key: item.name, value: item.name }, `${item.displayName} (${item.count})`))),
          h('button', { type: 'submit', disabled: busy || installing, style: control }, busy ? 'Loading…' : 'Search')),
        error && h('div', { role: 'alert' }, error, ' ', button('Refresh catalog', load, installing)),
        operation && h('div', { role: 'status', style: box },
          h('strong', null, operation.spec),
          h('p', null, installing ? 'Installing with the official plugin manager…' : operation.error ? operation.error : result?.application === 'applied' ? 'Installation completed. Enable the plugin in Settings → Plugins.' :
            result?.application === 'restart-required' ? 'The plugin manager requires a Desktop restart. Check Settings → Plugins after restarting.' :
              result?.application === 'cancelled' ? 'Installation cancelled.' : `Installation outcome: ${result?.application ?? 'unknown'}. Check Settings → Plugins.`),
          result?.error && h('p', null, result.error.message),
          result?.warnings?.map((warning, index) => h('p', { key: index }, warning)),
          result?.pendingBuilds?.length > 0 && h('p', null, `Build approval is required for ${result.pendingBuilds.join(', ')}. Review it through the official plugin manager.`),
          installing ? button('Cancel installation', () => run(async () => { const value = await execute('cancel', { requestId: operation.requestId }); if (alive.current) setOperation(value); })) :
            button('Manage installed plugin', () => openManagement(operation.packageName))),
        detail && h('article', { style: box, 'aria-label': 'Plugin details' },
          h('h3', null, detail.displayName), h('code', null, `${detail.packageName}@${detail.latestVersion}`),
          h('p', null, detail.summary), h('p', { style: { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' } }, detail.description),
          h('p', null, `${detail.categories.join(' · ')} · ${detail.weeklyDownloads} weekly downloads`),
          h('p', null, `Repository: ${detail.repository} · License: ${detail.license ?? 'not reported'}`),
          h('p', null, `${detail.claimed ? 'Publisher claimed' : 'Publisher unclaimed'} · ${detail.verified ? 'Publisher verified' : 'Publisher unverified'}`),
          h('p', null, security(detail), '. Publisher verification and scans do not guarantee safety.'),
          detail.security && h('ul', null, ...[['dependencyInventoryComplete', 'Complete dependency inventory'], ['advisoryScanned', 'Vulnerability advisories checked'], ['behaviorAnalyzed', 'Behavior analysis completed']].map(([key, label]) => h('li', { key }, `${label}: ${detail.security[key] === true ? 'yes' : 'no'}`))),
          h('a', { href: detail.url, target: '_blank', rel: 'noreferrer' }, 'View on DSH Plugin Hub'),
          h('p', null, `Your Desktop: DSH ${detail.environment.runtime} · ${detail.environment.platform}`),
          detail.candidate.compatibility && h('p', null, `Declared compatibility: DSH ${detail.candidate.compatibility.dsh} · ${detail.candidate.compatibility.surfaces.join(', ')} · ${detail.candidate.compatibility.platforms.join(', ') || 'all platforms'}`),
          detail.candidate.reasons.length > 0 && h('ul', null, ...detail.candidate.reasons.map(reason => h('li', { key: reason }, reason))),
          installed ? button('Manage in Plugins', () => openManagement(detail.packageName), installing) :
            button('Review installation', () => run(async () => { const value = await execute('prepare', { packageName: detail.packageName }); if (alive.current) { setDetail(value.detail); setPreview(value); } }), installing || detail.candidate.reasons.length > 0),
          preview && h('div', { style: { ...box, marginTop: 16 }, role: 'group', 'aria-label': 'Confirm plugin installation' },
            h('p', null, `Install ${preview.detail.candidate.spec} from ${preview.inspection.registry ?? 'your configured npm registry'}?`),
            h('p', null, 'The official manager will download the package and its dependencies. It will remain disabled until you enable it in Plugins. Enabling third-party plugins runs their code in the Host.'),
            button('Confirm installation', () => run(async () => { const value = await execute('install', { token: preview.token, confirm: true }); if (alive.current) { setOperation(value); setPreview(null); } }), installing),
            ' ', button('Back', () => setPreview(null), installing))),
        results && h('div', { 'aria-label': 'Plugin search results', style: { display: 'grid', gap: 12 } },
          results.items.length === 0 && h('p', null, 'No plugins match this search. Try another phrase or category.'),
          ...results.items.map(item => h('article', { key: item.packageName, style: box },
            h('h3', { style: { margin: 0 } }, item.displayName), h('code', null, `${item.packageName}@${item.latestVersion}`),
            h('p', null, item.summary), h('p', null, `${security(item)}${item.deprecated ? ' · Deprecated' : ''}`),
            button('View details', () => show(item.packageName), installing))),
          (results.nextPage || results.nextCursor) && button('Load more plugins', () => run(() => search(true)), installing)));
    }
    return { inject: ['slots', 'connection'], apply(ctx) {
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dscode-hub', order: 13, label: () => 'Plugin Hub',
        inject: () => ({ execute: async (action, args = {}) => {
          const response = await ctx.connection.rpc.call('/api', 'dscode-hub', { ...args, action });
          if (!response.ok) throw Error(response.error.message);
          return response.value;
        }, manage: packageName => {
          const navigation = ctx.get('pluginNavigation');
          if (!navigation) throw Error('Plugin management is unavailable. Close settings and open Plugins from the sidebar.');
          navigation.openBundle(packageName);
        } }),
      }, Hub));
    } };
  },
});
