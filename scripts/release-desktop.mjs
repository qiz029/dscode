import { basename, join, resolve } from 'node:path';
import { accessSync, constants, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { packDesktopPreset } from './pack-desktop-preset.mjs';
import { readDesktopRelease } from './desktop-release-artifact.mjs';

const root = resolve(import.meta.dirname, '..');
if (!process.argv[2]) throw Error('Usage: node scripts/release-desktop.mjs <qualified-runtime-directory>');
if (!process.env.DSCODE_TEST_CHROME) throw Error('Desktop release verification requires DSCODE_TEST_CHROME');
accessSync(process.env.DSCODE_TEST_CHROME, constants.X_OK);
const runtime = resolve(process.argv[2]);
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
if (!existsSync(join(root, 'docs/releases', `${version}.md`))) throw Error(`docs/releases/${version}.md is missing; write the release notes first`);
const directory = join(root, 'artifacts/desktop/release');
// This generated directory contains one candidate only. Older archives must not
// be attached by a later release's asset glob, even after an interrupted build.
rmSync(directory, { recursive: true, force: true });
mkdirSync(directory, { recursive: true });
const candidate = packDesktopPreset(runtime, directory, { release: true });
execFileSync(process.execPath, [join(root, 'scripts/verify-desktop-preset.mjs'), runtime, '--candidate', candidate.path, '--browser'], { cwd: root, stdio: 'inherit', timeout: 360000 });
cpSync(join(root, 'artifacts/local/desktop-preset.json'), join(directory, 'verification.json'));
writeFileSync(join(directory, 'candidate.json'), JSON.stringify({ ...candidate, filename: basename(candidate.path) }, null, 2) + '\n');
readDesktopRelease(root, { requireInstall: false });
execFileSync(process.execPath, [join(root, 'scripts/verify-desktop-registry.mjs'), runtime, '--local'], { cwd: root, stdio: 'inherit', timeout: 360000 });
cpSync(join(root, 'artifacts/local/desktop-local-install.json'), join(directory, 'installation.json'));
readDesktopRelease(root);
const filename = basename(candidate.path);
writeFileSync(join(directory, filename + '.sha256'), `${candidate.sha256}  ${filename}\n`);
writeFileSync(join(directory, `dscode-desktop-${version}-README.md`), execFileSync('tar', ['-xOf', candidate.path, 'package/README.md']));
cpSync(join(root, 'docs/releases', `${version}.md`), join(directory, `dscode-desktop-${version}-release-notes.md`));
console.log(`Desktop release candidate verified: ${filename}`);
