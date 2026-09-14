import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { root, provision, environment, dshEntry } from './harness.mjs';

const home = mkdtempSync(join(tmpdir(), 'dscode-login-runtime-'));
const uiEntry = join(root, 'node_modules/dsh-code/lib', `.dscode-login-runtime-${process.pid}.mjs`);
try {
  provision(home);
  writeFileSync(uiEntry, readFileSync(join(root, 'node_modules/dsh-code/lib/index.mjs'), 'utf8') + '\nexport { loadProviderSettings, saveProviderCredential };\n');
  const probe = join(home, 'probe.mjs');
  writeFileSync(probe, `
import assert from 'node:assert/strict';
import { loadProviderSettings, saveProviderCredential } from ${JSON.stringify(uiEntry)};
export const inject = ['credentials', 'llm', 'settings'];
export function apply(ctx) {
  void (async () => {
    await ctx.get('loader').await();
    const directory = await loadProviderSettings(ctx);
    const row = directory.rows.find(row => row.provider === 'deepseek-official');
    assert(row, 'missing official provider');
    assert.equal(row.credential.writable, true);
    if (process.env.DSCODE_LOGIN_CHECK === 'save') await saveProviderCredential(ctx, row, 'synthetic-runtime-key');
    assert.equal((await ctx.credentials.resolve('DEEPSEEK_API_KEY')).value, 'synthetic-runtime-key');
    console.log('LOGIN_RUNTIME_PASSED');
    ctx.get('appExit')(0);
  })().catch(() => { console.error('Login runtime fixture failed'); ctx.get('appExit')(1); });
}
`);
  const patch = join(home, 'login.patch.yml');
  writeFileSync(patch, `
- id: credentials
  config:
    path: ${JSON.stringify(join(home, 'shared', 'credentials.yaml'))}
- id: tui-startup
  disabled: true
- id: tui-runner
  disabled: true
- id: mcp-chrome
  disabled: true
- id: dscode-memory
  config:
    enabled: false
- id: dscode-session-cards
  config:
    enabled: false
- insert:
    - id: login-probe
      name: ${JSON.stringify(probe)}
`);
  for (const mode of ['save', 'reload']) {
    const env = { ...environment(home), DSCODE_LOGIN_CHECK: mode };
    delete env.DEEPSEEK_API_KEY;
    const child = spawn(process.execPath, [dshEntry, '--profile', 'tui', '--patch', patch], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 20000);
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }).finally(() => clearTimeout(timer));
    // A one-shot Host whose work finishes fast can drain its event loop before the boot's
    // dispose settles; `bin.js` then ends on an unsettled top-level await and Node reports
    // 13 regardless of the exit code the plugin asked for. The fixture checks the
    // credential round-trip, so that one code is acceptable — but only with the marker.
    assert(output.includes('LOGIN_RUNTIME_PASSED'), output);
    if (code !== 0) assert(code === 13 && output.includes('unsettled top-level await'), output);
  }
  console.log('Login runtime passed: real provider directory and native TUI save callback; a fresh Host loads the saved key. No provider API request.');
} finally { rmSync(home, { recursive: true, force: true }); rmSync(uiEntry, { force: true }); }
