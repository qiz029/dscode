import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { vendorHub, generatedProfileRootHash } from '../scripts/vendor-hub.mjs';

const root = new URL('../', import.meta.url).pathname;
const hash = value => 'sha256:' + createHash('sha256').update(value).digest('hex');
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value);

test('native Hub receipt accepts only the exact generated root and still rejects changed inputs', async t => {
  const home = mkdtempSync(join(tmpdir(), 'dscode-hub-receipt-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  symlinkSync(join(root, 'node_modules'), join(home, 'node_modules'), 'dir');
  const vendor = join(home, 'hub');
  vendorHub(join(root, 'node_modules/@dsh-plugin-hub/cli'), vendor);
  const { verifyEffectiveProfileDependencyLock } = await import(pathToFileURL(join(vendor, 'dist/profile-dependency-install.js')));
  const { scanProfileFiles } = await import(pathToFileURL(join(vendor, 'dist/profile-upgrade-files.js')));
  const profile = join(home, 'profile'); mkdirSync(profile);
  const manifest = { name: 'fixture', private: true };
  writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest));
  writeFileSync(join(profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
  const receipt = {
    schemaVersion: 1, packageManager: { name: 'pnpm', version: '10.33.0' },
    manifestHash: hash(canonical(manifest)), configurationHash: hash(canonical((await scanProfileFiles(profile)).filter(file => !['package.json', 'pnpm-lock.yaml'].includes(file.relativePath)))),
    environmentHash: hash('{}'), externalFiles: [], platform: process.platform, arch: process.arch,
    nodeAbi: process.versions.modules, hooksPresent: false, resolution: 'new',
    lock: { schemaVersion: 1, format: 'pnpm', lockfileVersion: '9.0', hash: hash(readFileSync(join(profile, 'pnpm-lock.yaml'))), packages: 0, snapshots: 0, directDependencies: 0, registryIntegrity: 0, declaredIntegrityVerified: 0, unverifiedGitHubBuilds: 0 },
  };
  await verifyEffectiveProfileDependencyLock(profile, receipt);
  const runtime = join(root, 'node_modules/@deepseek-ai/dsh/lib');
  const boot = readdirSync(runtime).find(file => /^profile-boot-.*\.js$/.test(file) && readFileSync(join(runtime, file), 'utf8').includes('const PROFILE_ROOT_CONFIG ='));
  const generated = readFileSync(join(runtime, boot), 'utf8').match(/const PROFILE_ROOT_CONFIG = `([^`]+)`;/)[1];
  assert.equal(hash(generated), generatedProfileRootHash, 'the compatibility fix must match the pinned Harness output');
  writeFileSync(join(profile, 'cordis.yml'), generated);
  await verifyEffectiveProfileDependencyLock(profile, receipt);
  await assert.rejects(verifyEffectiveProfileDependencyLock(profile, { ...receipt, hooksPresent: true }), /inputs changed/);
  writeFileSync(join(profile, 'cordis.yml'), '- name: unexpected\n');
  await assert.rejects(verifyEffectiveProfileDependencyLock(profile, receipt), /inputs changed/);
  writeFileSync(join(profile, 'cordis.yml'), generated);
  writeFileSync(join(profile, '.npmrc'), 'ignore-scripts=false\n');
  await assert.rejects(verifyEffectiveProfileDependencyLock(profile, receipt), /inputs changed/);
  rmSync(join(profile, '.npmrc'));
  writeFileSync(join(profile, 'pnpm-lock.yaml'), 'changed\n');
  await assert.rejects(verifyEffectiveProfileDependencyLock(profile, receipt), /inputs changed/);
});
