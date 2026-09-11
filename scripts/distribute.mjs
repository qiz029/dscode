import { mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { root, manifest } from './harness.mjs';

mkdirSync(join(root, 'artifacts'), { recursive: true });
const archive = join(root, 'artifacts', `dscode-${manifest.version}.tar.gz`);
const result = spawnSync('tar', ['-czf', archive, '-C', root,
  'package.json', 'package-lock.json', '.npmrc', '.env.example',
  'bin', 'scripts', 'packages', 'plugins', 'tests', 'presets', 'config/cordis.patch.yml', 'config/preset.json',
  'config/mcp.local.example.yml', 'config/auto-review.patch.yml', 'README.md', 'docs', 'install.sh',
], { stdio: 'inherit' });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(archive);
