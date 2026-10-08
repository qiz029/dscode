import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import React from 'react';
import { composeDesktopClient } from '../scripts/compose-desktop-client.mjs';
import { desktopClientPlugins } from '../scripts/build-desktop-preset.mjs';

test('the combined Desktop client mounts settings and preview through one native registration', async () => {
  const sources = desktopClientPlugins.map(plugin => readFileSync(new URL(`../plugins/${plugin}/desktop-client.mjs`, import.meta.url), 'utf8'));
  const registrations = [], slots = [], tabs = [], requests = [];
  runInNewContext(composeDesktopClient('desktop-fixture', sources), { globalThis: { __ModuleLoader__: { load: value => registrations.push(value) } } });
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].id, 'desktop-fixture');
  const plugin = registrations[0].factory(name => { assert.equal(name, 'react'); return React; });
  assert.deepEqual([...plugin.inject].sort(), ['connection', 'sidebarRightTabs', 'slots']);
  plugin.apply({ effect: callback => callback(),
    sidebarRightTabs: { register: spec => { tabs.push(spec); return () => {}; } },
    slots: { inject: (_name, callback) => callback(), register: spec => { slots.push(spec); return () => {}; } },
    connection: { rpc: { call: async (path, method, payload) => { requests.push({ path, method, payload }); return { ok: true, value: {} }; } } },
  });
  assert.equal(slots.length, 8);
  assert.equal(slots.filter(slot => slot.name === 'settings.section').length, 1);
  assert.equal(slots.some(slot => slot.id === 'dscode-hub'), false, 'DSCODE must not register the Hub settings page');
  assert.equal(tabs.length, 4);
  const settings = slots.find(slot => slot.name === 'settings.section');
  const preview = slots.find(slot => slot.name === 'sidebar.right.pane.tab');
  assert.equal(settings.id, 'dscode');
  assert(slots.some(slot => slot.name === 'plugins.bundle.activation'));
  assert(slots.some(slot => slot.name === 'plugins.item' && slot.label().includes('Community')));
  assert.equal(preview.key, tabs[0].id);
  const pages = settings.inject().pages;
  await pages.find(page => page.entry.id === 'dscode-models').entry.inject().execute('list');
  await pages.find(page => page.entry.id === 'dscode-accounts').entry.inject().execute('status');
  await pages.find(page => page.entry.id === 'dscode-schedules').entry.inject().execute('status');
  await preview.inject('session').execute('tabs');
  await slots.find(slot => slot.key === '@toddzheng024/dscode-email-desktop').inject('email-session').execute('list');
  await slots.find(slot => slot.key === '@toddzheng024/dscode-metrics-desktop').inject('metrics-session').execute();
  await slots.find(slot => slot.key === '@toddzheng024/dscode-delegation-desktop').inject('board-session').execute();
  assert.deepEqual(structuredClone(requests), [
    { path: '/api', method: 'dscode-custom', payload: { action: 'list' } },
    { path: '/api', method: 'dscode-accounts', payload: { action: 'status' } },
    { path: '/api', method: 'dscode-triggers', payload: { action: 'status' } },
    { path: '/api', method: 'dscode-browser', payload: { sessionId: 'session', action: 'tabs' } },
    { path: '/api', method: 'dscode-email', payload: { sessionId: 'email-session', action: 'list' } },
    { path: '/api', method: 'dscode-metrics', payload: { action: 'status', sessionId: 'metrics-session' } },
    { path: '/api', method: 'dscode-delegation', payload: { action: 'status', sessionId: 'board-session' } },
  ]);
});

test('client composition rejects source registration drift', () => {
  assert.throws(() => composeDesktopClient('fixture', []), /at least one/);
  assert.throws(() => composeDesktopClient('fixture', ['unrelated source']), /patch drift/);
});
