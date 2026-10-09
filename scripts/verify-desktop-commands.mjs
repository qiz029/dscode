// Load the shared command plugin through a real independently installed Host.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { stringify } from 'yaml';

if (!process.argv[2]) throw Error('Usage: node scripts/verify-desktop-commands.mjs <runtime-directory>');
const root = resolve(import.meta.dirname, '..');
const modules = join(resolve(process.argv[2]), 'node_modules');
const runtime = JSON.parse(readFileSync(join(modules, '@deepseek-ai/dsh/package.json'), 'utf8')).version;
const home = mkdtempSync(join(tmpdir(), 'dscode-desktop-commands-'));
try {
  symlinkSync(modules, join(home, 'node_modules'));
  cpSync(join(root, 'plugins'), join(home, 'plugins'), { recursive: true });
  mkdirSync(join(home, 'scripts'));
  cpSync(join(root, 'scripts/desktop-commands-probe.mjs'), join(home, 'scripts/probe.mjs'));
  writeFileSync(join(home, 'fixture.mjs'), 'export function apply() {}\n');
  const profile = join(home, 'profiles/test');
  mkdirSync(profile, { recursive: true });
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, type: 'module', dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }));
  writeFileSync(join(profile, 'cordis.patch.yml'), stringify([{ insert: [
    { id: 'agent-preset-registry', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'commands-fixture' } },
    ...[['commands-fixture', 'fixture-one'], ['commands-other', 'fixture-other']].map(([id, entryId]) => ({
      id, name: '@deepseek-ai/dsh-agent-preset', config: { id, plugins: [{ id: entryId, name: join(home, 'fixture.mjs') }] },
    })),
    { id: 'dscode-commands', name: join(home, 'plugins/tui-tools/index.mjs') },
    { id: 'command-probe', name: join(home, 'scripts/probe.mjs') },
  ] }]));
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'SYSTEMROOT'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), DSH_TELEMETRY_DISABLED: '1' });
  const child = spawn(process.execPath, [join(modules, '@deepseek-ai/dsh/lib/bin.js'), '--profile', 'test'], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', data => { output += data; });
  child.stderr.on('data', data => { output += data; });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 30000);
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }).finally(() => clearTimeout(timeout));
  if (code !== 0 || !output.includes('DESKTOP_COMMANDS_PASSED')) throw Error(output || `Command probe exited ${code}`);
  console.log(`Runtime ${runtime}: ${output.split('\n').find(line => line.startsWith('DESKTOP_COMMANDS_PASSED'))}`);
} finally { rmSync(home, { recursive: true, force: true }); }
