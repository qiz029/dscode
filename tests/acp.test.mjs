import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAcpArgs, acpOverlay, USAGE } from '../plugins/acp/cli.mjs';
import { presetAgents, startAcp } from '../plugins/acp/index.mjs';
import { runAcp } from '../scripts/acp.mjs';
import { EventEmitter } from 'node:events';
import { readFileSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { commandPlan } from '../packages/launcher/manager.mjs';

test('ACP accepts transport options, rejects prompts and malformed model routes', () => {
  assert.deepEqual(parseAcpArgs([]), { patches: [], help: false });
  assert.deepEqual(parseAcpArgs(['--model', 'custom-local/org/llama', '--patch', 'one', '--patch', 'two']), { model: 'custom-local/org/llama', patches: ['one', 'two'], help: false });
  assert.equal(parseAcpArgs(['-h']).help, true);
  assert.equal(parseAcpArgs(['--help']).help, true);
  for (const args of [['hello'], ['--unknown'], ['--model'], ['--patch'], ['--model', '--help'], ['--model', 'llama'], ['--model', '/llama'], ['--model', 'provider/']]) assert.throws(() => parseAcpArgs(args));
  assert.match(USAGE, /stdio/);
});

test('ACP composition removes terminal owners and auxiliary generation before mounting the bridge', () => {
  const overlay = acpOverlay('/tmp/a b/index.mjs', { model: 'custom-local/llama' });
  for (const id of ['tui-startup', 'tui-runner', 'session-title-llm']) assert(overlay.includes(`- id: ${id}\n  disabled: true`));
  assert.match(overlay, /dscode-session-cards\n {2}config:\n {4}enabled: false/);
  assert.match(overlay, /dsh-acp-app/);
  assert.match(overlay, /"custom-local\/llama"/);
  assert.match(overlay, /"\/tmp\/a b\/index.mjs"/);
  assert(!acpOverlay('/entry', {}).includes('undefined'));
});

test('ACP agents mount DSCODE on create and resume without changing the shared factory', async () => {
  const events = [], calls = [];
  const handle = { agent: { session: {} } };
  const original = { async create(options) { assert.equal(this, original); calls.push(options); await options.setup('agent-ctx', handle.agent); return handle; }, async resume(options) { return this.create(options); } };
  const ctx = { agents: original, agentPresets: { async mount(scope, name) { events.push([scope, name]); } }, permissionPresets: { set(session, mode) { assert.equal(session, handle.agent.session); events.push(mode); } } };
  const wrapped = presetAgents(ctx);
  original.label = 'shared';
  original.get = function () { assert.equal(this, original); return handle; };
  assert.equal(wrapped.label, 'shared');
  assert.equal(wrapped.get(), handle);
  const setup = async (...args) => events.push(args);
  assert.equal(await wrapped.create({ meta: { cwd: '/tmp' }, setup }), handle);
  assert.deepEqual(calls[0].meta, { cwd: '/tmp', agentPreset: 'dscode' });
  assert.deepEqual(events, [['agent-ctx', 'dscode'], ['agent-ctx', handle.agent], 'ask']);
  events.length = 0;
  await wrapped.resume({ resumeSessionId: 'saved', setup });
  assert.equal(calls[1].resumeSessionId, 'saved');
  assert.deepEqual(events, [['agent-ctx', 'dscode'], ['agent-ctx', handle.agent], 'ask']);
  await wrapped.create({});
  assert.equal(ctx.agents, original);
});

test('ACP setup failure rejects session creation and bridge resolves explicit or saved model', async () => {
  const ctx = { agents: { async create(o) { await o.setup({}); } }, agentPresets: { async mount() { throw Error('preset failed'); } } };
  await assert.rejects(presetAgents(ctx).create({}), /preset failed/);
  const scoped = {};
  const full = { ...ctx, agentDefaultModel: { currentSelection: () => ({ provider: 'custom-saved', model: 'llama' }) }, extend(meta) { Object.assign(scoped, meta); return scoped; } };
  const seen = [];
  startAcp(full, {}, (scope, config) => seen.push([scope, config]));
  assert.equal(seen[0][0], scoped);
  assert.deepEqual(seen[0][1], { provider: 'custom-saved', model: 'llama' });
  startAcp(full, { model: 'openrouter/org/model' }, (_scope, config) => seen.push(config));
  assert.deepEqual(seen[1], { provider: 'openrouter', model: 'org/model' });
});

test('source ACP runner forwards options and signals, preserves exit codes and cleans overlays', async () => {
  for (const event of ['exit', 'error']) {
    const child = new EventEmitter(), kills = [];
    child.kill = signal => kills.push(signal);
    const before = process.listenerCount('SIGHUP');
    let overlay;
    const task = runAcp(['--patch', 'extra.yml', '--model', 'custom-test/llama'], {
      home: '/tmp/acp-test', prepare(home) { assert.equal(home, '/tmp/acp-test'); },
      launch(args, options) {
        assert.equal(options.home, '/tmp/acp-test');
        overlay = args.at(-1);
        assert.match(readFileSync(overlay, 'utf8'), /custom-test\/llama/);
        assert(args.some(arg => arg.endsWith('/extra.yml')));
        return child;
      },
    });
    process.emit('SIGHUP');
    assert.deepEqual(kills, ['SIGHUP']);
    if (event === 'exit') { child.emit('exit', null, 'SIGTERM'); assert.equal(await task, 130); }
    else { child.emit('error', Error('spawn failed')); await assert.rejects(task, /spawn failed/); }
    assert.equal(process.listenerCount('SIGHUP'), before);
    assert(!existsSync(overlay));
  }
  assert.equal(await runAcp(['--help'], { prepare() { assert.fail('help must not provision'); } }), 0);
});

test('npm launcher routes ACP and keeps stdin and protocol stdout intact', () => {
  assert.deepEqual(commandPlan(['acp', '--model', 'custom-x/m'], {}, false), { acp: ['--model', 'custom-x/m'], install: true });
  const home = mkdtempSync(join(tmpdir(), 'acp-launcher-'));
  const profile = join(home, 'profiles/dscode');
  const release = { version: '0.1.0', runtime: '0.1.7-alpha.2', bundle: '@test/bundle' };
  const write = (path, content) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, typeof content === 'string' ? content : JSON.stringify(content)); };
  const manager = new URL('../packages/launcher/manager.mjs', import.meta.url).href;
  const run = args => spawnSync(process.execPath, ['--input-type=module', '-e', `import { run } from ${JSON.stringify(manager)}; await run(${JSON.stringify(args)}, ${JSON.stringify(release)});`], { env: { ...process.env, DSCODE_HOME: home }, input: 'CLIENT_FRAME\n', encoding: 'utf8', timeout: 10000 });
  try {
    assert.match(run(['acp', '--help']).stdout, /Usage: dscode acp/);
    assert(!existsSync(join(home, '.launcher.guard')));
    write(join(home, '.hub/installations/dscode/current.json'), {});
    write(join(profile, 'package.json'), {});
    write(join(profile, 'node_modules/@test/bundle/package.json'), { name: release.bundle, version: release.version, dependencies: { '@deepseek-ai/dsh': release.runtime } });
    write(join(profile, 'node_modules/@deepseek-ai/dsh/package.json'), { version: release.runtime });
    write(join(profile, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), `const fs=require('fs'); const args=process.argv.slice(2); console.log(JSON.stringify({stdin:fs.readFileSync(0,'utf8'),overlay:fs.readFileSync(args.at(-1),'utf8')})); process.exit(7);`);
    assert.match(run(['acp']).stderr, /no ACP runner/);
    write(join(profile, 'node_modules/@test/bundle/plugins/acp/index.mjs'), 'export {};');
    const result = run(['acp', '--model', 'custom-x/llama']);
    assert.equal(result.status, 7, result.stderr);
    const frame = JSON.parse(result.stdout);
    assert.equal(frame.stdin, 'CLIENT_FRAME\n');
    assert.match(frame.overlay, /custom-x\/llama/);
    assert.equal(result.stderr, '');
  } finally { rmSync(home, { recursive: true, force: true }); }
});
