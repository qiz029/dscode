import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createTestRuntime, upstreamPackages } from '../scripts/test-runtime.mjs';
import { patchTui } from '../scripts/patch-tui.mjs';
import { patchRuntime } from '../scripts/patch-runtime.mjs';
import { patchStyle } from '../scripts/patch-style.mjs';

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
