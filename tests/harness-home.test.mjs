import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('default and configured Harness homes own workspace hooks, browser state, review and usage', t => {
  const directory = mkdtempSync(join(tmpdir(), 'dscode-home-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  for (const override of [undefined, '   ', '~/custom-harness']) {
    const env = { ...process.env, HOME: directory };
    delete env.DSH_HOME; delete env.DSCODE_HOME;
    if (override !== undefined) env.DSH_HOME = override;
    const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
      import assert from 'node:assert/strict';
      import { existsSync } from 'node:fs';
      import { join } from 'node:path';
      import { homedir } from 'node:os';
      import { apply as workspace } from './plugins/desktop-workspace/index.mjs';
      import { apply as review } from './plugins/auto-review/index.mjs';
      import { browserHome } from './plugins/browser/config.mjs';
      import { appendMetric } from './plugins/session-metrics/store.mjs';
      import { sessionSpend } from './plugins/session-metrics/view.mjs';
      const home = join(homedir(), process.env.DSH_HOME?.trim() ? 'custom-harness' : '.dsh');
      workspace({ on() {} });
      assert(existsSync(join(home, 'config/hooks.local.json')));
      assert.equal(browserHome(), join(home, 'browser'));
      const commands = [];
      review({ on() {}, commands: { register: command => commands.push(command) } }, {});
      assert(commands.some(command => command.name === 'review-usage'));
      appendMetric(home, 'home-regression', { kind: 'end', id: 'request', cost: 0.25 });
      assert.equal(sessionSpend('home-regression').cost, 0.25);
      console.log('HOME_PASSED');
    `], { cwd: new URL('..', import.meta.url), env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15000 });
    assert.match(output, /HOME_PASSED/);
  }
});
