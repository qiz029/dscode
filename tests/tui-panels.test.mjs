process.env.DSCODE_UPDATE_CHECK = 'off';
process.env.FORCE_COLOR = '3';
process.env.DSCODE_LANGUAGE = 'en';

import test from 'node:test';
import assert from 'node:assert/strict';
import { DscodeGrokPanel, DscodeProviderPanel } from '../packages/tui/src/app.ts';
import { StatuslinePanel } from '../packages/tui/src/kernel-panels.ts';
import { DEFAULT_STATUSLINE_ITEMS, STATUS_ITEMS } from '../packages/tui/src/render/status.ts';
import { mount, assertFits, tick } from './fixtures/tui-mount.mjs';

// These panels are keyboard surfaces DSCODE added on top of the vendored terminal, and
// no test mounted any of them: a key that stops being routed, a status column that stops
// being computed, or a cursor that stops moving would ship unnoticed. Each test drives
// real stdin bytes and asserts the rendered frame.

test('the Grok panel reports the local login, the plan and the credit window', async () => {
  let refreshed = 0;
  let closed = 0;
  const snapshot = {
    status: { kind: 'expired' },
    subscription: { tier: 'SuperGrok', usedPercent: 42, periodEnd: '2026-10-01T00:00:00.000Z' },
  };
  const ui = await mount(DscodeGrokPanel, {
    snapshot,
    refresh: () => { refreshed += 1; },
    back: () => { closed += 1; },
  }, { columns: 100 });
  try {
    assertFits(ui);
    const text = ui.frame();
    assert.match(text, /Grok subscription/);
    assert.match(text, /login expired/i);
    assert.match(text, /Run grok login/);
    assert.match(text, /Plan: SuperGrok/);
    assert.match(text, /42% used/);
    assert.match(text, /Resets:/);
    await ui.write('r');
    assert.equal(refreshed, 1, 'r re-checks the login and the credit window');
    await ui.write('q');
    assert.equal(closed, 1, 'q closes the panel');
  } finally {
    ui.close();
  }
});

test('the Grok panel names only the local login when the token file is missing', async () => {
  const ui = await mount(DscodeGrokPanel, {
    snapshot: { status: { kind: 'missing' } },
    refresh: () => {},
    back: () => {},
  }, { columns: 100 });
  try {
    assertFits(ui);
    const text = ui.frame();
    assert.match(text, /No local grok login found/);
    assert.match(text, /Plan: not reported/);
    assert.match(text, /the server reports none for this period/);
    assert.doesNotMatch(text, /Resets:/, 'a missing window draws no reset row');
  } finally {
    ui.close();
  }
});

test('the statusline picker lists every item and toggles one with space', async () => {
  const changes = [];
  const enabled = DEFAULT_STATUSLINE_ITEMS.slice(0, 2);
  const ui = await mount(StatuslinePanel, {
    enabled,
    change: items => changes.push(items),
    close: () => {},
  }, { columns: 100 });
  try {
    assertFits(ui);
    const marks = () => ui.frame().split('\n').filter(line => /[●○]/.test(line));
    assert.ok(marks().length >= 6, 'the panel draws a scrolling window of item rows');
    assert.equal(marks().filter(line => line.includes('●')).length, enabled.length, 'enabled items are marked');

    await ui.write(' ');
    assert.deepEqual(changes.at(-1), enabled.slice(1), 'space drops the item under the cursor');
    await ui.write(' ');
    assert.deepEqual(changes.at(-1), [...enabled], 'space adds it back on the same row');

    const cursorRow = () => ui.frame().split('\n').findIndex(line => line.includes('›'));
    const before = cursorRow();
    await ui.write('\u001b[B');
    assert.equal(cursorRow(), before + 1, 'the down arrow moves the cursor one row');
    await ui.write('\u001b[A');
    assert.equal(cursorRow(), before, 'the up arrow moves it back');
    const firstVisible = marks()[0];
    await ui.write('G');
    assert.notEqual(marks()[0], firstVisible, 'G scrolls the window to the last item');
  } finally {
    ui.close();
  }
});

test('the statusline picker resets to the defaults and closes on Esc', async () => {
  const changes = [];
  let closed = 0;
  const ui = await mount(StatuslinePanel, {
    enabled: [],
    change: items => changes.push(items),
    close: () => { closed += 1; },
  }, { columns: 100 });
  try {
    await ui.write('d');
    assert.deepEqual([...changes.at(-1)], [...DEFAULT_STATUSLINE_ITEMS], 'd restores the default set');
    await ui.write('\u001b');
    assert.equal(closed, 1, 'Esc closes the picker');
  } finally {
    ui.close();
  }
});

test('the provider panel computes each route status and switches on Enter', async () => {
  const chosen = [];
  let closed = 0;
  const rows = [
    { provider: 'deepseek-official', configured: true, credential: { kind: 'facts', configured: true, source: 'env', writable: true } },
    { provider: 'openrouter', configured: true, credential: { kind: 'facts', configured: false, source: 'none', writable: true } },
    { provider: 'grok', configured: false, credential: undefined },
  ];
  const ui = await mount(DscodeProviderPanel, {
    current: 'deepseek-official',
    load: async () => ({ rows, writable: true, failures: [] }),
    choose: id => chosen.push(id),
    back: () => { closed += 1; },
    grokStatus: () => 'grok login not detected',
  }, { columns: 100 });
  try {
    await tick(80);
    assertFits(ui);
    const text = ui.frame();
    assert.match(text, /Provider/);
    assert.match(text, /key from DEEPSEEK_API_KEY/, 'an environment credential reads as env');
    assert.match(text, /needs an API key/, 'a configured route with no credential asks for one');
    assert.match(text, /grok login not detected/, 'the Grok rail reports its own login state');

    await ui.write('\u001b[B');
    await ui.write('\r');
    assert.deepEqual(chosen, ['openrouter'], 'Enter switches to the row under the cursor');
    assert.equal(closed, 1, 'Enter also returns from the panel');
  } finally {
    ui.close();
  }
});

test('the provider panel keeps working when the directory fails to load', async () => {
  let closed = 0;
  const ui = await mount(DscodeProviderPanel, {
    current: 'openrouter',
    load: async () => { throw new Error('settings unavailable'); },
    choose: () => {},
    back: () => { closed += 1; },
    grokStatus: () => 'grok login not detected',
  }, { columns: 100 });
  try {
    await tick(80);
    assertFits(ui);
    assert.match(ui.frame(), /status unavailable/, 'a failed load degrades to one column, not a crash');
    await ui.write('\u001b');
    assert.equal(closed, 1, 'Esc leaves the panel');
  } finally {
    ui.close();
  }
});
