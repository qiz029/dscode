import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bundleDesktopSystemAddon, desktopSystemAddon, desktopSystemAddonVersion } from '../scripts/desktop-native-bundle.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'dscode-native-bundle-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const names = [desktopSystemAddon, ...['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'].map(platform => `${desktopSystemAddon}-${platform}`)];
  const source = join(root, 'package'); mkdirSync(source);
  const lock = { packages: {} }, archives = new Map();
  for (const [index, name] of names.entries()) {
    const manifest = { name, version: desktopSystemAddonVersion,
      ...(index === 0 ? { optionalDependencies: Object.fromEntries(names.slice(1).map(name => [name, desktopSystemAddonVersion])) } : {}) };
    writeFileSync(join(source, 'package.json'), JSON.stringify(manifest));
    writeFileSync(join(source, 'LICENSE'), `license for ${name}`);
    const archive = join(root, `${index}.tgz`);
    execFileSync('tar', ['-czf', archive, '-C', root, 'package'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const resolved = `https://registry.invalid/${index}.tgz`;
    archives.set(resolved, archive);
    lock.packages[`node_modules/${name}`] = { ...manifest, resolved,
      integrity: `sha512-${createHash('sha512').update(readFileSync(archive)).digest('base64')}` };
  }
  const saveLock = () => writeFileSync(join(root, 'package-lock.json'), JSON.stringify(lock)); saveLock();
  let fetches = 0;
  const fetchPackage = (record, directory) => {
    fetches++; const output = join(directory, 'download.tgz'); cpSync(archives.get(record.resolved), output); return output;
  };
  return { root, names, lock, saveLock, fetchPackage, fetches: () => fetches, cacheDirectory: join(root, 'cache') };
}

test('Desktop bundles every native platform from verified archives and reuses the cache without fetching', t => {
  const f = fixture(t), output = join(f.root, 'bundle');
  const records = bundleDesktopSystemAddon(output, f);
  assert.deepEqual(records.map(record => record.name), f.names);
  assert.equal(f.fetches(), 5);
  for (const name of f.names) assert.equal(readFileSync(join(output, 'node_modules', name, 'LICENSE'), 'utf8'), `license for ${name}`);
  assert.deepEqual(bundleDesktopSystemAddon(join(f.root, 'second'), f), records);
  assert.equal(f.fetches(), 5, 'A cached rebuild must not require the registry');
  const archive = join(f.cacheDirectory, readdirSync(f.cacheDirectory).find(name => name.endsWith('.tgz')));
  writeFileSync(archive, 'corrupt cache');
  assert.throws(() => bundleDesktopSystemAddon(join(f.root, 'corrupt'), f), /integrity mismatch/);
  assert.equal(f.fetches(), 5, 'Corruption must be reported, not silently replaced');
});

test('Desktop native bundling rejects missing platforms, version drift and altered downloads', t => {
  const f = fixture(t), entry = f.lock.packages[`node_modules/${desktopSystemAddon}`];
  delete entry.optionalDependencies[f.names.at(-1)]; f.saveLock();
  assert.throws(() => bundleDesktopSystemAddon(join(f.root, 'missing'), f), /platform inventory drift/);
  entry.optionalDependencies[f.names.at(-1)] = desktopSystemAddonVersion; entry.version = '999.0.0'; f.saveLock();
  assert.throws(() => bundleDesktopSystemAddon(join(f.root, 'version'), f), /lock version drift/);
  entry.version = desktopSystemAddonVersion; f.saveLock();
  assert.throws(() => bundleDesktopSystemAddon(join(f.root, 'download'), { ...f, fetchPackage: (_record, directory) => {
    const output = join(directory, 'download.tgz'); writeFileSync(output, 'unexpected download'); return output;
  } }), /integrity mismatch/);
});
