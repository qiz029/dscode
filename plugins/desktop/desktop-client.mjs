globalThis.__ModuleLoader__.load({
  id: '@toddzheng024/dscode-desktop',
  factory: require => {
    const { createElement: h, useState } = require('react');
    const packageName = '@toddzheng024/dscode-desktop';
    const labels = { 'dscode-models': 'Models', 'dscode-accounts': 'Accounts', 'dscode-schedules': 'Schedules' };
    function Mark() {
      return h('svg', { width: 28, height: 28, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
        h('rect', { x: 2, y: 4, width: 20, height: 16, rx: 4 }), h('path', { d: 'm7 9 3 3-3 3m6 0h4' }));
    }
    function Setup() {
      const steps = [
        ['Enable and restart', 'Enable the DSCODE bundle in Plugins. After installing or updating, fully quit and reopen DeepSeek Harness. Closing a window is not enough.'],
        ['Show agent presets', 'In Settings → General, enable Show coding view. If Agent presets is disabled in Plugins, enable it too.'],
        ['Start a DSCODE session', 'Create a new session and choose DSCODE in the Agent preset picker. Existing sessions keep their original preset.'],
        ['Use your existing account', 'Choose a model in the normal model picker. No second login or copied API key is required for models you already use.'],
      ];
      return h('section', { className: 'dscode-setup', 'aria-label': 'Start using DSCODE' },
        h('h3', null, 'Start using DSCODE'),
        h('ol', { className: 'dscode-steps' }, ...steps.map(([title, description]) =>
          h('li', { key: title }, h('div', null, h('strong', null, title), h('p', null, description))))),
        h('p', { className: 'dscode-note' }, 'Browser preview controls DSCODE’s external Chrome. The official Browser remains available for ordinary browsing.'));
    }
    function Settings({ pages, view }) {
      const [selected, setSelected] = useState('overview');
      if (view === 'summary') return h('span', null, 'Community DSCODE coding preset · Setup, additional providers and schedules');
      const page = pages.find(page => page.entry.id === selected);
      return h('section', { 'aria-label': 'DSCODE settings', className: 'dscode-ui dscode-settings' },
        view !== 'page' && h('div', { className: 'dscode-heading' }, h(Mark), h('h2', null, 'DSCODE'), h('span', null, 'Community plugin')),
        h('p', null, 'Coding workflows in Harness Desktop. Your existing models and accounts work here.'),
        h('nav', { 'aria-label': 'DSCODE settings pages', className: 'dscode-tabs' },
          ...[['overview', 'Get started'], ...pages.map(page => [page.entry.id, labels[page.entry.id]])].map(([id, label]) =>
            h('button', { key: id, type: 'button', 'aria-pressed': selected === id, onClick: () => setSelected(id) }, label))),
        page ? h(page.Component, { key: selected, ...page.entry.inject() }) : h(Setup));
    }
    function Activation({ onDismiss, onOpenDetails }) {
      return h('section', { className: 'dscode-ui dscode-activation' }, h('h2', null, 'DSCODE enabled — restart to finish setup'), h(Setup),
        h('div', { className: 'dscode-actions' },
          h('button', { type: 'button', className: 'dscode-primary', onClick: onOpenDetails }, 'Open DSCODE setup'),
          h('button', { type: 'button', onClick: onDismiss }, 'Close')));
    }
    return { inject: ['slots'], apply(ctx, { pages = [] } = {}) {
      const props = () => ({ pages });
      ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'dscode', order: 11, label: () => 'DSCODE', inject: props }, Settings));
      ctx.slots.inject('plugins.item', () => ctx.slots.register({ name: 'plugins.item', id: 'dscode', order: 90, label: () => 'DSCODE · Community', inject: props }, Settings));
      ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: packageName, inject: props }, Settings));
      ctx.slots.inject('plugins.bundle.activation', () => ctx.slots.register({ name: 'plugins.bundle.activation', key: packageName }, Activation));
    } };
  },
});
