import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseUpdateArgs, releaseAsset, verifyDigest, migrateState, selfUpdate } from '../scripts/self-update.mjs';
import { compareVersion, launcherUpdateVersion, installLauncher, commandPlan } from '../packages/launcher/manager.mjs';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';

test('update args accept only an exact version', () => {
  assert.deepEqual(parseUpdateArgs([]), { version: undefined });
  assert.deepEqual(parseUpdateArgs(['0.7.9']), { version: '0.7.9' });
  assert.deepEqual(parseUpdateArgs(['0.8.0-rc.1']), { version: '0.8.0-rc.1' });
  assert.deepEqual(parseUpdateArgs(['latest']), { version: undefined }, '"latest" is what the TUI schedules when no version is named');
  assert.throws(() => parseUpdateArgs(['newest']), /Usage/);
  assert.throws(() => parseUpdateArgs(['--force']), /Usage/);
  assert.throws(() => parseUpdateArgs(['0.7.9', 'extra']), /Usage/);
});

test('releaseAsset picks the matching tarball and its sha256 digest', () => {
  const body = { tag_name: 'v0.7.9', draft: false, prerelease: false,
    assets: [{ name: 'dscode-0.7.9.tar.gz', browser_download_url: 'https://example/dscode-0.7.9.tar.gz', digest: 'sha256:abc123', size: 10 }] };
  assert.deepEqual(releaseAsset(body, undefined), { version: '0.7.9', url: 'https://example/dscode-0.7.9.tar.gz', digest: 'abc123', size: 10 });
  assert.equal(releaseAsset(body, '0.7.8'), undefined, 'a tagged release must match the requested version');
  assert.equal(releaseAsset({ ...body, prerelease: true }, undefined), undefined);
  assert.equal(releaseAsset({ ...body, assets: [{ name: 'other.tgz', browser_download_url: 'x' }] }, undefined), undefined);
  assert.equal(releaseAsset({ tag_name: 'v0.7.9', assets: [{ name: 'dscode-0.7.9.tar.gz', browser_download_url: 'x' }] }, undefined).digest, undefined);
});

test('verifyDigest accepts a missing digest and rejects a mismatch', () => {
  const buffer = Buffer.from('payload');
  const digest = createHash('sha256').update(buffer).digest('hex');
  assert.equal(verifyDigest(buffer, digest), true);
  assert.equal(verifyDigest(buffer, '0'.repeat(64)), false);
  assert.equal(verifyDigest(buffer, undefined), true);
});

