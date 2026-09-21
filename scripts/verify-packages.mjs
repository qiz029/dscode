import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { customPlugins } from './composition.mjs';

const root = resolve(import.meta.dirname, '..');
const home = mkdtempSync(join(tmpdir(), 'dscode-package-check-'));
try {
  for (const name of ['launcher', 'bundle']) {
    const [pack] = JSON.parse(readFileSync(join(root, 'artifacts/npm', `${name}-pack.json`), 'utf8'));
    const tarball = join(root, 'artifacts/npm', pack.filename);
    assert.equal('sha512-' + createHash('sha512').update(readFileSync(tarball)).digest('base64'), pack.integrity);
    const destination = join(home, name); mkdirSync(destination);
    const unpack = spawnSync('tar', ['-xzf', tarball, '-C', destination, '--strip-components=1'], { encoding: 'utf8' });
    assert.equal(unpack.status, 0, unpack.stderr);
    const pkg = JSON.parse(readFileSync(join(destination, 'package.json'), 'utf8'));
    const entries = name === 'launcher' ? ['cli.mjs', 'manager.mjs', 'locks.mjs', 'session-bridge/client.mjs', 'exec/cli.mjs', 'trigger/cli.mjs', 'trigger/overlay.mjs', 'trigger/config.mjs', 'trigger/launchd.mjs'] : Object.values(pkg.exports).filter(path => path.endsWith('.mjs') || path.endsWith('.js'));
    for (const entry of entries) {
      assert(existsSync(join(destination, entry)), `Missing packaged entry: ${entry}`);
      const check = spawnSync(process.execPath, ['--check', join(destination, entry)], { encoding: 'utf8' });
      assert.equal(check.status, 0, check.stderr);
    }
    if (name === 'launcher') {
      assert.equal(pkg.dependencies['@deepseek-ai/node-addon-system'], '0.1.2');
      assert.match(readFileSync(join(destination, 'manager.mjs'), 'utf8'), /'\.\/exec\/cli\.mjs'/, 'the launcher loads its own exec CLI');
      assert.match(readFileSync(join(destination, 'manager.mjs'), 'utf8'), /trigger\/cli\.mjs/, 'the launcher loads its own trigger CLI');
      assert.equal(pkg.dependencies.yaml, '2.9.1', 'the launcher carries the YAML parser its trigger CLI reads definitions with');
    }
    else {
      assert.match(readFileSync(join(destination, 'vendor/terminal/index.js'), 'utf8'), /dscode-no-history-expansion-v1/);
      assert.match(readFileSync(join(destination, 'presets/dscode/agent.cordis.yml'), 'utf8'), /dscode-bundle\/terminal/);
      assert.equal(pkg.exports['./code-review'], './plugins/code-review/index.mjs');
      // Every DSCODE plugin the composition mounts needs its own bundle subpath: a missing
      // export only surfaces when a real Hub install boots the profile, not in the tarball itself.
      for (const plugin of customPlugins) assert.equal(pkg.exports['./' + plugin], `./plugins/${plugin}/index.mjs`, `the bundle must export the ${plugin} plugin`);
      assert.match(readFileSync(join(destination, 'presets/dscode/agent.cordis.yml'), 'utf8'), /name: '@toddzheng024\/dscode-bundle\/code-review'/);
      assert.match(readFileSync(join(destination, 'vendor/tui/lib/app.mjs'), 'utf8'), /dispatch\(text\)/, 'the terminal routes /review through the shared service');
      assert.match(readFileSync(join(destination, 'vendor/subagent/index.js'), 'utf8'), /dscode-child-worktree-v3/);
      assert.match(readFileSync(join(destination, 'vendor/command-goal/index.js'), 'utf8'), /dscode-goal-cap-v1/, 'the vendored goal command carries the [N] round-cap patch');
      assert.match(readFileSync(join(destination, 'presets/dscode/agent.cordis.yml'), 'utf8'), /dscode-bundle\/command-goal/);
      assert.match(readFileSync(join(destination, 'vendor/subagent-core/index.js'), 'utf8'), /workspaceCwd/);
      assert.match(readFileSync(join(destination, 'vendor/subagent-driver/index.js'), 'utf8'), /request\.workspaceCwd/);
      assert.match(readFileSync(join(destination, 'cordis.patch.yml'), 'utf8'), /name: '@toddzheng024\/dscode-bundle\/subagent-core'/);
      assert(!existsSync(join(destination, 'vendor/pi-ai')), 'OpenRouter no longer runs through a vendored pi-ai adapter');
      assert.equal(pkg.exports['./openrouter'], './plugins/openrouter/index.mjs');
      assert.equal(pkg.exports['./compaction'], './plugins/compaction/engine.mjs', 'the bundle exports the DSCODE compaction engine');
      assert.match(pkg.dependencies['@deepseek-ai/dsh-compaction-basic'], /^\d+\.\d+\.\d+/, 'the engine resolves its upstream base from the bundle dependencies');
      assert.match(readFileSync(join(destination, 'plugins/compaction/engine.mjs'), 'utf8'), /from '\.\/threshold\.mjs'/);
      assert.match(readFileSync(join(destination, 'vendor/tui/lib/app.mjs'), 'utf8'), /from ['"]\.\.\/\.\.\/\.\.\/plugins\/compaction\/tetris\.mjs['"]/);
      assert.match(readFileSync(join(destination, 'presets/dscode/agent.cordis.yml'), 'utf8'), /name: '@toddzheng024\/dscode-bundle\/compaction'/);
      assert.match(readFileSync(join(destination, 'vendor/tui/lib/app.mjs'), 'utf8'), /DscodeProviderPanel/);
      assert(existsSync(join(destination, 'plugins/providers/catalog.mjs')), 'the terminal imports the provider catalog from the bundle');
      assert(existsSync(join(destination, 'plugins/providers/openrouter-account.mjs')), 'the /openrouter panel reads its account module from the bundle');
      assert.match(readFileSync(join(destination, 'vendor/tui/lib/app.mjs'), 'utf8'), /DscodeOpenRouterPanel/);
      const bundlePatch = readFileSync(join(destination, 'cordis.patch.yml'), 'utf8');
      assert.match(bundlePatch, /- id: llm-pi-ai\n {2}disabled: true\n/);
      assert.match(bundlePatch, /searchProvider: dscode-web/);
      assert.match(bundlePatch, /name: ['"]?@toddzheng024\/dscode-bundle\/openrouter['"]?\n/);
      assert(!bundlePatch.includes('dscode-bundle/pi-ai'));
      assert(existsSync(join(destination, 'plugins/openrouter/models.mjs')));
      assert(existsSync(join(destination, 'plugins/worktree-subagent/worktree.mjs')));
      assert(existsSync(join(destination, 'plugins/session-metrics/rate.mjs')));
      assert(existsSync(join(destination, 'plugins/tui-tools/doctor.mjs')));
      assert(existsSync(join(destination, 'plugins/tui-tools/doctor-cli.mjs')));
    }
    const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]);
    for (const file of walk(destination)) {
      assert(!/\/(?:\.env|credentials\.yaml|hooks\.local\.json)$/.test(file), `Local state leaked into tarball: ${file}`);
      if (/\.(?:mjs|js|yml)$/.test(file)) assert(!readFileSync(file, 'utf8').includes(root), `Build path leaked into ${file}`);
    }
  }
  console.log('Package checks passed: exact tarball integrity, exports, syntax, launcher lock dependency, and no local state/build paths.');
} finally { rmSync(home, { recursive: true, force: true }); }
