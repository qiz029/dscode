// Keep the small flock package and every published platform prebuild together.
// pnpm 11.7's hoisted upgrade path can start foreign optional-package workers
// after its normal worker shutdown, leaving a completed installation running.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

export const desktopSystemAddon = '@deepseek-ai/node-addon-system';
export const desktopSystemAddonVersion = '0.1.2';

function download(record, directory, root) {
  const [packed] = JSON.parse(execFileSync('npm', ['pack', record.resolved, '--ignore-scripts', '--json', '--pack-destination', directory],
    { cwd: root, encoding: 'utf8', timeout: 120000 }));
  return join(directory, packed.filename);
}

/** Stage npm bundled dependencies from integrity-checked, lockfile-pinned archives. */
export function bundleDesktopSystemAddon(destination, { root = resolve(import.meta.dirname, '..'),
  cacheDirectory = join(root, 'artifacts/desktop/native-cache'), fetchPackage = download } = {}) {
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')).packages;
  const entry = lock[`node_modules/${desktopSystemAddon}`];
  assert.equal(entry?.version, desktopSystemAddonVersion, 'Desktop system addon lock version drift');
  const platforms = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];
  const names = [desktopSystemAddon, ...platforms.map(platform => `${desktopSystemAddon}-${platform}`)];
  assert.deepEqual(Object.keys(entry.optionalDependencies).sort(), names.slice(1).sort(), 'Desktop native platform inventory drift');
  mkdirSync(cacheDirectory, { recursive: true });
  return names.map(name => {
    const record = lock[`node_modules/${name}`];
    assert.equal(record?.version, desktopSystemAddonVersion, `Missing pinned native package: ${name}`);
    if (name !== desktopSystemAddon) assert.equal(entry.optionalDependencies[name], record.version, `Native optional dependency version drift: ${name}`);
    assert.match(record.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/, `Missing SHA-512 integrity: ${name}`);
    const verify = archive => {
      const bytes = readFileSync(archive);
      assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, record.integrity, `Native package integrity mismatch: ${name}`);
    };
    const archive = join(cacheDirectory, `${createHash('sha256').update(record.integrity).digest('hex')}.tgz`);
    if (!existsSync(archive)) {
      const temporary = mkdtempSync(join(cacheDirectory, '.download-'));
      try {
        const downloaded = fetchPackage(record, temporary, root);
        verify(downloaded);
        renameSync(downloaded, archive);
      } finally { rmSync(temporary, { recursive: true, force: true }); }
    }
    verify(archive);
    const target = join(destination, 'node_modules', name);
    rmSync(target, { recursive: true, force: true }); mkdirSync(target, { recursive: true });
    execFileSync('tar', ['-xzf', archive, '-C', target, '--strip-components=1'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const manifest = JSON.parse(readFileSync(join(target, 'package.json'), 'utf8'));
    assert.equal(manifest.name, name); assert.equal(manifest.version, record.version);
    return { name, version: record.version, integrity: record.integrity, resolved: record.resolved };
  });
}
