import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopPackageMetadata, desktopPresetPackage, desktopReleaseRuntime } from '../scripts/desktop-package.mjs';

test('Desktop release identity remains stable while unsupported runtime candidates cannot be published', () => {
  const local = desktopPackageMetadata('0.8.0-preview.1', desktopReleaseRuntime);
  assert.equal(local.name, desktopPresetPackage);
  assert.equal(local.private, true);
  const release = desktopPackageMetadata('0.8.0-preview.1', desktopReleaseRuntime, { release: true });
  assert.equal(release.private, false);
  assert.equal(release.engines.dsh, release.peerDependencies['@deepseek-ai/dsh']);
  assert.equal(release.publishConfig.tag, 'preview');
  assert.equal(desktopPackageMetadata('0.8.0-preview.1', '0.2.1-alpha.1').private, true);
  assert.throws(() => desktopPackageMetadata('0.8.0-preview.1', '0.2.1-alpha.1', { release: true }), /qualified runtime/);
});
