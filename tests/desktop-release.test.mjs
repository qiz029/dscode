import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { hubListingSchema } from '@dsh-plugin-hub/schemas';
import { desktopHubListing, desktopPackageMetadata, desktopReleaseRuntime } from '../scripts/desktop-package.mjs';
import { readDesktopRelease } from '../scripts/desktop-release-artifact.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'desktop-release-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'artifacts/desktop/release');
  mkdirSync(directory, { recursive: true });
  mkdirSync(join(root, 'package')); mkdirSync(join(root, 'docs/releases'), { recursive: true });
  const version = '1.2.3';
  const manifest = { ...desktopPackageMetadata(version, desktopReleaseRuntime, { release: true }), dsh: { hub: desktopHubListing(desktopReleaseRuntime) } };
  const write = (path, value) => writeFileSync(path, JSON.stringify(value));
  write(join(root, 'package/package.json'), manifest);
  write(join(root, 'package.json'), { version });
  writeFileSync(join(root, 'docs/releases/1.2.3.md'), '# Release\n');
  execFileSync('tar', ['-czf', join(directory, 'candidate.tgz'), '-C', root, 'package']);
  const bytes = readFileSync(join(directory, 'candidate.tgz'));
  const candidate = { name: manifest.name, version, runtime: desktopReleaseRuntime, private: false, filename: 'candidate.tgz',
    sha256: createHash('sha256').update(bytes).digest('hex'), integrity: 'sha512-' + createHash('sha512').update(bytes).digest('base64') };
  const proof = { packageName: manifest.name, packageVersion: version, packageSha256: candidate.sha256,
    runtimeSources: { runtime: desktopReleaseRuntime }, phases: [{ phase: 'initial' }, { phase: 'reload' }],
    npmPackRoundtrip: true, sourceRuntimeUnchanged: true, persistentShell: true, freshShell: true, bundledPatchHelper: true,
    nativeStandardShellUnchanged: true, workspaceInstructionIsolation: true, workspaceSkillIsolation: true, workspaceHookIsolation: true,
    hubToolsScoped: true, hubSettingsRpc: true, hubSettingsAuth: true, customSettingsAuth: true, customHostRestart: true,
    combinedDesktopBrowser: true, customBrowserScreenshot: true, customBrowserAnnotation: true, combinedBrowserRevocation: true,
    browserPermissionsSurvivedRestart: true };
  write(join(directory, 'installation.json'), { ...candidate, packageSha256: candidate.sha256,
    nativeInstall: true, installedHost: true, hubRpc: true, presetResolved: true, defaultHome: true, componentsActive: true });
  const save = () => { write(join(directory, 'candidate.json'), candidate); write(join(directory, 'verification.json'), proof); };
  save(); return { root, directory, candidate, proof, save, write };
}

test('a qualified Desktop archive retains public identity, compatibility and integrity', t => {
  const f = fixture(t), release = readDesktopRelease(f.root);
  assert.equal(release.path, join(f.directory, 'candidate.tgz'));
  const listing = hubListingSchema.parse(release.manifest.dsh.hub);
  assert.equal(listing.compatibility.dsh, desktopReleaseRuntime);
  assert.deepEqual(listing.compatibility.surfaces, ['desktop']);
});

test('changed public bytes and stale verification cannot reuse a release receipt', t => {
  const f = fixture(t);
  f.proof.packageSha256 = 'stale'; f.save();
  assert.throws(() => readDesktopRelease(f.root), /changed after verification/);
  f.proof.packageSha256 = f.candidate.sha256; f.save();
  writeFileSync(join(f.directory, 'candidate.tgz'), 'replaced archive');
  assert.throws(() => readDesktopRelease(f.root), /checksum mismatch/);
});

test('private or unsupported Desktop candidates cannot enter publication', t => {
  const f = fixture(t);
  f.candidate.private = true; f.save();
  assert.throws(() => readDesktopRelease(f.root), /Private Desktop/);
  f.candidate.private = false; f.candidate.runtime = '0.2.1-alpha.1'; f.save();
  assert.throws(() => readDesktopRelease(f.root), /Unqualified Desktop/);
});

test('missing browser, authorization or restart proof stops publication', t => {
  const f = fixture(t);
  for (const field of ['hubSettingsAuth', 'customBrowserAnnotation', 'browserPermissionsSurvivedRestart']) {
    delete f.proof[field]; f.save();
    assert.throws(() => readDesktopRelease(f.root), new RegExp(field));
    f.proof[field] = true;
  }
  f.proof.phases.pop(); f.save();
  assert.throws(() => readDesktopRelease(f.root), /Both Host phases/);
});

test('publication requires successful native installation of the same archive', t => {
  const f = fixture(t);
  f.write(join(f.directory, 'installation.json'), { ...f.candidate, packageSha256: 'older-package', nativeInstall: true });
  assert.throws(() => readDesktopRelease(f.root), /install archive mismatch/);
  rmSync(join(f.directory, 'installation.json'));
  assert.throws(() => readDesktopRelease(f.root), /installation.json/);
  // Only the build's bootstrap verifier may consume a Host-qualified archive
  // before recording its native-install result.
  assert.doesNotThrow(() => readDesktopRelease(f.root, { requireInstall: false }));
});

test('publication rejects installation proof that skipped default-home component activation', t => {
  const f = fixture(t), path = join(f.directory, 'installation.json');
  const proof = JSON.parse(readFileSync(path, 'utf8'));
  for (const field of ['defaultHome', 'componentsActive']) {
    f.write(path, { ...proof, [field]: false });
    assert.throws(() => readDesktopRelease(f.root), new RegExp(field));
  }
});

test('release version, npm integrity, filename and release notes are enforced', t => {
  const f = fixture(t);
  f.candidate.filename = '../candidate.tgz'; f.save();
  assert.throws(() => readDesktopRelease(f.root));
  f.candidate.filename = 'candidate.tgz';
  const integrity = f.candidate.integrity;
  f.candidate.integrity = 'sha512-wrong'; f.save();
  assert.throws(() => readDesktopRelease(f.root), /npm integrity mismatch/);
  f.candidate.integrity = integrity; f.save();
  f.write(join(f.root, 'package.json'), { version: '1.2.4' });
  assert.throws(() => readDesktopRelease(f.root), /source manifest/);
  f.write(join(f.root, 'package.json'), { version: '1.2.3' });
  writeFileSync(join(f.root, 'docs/releases/1.2.3.md'), '');
  assert.throws(() => readDesktopRelease(f.root), /release notes/);
});
