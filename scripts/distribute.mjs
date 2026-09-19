import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { root, manifest } from './harness.mjs';
import { PREBUILT_MARKER } from './self-update.mjs';

const ENTRIES = [
  'package.json', 'package-lock.json', '.npmrc', '.env.example', 'LICENSE',
  'bin', 'scripts', 'packages', 'plugins', 'tests', 'presets', 'config/cordis.patch.yml', 'config/preset.json',
  'config/mcp.local.example.yml', 'config/auto-review.patch.yml', 'README.md', 'docs', 'install.sh',
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { stdio: 'inherit', ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const artifacts = join(root, 'artifacts');
mkdirSync(artifacts, { recursive: true });
const archive = join(artifacts, `dscode-${manifest.version}.tar.gz`);
run('tar', ['-czf', archive, '-C', root, ...ENTRIES]);
console.log(archive);

// The source tarball above leaves `npm ci` to the recipient, and a registry they cannot
// reach (a corporate proxy, an offline host) ends the install there. A prebuilt tarball is
// the same tree with the locked dependency graph already installed for one platform, so
// installing it needs GitHub and Node only. `--ignore-scripts` matches what the installer
// runs, and the native addons are all prebuilt optional packages that `--os`/`--cpu`
// select, so one runner builds every architecture. DSCODE_PREBUILT_ARCHS= (empty) skips this.
const archs = (process.env.DSCODE_PREBUILT_ARCHS ?? 'arm64,x64').split(',').map(arch => arch.trim()).filter(Boolean);
for (const arch of archs) {
  const platform = `darwin-${arch}`;
  const stage = join(artifacts, `.prebuilt-${platform}`);
  rmSync(stage, { recursive: true, force: true });
  for (const entry of ENTRIES) {
    mkdirSync(dirname(join(stage, entry)), { recursive: true });
    cpSync(join(root, entry), join(stage, entry), { recursive: true });
  }
  // The shipped .npmrc points the cache inside the tree; keep it out of the package.
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--os=darwin', `--cpu=${arch}`, '--cache', join(root, '.npm-cache')], { cwd: stage });
  writeFileSync(join(stage, PREBUILT_MARKER), platform + '\n');
  const prebuilt = join(artifacts, `dscode-${manifest.version}-${platform}.tar.gz`);
  run('tar', ['-czf', prebuilt, '-C', stage, ...ENTRIES, 'node_modules', PREBUILT_MARKER]);
  rmSync(stage, { recursive: true, force: true });
  console.log(prebuilt);
}
