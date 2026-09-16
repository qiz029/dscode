import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newerVersion, fetchLatestVersion, planUpdate, scheduleUpdate, runUpdateAfterExit, stateHome } from '../plugins/tui-tools/update.mjs';
import { patchErrors } from '../scripts/patch-errors.mjs';
import { catalogEntry } from '../scripts/patch-command-catalog.mjs';
import { patchUpdateCheck, UPDATE_CHECK_MARKER } from '../scripts/patch-update-tui.mjs';
import { patchTui } from '../scripts/patch-tui.mjs';

const root = join(import.meta.dirname, '..');

test('newerVersion orders releases and ranks a prerelease below its release', () => {
  assert.equal(newerVersion('0.7.11', '0.7.10'), true);
  assert.equal(newerVersion('0.8.0', '0.7.10'), true);
  assert.equal(newerVersion('0.7.10', '0.7.10'), false);
  assert.equal(newerVersion('0.7.9', '0.7.10'), false);
  assert.equal(newerVersion('0.8.0-rc.1', '0.8.0'), false);
  assert.equal(newerVersion('0.8.0', '0.8.0-rc.1'), true);
});

test('fetchLatestVersion answers only a readable, well-formed listing', async () => {
  const ok = async () => ({ ok: true, json: async () => ({ version: '0.7.11' }) });
  assert.equal(await fetchLatestVersion({ fetchImpl: ok }), '0.7.11');
  assert.equal(await fetchLatestVersion({ fetchImpl: async () => ({ ok: false, status: 500 }) }), undefined);
  assert.equal(await fetchLatestVersion({ fetchImpl: async () => ({ ok: true, json: async () => ({ version: 'latest' }) }) }), undefined);
  assert.equal(await fetchLatestVersion({ fetchImpl: async () => { throw Error('offline'); } }), undefined);
});

test('planUpdate targets the tree it is installed in, and the npm launcher otherwise', () => {
  const self = fileURLToPath(new URL('../plugins/tui-tools/update.mjs', import.meta.url));
  const plan = planUpdate({ moduleUrl: `file://${self}` });
  assert.deepEqual(plan.args, [join(root, 'bin/dscode.mjs'), 'update', 'latest']);
  const scratch = mkdtempSync(join(tmpdir(), 'dscode-plan-'));
  try {
    const orphan = join(scratch, 'plugins/tui-tools/update.mjs');
    mkdirSync(join(scratch, 'plugins/tui-tools'), { recursive: true });
    assert.equal(planUpdate({ moduleUrl: `file://${orphan}` }).command, 'dscode');
  } finally { rmSync(scratch, { recursive: true, force: true }); }
});

test('scheduleUpdate starts a detached helper with the session pid', () => {
  const calls = [];
  const spawnImpl = (command, args, options) => { calls.push([command, args, options]); return { unref() { calls[calls.length - 1].unref = true; } }; };
  const home = mkdtempSync(join(tmpdir(), 'dscode-schedule-'));
  try {
    const result = scheduleUpdate({ helperModuleUrl: new URL('../plugins/tui-tools/update.mjs', import.meta.url), pid: 4242, version: '0.7.11', env: { ...process.env, DSH_HOME: home }, spawnImpl });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0][1].slice(-2), ['4242', '0.7.11']);
    assert.equal(calls[0][2].detached, true);
    assert.equal(calls[0].unref, true, 'the helper must outlive the TUI');
    assert.equal(result.log, join(home, 'update.log'));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('runUpdateAfterExit waits for the session, runs the update and records the outcome', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dscode-after-'));
  const calls = [];
  try {
    const result = await runUpdateAfterExit({ pid: 999999, version: '0.7.11', home, moduleUrl: `file://${fileURLToPath(new URL('../plugins/tui-tools/update.mjs', import.meta.url))}`, sleep: async () => {}, spawnImpl: (command, args) => { calls.push([command, ...args]); return { status: 0, stdout: 'updated', stderr: '' }; } });
    assert.equal(result.status, 'done');
    assert.deepEqual(calls, [[process.execPath, join(root, 'bin/dscode.mjs'), 'update', '0.7.11']]);
    assert.match(readFileSync(join(home, 'update.log'), 'utf8'), /finished/);
    assert.deepEqual(JSON.parse(readFileSync(join(home, 'update-result.json'), 'utf8')).status, 'done');
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('runUpdateAfterExit records a failed update instead of throwing', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dscode-after-'));
  try {
    const result = await runUpdateAfterExit({ pid: 999999, home, sleep: async () => {}, spawnImpl: () => ({ status: 2, stdout: '', stderr: 'npm failed' }) });
    assert.equal(result.status, 'failed');
    assert.match(readFileSync(join(home, 'update.log'), 'utf8'), /npm failed/);
    assert.equal(JSON.parse(readFileSync(join(home, 'update-result.json'), 'utf8')).code, 2);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test('stateHome follows DSH_HOME and falls back to the launcher default', () => {
  assert.equal(stateHome({ DSH_HOME: '/tmp/x' }, '/home/u'), '/tmp/x');
  assert.equal(stateHome({}, '/home/u'), '/home/u/.local/share/dscode-hub');
});

test('the patched TUI shows unexpected stops as errors and keeps user cancels dim', () => {
  const path = join(root, 'node_modules/dsh-code/lib/index.mjs');
  const text = readFileSync(path, 'utf8');
  assert.equal(patchErrors(text), text, 'the error patch is idempotent once applied');
  assert.match(text, /kind: userCancelled \|\| reason\.kind === "max-tokens" \? "turn-marker" : "error"/);
});

test('the patched TUI checks the registry once at startup and offers /update', () => {
  const path = join(root, 'node_modules/dsh-code/lib/index.mjs');
  const text = readFileSync(path, 'utf8');
  assert.ok(text.includes(UPDATE_CHECK_MARKER));
  assert.match(text, /function dscodeNewerVersion\(/);
  assert.match(text, /DSCODE_UPDATE_CHECK === "off"/);
  assert.match(text, /function dscodeT\(/, "the language runtime must exist for the notice");
  assert.match(text, /dscodeT\("update\.available", \{ version: latest \}\)/);
  assert.match(patchUpdateCheck(text, '0.7.10'), /dscodeNewerVersion\(latest, "0\.7\.10"\)/);
  // The catalog row is keyed through the DSCODE i18n arm in the 1.2.0 generation.
  assert.ok(text.includes(catalogEntry('update')), 'the /update row rides the command catalog');
  assert.match(text, /"cmd\.dscode\.update": "upgrade DSCODE after this session exits"/);
});

test('provisioning the TUI is complete and repeatable', () => {
  const dir = join(root, 'node_modules/dsh-code/lib/index.mjs');
  const before = readFileSync(dir, 'utf8');
  patchTui(root);
  assert.equal(readFileSync(dir, 'utf8'), before, 're-provisioning an already patched tree changes nothing');
  assert.ok(existsSync(join(root, '.runtime/profiles/tui/cordis.patch.yml')));
});
