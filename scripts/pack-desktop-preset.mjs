// Produce a local, runtime-specific package without installing or publishing it.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { buildDesktopPreset } from './build-desktop-preset.mjs';

export function packDesktopPreset(runtimeDirectory, outputDirectory, options = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'dscode-desktop-pack-'));
  try {
    const staged = buildDesktopPreset(join(temporary, 'bundle'), runtimeDirectory, options);
    const manifest = JSON.parse(readFileSync(join(staged, 'package.json'), 'utf8'));
    const sources = JSON.parse(readFileSync(join(staged, 'runtime-sources.json'), 'utf8'));
    const packed = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', temporary], { cwd: staged, encoding: 'utf8' }))[0];
    for (const native of sources.nativePackages) assert(packed.bundled.includes(native.name), `Missing bundled native package: ${native.name}`);
    const bytes = readFileSync(join(temporary, packed.filename));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const filename = `dscode-desktop-${manifest.version}-dsh-${sources.runtime}-${sha256.slice(0, 12)}.tgz`;
    const directory = resolve(outputDirectory), path = join(directory, filename);
    mkdirSync(directory, { recursive: true });
    try { writeFileSync(path, bytes, { flag: 'wx' }); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), sha256, 'Existing package does not match its content address');
    }
    const receipt = { path, name: manifest.name, version: manifest.version, runtime: sources.runtime,
      sha256, integrity: packed.integrity, bytes: bytes.length, private: manifest.private, runtimeSources: sources.sources, nativePackages: sources.nativePackages };
    writeFileSync(path + '.json', JSON.stringify(receipt, null, 2) + '\n');
    return receipt;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2).filter(value => value !== '--release');
  if (!args[0] || args.length > 2 || args.some(value => value.startsWith('--'))) throw Error('Usage: node scripts/pack-desktop-preset.mjs <matching-runtime-directory> [output-directory] [--release]');
  console.log(JSON.stringify(packDesktopPreset(args[0], args[1] ?? join(import.meta.dirname, '../artifacts/desktop/packages'), { release: process.argv.includes('--release') }), null, 2));
}
