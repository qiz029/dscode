import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, readFile, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Context } from '@deepseek-ai/cordis';
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment';
import Credentials from '../plugins/credentials/index.mjs';

test('native credential persistence, legacy fallback, environment precedence and owner-only permissions', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dscode-credentials-'));
  const path = join(home, 'shared', 'credentials.yaml');
  const roots = [];
  async function open(env = {}) {
    const ctx = new Context(); roots.push(ctx);
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: env }]));
    await ctx.plugin(Credentials, { path, dshHome: home, watch: false });
    return ctx;
  }
  try {
    const ref = 'DEEPSEEK_API_KEY';
    await writeFile(join(home, '.credentials.yaml'), 'version: 1\nrefs:\n  DEEPSEEK_API_KEY: synthetic-legacy\n  OTHER_KEY: synthetic-other\n', { mode: 0o600 });
    const first = await open();
    assert.equal((await first.credentials.resolve(ref)).value, 'synthetic-legacy');
    assert.equal((await first.credentials.resolve('OTHER_KEY')).value, 'synthetic-other');
    const events = [];
    first.on('credentials/reference-updated', ref => events.push(ref));
    await first.credentials.set(ref, 'synthetic-new');
    assert.equal((await first.credentials.resolve(ref)).value, 'synthetic-new');
    assert.deepEqual(events, [ref]);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal((await stat(join(home, 'shared'))).mode & 0o777, 0o700);
    assert.match(await readFile(join(home, '.credentials.yaml'), 'utf8'), /synthetic-legacy/);
    await first.fiber.dispose();
    const second = await open();
    assert.equal((await second.credentials.resolve(ref)).value, 'synthetic-new');
    const overridden = await open({ [ref]: 'synthetic-env' });
    assert.equal((await overridden.credentials.resolve(ref)).value, 'synthetic-env');
    assert.equal((await overridden.credentials.describe(ref)).writable, false);
    await assert.rejects(overridden.credentials.set(ref, 'synthetic-replacement'), /read-only/);
    await second.credentials.unset(ref);
    assert.equal(await second.credentials.resolve(ref), undefined);
    await second.fiber.dispose();
    await overridden.fiber.dispose();
    await chmod(path, 0o644);
    await assert.rejects(open(), /permission|owner|0600|readable/i);
  } finally {
    for (const ctx of roots) await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
});

test('the OpenRouter key shares the cross-project store and its environment override', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dscode-credentials-openrouter-'));
  const path = join(home, 'shared', 'credentials.yaml');
  const roots = [];
  async function open(env = {}) {
    const ctx = new Context(); roots.push(ctx);
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: env }]));
    await ctx.plugin(Credentials, { path, dshHome: home, watch: false });
    return ctx;
  }
  try {
    const ref = 'OPENROUTER_API_KEY';
    const first = await open();
    assert.equal((await first.credentials.describe(ref)).configured, false);
    await first.credentials.set(ref, 'synthetic-openrouter');
    assert.match(await readFile(path, 'utf8'), /OPENROUTER_API_KEY: synthetic-openrouter/);
    await first.fiber.dispose();
    const second = await open();
    assert.equal((await second.credentials.resolve(ref)).value, 'synthetic-openrouter');
    const overridden = await open({ [ref]: 'synthetic-env' });
    assert.equal((await overridden.credentials.resolve(ref)).value, 'synthetic-env');
    assert.equal((await overridden.credentials.describe(ref)).writable, false);
    await second.credentials.unset(ref);
    assert.equal(await second.credentials.resolve(ref), undefined);
  } finally {
    for (const ctx of roots) await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
});

test('the OpenCode Go login is a read-only credential the login command writes to the shared store', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dscode-credentials-opencode-'));
  const ctx = new Context();
  try {
    ctx.provide('launchEnvironment', createLaunchEnvironmentSnapshot([{ source: 'process', values: {} }]));
    await ctx.plugin(Credentials, { path: join(home, 'shared', 'credentials.yaml'), dshHome: home, watch: false });
    assert.deepEqual(await ctx.credentials.describe('OPENCODE_OAUTH'), { configured: false, writable: false }, 'no key form is offered');
    await ctx.credentials.set('OPENCODE_OAUTH', '{"version":1}');
    assert.match(await readFile(join(home, 'shared', 'credentials.yaml'), 'utf8'), /OPENCODE_OAUTH/, 'the login lives in the shared store');
    assert.deepEqual(await ctx.credentials.describe('OPENCODE_OAUTH'), { configured: true, source: 'account', writable: false });
    await ctx.credentials.unset('OPENCODE_OAUTH');
    assert.equal((await ctx.credentials.describe('OPENCODE_OAUTH')).configured, false);
  } finally {
    await ctx.fiber.dispose();
    await rm(home, { recursive: true, force: true });
  }
});
