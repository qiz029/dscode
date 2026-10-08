// Official Harness client-module format; React is supplied by the shared UI.
globalThis.__ModuleLoader__.load({
  id: '@toddzheng024/dscode-browser-desktop',
  factory: require => {
    const { createElement: h, useState, useEffect, useRef } = require('react');
    const id = '@toddzheng024/dscode-browser-desktop';
    const button = { padding: '7px 11px', border: '1px solid #8886', borderRadius: 6, background: 'transparent', color: 'inherit', cursor: 'pointer' };
    function previewButton(props, label) {
      return h('button', { ...props, style: { ...button, ...props.style, ...(props.disabled ? { opacity: 0.5, cursor: 'not-allowed' } : {}) } }, label);
    }
    const sitePermissions = (permissions, origin) => origin && JSON.stringify([
      permissions?.developerMode, permissions?.sites?.[origin], permissions?.sessionSites?.includes(origin),
    ]);
    function SessionPreview({ execute, draft }) {
      const { pageId, setPageId, text, setText, draftRevision } = draft;
      const [pages, setPages] = useState([]);
      const [permissions, setPermissions] = useState(null);
      const [handoff, setHandoff] = useState(null);
      const [frame, setFrame] = useState(null), [point, setPoint] = useState(null);
      const [expanded, setExpanded] = useState(false);
      const [expired, setExpired] = useState(false);
      const mounted = useRef(true);
      useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
      const [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false), [live, setLive] = useState(false);
      const pending = useRef(false), controlPending = useRef(false), controlEpoch = useRef(0);
      const activityEpoch = useRef(0);
      const browserAvailable = useRef(!!pageId);
      const [controlBusy, setControlBusy] = useState(false);
      const disconnected = () => {
        browserAvailable.current = false;
        setHandoff(null); setPages([]); setPageId(''); setPermissions(null);
        setFrame(null); setPoint(null); setLive(false);
        setNotice('Browser disconnected. Your draft is kept. Start or reconnect the browser and capture a new preview.');
      };
      const run = async action => {
        if (pending.current || controlPending.current) return;
        activityEpoch.current++;
        const epoch = controlEpoch.current;
        const current = () => epoch === controlEpoch.current && !controlPending.current;
        const operation = {};
        pending.current = operation; setBusy(true); setError('');
        try { await action(current); } catch (error) {
          if (!current()) return;
          setError(error.message); setLive(false); setFrame(null); setPoint(null); setPermissions(null);
        }
        finally { if (pending.current === operation) { pending.current = false; setBusy(false); } }
      };
      const list = async (current, { preserveDraft = false } = {}) => {
        const revision = draftRevision.current;
        const result = await execute('tabs');
        if (!current() || !mounted.current) return;
        if (result.connected === false) { disconnected(); return; }
        browserAvailable.current = true;
        setPages(result.pages);
        setPermissions(result.permissions ?? null);
        setHandoff(result.handoff ?? null);
        if (result.handoff) { setFrame(null); setPoint(null); setLive(false); }
        const selected = result.pages.find(page => String(page.id) === pageId) ?? result.pages.find(page => page.selected) ?? result.pages[0];
        if (String(selected?.id ?? '') !== pageId) {
          setPageId(selected ? String(selected.id) : ''); setFrame(null); setPoint(null); setLive(false);
          // A first selection can follow browser startup or an empty tab list.
          // Keep text written before any page was assigned to the draft.
          if (pageId && !preserveDraft && !result.handoff && draftRevision.current === revision) setText('');
        } else if (frame && (selected?.url !== frame.url || selected?.documentId !== frame.documentId)) {
          setFrame(null); setPoint(null); setLive(false);
          setNotice('The page changed or could not be verified. Refresh the preview; your draft is kept.');
        }
      };
      const refresh = async current => {
        if (!pageId || handoff) return;
        setPoint(null);
        const result = await execute('capture', { pageId: Number(pageId) });
        if (current()) {
          browserAvailable.current = true;
          setPages(previous => previous.map(page => page.id === result.pageId ? { ...page, url: result.url, documentId: result.documentId } : page));
          setPermissions(result.permissions ?? null);
          setFrame(result); setNotice('');
        }
      };
      let origin;
      try {
        const url = new URL(pages.find(page => String(page.id) === pageId)?.url);
        if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) origin = url.origin;
      } catch { /* Blank and unavailable tabs have no site grant. */ }
      useEffect(() => { void run(list); }, []);
      useEffect(() => {
        let active = true, reading = false;
        const timer = setInterval(async () => {
          if (reading || pending.current || controlPending.current) return;
          const epoch = activityEpoch.current;
          reading = true;
          try {
            // Read Host state and grants: no Chrome request or image capture.
            const result = await execute('handoff');
            if (!active || !mounted.current || epoch !== activityEpoch.current) return;
            if (result.connected === false) {
              if (!browserAvailable.current && !handoff) return;
              disconnected();
              return;
            }
            if (result.connected === true) browserAvailable.current = true;
            if (result.permissions && JSON.stringify(result.permissions) !== JSON.stringify(permissions)) {
              if (sitePermissions(result.permissions, origin) !== sitePermissions(permissions, origin)) {
                setFrame(null); setPoint(null); setLive(false);
                setNotice('Site permissions changed. Your draft is kept. Capture a new preview after access is granted.');
              }
              setPermissions(result.permissions);
            }
            const next = result.handoff ?? null;
            if (JSON.stringify(next) === JSON.stringify(handoff)) return;
            setHandoff(next); setFrame(null); setPoint(null); setLive(false);
          } catch { /* The next visible tick retries; browser actions still enforce handoff. */ }
          finally { reading = false; }
        }, 2500);
        return () => { active = false; clearInterval(timer); };
      }, [execute, handoff, permissions, origin]);
      const expire = () => { setExpired(true); setPoint(null); setLive(false); };
      useEffect(() => {
        setExpired(false);
        if (!frame) return;
        const remaining = frame.capturedAt + 60000 - Date.now();
        if (remaining <= 0) { expire(); return; }
        let active = true;
        const timer = setTimeout(() => { if (active) expire(); }, remaining);
        return () => { active = false; clearTimeout(timer); };
      }, [frame]);
      useEffect(() => {
        if (!live || point || !pageId || handoff) return;
        const timer = setInterval(() => { void run(refresh); }, 2500);
        return () => clearInterval(timer);
      }, [live, point, pageId, handoff, execute]);
      const canSelect = () => {
        if (!frame || handoff || pending.current || controlPending.current || expired) return false;
        if (Date.now() - frame.capturedAt >= 60000) { expire(); return false; }
        return true;
      };
      const selectPoint = event => {
        if (!canSelect()) return;
        setLive(false);
        const rect = event.currentTarget.getBoundingClientRect();
        setPoint({ x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) });
      };
      const selectPointKey = event => {
        if (event.altKey || event.ctrlKey || event.metaKey || !['Enter', ' ', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
        event.preventDefault();
        if (!canSelect()) return;
        if (event.key === 'Escape') { setPoint(null); return; }
        setLive(false);
        setPoint(previous => {
          const xMax = frame.width - 1, yMax = frame.height - 1;
          const base = ['Enter', ' '].includes(event.key) ? null : previous;
          let x = Math.round((base?.x ?? 0.5) * xMax), y = Math.round((base?.y ?? 0.5) * yMax);
          const step = event.shiftKey ? 10 : 1;
          if (event.key === 'ArrowLeft') x -= step;
          if (event.key === 'ArrowRight') x += step;
          if (event.key === 'ArrowUp') y -= step;
          if (event.key === 'ArrowDown') y += step;
          return { x: xMax ? Math.min(xMax, Math.max(0, x)) / xMax : 0, y: yMax ? Math.min(yMax, Math.max(0, y)) / yMax : 0 };
        });
      };
      const rule = permissions?.sites?.[origin];
      const access = rule?.access === 'block' ? 'Blocked' : rule?.access === 'allow' ? 'Always allowed' :
        permissions?.sessionSites?.includes(origin) ? 'Allowed until browser stops' : permissions ? 'Permission required' : 'Refresh tabs to load permissions';
      const changeControl = async action => {
        if (controlPending.current) return;
        // Stop and revocation must not wait for a slow ordinary request. The epoch
        // prevents earlier responses from restoring pixels or stale grants.
        controlPending.current = true; controlEpoch.current++;
        activityEpoch.current++;
        // Superseded requests may remain in transport indefinitely. Release their
        // UI lock; only the currently owned operation may clear a later lock.
        pending.current = false; setBusy(false);
        setControlBusy(true); setError(''); setNotice('');
        setFrame(null); setPoint(null); setLive(false);
        try {
          await action();
        } catch (error) {
          setError(error.message); setPermissions(null);
        } finally { controlPending.current = false; setControlBusy(false); }
      };
      const changePermission = (change, value = origin) => changeControl(async () => {
        const result = await execute('permission', { change, value });
        setPermissions(result.permissions);
        setNotice(change === 'developer-mode' ? `Developer mode ${value}. Each site also needs its own grant.` : `Permissions updated for ${value}.`);
      });
      const stop = () => changeControl(async () => {
        browserAvailable.current = false;
        setPages([]); setPageId(''); setPermissions(null); setHandoff(null);
        await execute('stop');
        setNotice('Browser stopped. Your draft is kept. Start the browser and capture a new preview to continue.');
      });
      const resume = () => run(async current => {
        setNotice(''); setFrame(null); setPoint(null); setLive(false);
        await execute('resume');
        if (!current() || !mounted.current) return;
        setHandoff(null);
        setNotice('Browser control resumed. Your draft is kept. Capture a new preview before sending.');
        await list(current, { preserveDraft: true });
      });
      return h('section', { 'aria-label': 'DSCODE browser preview', style: { padding: 12, boxSizing: 'border-box', overflow: 'auto', height: '100%', display: 'flex', flexDirection: 'column', gap: 8, color: 'inherit' } },
        h('strong', null, 'Browser preview'),
        handoff && h('div', { 'aria-label': 'Browser handoff', role: 'status', style: { border: '1px solid #8886', borderRadius: 8, padding: 10, overflowWrap: 'anywhere' } },
          h('strong', null, 'Waiting for you'),
          h('p', null, handoff.reason),
          handoff.invalidated && h('p', null, 'Chrome restarted. The original tab is unavailable; choose a live tab after resuming.'),
          handoff.focusError && h('p', null, handoff.focusError),
          h('p', null, 'Complete the manual step in Chrome, then resume browser control.'),
          previewButton({ style: button, disabled: busy || controlBusy, onClick: resume }, 'Resume browser control')),
        h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 8 } },
          previewButton({ style: button, disabled: busy || controlBusy || !!handoff, onClick: () => run(async current => { setNotice(''); await execute('start'); if (current()) await list(current); }) }, 'Start browser'),
          previewButton({ style: button, disabled: controlBusy, onClick: stop }, 'Stop browser'),
          previewButton({ style: button, disabled: busy || controlBusy, onClick: () => run(list) }, 'Refresh tabs'),
          previewButton({ style: button, disabled: busy || controlBusy || !pageId || !!handoff, onClick: () => run(refresh) }, 'Refresh preview'),
          frame && previewButton({ style: button, onClick: () => setExpanded(!expanded) }, expanded ? 'Fit image' : 'Expand image')),
        h('select', { 'aria-label': 'Browser tab', value: pageId, disabled: busy || controlBusy, onChange: e => { setPageId(e.target.value); setFrame(null); setPoint(null); setText(''); setLive(false); }, style: { ...button, width: '100%' } }, h('option', { value: '' }, 'Choose a tab'), ...pages.map(page => h('option', { key: page.id, value: String(page.id) }, `${page.id} · ${page.url}`))),
        origin && h('details', { 'aria-label': 'Browser site permissions', style: { border: '1px solid #8886', borderRadius: 8, padding: '8px 10px', margin: 0, minWidth: 0 } },
          h('summary', { 'aria-label': `Site permissions · ${access}`, style: { cursor: 'pointer' } }, 'Site permissions · ', h('span', { 'aria-label': 'Site access status' }, access)),
          h('div', { style: { fontSize: 12, overflowWrap: 'anywhere', margin: '8px 0' } }, origin),
          h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
            ...[['Allow this session', 'once'], ['Always allow', 'allow'], ['Block site', 'block'], ['Forget decision', 'forget']].map(([label, change]) =>
              previewButton({ key: change, style: button, disabled: controlBusy || change === 'once' && ['block', 'allow'].includes(rule?.access), onClick: () => changePermission(change) }, label))),
          h('details', { style: { marginTop: 10 } },
            h('summary', { style: { cursor: 'pointer' } }, 'Developer access'),
            h('p', { 'aria-label': 'Developer access status', style: { fontSize: 12 } }, permissions ?
              `Developer mode: ${permissions.developerMode ? 'on globally' : 'off globally'}. This site: ${rule?.developer ? 'granted' : 'not granted'}. Scripts, CSS, console and network inspection require both.` : 'Refresh tabs to load Developer permissions.'),
            h('div', { style: { display: 'flex', flexWrap: 'wrap', gap: 6 } },
              previewButton({ style: button, disabled: controlBusy || !permissions, onClick: () => changePermission('developer-mode', permissions.developerMode ? 'off' : 'on') }, permissions?.developerMode ? 'Disable Developer mode' : 'Enable Developer mode'),
              previewButton({ style: button, disabled: controlBusy || !permissions || rule?.access === 'block', onClick: () => changePermission(rule?.developer ? 'developer-block' : 'developer-allow') }, rule?.developer ? 'Revoke site Developer access' : 'Grant site Developer access'))),
          h('p', { style: { fontSize: 12, opacity: 0.75, marginBottom: 0 } }, 'Changes apply to this exact origin. Action approvals still apply. Permissions sync while this pane is visible and idle; Refresh tabs updates them immediately.')),
        h('label', null, h('input', { type: 'checkbox', checked: live, disabled: controlBusy || !pageId || !!point || !!handoff, onChange: e => setLive(e.target.checked) }), ' Refresh while visible'),
        error && h('div', { role: 'alert', style: { whiteSpace: 'pre-wrap', color: '#db6868' } }, error),
        frame && h('div', null,
          h('div', { style: { fontSize: 12, overflowWrap: 'anywhere', marginBottom: 8 } }, `${frame.url} · ${new Date(frame.capturedAt).toLocaleTimeString()}`),
          h('div', { style: { position: 'relative', lineHeight: 0, display: 'inline-block', maxWidth: '100%', ...(expanded ? { width: '100%' } : {}) } },
            h('img', { src: `data:${frame.image.mimeType};base64,${frame.image.data}`, alt: expired ? 'Expired browser preview; refresh before annotating' : 'Captured browser page; click a point to annotate', role: 'button', tabIndex: 0, 'aria-disabled': busy || controlBusy || expired, 'aria-description': 'Enter or Space selects the center. Arrow keys move one pixel; Shift moves ten. Escape clears the point.', onClick: selectPoint, onKeyDown: selectPointKey, style: { maxWidth: '100%', maxHeight: expanded ? 'none' : '30vh', width: expanded ? '100%' : 'auto', height: 'auto', display: 'block', cursor: expired ? 'default' : 'crosshair', borderRadius: 6 } }),
            point && h('span', { 'aria-label': 'Selected annotation point', style: { position: 'absolute', left: `${point.x * 100}%`, top: `${point.y * 100}%`, width: 20, height: 20, border: '3px solid #f97316', borderRadius: '50%', transform: 'translate(-50%, -50%)', pointerEvents: 'none', boxShadow: '0 0 0 2px white' } }))),
        h('p', { style: { fontSize: 12, margin: 0, opacity: 0.75 } }, 'Preview shows the controlled Chrome tab. Click a point, or focus the image and press Enter or Space to select the center. Arrow keys move one pixel; Shift moves ten. Escape clears the point. Refresh after navigation or after one minute.'),
        frame && point && h('p', { 'aria-label': 'Annotation coordinates', 'aria-live': 'polite', style: { fontSize: 12, margin: 0 } }, `Selected pixel: (${Math.round(point.x * (frame.width - 1))}, ${Math.round(point.y * (frame.height - 1))}) in ${frame.width}×${frame.height}.`),
        frame && expired && h('p', { 'aria-label': 'Preview freshness', role: 'status', style: { fontSize: 12, margin: 0 } }, 'This preview has expired. Choose Refresh preview, then select the point again. Your draft is kept.'),
        h('textarea', { 'aria-label': 'Browser annotation', placeholder: 'Describe what should change here…', value: text, maxLength: 4000, onChange: e => { draftRevision.current++; setText(e.target.value); }, style: { ...button, minHeight: 76, width: '100%', boxSizing: 'border-box', cursor: 'text' } }),
        previewButton({ style: button, disabled: busy || controlBusy || expired || !!handoff || !frame || !point || !text.trim(), onClick: () => run(async current => {
          if (!frame || handoff || expired || !point || !text.trim()) return;
          // Background windows may throttle timers; check again at submission.
          if (Date.now() - frame.capturedAt >= 60000) { expire(); return; }
          const revision = draftRevision.current;
          const result = await execute('annotate', { annotation: { token: frame.token, ...point, text } });
          if (!current()) return;
          setNotice(result.message); setPoint(null); setFrame(null);
          // The editable field may already contain the user's next annotation.
          if (draftRevision.current === revision) setText('');
        }) }, 'Send annotation'),
        notice && h('div', { role: 'status' }, notice));
    }
    function SessionPane({ execute, visible }) {
      // Keep only the draft and selected tab while this session's pane is hidden.
      // Sharing the revision also lets an in-flight send settle without clearing
      // text edited after reopening. Pixels and refresh timers remain disposable.
      const [pageId, setPageId] = useState(''), [text, setText] = useState('');
      const draftRevision = useRef(0);
      return visible ? h(SessionPreview, { execute, draft: { pageId, setPageId, text, setText, draftRevision } }) : null;
    }
    function Preview({ sessionId, execute, useTabInfo }) {
      const { tab } = useTabInfo();
      // Session changes discard the draft. Hidden panes discard their request
      // lock and preview, while late responses stay bound to the original session.
      return h(SessionPane, { key: sessionId, execute, visible: tab.visible });
    }
    return {
      inject: ['slots', 'sidebarRightTabs', 'connection'],
      apply(ctx) {
        ctx.effect(() => ctx.sidebarRightTabs.register({ id, kind: 'dscode-browser', multiple: false, keepMounted: true, title: () => 'Browser preview', guide: [{ id: 'open', order: 31, title: () => 'Browser preview', description: () => 'Inspect the controlled Chrome tab and send a visual annotation.' }] }), 'dscode-browser-preview.type');
        ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: id,
          inject: sessionId => ({ sessionId, execute: async (action, args = {}) => {
            const response = await ctx.connection.rpc.call('/api', 'dscode-browser', { sessionId, action, ...args });
            if (!response.ok) throw Error(response.error.message);
            return response.value;
          } }),
        }, Preview)), 'dscode-browser-preview.body');
      },
    };
  },
});
