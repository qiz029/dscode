import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createTestRuntime, upstreamPackages } from '../scripts/test-runtime.mjs';
import { patchTui } from '../scripts/patch-tui.mjs';
import { patchRuntime } from '../scripts/patch-runtime.mjs';
import { patchStyle } from '../scripts/patch-style.mjs';
import { visibleSettledLines } from '../scripts/patch-viewport.mjs';
import { welcomeVisibleRows } from '../scripts/patch-welcome.mjs';

test('transcript viewport keeps the newest settled lines within its row budget', () => {
  const entries = [['old'], [], ['a', 'b', 'c'], ['streaming']];
  const render = (entry, width, reasoning) => {
    assert.equal(width, 10);
    assert.equal(reasoning, false);
    return entry;
  };
  assert.deepEqual(visibleSettledLines(entries, 3, 2, 8, false, render), ['b', 'c']);
  assert.deepEqual(visibleSettledLines(entries, 3, 5, 8, false, render), ['old', 'a', 'b', 'c']);
  assert.deepEqual(visibleSettledLines(entries, 3, 0, 8, false, () => assert.fail('hidden viewport must not render')), []);
});

test('welcome rows yield to conversation demand without exceeding the viewport', () => {
  assert.equal(welcomeVisibleRows(20, 13, 0), 13);
  assert.equal(welcomeVisibleRows(20, 13, 7), 13);
  assert.equal(welcomeVisibleRows(20, 13, 8), 12);
  assert.equal(welcomeVisibleRows(20, 13, 20), 0);
  assert.equal(welcomeVisibleRows(3, 4, 30), 4);
  assert.equal(welcomeVisibleRows(20, 13, 20, false), 13);
});

test('pristine locked upstream accepts all patches once, remains valid JS, and is idempotent', t => {
  const fixture = createTestRuntime({ tui: true, runtime: true, patched: false });
  t.after(fixture.close);
  const files = upstreamPackages.map(name => `${fixture.root}/node_modules/${name}/lib/index.${name === 'dsh-code' ? 'mjs' : 'js'}`);
  const before = files.map(path => readFileSync(path, 'utf8'));
  assert(before.every(text => !text.includes('// dscode-')));
  patchTui(fixture.root); patchRuntime(fixture.root);
  const after = files.map(path => readFileSync(path, 'utf8'));
  for (let i = 0; i < files.length; i++) {
    assert.notEqual(after[i], before[i]);
    const checked = spawnSync(process.execPath, ['--check', files[i]], { encoding: 'utf8' });
    assert.equal(checked.status, 0, checked.stderr);
  }
  patchTui(fixture.root); patchRuntime(fixture.root);
  assert.deepEqual(files.map(path => readFileSync(path, 'utf8')), after);
  // Prior style revisions used a shorter activity suffix and summary catalog.
  const oldStyle = after[0].replace(': " · 本轮 " + runClock(elapsed);', ': " · " + runClock(elapsed);');
  assert.equal(patchStyle(oldStyle), after[0]);
});

test('upstream drift fails before replacing any TUI file, including missing login anchors', t => {
  const fixture = createTestRuntime({ tui: true, patched: false });
  t.after(fixture.close);
  const path = `${fixture.root}/node_modules/dsh-code/lib/index.mjs`;
  const original = readFileSync(path, 'utf8');
  for (const anchor of ['const LOCAL_COMMANDS = [', 'const text = submissionPayload(liveValue);', 'function ProviderSetupPanel(']) {
    const drifted = original.replace(anchor, '/* changed upstream */');
    assert.notEqual(drifted, original);
    writeFileSync(path, drifted);
    assert.throws(() => patchTui(fixture.root), /Unsupported|drift/);
    assert.equal(readFileSync(path, 'utf8'), drifted);
  }
});
