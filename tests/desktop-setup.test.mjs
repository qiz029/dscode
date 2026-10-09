import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { composeDesktopClient } from '../scripts/compose-desktop-client.mjs';
import { desktopClientPlugins } from '../scripts/build-desktop-preset.mjs';

function fixture() {
  let definition;
  const slots = [], requests = [];
  runInNewContext(composeDesktopClient('fixture', desktopClientPlugins.map(name =>
    readFileSync(new URL(`../plugins/${name}/desktop-client.mjs`, import.meta.url), 'utf8'))), {
    globalThis: { __ModuleLoader__: { load: value => { definition = value; } } },
    AbortController, AbortSignal, setInterval, clearInterval,
  });
  definition.factory(() => React).apply({
    effect: callback => callback(), sidebarRightTabs: { register: () => () => {} },
    slots: { inject: (_name, callback) => callback(), register: (entry, Component) => { slots.push({ entry, Component }); return () => {}; } },
    connection: { rpc: { call: async (_path, method, payload) => {
      requests.push({ method, payload });
      return { ok: true, value: method === 'dscode-custom' ? { providers: [], revision: 'fixture' }
        : method === 'dscode-accounts' ? { openrouter: {}, grok: {}, opencode: { lines: [] } }
          : { available: false } };
    } } },
  });
  return { slots, requests };
}
async function render(t, Component, props) {
  let renderer;
  await act(async () => { renderer = TestRenderer.create(React.createElement(Component, props)); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  return { renderer, text: () => JSON.stringify(renderer.toJSON()), click: async label => {
    const button = renderer.root.findAllByType('button').find(node => node.children.join('') === label);
    assert(button, `Missing ${label}`); await act(async () => button.props.onClick());
  } };
}

test('one DSCODE page explains restart/preset/native-account setup before loading optional settings', async t => {
  const f = fixture(), settings = f.slots.filter(slot => slot.entry.name === 'settings.section');
  assert.equal(settings.length, 1);
  const page = settings[0];
  const ui = await render(t, page.Component, page.entry.inject());
  assert.match(ui.text(), /fully quit and reopen/);
  assert.match(ui.text(), /Show coding view/);
  assert.match(ui.text(), /Agent presets/);
  assert.match(ui.text(), /No second login/);
  assert.deepEqual(f.requests, [], 'Opening setup must not query providers or start account flows');
  await ui.click('Models');
  assert.equal(f.requests.at(-1).method, 'dscode-custom');
  await ui.click('Accounts');
  assert.equal(f.requests.at(-1).method, 'dscode-accounts');
  await ui.click('Get started');
  assert.match(ui.text(), /Start using DSCODE/);
  assert.equal(f.requests.length, 2);
});

test('Plugins item is labeled community and bundle activation explains the required restart', async t => {
  const f = fixture();
  const item = f.slots.find(slot => slot.entry.name === 'plugins.item');
  assert.match(item.entry.label(), /Community/);
  const summary = await render(t, item.Component, { ...item.entry.inject(), view: 'summary' });
  assert.match(summary.text(), /Community DSCODE/);
  assert(!summary.text().includes('Additional models'));
  const activation = f.slots.find(slot => slot.entry.name === 'plugins.bundle.activation');
  let opened = 0, dismissed = 0;
  const ui = await render(t, activation.Component, { onOpenDetails: () => opened++, onDismiss: () => dismissed++ });
  assert.match(ui.text(), /restart to finish setup/);
  await ui.click('Open DSCODE setup'); await ui.click('Close');
  assert.equal(opened, 1); assert.equal(dismissed, 1);
});

test('combined preview explains Standard preset boundary without starting a browser', async t => {
  const f = fixture(), preview = f.slots.find(slot => slot.entry.name === 'sidebar.right.pane.tab' && slot.entry.key.includes('browser'));
  const ui = await render(t, preview.Component, { ...preview.entry.inject('standard-fixture'), useTabInfo: () => ({ tab: { visible: true } }) });
  assert.match(ui.text(), /another preset/);
  assert.deepEqual(f.requests.map(row => row.payload.action), ['availability']);
  assert.equal(ui.renderer.root.findAllByType('button').length, 0);
});