test('migrateState moves .runtime, drops the stale profile link and carries local config forward', t => {
  const parent = mkdtempSync(join(tmpdir(), 'dscode-migrate-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const from = join(parent, 'old'), to = join(parent, 'new');
  mkdirSync(join(from, '.runtime/profiles/tui'), { recursive: true });
  symlinkSync('/somewhere/old/node_modules', join(from, '.runtime/profiles/tui/node_modules'));
  writeFileSync(join(from, '.env'), 'KEY=1\n');
  mkdirSync(join(from, 'config'), { recursive: true });
  writeFileSync(join(from, 'config/hooks.local.json'), '{"hooks":{}}\n');
  writeFileSync(join(from, 'config/team.yml'), 'custom: true\n');
  mkdirSync(join(to, 'config'), { recursive: true });
  writeFileSync(join(to, 'config/cordis.patch.yml'), 'new-release-defaults\n');
  writeFileSync(join(from, 'config/cordis.patch.yml'), 'stale-previous-defaults\n');
  migrateState(from, to);
  assert.equal(readFileSync(join(to, '.env'), 'utf8'), 'KEY=1\n');
  assert.equal(readFileSync(join(to, 'config/hooks.local.json'), 'utf8'), '{"hooks":{}}\n');
  assert.equal(readFileSync(join(to, 'config/team.yml'), 'utf8'), 'custom: true\n', 'a user config file nothing shipped survives');
  assert.equal(readFileSync(join(to, 'config/cordis.patch.yml'), 'utf8'), 'new-release-defaults\n', 'release-shipped defaults come from the new version');
  assert.ok(existsSync(join(to, '.runtime/profiles/tui')), 'the migrated profile stays');
  assert.ok(!existsSync(join(to, '.runtime/profiles/tui/node_modules')), 'the stale node_modules link is rebuilt by provision');
  assert.ok(!existsSync(join(from, '.runtime')), 'state moved, not copied');
  assert.ok(existsSync(join(from, '.env')), 'small config files are copied, not moved');
});

function installFixture(t, version = '0.7.8') {
  const parent = mkdtempSync(join(tmpdir(), 'dscode-selfupdate-'));
  const installDir = join(parent, 'dscode');
  mkdirSync(join(installDir, 'bin'), { recursive: true });
  mkdirSync(join(installDir, '.runtime/profiles/tui'), { recursive: true });
  symlinkSync('/somewhere/old/node_modules', join(installDir, '.runtime/profiles/tui/node_modules'));
  writeFileSync(join(installDir, 'package.json'), JSON.stringify({ version }));
  writeFileSync(join(installDir, 'bin/dscode.mjs'), '// entry\n');
  writeFileSync(join(installDir, '.env'), 'KEY=fixture\n');
  mkdirSync(join(installDir, 'config'), { recursive: true });
  writeFileSync(join(installDir, 'config/hooks.local.json'), '{"hooks":{}}\n');
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  return { parent, installDir };
}

const TAR_GZ = Buffer.from('dscode-tarball-bytes');
const releaseBody = (version, digest) => ({ tag_name: `v${version}`, draft: false, prerelease: false,
  assets: [{ name: `dscode-${version}.tar.gz`, browser_download_url: 'https://example/download', digest: `sha256:${digest}`, size: TAR_GZ.length }] });

function fakeFetch(body, tarball) {
  const calls = [];
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('api.github.com')) return { ok: true, json: async () => body, arrayBuffer: async () => { throw Error('no body'); } };
    return { ok: true, json: async () => { throw Error('no json'); }, arrayBuffer: async () => tarball };
  };
  return { fetchImpl, calls };
}

function fakeExec(stagedVersion) {
  const calls = [];
  return { calls, exec: (argv, { cwd, capture = false } = {}) => {
    calls.push(argv.join(' '));
    if (argv[0] === 'ps') return '  /sbin/launchd\n';
    if (argv[0] === 'tar') {
      writeFileSync(join(cwd, 'package.json'), JSON.stringify({ version: stagedVersion }));
      mkdirSync(join(cwd, 'bin'), { recursive: true });
      writeFileSync(join(cwd, 'bin/dscode.mjs'), '// new entry\n');
      return '';
    }
    if (argv[0] === 'npm') { writeFileSync(join(cwd, 'npm.done'), argv.join(' ')); return ''; }
    throw Error(`unexpected command: ${argv.join(' ')}`);
  } };
}

function checkoutExec(calls, { dirty = false, changed = true } = {}) {
  let head = 'head-before';
  return (argv, options = {}) => {
    calls.push(argv.join(' '));
    if (argv[0] === 'ps') return '  /sbin/launchd\n';
    if (argv[2] === '--porcelain') return dirty ? ' M bin/dscode.mjs\n' : '';
    if (argv[1] === 'rev-parse') return `${head}\n`;
    if (argv[1] === 'pull') {
      if (changed) { head = 'head-after'; writeFileSync(join(options.cwd, 'package.json'), JSON.stringify({ version: '0.7.9' })); }
      return '';
    }
    if (argv[0] === 'npm') return '';
    throw Error(`unexpected command: ${argv.join(' ')}`);
  };
}

test('selfUpdate updates a source checkout through git and reinstalls its dependencies', async t => {
  const { installDir } = installFixture(t);
  mkdirSync(join(installDir, '.git'));
  const calls = [];
  const result = await selfUpdate([], { installDir, exec: checkoutExec(calls), fetchImpl: async () => { throw Error('a source checkout must not read GitHub'); } });
  assert.deepEqual(result, { status: 'updated', from: '0.7.8', to: '0.7.9', method: 'git' });
  assert.deepEqual(calls, ['ps -axo command=', 'git status --porcelain --untracked-files=no', 'git rev-parse HEAD', 'git pull --ff-only', 'git rev-parse HEAD', 'npm ci --ignore-scripts --no-audit', 'npm run setup']);
});

