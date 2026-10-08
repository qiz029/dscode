import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { stringify } from 'yaml';
import { buildDesktopPreset, desktopPresetPackage } from './build-desktop-preset.mjs';
import { removeDesktopProbeHome, seedDesktopProviderCatalogs } from './desktop-probe-home.mjs';

if (!process.argv[2]) throw Error('Usage: node scripts/verify-desktop-preset.mjs <independent-runtime-directory>');
const root = resolve(import.meta.dirname, '..'), runtime = resolve(process.argv[2]);
const modules = join(runtime, 'node_modules');
const browser = process.argv.includes('--browser');
if (browser && !process.env.DSCODE_TEST_CHROME) throw Error('--browser requires DSCODE_TEST_CHROME pointing to a test Chrome executable');
const home = mkdtempSync(join(tmpdir(), 'dscode-desktop-preset-'));
try {
  seedDesktopProviderCatalogs(home);
  symlinkSync(modules, join(home, 'node_modules'));
  const staged = buildDesktopPreset(join(home, 'staged'), runtime);
  const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', home], { cwd: staged, encoding: 'utf8' }));
  const installed = join(home, 'installed');
  mkdirSync(installed);
  execFileSync('tar', ['-xzf', join(home, packed[0].filename), '-C', installed]);
  rmSync(staged, { recursive: true, force: true });
  const bundle = join(installed, 'package');
  const profile = join(home, 'profiles/test');
  mkdirSync(join(profile, 'node_modules/@toddzheng024'), { recursive: true });
  symlinkSync(bundle, join(profile, 'node_modules', desktopPresetPackage));
  symlinkSync(join(modules, '@deepseek-ai'), join(profile, 'node_modules/@deepseek-ai'));
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { [desktopPresetPackage]: `file:${bundle}` }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', desktopPresetPackage] } } }));
  cpSync(join(root, 'scripts/desktop-preset-probe.mjs'), join(home, 'probe.mjs'));
  cpSync(join(root, 'scripts/desktop-custom-probe.mjs'), join(home, 'desktop-custom-probe.mjs'));
  cpSync(join(root, 'scripts/desktop-browser-probe.mjs'), join(home, 'desktop-browser-probe.mjs'));
  if (browser) {
    mkdirSync(join(home, 'browser'));
    writeFileSync(join(home, 'browser/config.json'), JSON.stringify({ mode: 'isolated', headless: true, executablePath: process.env.DSCODE_TEST_CHROME }));
    for (const [name, version] of Object.entries(JSON.parse(readFileSync(join(bundle, 'package.json'), 'utf8')).dependencies)) {
      assert.equal(JSON.parse(readFileSync(join(modules, name, 'package.json'), 'utf8')).version, version, `Browser dependency mismatch: ${name}`);
    }
  }
  writeFileSync(join(profile, 'cordis.patch.yml'), stringify([
    { id: 'frontend', disabled: true }, { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
    { id: 'product-analytics', config: { enabled: false } },
    { insert: [{ id: 'desktop-preset-probe', name: join(home, 'probe.mjs') }] },
  ]));
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'SYSTEMROOT'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  const userHome = join(home, 'user');
  writeFileSync(join(home, 'AGENTS.md'), 'GLOBAL_FIXTURE_GUIDANCE\n');
  const hookGroup = text => [{ hooks: [{ type: 'command', command: `printf '${text}\\n' >> hook-log` }] }];
  mkdirSync(join(home, 'config'));
  writeFileSync(join(home, 'config/hooks.local.json'), JSON.stringify({ hooks: { SessionStart: hookGroup('global-start') } }));
  for (const label of ['alpha', 'beta']) {
    const directory = join(userHome, label);
    mkdirSync(join(directory, 'project/.git'), { recursive: true });
    writeFileSync(join(directory, 'AGENTS.md'), `ANCESTOR_${label.toUpperCase()}_ONLY\n`);
    writeFileSync(join(directory, 'project/AGENTS.md'), `PROJECT_${label.toUpperCase()}_ONLY\n`);
    mkdirSync(join(directory, 'project/.codex'));
    writeFileSync(join(directory, 'project/.codex/hooks.json'), JSON.stringify({ hooks: Object.fromEntries([
      ['SessionStart', 'start'], ['UserPromptSubmit', 'prompt'], ['PreToolUse', 'pre'], ['PostToolUse', 'post'], ['Stop', 'stop'],
    ].map(([event, suffix]) => [event, hookGroup(`${label}-${suffix}`)])) }));
    const skill = join(directory, '.agents/skills', `${label}-skill`);
    mkdirSync(skill, { recursive: true });
    writeFileSync(join(skill, 'SKILL.md'), `---\nname: ${label}-skill\ndescription: ${label} fixture skill\n---\n${label} workspace only.\n`);
  }
  Object.assign(env, { HOME: userHome, DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), DSH_TELEMETRY_DISABLED: '1', ZDOTDIR: home });
  const receipt = {}, phases = [];
  for (const reload of [false, true]) {
    const child = spawn(process.execPath, [join(modules, '@deepseek-ai/dsh/lib/bin.js'), '--profile', 'test', '--no-open'], {
      cwd: home, env: { ...env, DSCODE_DESKTOP_PROBE_RELOAD: reload ? '1' : '0', DSCODE_DESKTOP_BROWSER: browser ? '1' : '0' }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const timeout = setTimeout(() => child.kill('SIGKILL'), browser ? 120000 : 60000);
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }).finally(() => clearTimeout(timeout));
    if (code !== 0 || !output.includes('DESKTOP_PRESET_PASSED')) throw Error(output.replace(/token=[^\s"&]+/g, 'token=<redacted>') || `Preset probe exited ${code}`);
    const result = JSON.parse(output.split('\n').find(line => line.startsWith('DESKTOP_PRESET_PASSED')).slice('DESKTOP_PRESET_PASSED '.length));
    phases.push({ phase: reload ? 'reload' : 'initial', ...result });
    Object.assign(receipt, result);
  }
  const runtimeSources = JSON.parse(readFileSync(join(bundle, 'runtime-sources.json'), 'utf8'));
  for (const source of runtimeSources.sources) {
    const original = readFileSync(join(modules, source.package, 'lib/index.js'));
    assert.equal(createHash('sha256').update(original).digest('hex'), source.entrySha256, `Source runtime was changed: ${source.package}`);
  }
  mkdirSync(join(root, 'artifacts/local'), { recursive: true });
  const packageSha256 = createHash('sha256').update(readFileSync(join(home, packed[0].filename))).digest('hex');
  const report = JSON.stringify({ ...receipt, phases, packageSha256, surface: 'independent native Host', renderedUi: false, npmPackRoundtrip: true, sourceRuntimeUnchanged: true, runtimeSources }, null, 2) + '\n';
  writeFileSync(join(root, `artifacts/local/desktop-preset-${runtimeSources.runtime}${browser ? '-browser' : ''}.json`), report);
  writeFileSync(join(root, 'artifacts/local/desktop-preset.json'), report);
  console.log('DESKTOP_PRESET_PASSED ' + JSON.stringify(receipt));
} finally {
  removeDesktopProbeHome(home);
}
