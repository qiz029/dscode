import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import { Context } from '@deepseek-ai/cordis';
import { createScope } from '@deepseek-ai/dsh-scope';
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { DelegateBoard, delegateBoardFor, setBoardSource } from '../plugins/dscode/board.mjs';
import { desktopBoardRequest } from '../plugins/dscode/desktop-host.mjs';

test('Desktop board reads the owning live cache, isolates simultaneous sessions and survives unrelated disposal', t => {
  const home = mkdtempSync(join(tmpdir(), 'desktop-board-')); t.after(() => rmSync(home, { recursive: true, force: true }));
  const ctx = new Context(), live = new Map(), mounts = [];
  const host = { agents: { get: id => live.get(id) }, agentPresets: { composedPreset: scope => scope.preset } };
  const make = (id, preset = 'dscode', origin) => {
    const agent = { id, session: { id, header: { origin } } }, scope = createScope(ctx, agent);
    agent.ctx = scope.ctx.extend({ preset }); live.set(id, agent); mounts.push(scope);
    const board = new DelegateBoard({ root: home });
    const dispose = setBoardSource(sessionId => ({ columns: board.view(sessionId, child => live.get(child)?.status), running: 0, limit: 5 }), agent);
    t.after(dispose); return { agent, board, dispose };
  };
  t.after(async () => { for (const scope of mounts) await scope.dispose(); });
  const one = make('one'), two = make('two'); make('standard', 'standard'); make('child', 'dscode', 'subagent');
  const status = id => desktopBoardRequest(host, { action: 'status', sessionId: id });
  assert.equal(status('one').columns.pending.length, 0);
  one.board.add('one', [{ title: 'Base', child: 'base', detail: 'Owned files and checks' }, { title: 'UI', child: 'ui', depends_on: ['base'], priority: 'high' }]);
  two.board.add('two', [{ title: 'Other session', child: 'other' }]);
  assert.deepEqual(status('one').columns.pending.map(task => task.title), ['Base', 'UI']);
  assert.deepEqual(status('one').columns.pending[1].blockedBy, ['t1']);
  assert.equal(status('two').columns.pending[0].title, 'Other session');
  one.board.launched('one', 'base', 'base-child', '/workspace/base');
  one.board.waiting('one', 'base-child', true);
  assert.equal(status('one').columns.running[0].waiting, true);
  assert.equal(status('one').columns.running[0].worktree, '/workspace/base');
  assert(!JSON.stringify(status('one')).includes('base-child'), 'internal child IDs are omitted');
  one.board.waiting('one', 'base-child', false); assert.equal(status('one').columns.verifying.length, 1);
  one.board.complete('one', 't1', 'Reviewed diff and tests passed');
  assert.deepEqual(status('one').columns.pending[0].blockedBy, []);
  assert.equal(status('one').columns.complete[0].verification, 'Reviewed diff and tests passed');
  two.dispose(); assert.equal(delegateBoardFor('one').columns.complete.length, 1, 'terminal lookup still finds the owning source');
  assert.equal(status('one').columns.complete.length, 1);
  assert.throws(() => status('two'), /unavailable/);
  for (const id of ['standard', 'child', 'missing']) assert.throws(() => status(id), /open DSCODE main session/);
  assert.throws(() => desktopBoardRequest(host, { action: 'clear', sessionId: 'one' }), /Choose/);
  one.dispose(); assert.throws(() => status('one'), /unavailable/);
});

test('Desktop board displays dependencies and evidence, clears failed state and ignores replies after switching sessions', async t => {
  let definition, Component, inject, tick, reject = false, pending;
  runInNewContext(readFileSync(new URL('../plugins/dscode/desktop-client.mjs', import.meta.url), 'utf8'), {
    globalThis: { __ModuleLoader__: { load: value => { definition = value; } } }, setInterval: fn => { tick = fn; return 1; }, clearInterval() {},
  });
  const task = { id: 't1', title: 'Task one', child: 'worker', priority: 'high', dependsOn: ['t0'], blockedBy: ['t0'], waiting: false,
    detail: 'scope', note: '', verification: '', worktree: '/workspace/task' };
  const snapshot = title => ({ running: 0, limit: 5, columns: { pending: [{ ...task, title }], running: [], verifying: [], complete: [] } });
  definition.factory(() => React).apply({ effect: fn => fn(), sidebarRightTabs: { register: () => () => {} },
    slots: { inject: (_name, fn) => fn(), register: (spec, component) => { inject = spec.inject; Component = component; return () => {}; } },
    connection: { rpc: { call: async (_path, _method, { sessionId }) => {
      if (reject) throw Error('Session closed');
      if (pending) return pending;
      return { ok: true, value: snapshot(sessionId) };
    } } },
  });
  const props = id => ({ ...inject(id), useTabInfo: () => ({ tab: { visible: true } }) });
  let renderer; await act(async () => { renderer = TestRenderer.create(React.createElement(Component, props('one'))); });
  t.after(async () => { await act(async () => renderer.unmount()); });
  const text = () => JSON.stringify(renderer.toJSON());
  assert(text().includes('Blocked by t0')); assert(text().includes('/workspace/task')); assert(text().includes('one'));
  reject = true; await act(async () => tick()); assert(text().includes('Session closed')); assert(!text().includes('/workspace/task')); reject = false;
  let resolve; pending = new Promise(done => { resolve = done; });
  let previous; await act(async () => { previous = tick(); }); pending = null;
  await act(async () => renderer.update(React.createElement(Component, props('two'))));
  await act(async () => { resolve({ ok: true, value: snapshot('STALE_SESSION') }); await previous; });
  assert(text().includes('two')); assert(!text().includes('STALE_SESSION'));
  await act(async () => renderer.update(React.createElement(Component, { ...props('two'), useTabInfo: () => ({ tab: { visible: false } }) })));
  assert.equal(renderer.toJSON(), null);
});
