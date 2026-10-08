import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { desktopPresetPackage, desktopReleaseRuntime } from './desktop-package.mjs';

export function assertDesktopVerification(candidate, proof) {
  assert.equal(candidate.name, desktopPresetPackage, 'Wrong Desktop package identity');
  assert.equal(candidate.runtime, desktopReleaseRuntime, 'Unqualified Desktop runtime');
  assert.equal(candidate.private, false, 'Private Desktop candidates cannot be published');
  assert.equal(proof.packageName, candidate.name, 'Verification package identity mismatch');
  assert.equal(proof.packageVersion, candidate.version, 'Verification package version mismatch');
  assert.equal(proof.packageSha256, candidate.sha256, 'Desktop package changed after verification');
  assert.equal(proof.runtimeSources?.runtime, candidate.runtime, 'Verification runtime mismatch');
  for (const field of ['npmPackRoundtrip', 'sourceRuntimeUnchanged', 'persistentShell', 'freshShell', 'bundledPatchHelper',
    'nativeStandardShellUnchanged', 'workspaceInstructionIsolation', 'workspaceSkillIsolation', 'workspaceHookIsolation',
    'hubToolsScoped', 'hubSettingsRpc', 'hubSettingsAuth', 'customSettingsAuth', 'customHostRestart',
    'combinedDesktopBrowser', 'customBrowserScreenshot', 'customBrowserAnnotation', 'combinedBrowserRevocation', 'browserPermissionsSurvivedRestart']) {
    assert.equal(proof[field], true, `Missing Desktop qualification: ${field}`);
  }
  assert.deepEqual(proof.phases?.map(phase => phase.phase), ['initial', 'reload'], 'Both Host phases must complete');
}

export function readDesktopRelease(root, { requireInstall = true } = {}) {
  const directory = join(root, 'artifacts/desktop/release');
  const candidate = JSON.parse(readFileSync(join(directory, 'candidate.json'), 'utf8'));
  const filename = candidate.filename;
  assert.equal(typeof filename, 'string'); assert.equal(basename(filename), filename); assert(filename.endsWith('.tgz'));
  const path = join(directory, filename), bytes = readFileSync(path);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), candidate.sha256, 'Desktop tarball checksum mismatch');
  assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, candidate.integrity, 'Desktop npm integrity mismatch');
  const proof = JSON.parse(readFileSync(join(directory, 'verification.json'), 'utf8'));
  assertDesktopVerification(candidate, proof);
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  assert.equal(candidate.version, version, 'Desktop release version must match the source manifest');
  assert(readFileSync(join(root, 'docs/releases', `${version}.md`), 'utf8').trim(), 'Write the release notes before publishing');
  const manifest = JSON.parse(execFileSync('tar', ['-xOf', path, 'package/package.json'], { encoding: 'utf8' }));
  assert.equal(manifest.name, candidate.name); assert.equal(manifest.version, candidate.version); assert.equal(manifest.private, false);
  assert.equal(manifest.engines?.dsh, candidate.runtime); assert.equal(manifest.peerDependencies?.['@deepseek-ai/dsh'], candidate.runtime);
  assert.equal(manifest.publishConfig?.tag, 'preview'); assert.deepEqual(manifest.dsh?.hub?.compatibility?.surfaces, ['desktop']);
  if (requireInstall) {
    const installation = JSON.parse(readFileSync(join(directory, 'installation.json'), 'utf8'));
    for (const field of ['name', 'version', 'runtime', 'integrity']) assert.equal(installation[field], candidate[field], `Desktop install ${field} mismatch`);
    assert.equal(installation.packageSha256, candidate.sha256, 'Desktop install archive mismatch');
    for (const field of ['nativeInstall', 'installedHost', 'hubRpc', 'presetResolved', 'defaultHome', 'componentsActive']) assert.equal(installation[field], true, `Missing installed Desktop qualification: ${field}`);
  }
  return { ...candidate, path, proof, manifest };
}
