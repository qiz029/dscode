import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { patchTui } from './patch-tui.mjs';
import { patchRuntime } from './patch-runtime.mjs';

const root = resolve(import.meta.dirname, '..');
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
export const upstreamPackages = ['dsh-code', ...['dsh-tool-subagent', 'dsh-subagent', 'dsh-subagent-in-process-driver', 'dsh-llm-deepseek', 'dsh-llm-pi-ai', 'dsh-tool-bash', 'dsh-tool-bash-persistent', 'dsh-terminal-bash'].map(name => '@deepseek-ai/' + name)];
// The macOS process inspector is patched inside a content-hashed runner chunk
// rather than lib/index.js, so fixtures need it without joining the index-only list.
export const fixturePackages = [...upstreamPackages, '@deepseek-ai/dsh-subprocess-local'];
const cache = join(root, 'artifacts/local/test-upstream');

// Keep exact upstream tarballs, verified against the checked-in lock. An
// already-patched developer install is never a source fixture.
function archive(name) {
  const { resolved, integrity } = lock.packages['node_modules/' + name];
  const [algorithm, expected] = integrity.split('-');
  const path = join(cache, createHash('sha256').update(integrity).digest('hex') + '.tgz');
  const valid = file => createHash(algorithm).update(readFileSync(file)).digest('base64') === expected;
  if (existsSync(path)) {
    if (!valid(path)) throw Error('Corrupt upstream fixture: ' + name);
    return path;
  }
  mkdirSync(cache, { recursive: true });
  const staging = mkdtempSync(join(cache, '.pack-'));
  try {
    // Read npm's content-addressed cache without writing to a user's npm home.
    // A miss falls back to npm itself; every path is verified by integrity.
    const hex = Buffer.from(expected, 'base64').toString('hex');
    const cached = join(process.env.npm_config_cache ?? join(homedir(), '.npm'), '_cacache/content-v2', algorithm, hex.slice(0, 2), hex.slice(2, 4), hex.slice(4));
    if (existsSync(cached) && valid(cached)) {
      cpSync(cached, join(staging, 'upstream.tgz'));
      renameSync(join(staging, 'upstream.tgz'), path);
      return path;
    }
    const args = ['pack', '--ignore-scripts', '--json', '--fetch-retries=0', '--fetch-timeout=15000', '--pack-destination', staging, resolved];
    let result = spawnSync('npm', [...args, '--offline'], { encoding: 'utf8' });
    if (result.status !== 0 && result.stderr.includes('ENOTCACHED')) result = spawnSync('npm', [...args, '--prefer-offline'], { encoding: 'utf8' });
    if (result.status !== 0) throw Error(result.stderr || 'Could not prepare upstream fixture: ' + name);
    const packed = join(staging, JSON.parse(result.stdout)[0].filename);
    if (!valid(packed)) throw Error('Upstream fixture integrity mismatch: ' + name);
    renameSync(packed, path);
    return path;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

export function createTestRuntime({ tui = false, runtime = false, patched = true } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'dscode-test-runtime-'));
  const modules = join(directory, 'node_modules');
  mkdirSync(modules);
  const selected = fixturePackages.filter(name => name === 'dsh-code' ? tui : runtime);
  try {
    for (const name of selected) {
      const destination = join(modules, name);
      mkdirSync(destination, { recursive: true });
      const result = spawnSync('tar', ['-xzf', archive(name), '-C', destination, '--strip-components=1'], { encoding: 'utf8' });
      if (result.status !== 0) throw Error(result.stderr);
    }
    const link = name => {
      if (!selected.includes(name)) symlinkSync(join(root, 'node_modules', name), join(modules, name), 'dir');
    };
    for (const name of readdirSync(join(root, 'node_modules'))) {
      if (name.startsWith('.')) continue;
      if (name.startsWith('@')) {
        mkdirSync(join(modules, name), { recursive: true });
        for (const child of readdirSync(join(root, 'node_modules', name))) link(`${name}/${child}`);
      } else link(name);
    }
    symlinkSync(join(root, 'plugins'), join(directory, 'plugins'), 'dir');
    if (patched && tui) patchTui(directory);
    if (patched && runtime) patchRuntime(directory);
    return { root: directory, close: () => rmSync(directory, { recursive: true, force: true }) };
  } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
}

export function copyVerificationSource(directory) {
  // Never copy .env, local overlays, credentials or runtime state into fixtures.
  unlinkSync(join(directory, 'plugins'));
  for (const name of ['scripts', 'presets', 'bin', 'packages', 'plugins', 'tests', 'docs']) cpSync(join(root, name), join(directory, name), { recursive: true });
  mkdirSync(join(directory, 'config'));
  for (const name of readdirSync(join(root, 'config'))) if (!name.includes('.local.')) cpSync(join(root, 'config', name), join(directory, 'config', name));
  for (const name of ['package.json', 'package-lock.json', 'LICENSE', 'README.md', 'install.sh', '.env.example', '.npmrc']) cpSync(join(root, name), join(directory, name));
}
