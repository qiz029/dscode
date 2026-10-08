// Native installation into a new profile. --local rehearses the same path
// before publication; only the default exact npm spec proves public install.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { delimiter, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { parse, stringify } from 'yaml';
import { readDesktopRelease } from './desktop-release-artifact.mjs';
import { removeDesktopProbeHome, seedDesktopProviderCatalogs } from './desktop-probe-home.mjs';

const root = resolve(import.meta.dirname, '..');
const runtime = resolve(process.argv[2] ?? '.research/desktop-release-runtime');
if (process.argv.slice(3).some(arg => arg !== '--local')) throw Error('Usage: node scripts/verify-desktop-registry.mjs [runtime-directory] [--local]');
const publicInstall = !process.argv.includes('--local');
const candidate = readDesktopRelease(root, { requireInstall: publicInstall });
const home = mkdtempSync(join(tmpdir(), 'dscode-desktop-registry-'));
const profile = join(home, 'profiles/desktop-release-test');
const env = Object.fromEntries(['PATH', 'TMPDIR', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(env, { HOME: join(home, 'user'), DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'),
  ZDOTDIR: home, DSH_TELEMETRY_DISABLED: '1', npm_config_registry: 'https://registry.npmjs.org', npm_config_ignore_scripts: 'true' });
env.PATH = join(runtime, 'node_modules/.bin') + delimiter + env.PATH;
async function run(entry, args, timeoutMs) {
  const child = spawn(process.execPath, [entry, ...args], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', escalation;
  child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
  const timer = setTimeout(() => { child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 5000); }, timeoutMs);
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); })
    .finally(() => { clearTimeout(timer); clearTimeout(escalation); });
  assert.equal(code, 0, output.replace(/token=[^\s"&]+/g, 'token=<redacted>'));
  return output;
}
try {
  mkdirSync(env.HOME); mkdirSync(profile, { recursive: true }); seedDesktopProviderCatalogs(home);
  const base = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, type: 'module',
    dependencies: Object.fromEntries(['@deepseek-ai/dsh', ...base].map(name => [name, candidate.runtime])),
    dsh: { profile: { bundles: base } } }));
  const installer = join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  const spec = publicInstall ? `${candidate.name}@${candidate.version}` : candidate.path;
  await run(installer, ['plugin', '--profile', 'desktop-release-test', 'add', spec, '--ignore-scripts'], 240000);
  const installed = join(profile, 'node_modules', candidate.name);
  const manifest = JSON.parse(readFileSync(join(installed, 'package.json'), 'utf8'));
  assert.equal(manifest.name, candidate.name); assert.equal(manifest.version, candidate.version);
  assert.equal(manifest.peerDependencies['@deepseek-ai/dsh'], candidate.runtime);
  const lock = parse(readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8'));
  const locked = Object.entries(lock.packages).find(([key]) => key.startsWith(`${candidate.name}@`));
  assert(locked, 'Installed Desktop package is missing from the dependency lock');
  assert.equal(locked[1].resolution.integrity, candidate.integrity, 'Installed package differs from the qualified archive');
  const profileManifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8'));
  assert(profileManifest.dsh.profile.bundles.includes(candidate.name));
  cpSync(join(root, 'scripts/desktop-registry-probe.mjs'), join(profile, 'probe.mjs'));
  writeFileSync(join(profile, 'cordis.patch.yml'), stringify([
    { id: 'frontend', disabled: true }, { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
    { id: 'product-analytics', config: { enabled: false } },
    { insert: [{ id: 'registry-probe', name: join(profile, 'probe.mjs') }] },
  ]));
  const output = await run(join(profile, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), ['--profile', 'desktop-release-test', '--no-open'], 90000);
  assert(output.includes('DESKTOP_REGISTRY_PASSED'), 'Installed Host never completed qualification');
  const proof = { publicInstall, nativeInstall: true, installedHost: true, hubRpc: true, presetResolved: true,
    name: candidate.name, version: candidate.version, runtime: candidate.runtime, integrity: candidate.integrity, packageSha256: candidate.sha256 };
  mkdirSync(join(root, 'artifacts/local'), { recursive: true });
  writeFileSync(join(root, `artifacts/local/desktop-${publicInstall ? 'public' : 'local'}-install.json`), JSON.stringify(proof, null, 2) + '\n');
  console.log(JSON.stringify(proof));
} finally { removeDesktopProbeHome(home); }
