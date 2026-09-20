import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = resolve(fileURLToPath(new URL('..', import.meta.url)));

// Nothing else reads the vendored terminal's types: Node strips them without
// checking, scripts/build-tui.mjs transpiles syntax only, and ESLint never opens a
// .ts file. `npm run typecheck` and `npm run typecheck:strict` are that gate; these
// pin it so a type error cannot land unnoticed between releases, and so the gate
// cannot quietly lose its teeth.

const CONFIGS = [
  { name: 'tsconfig.json', file: join(root, 'packages', 'tui', 'tsconfig.json') },
  { name: 'tsconfig.strict.json (noImplicitAny for src/dscode)', file: join(root, 'packages', 'tui', 'tsconfig.strict.json') },
];

for (const { name, file } of CONFIGS) {
  test(`the vendored terminal compiles under ${name}`, async () => {
    const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
    try {
      await run(process.execPath, [tsc, '-p', file], { cwd: root });
    } catch (error) {
      assert.fail(`the vendored terminal no longer type-checks:\n${String(error.stdout || error.message)}`);
    }
  });
}

// Without React's types every hook and prop in the terminal degrades to `any`, and
// the compiler silently stops reading the largest part of the fork.
test('React types stay installed so the terminal check keeps its teeth', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.ok(manifest.devDependencies['@types/react'], '@types/react must stay a devDependency');
  assert.match(readFileSync(CONFIGS[0].file, 'utf8'), /"src\/\*\*\/\*\.ts"/,
    'the base tsconfig must keep checking packages/tui/src');
});

// The ratchet only ratchets if the first-party seed stays in it.
test('the strict subset still seeds from the first-party dscode files', () => {
  const strict = readFileSync(CONFIGS[1].file, 'utf8');
  assert.match(strict, /"include":\s*\["src\/dscode\/\*\*\/\*\.ts"\]/, 'tsconfig.strict.json must keep src/dscode in include');
  assert.match(strict, /"noImplicitAny":\s*true/, 'tsconfig.strict.json must keep noImplicitAny on');
});
