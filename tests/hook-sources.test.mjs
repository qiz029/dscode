import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { hookReportFile, mergeHooks, projectHooksEnabled, resolveHookSources, writeHookConfig } from '../plugins/tui-tools/hook-sources.mjs';

const gate = command => ({ hooks: { PreToolUse: [{ matcher: '^bash$', hooks: [{ type: 'command', command, timeout: 5 }] }] } });
const writeJson = (path, value) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value) + '\n');
};

function scaffold() {
  const base = mkdtempSync(join(tmpdir(), 'dscode-hooks-'));
  const root = join(base, 'install');
  const cwd = join(base, 'project');
  const home = join(base, 'home');
  mkdirSync(join(root, 'config'), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  writeJson(join(root, 'config/hooks.local.json'), gate('/bin/installation-gate'));
  return { base, root, cwd, home, installation: join(root, 'config/hooks.local.json'), cleanup: () => rmSync(base, { recursive: true, force: true }) };
}

test('project hook files layer on by default and the switch turns them off', () => {
  const { root, cwd, home, cleanup } = scaffold();
  try {
    writeJson(join(cwd, '.codex/hooks.json'), gate('/bin/project-gate'));
    const layered = writeHookConfig({ root, cwd, home, env: {} });
    assert.deepEqual(layered.sources, [join(root, 'config/hooks.local.json'), join(cwd, '.codex/hooks.json')]);
    assert.equal(layered.path, join(home, 'hooks.resolved.json'));
    const alone = writeHookConfig({ root, cwd, home, env: { DSCODE_PROJECT_HOOKS: '0' } });
    assert.deepEqual(alone, { path: join(root, 'config/hooks.local.json'), sources: [join(root, 'config/hooks.local.json')], skipped: [] });
    assert.equal(projectHooksEnabled({}), true);
    assert.equal(projectHooksEnabled({ DSCODE_PROJECT_HOOKS: '' }), false);
    assert.equal(projectHooksEnabled({ DSCODE_PROJECT_HOOKS: 'off' }), false);
    assert.equal(projectHooksEnabled({ DSCODE_PROJECT_HOOKS: 'false' }), false);
    assert.equal(projectHooksEnabled({ DSCODE_PROJECT_HOOKS: ' TRUE ' }), true);
    assert.equal(projectHooksEnabled({ DSCODE_PROJECT_HOOKS: '1' }), true);
    assert.equal(projectHooksEnabled({ DSCODE_PROJECT_HOOKS: 'yes' }), true);
    for (const value of ['no', 'none', 'disable', 'disabled', '2']) assert.equal(projectHooksEnabled({ DSCODE_PROJECT_HOOKS: value }), false, `DSCODE_PROJECT_HOOKS=${value} must not arm project hooks`);
  } finally {
    cleanup();
  }
});

test('codex, dsh and claude files merge into one private bridge config with a report', () => {
  const { root, cwd, home, cleanup } = scaffold();
  try {
    writeJson(join(cwd, '.codex/hooks.json'), gate('/bin/codex-gate'));
    writeJson(join(cwd, '.dsh/hooks.json'), gate('/bin/dsh-gate'));
    writeJson(join(cwd, '.claude/settings.json'), { model: 'sonnet', ...gate('/bin/claude-gate') });
    const resolved = writeHookConfig({ root, cwd, home, env: {} });
    assert.deepEqual(resolved.sources, [
      join(root, 'config/hooks.local.json'), join(cwd, '.codex/hooks.json'), join(cwd, '.dsh/hooks.json'), join(cwd, '.claude/settings.json'),
    ]);
    assert.equal(resolved.path, join(home, 'hooks.resolved.json'));
    const merged = JSON.parse(readFileSync(resolved.path, 'utf8'));
    assert.deepEqual(Object.keys(merged.hooks), ['PreToolUse']);
    assert.deepEqual(merged.hooks.PreToolUse.flatMap(group => group.hooks.map(hook => hook.command)), [
      '/bin/installation-gate', '/bin/codex-gate', '/bin/dsh-gate', '/bin/claude-gate',
    ]);
    assert.equal(statSync(resolved.path).mode & 0o777, 0o600);
    const report = JSON.parse(readFileSync(join(home, hookReportFile), 'utf8'));
    assert.deepEqual(report, { sources: resolved.sources, skipped: [] });
    assert.equal(statSync(join(home, hookReportFile)).mode & 0o777, 0o600);
  } finally {
    cleanup();
  }
});

test('a settings file without hooks is skipped, unsupported project events are reported, the installation file still fails', () => {
  const { root, cwd, home, installation, cleanup } = scaffold();
  try {
    writeJson(join(cwd, '.claude/settings.json'), { model: 'sonnet', permissions: {} });
    assert.deepEqual(writeHookConfig({ root, cwd, home, env: {} }).sources, [installation]);
    writeJson(join(cwd, '.claude/settings.json'), { hooks: { PreCompact: [{ hooks: [{ type: 'command', command: '/bin/compact' }] }], ...gate('/bin/claude-gate').hooks } });
    const layered = writeHookConfig({ root, cwd, home, env: {} });
    assert.deepEqual(layered.skipped, [{ path: '.claude/settings.json', events: ['PreCompact'] }]);
    const merged = JSON.parse(readFileSync(layered.path, 'utf8'));
    assert.deepEqual(Object.keys(merged.hooks), ['PreToolUse']);
    writeJson(join(cwd, '.codex/hooks.json'), { hooks: { PreToolUse: { matcher: '^bash$' }, Stop: [{ hooks: [{ type: 'command', command: '/bin/stop' }] }] } });
    const lenient = writeHookConfig({ root, cwd, home, env: {} });
    assert.deepEqual(lenient.skipped.find(entry => entry.path === '.codex/hooks.json'), { path: '.codex/hooks.json', events: ['PreToolUse (expected matcher groups)'] });
    const lenientMerged = JSON.parse(readFileSync(lenient.path, 'utf8'));
    assert.deepEqual(Object.keys(lenientMerged.hooks).sort(), ['PreToolUse', 'Stop']);
    assert.equal(lenientMerged.hooks.Stop.length, 1);
    writeFileSync(join(cwd, '.codex/hooks.json'), '{ "hooks": { /* a Claude settings file may carry comments */ } }\n');
    const unreadable = writeHookConfig({ root, cwd, home, env: {} });
    assert.equal(unreadable.skipped.find(entry => entry.path === '.codex/hooks.json').events.length, 1);
    assert.match(unreadable.skipped.find(entry => entry.path === '.codex/hooks.json').events[0], /^\(not loaded: /);
    writeJson(installation, { hooks: { PreCompact: [] } });
    assert.throws(() => resolveHookSources({ root, cwd, env: {} }), /Unsupported hook event: PreCompact/);
  } finally {
    cleanup();
  }
});

test('a stale merge is removed when the project layers go away', () => {
  const { root, cwd, home, installation, cleanup } = scaffold();
  try {
    const project = join(cwd, '.codex/hooks.json');
    writeJson(project, gate('/bin/project-gate'));
    const layered = writeHookConfig({ root, cwd, home, env: {} });
    assert(existsSync(layered.path));
    assert(existsSync(join(home, hookReportFile)));
    rmSync(project);
    const alone = writeHookConfig({ root, cwd, home, env: {} });
    assert.equal(alone.path, installation);
    assert.equal(existsSync(join(home, 'hooks.resolved.json')), false);
    assert.equal(existsSync(join(home, hookReportFile)), false);
  } finally {
    cleanup();
  }
});

test('merging concatenates each event in source order and tolerates an empty installation file', () => {
  const group = command => ({ matcher: '^bash$', hooks: [{ type: 'command', command }] });
  assert.deepEqual(mergeHooks([
    { path: 'installation', hooks: undefined },
    { path: 'project', hooks: { PreToolUse: [group('a')], Stop: [group('c')] } },
    { path: 'project2', hooks: { PreToolUse: [group('b')] } },
  ]), { hooks: { PreToolUse: [group('a'), group('b')], Stop: [group('c')] } });
});