test('selfUpdate reports a source checkout already at its branch tip', async t => {
  const { installDir } = installFixture(t);
  mkdirSync(join(installDir, '.git'));
  const calls = [];
  assert.deepEqual(await selfUpdate([], { installDir, exec: checkoutExec(calls, { changed: false }) }), { status: 'current', version: '0.7.8' });
  assert.ok(!calls.includes('npm ci --ignore-scripts --no-audit'), 'nothing is reinstalled when the pull brings no commit');
});

test('selfUpdate refuses a dirty source checkout before running anything', async t => {
  const { installDir } = installFixture(t);
  mkdirSync(join(installDir, '.git'));
  const calls = [];
  await assert.rejects(selfUpdate([], { installDir, exec: checkoutExec(calls, { dirty: true }) }), /uncommitted changes/);
  assert.deepEqual(calls, ['ps -axo command=', 'git status --porcelain --untracked-files=no']);
});

test('selfUpdate refuses an exact version for a source checkout', async t => {
  const { installDir } = installFixture(t);
  mkdirSync(join(installDir, '.git'));
  const calls = [];
  await assert.rejects(selfUpdate(['0.7.9'], { installDir, exec: checkoutExec(calls) }), /tracks its own branch/);
  assert.deepEqual(calls, []);
});

test('selfUpdate reports an up-to-date install without swapping', async t => {
  const { installDir } = installFixture(t, '0.7.8');
  const { fetchImpl } = fakeFetch(releaseBody('0.7.8', createHash('sha256').update(TAR_GZ).digest('hex')), TAR_GZ);
  assert.deepEqual(await selfUpdate([], { installDir, fetchImpl, exec: fakeExec('0.7.9').exec }), { status: 'current', version: '0.7.8' });
});

