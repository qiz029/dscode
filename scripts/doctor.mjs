import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, manifest, provision, environment, dshEntry } from './harness.mjs';

const local = join(root, 'artifacts/local');
mkdirSync(local, { recursive: true });
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
for (const [path, entry] of Object.entries(lock.packages)) {
  const name = path.split('node_modules/').at(-1);
  if (name.startsWith('@deepseek-ai/dsh')) assert.equal(entry.version, manifest.dependencies['@deepseek-ai/dsh'], `Mixed Harness runtime: ${path}`);
}
console.log('PASS: all Harness dependencies use the pinned runtime version');
assert(existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), 'Install Google Chrome to use the browser MCP');
const home = join(root, '.runtime/doctor');
provision(home);
const overlay = join(home, 'probe.patch.yml');
const hooksFixture = join(home, 'hooks-fixture.json');
const quoteShell = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
writeFileSync(hooksFixture, JSON.stringify({ hooks: { PreToolUse: [{ matcher: '^bash$', hooks: [{ type: 'command', command: `${quoteShell(process.execPath)} ${quoteShell(join(root, 'scripts/hook-fixture.mjs'))}`, timeout: 5 }] }] } }));
writeFileSync(overlay, `- id: dscode-hooks\n  config:\n    configPath: ${JSON.stringify(hooksFixture)}\n- id: dscode-session-cards\n  config:\n    enabled: false\n- id: tui-startup\n  disabled: true\n- id: tui-runner\n  disabled: true\n- insert:\n    - id: harness-probe\n      name: ${JSON.stringify(join(root, 'scripts/probe-plugin.mjs'))}\n`);
const report = join(local, 'doctor.json');
const child = spawn(process.execPath, [dshEntry, '--profile', 'tui', '--patch', overlay], {
  cwd: root, env: { ...environment(home), DSH_TUI_PROBE_REPORT: report }, stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', chunk => { output += chunk; });
child.stderr.on('data', chunk => { output += chunk; });
const timeout = setTimeout(() => child.kill('SIGTERM'), 60000);
const code = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', resolve);
}).finally(() => clearTimeout(timeout));
writeFileSync(join(local, 'doctor.log'), output);
if (code !== 0 || !output.includes('HARNESS_PROBE_PASSED')) {
  console.error(output);
  throw new Error(`Harness probe failed (${code}); see artifacts/local/doctor.log`);
}
const result = JSON.parse(readFileSync(report, 'utf8'));
console.log(`PASS: real profile boot, standard preset, ${result.tools.length} tools, Chrome MCP discovery, skill activation, file editing, shell execution, compaction provider and nonempty session resume`);
console.log(`Computer Use health: ${JSON.stringify(result.computer)}`);
console.log('Agent loop used a deterministic local adapter. Not exercised: remote model requests, browser actions, desktop actions, remote-model compaction.');
console.log(`Report: ${report}`);
console.log(`Auto review: ${result.autoReview}`);

console.log(`DSCODE: ${JSON.stringify(result.dscode)}`);
