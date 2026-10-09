// Dedicated verification runtime; never modifies the terminal dependency tree.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { desktopDependencies } from './build-desktop-preset.mjs';
import { desktopReleaseRuntime } from './desktop-package.mjs';

const directory = resolve(process.argv[2] ?? '.research/desktop-release-runtime');
const manifest = { name: 'dscode-desktop-verification-runtime', private: true,
  dependencies: { '@deepseek-ai/dsh': desktopReleaseRuntime, ...desktopDependencies, pnpm: '10.15.1' } };
mkdirSync(directory, { recursive: true });
const path = join(directory, 'package.json');
if (existsSync(path)) {
  const previous = JSON.parse(readFileSync(path, 'utf8'));
  if (previous.name !== manifest.name || previous.private !== true) throw Error('Refusing to replace an unrelated runtime project. Choose an empty directory.');
} else if (readdirSync(directory).length) throw Error('The verification runtime directory must be empty.');
writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: directory, stdio: 'inherit', timeout: 300000 });
console.log(`Desktop verification runtime ready: ${directory}`);
