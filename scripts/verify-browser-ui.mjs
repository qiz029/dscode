// Launch the official Web UI shared with Desktop, in a disposable fixture home.
// Keep running for browser-driven qualification; Ctrl+C removes the fixture.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { stringify } from 'yaml';
import { buildBrowserDesktop, desktopBrowserPackage, desktopRuntime } from './build-browser-desktop.mjs';
const root = resolve(import.meta.dirname, '..');
if (!process.argv[2]) throw Error('Usage: node scripts/verify-browser-ui.mjs <independent-runtime-directory>');
const modules = join(resolve(process.argv[2]), 'node_modules');
if (JSON.parse(readFileSync(join(modules, '@deepseek-ai/dsh/package.json'), 'utf8')).version !== desktopRuntime) throw Error(`Expected DSH ${desktopRuntime}`);
const home = mkdtempSync(join(tmpdir(), 'dscode-browser-ui-'));
try {
  symlinkSync(modules, join(home, 'node_modules'), 'dir');
  const bundle = buildBrowserDesktop(join(home, 'bundle'));
  mkdirSync(join(home, 'scripts'));
  cpSync(join(root, 'scripts/browser-ui-probe.mjs'), join(home, 'scripts/probe.mjs'));
  symlinkSync(join(bundle, 'plugins'), join(home, 'plugins'), 'dir');
  mkdirSync(join(home, 'browser'));
  writeFileSync(join(home, 'browser/config.json'), JSON.stringify({ mode: 'isolated', headless: true }));
  const profile = join(home, 'profiles', 'browser-ui');
  mkdirSync(join(profile, 'node_modules', '@toddzheng024'), { recursive: true });
  symlinkSync(bundle, join(profile, 'node_modules', desktopBrowserPackage), 'dir');
  symlinkSync(join(modules, '@deepseek-ai'), join(profile, 'node_modules', '@deepseek-ai'), 'dir');
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'browser-ui', private: true, type: 'module', dependencies: { [desktopBrowserPackage]: `file:${bundle}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', desktopBrowserPackage] } } }));
  writeFileSync(join(profile, 'cordis.patch.yml'), readFileSync(join(root, 'config/auto-review.patch.yml'), 'utf8') + '\n' + stringify([{ insert: [{ id: 'browser-ui-probe', name: join(home, 'scripts/probe.mjs') }] }]));
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'SYSTEMROOT'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents') });
  const child = spawn(process.execPath, [join(modules, '@deepseek-ai/dsh/lib/bin.js'), '--profile', 'browser-ui', '--no-open', '--port', '0'], { cwd: home, env, stdio: 'inherit' });
  const stop = () => child.kill('SIGTERM');
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  process.exitCode = await new Promise((resolve, reject) => { child.once('exit', code => resolve(code ?? 0)); child.once('error', reject); });
} finally { rmSync(home, { recursive: true, force: true }); }