test('selfUpdate stages, verifies, migrates and swaps the installation directory', async t => {
  const { parent, installDir } = installFixture(t, '0.7.8');
  const digest = createHash('sha256').update(TAR_GZ).digest('hex');
  const { fetchImpl } = fakeFetch(releaseBody('0.7.9', digest), TAR_GZ);
  const { exec, calls } = fakeExec('0.7.9');
  const result = await selfUpdate([], { installDir, fetchImpl, exec });
  assert.deepEqual(result, { status: 'updated', from: '0.7.8', to: '0.7.9', backup: result.backup });
  assert.ok(result.backup.startsWith(parent) && existsSync(result.backup), 'the previous installation is kept as a sibling backup');
  assert.equal(JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')).version, '0.7.9');
  assert.equal(readFileSync(join(installDir, '.env'), 'utf8'), 'KEY=fixture\n', 'local env survives the swap');
  assert.equal(readFileSync(join(installDir, 'config/hooks.local.json'), 'utf8'), '{"hooks":{}}\n');
  assert.ok(existsSync(join(installDir, '.runtime/profiles/tui')), 'state moves with the installation');
  assert.ok(!existsSync(join(installDir, '.runtime/profiles/tui/node_modules')), 'the stale profile link is left for provision to rebuild');
  assert.ok(!existsSync(join(parent, `.dscode-update-${process.pid}`)), 'the staging area is cleaned up');
  assert.ok(calls.some(line => line.startsWith('npm ci --ignore-scripts')), 'dependencies install in the staged tree');
  assert.ok(calls.includes('npm run setup'), 'setup reprovisions the staged profile');
  assert.ok(!existsSync(join(result.backup, '.runtime')), '.runtime moved into the new installation');
});

test('selfUpdate re-checks for sessions right before the swap and changes nothing', async t => {
  const { installDir } = installFixture(t, '0.7.8');
  const digest = createHash('sha256').update(TAR_GZ).digest('hex');
  const { fetchImpl } = fakeFetch(releaseBody('0.7.9', digest), TAR_GZ);
  let checked = 0;
  const exec = (argv, options = {}) => {
    if (argv[0] === 'ps') { checked++; return checked > 1 ? `node ${installDir}/bin/dscode.mjs\n` : '  /sbin/launchd\n'; }
    return fakeExec('0.7.9').exec(argv, options);
  };
  await assert.rejects(selfUpdate([], { installDir, fetchImpl, exec }), /DSCODE started while the update was staged/);
  assert.equal(JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')).version, '0.7.8', 'nothing was swapped');
});

test('selfUpdate refuses a tarball whose digest does not match the release', async t => {
  const { installDir } = installFixture(t, '0.7.8');
  const { fetchImpl } = fakeFetch(releaseBody('0.7.9', '0'.repeat(64)), TAR_GZ);
  const { exec } = fakeExec('0.7.9');
  await assert.rejects(selfUpdate([], { installDir, fetchImpl, exec }), /digest/);
  assert.equal(JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')).version, '0.7.8', 'nothing changed');
});

test('selfUpdate refuses a tagged release without a matching tarball asset', async t => {
  const { installDir } = installFixture(t, '0.7.8');
  const { fetchImpl } = fakeFetch({ tag_name: 'v0.7.9', draft: false, prerelease: false, assets: [{ name: 'notes.txt', browser_download_url: 'x' }] }, TAR_GZ);
  await assert.rejects(selfUpdate(['0.7.9'], { installDir, fetchImpl, exec: fakeExec('0.7.9').exec }), /carries no dscode tarball/);
});

test('compareVersion is numeric and puts a prerelease below its release', () => {
  assert.ok(compareVersion('0.7.10', '0.7.9') > 0);
  assert.ok(compareVersion('0.7.9', '0.7.10') < 0);
  assert.equal(compareVersion('0.7.9', '0.7.9'), 0);
  assert.ok(compareVersion('0.8.0-rc.1', '0.8.0') < 0);
  assert.ok(compareVersion('0.7.9', '0.10.0') < 0);
});

test('selfUpdate updates a real git checkout whose branch advanced', async t => {
  const parent = mkdtempSync(join(tmpdir(), 'dscode-git-'));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const origin = join(parent, 'origin.git'), work = join(parent, 'work');
  const git = args => {
    const result = spawnSync('git', ['-c', 'user.name=fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { encoding: 'utf8' });
    assert.equal(result.status, 0, `git ${args.join(' ')}: ${result.stderr}`);
    return result.stdout ?? '';
  };
  git(['init', '--bare', origin]);
  git(['clone', origin, work]);
  writeFileSync(join(work, 'package.json'), JSON.stringify({ version: '0.7.13' }));
  git(['-C', work, 'add', '.']);
  git(['-C', work, 'commit', '-m', 'release 0.7.13']);
  git(['-C', work, 'push', 'origin', 'HEAD']);
  writeFileSync(join(work, 'package.json'), JSON.stringify({ version: '0.7.14' }));
  git(['-C', work, 'commit', '-am', 'release 0.7.14']);
  git(['-C', work, 'push', 'origin', 'HEAD']);
  git(['-C', work, 'reset', '--hard', 'HEAD~1']);
  // Real git, real pull; only the npm steps are stubbed so the test stays offline and fast.
  const calls = [];
  const exec = (argv, options = {}) => {
    calls.push(argv.join(' '));
    if (argv[0] === 'ps') return '  /sbin/launchd\n';
    if (argv[0] !== 'git') return '';
    const result = spawnSync('git', argv.slice(1), { cwd: options.cwd, encoding: 'utf8' });
    if (result.status !== 0) throw Error(`git ${argv.slice(1).join(' ')} failed: ${result.stderr}`);
    return result.stdout ?? '';
  };
  assert.deepEqual(await selfUpdate([], { installDir: work, exec }), { status: 'updated', from: '0.7.13', to: '0.7.14', method: 'git' });
  assert.equal(JSON.parse(readFileSync(join(work, 'package.json'), 'utf8')).version, '0.7.14');
  assert.deepEqual(calls.filter(line => line.startsWith('npm')), ['npm ci --ignore-scripts --no-audit', 'npm run setup']);
  assert.deepEqual(await selfUpdate([], { installDir: work, exec }), { status: 'current', version: '0.7.14' }, 'a checkout already at the branch tip is left alone');
  writeFileSync(join(work, 'package.json'), JSON.stringify({ version: '0.7.99' }));
  await assert.rejects(selfUpdate([], { installDir: work, exec }), /uncommitted changes/);
});

test('launcherUpdateVersion prefers an explicit argument and asks npm otherwise', async t => {
  const release = { version: '0.7.8' };
  assert.equal(await launcherUpdateVersion('0.9.0', release), '0.9.0');
  const newer = { ok: true, json: async () => ({ version: '0.7.9' }) };
  assert.equal(await launcherUpdateVersion(undefined, release, { fetchImpl: async () => newer }), '0.7.9');
  const same = { ok: true, json: async () => ({ version: '0.7.8' }) };
  assert.equal(await launcherUpdateVersion(undefined, release, { fetchImpl: async () => same }), undefined);
  assert.equal(await launcherUpdateVersion(undefined, release, { fetchImpl: async () => ({ ok: false, status: 500 }) }), undefined, 'a failing registry falls back to the current launcher');
  let asked;
  assert.equal(await launcherUpdateVersion(undefined, release, { fetchImpl: async (url, init) => { asked = init.headers.accept; return newer; } }), '0.7.9');
  assert.equal(asked, 'application/json', 'the abbreviated metadata type is answered 406 on the /latest endpoint, which silently disabled this check');
  assert.equal(await launcherUpdateVersion('latest', release, { fetchImpl: async () => newer }), '0.7.9', '"latest" asks npm like no argument at all');
});

test('installLauncher runs npm install -g for the exact version and fails closed', async t => {
  const events = [];
  const spawnImpl = (command, argv) => {
    events.push([command, ...argv]);
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  };
  await installLauncher('0.7.9', { spawnImpl, log: () => {} });
  assert.deepEqual(events, [['npm', 'install', '-g', '@toddzheng024/dscode@0.7.9']]);
  const failing = () => { const child = new EventEmitter(); queueMicrotask(() => child.emit('exit', 1)); return child; };
  await assert.rejects(installLauncher('0.7.9', { spawnImpl: failing, log: () => {} }), /exited with 1/);
});

test('commandPlan wires launcher and profile versions for update', () => {
  const release = { slug: 'dscode', version: '0.7.8', bundle: '@fixture/bundle' };
  assert.equal(commandPlan(['update'], release, true).launcherUpdate, undefined, 'no newer launcher found: profile follows this launcher');
  assert.deepEqual(commandPlan(['update'], release, true).hub, ['profile', 'upgrade', 'dscode', '--version', '0.7.8', '--profile', 'dscode']);
  const plan = commandPlan(['update'], release, true, '0.7.9');
  assert.equal(plan.launcherUpdate, '0.7.9');
  assert.deepEqual(plan.hub, ['profile', 'upgrade', 'dscode', '--version', '0.7.9', '--profile', 'dscode']);
  assert.equal(commandPlan(['update', '0.7.9'], release, true).launcherUpdate, '0.7.9', 'an explicit version updates the launcher too');
  assert.equal(commandPlan(['update', '0.7.8'], release, true).launcherUpdate, undefined, 'the running launcher version needs no npm pass');
  assert.equal(commandPlan(['install', '0.7.9'], release, false).launcherUpdate, undefined, 'a fresh install never self-updates');
  assert.deepEqual(commandPlan(['update', 'latest'], release, true).hub, commandPlan(['update'], release, true).hub, '"latest" plans the same upgrade as no argument');
  assert.deepEqual(commandPlan(['install', '0.7.9'], release, false).hub, ['profile', 'apply', 'dscode', '--version', '0.7.9', '--profile', 'dscode']);
});
