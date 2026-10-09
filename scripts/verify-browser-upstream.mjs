// Run the same native browser contract against an independently installed DSH.
// This verifies the Host boundary, not the Electron UI or the full DSCODE preset.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { stringify } from 'yaml';
import { buildBrowserDesktop, desktopBrowserPackage, desktopRuntimes } from './build-browser-desktop.mjs';

const root = resolve(import.meta.dirname, '..');
if (!process.argv[2]) throw Error('Usage: node scripts/verify-browser-upstream.mjs <independent-runtime-directory>');
const runtime = resolve(process.argv[2]);
const modules = join(runtime, 'node_modules');
const meta = JSON.parse(readFileSync(join(modules, '@deepseek-ai/dsh/package.json'), 'utf8'));
if (!desktopRuntimes.includes(meta.version)) throw Error(`Unsupported Desktop runtime: ${meta.version}`);
const home = mkdtempSync(join(tmpdir(), 'dscode-browser-upstream-'));
try {
  // Copies must resolve their imports from the tested runtime, never this repo.
  symlinkSync(modules, join(home, 'node_modules'), 'dir');
  const staged = buildBrowserDesktop(join(home, 'staged'), meta.version);
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', home], { cwd: staged, encoding: 'utf8' }));
  const installed = join(home, 'installed');
  mkdirSync(installed);
  execFileSync('tar', ['-xzf', join(home, packed[0].filename), '-C', installed]);
  const bundle = join(installed, 'package');
  rmSync(staged, { recursive: true, force: true });
  mkdirSync(join(home, 'scripts'));
  cpSync(join(root, 'scripts/browser-probe.mjs'), join(home, 'scripts/probe.mjs'));
  symlinkSync(join(bundle, 'plugins'), join(home, 'plugins'), 'dir');
  mkdirSync(join(home, 'browser'));
  writeFileSync(join(home, 'browser/config.json'), JSON.stringify({ mode: 'isolated', headless: true,
    ...(process.env.DSCODE_TEST_CHROME ? { executablePath: process.env.DSCODE_TEST_CHROME } : {}) }));
  const profile = join(home, 'profiles', 'browser-compat');
  mkdirSync(profile, { recursive: true });
  // Install the local bundle by name while retaining the independently resolved
  // runtime graph. The native bundle loader must consume its actual patch.
  mkdirSync(join(profile, 'node_modules', '@toddzheng024'), { recursive: true });
  symlinkSync(bundle, join(profile, 'node_modules', desktopBrowserPackage), 'dir');
  symlinkSync(join(modules, '@deepseek-ai'), join(profile, 'node_modules', '@deepseek-ai'), 'dir');
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'browser-compat', private: true, type: 'module',
    dependencies: { [desktopBrowserPackage]: `file:${bundle}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', desktopBrowserPackage] } } }));
  writeFileSync(join(profile, 'cordis.patch.yml'), readFileSync(join(root, 'config/auto-review.patch.yml'), 'utf8') + '\n' + stringify([
    { insert: [
      { id: 'browser-probe', name: join(home, 'scripts/probe.mjs'), config: { preset: null } },
    ] },
  ]));
  // Deliberately omit provider credentials and user-level DSH configuration.
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'SYSTEMROOT'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents') });
  const child = spawn(process.execPath, [join(modules, '@deepseek-ai/dsh/lib/bin.js'), '--profile', 'browser-compat'], {
    cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const timer = setTimeout(() => child.kill('SIGKILL'), 90000);
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }).finally(() => clearTimeout(timer));
  if (code !== 0 || !output.includes('BROWSER_RUNTIME_PROBE_PASSED')) throw Error(output || `Upstream probe exited ${code}`);
  console.log(`BROWSER_UPSTREAM_PASSED: packed Desktop bundle on DSH ${meta.version}; browser and review plugins resolve exclusively from ${runtime}`);
  console.log(output.split('\n').find(line => line.includes('BROWSER_RUNTIME_PROBE_PASSED')));
} finally { rmSync(home, { recursive: true, force: true }); }
