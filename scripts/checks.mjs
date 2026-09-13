import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { createTestRuntime, copyVerificationSource, upstreamPackages } from './test-runtime.mjs';

const root = resolve(import.meta.dirname, '..');
const suite = process.argv[2] ?? 'unit';
const tests = readdirSync(join(root, 'tests')).filter(name => name.endsWith('.test.mjs')).map(name => join(root, 'tests', name));
const output = join(root, 'artifacts/local/coverage');
const run = (args, cwd = root) => new Promise((resolvePromise, reject) => {
  const child = spawn(process.execPath, args, {
    cwd, stdio: 'inherit',
    env: suite === 'package' ? { ...process.env, npm_config_cache: join(cwd, '.npm-cache') } : process.env,
  });
  const timeout = setTimeout(() => child.kill('SIGKILL'), 180000);
  child.once('error', reject);
  child.once('exit', (code, signal) => {
    clearTimeout(timeout);
    if (code === 0) resolvePromise(); else reject(Error(`Check failed: ${args[0]} (${signal ?? code})`));
  });
});

function coverage() {
  const raw = readFileSync(join(output, 'loaded.lcov'), 'utf8');
  const loaded = new Map(raw.split('end_of_record').filter(record => record.includes('SF:')).map(record => {
    const file = record.match(/^SF:(.+)$/m)[1];
    const lines = [...record.matchAll(/^DA:(\d+),(\d+)/gm)].map(([, line, hits]) => ({ line: +line, hits: +hits }));
    return [resolve(root, file), { record: record.trim() + '\nend_of_record\n', lines }];
  }));
  const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? walk(join(directory, entry.name)) : [join(directory, entry.name)]);
  const files = ['plugins', 'packages', 'scripts', 'bin'].flatMap(dir => walk(join(root, dir))).filter(file => file.endsWith('.mjs'))
    .filter(file => !/\/(?:verify-[^/]+|[^/]*probe[^/]*|hook-fixture|test-runtime|checks)\.mjs$/.test(file));
  let total = 0, covered = 0, lcov = '';
  const details = files.map(file => {
    const entry = loaded.get(file);
    const count = readFileSync(file, 'utf8').replace(/\n$/, '').split('\n').length;
    const hits = entry?.lines.filter(line => line.hits > 0).length ?? 0;
    const lines = entry?.lines.length ?? count;
    total += lines; covered += hits;
    lcov += entry?.record ?? `TN:\nSF:${relative(root, file)}\n${Array.from({ length: count }, (_, i) => `DA:${i + 1},0`).join('\n')}\nLF:${count}\nLH:0\nend_of_record\n`;
    return { file: relative(root, file), lines, covered: hits, loaded: !!entry };
  });
  const percent = 100 * covered / total;
  const report = { scope: 'All first-party runtime, launcher, build and patch .mjs files; probe/check fixtures excluded. Unloaded files count as zero.', lines: total, covered, percent, files: details };
  writeFileSync(join(output, 'lcov.info'), lcov);
  writeFileSync(join(output, 'summary.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`Complete source inventory: ${covered}/${total} lines (${percent.toFixed(2)}%); ${details.filter(f => !f.loaded).length} unloaded files counted as zero.`);
  if (percent < 75) throw Error('Full-inventory line coverage fell below the 75% baseline');
}

async function main() {
  if (['unit', 'coverage'].includes(suite)) {
    const paths = upstreamPackages.map(name => join(root, 'node_modules', name, 'lib/index.' + (name === 'dsh-code' ? 'mjs' : 'js')));
    const hashes = () => paths.map(path => createHash('sha256').update(readFileSync(path)).digest('hex'));
    const before = hashes();
    try {
      if (suite === 'coverage') {
        mkdirSync(output, { recursive: true });
        await run(['--test', '--experimental-test-coverage', '--test-reporter=spec', '--test-reporter-destination=stdout', '--test-reporter=lcov', `--test-reporter-destination=${join(output, 'loaded.lcov')}`, ...tests]);
        coverage();
      } else await run(['--test', ...tests]);
    } finally {
      if (JSON.stringify(before) !== JSON.stringify(hashes())) throw Error('Tests modified the developer runtime in node_modules');
    }
    return;
  }
  const groups = {
    integration: ['verify-session-bridge', 'verify-session-messaging', 'verify-runtime-foundations', 'verify-session-cards', 'verify-memory', 'verify-login-runtime'],
    ui: ['verify-login', 'verify-tui-style', 'verify-tui-viewport', 'verify-effort-bar'],
    package: ['build-packages', 'verify-packages'],
  };
  if (!groups[suite]) throw Error('Unknown check suite: ' + suite);
  const fixture = createTestRuntime({ tui: true, runtime: true });
  try {
    copyVerificationSource(fixture.root);
    for (const script of groups[suite]) await run([join(fixture.root, 'scripts', script + '.mjs')], fixture.root);
  } finally { fixture.close(); }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
