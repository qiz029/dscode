// The Linux end-to-end harness. Two modes share this file the way scripts/checks.mjs
// shares its suites: the host mode builds docker/e2e.Dockerfile and runs it, and
// `--inside` is what the container then runs.
//
// Why a container: inside a dscode session on macOS a nested Seatbelt profile is
// refused, so `verify:hub` — install the built bundle, boot the installed profile,
// exercise the agent loop, fail an upgrade, roll back — can never run there; and the
// maintained gate only ever ran on macos-14, so no Linux assumption was ever tested.
// This is never part of `npm run check`: it needs a Docker daemon.
//
// Usage: npm run test:e2e [-- --no-hub] [-- --no-cache]
import { spawn, spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const image = 'dscode-e2e:local';
const args = new Set(process.argv.slice(2));
const seconds = ms => (Date.now() - ms) / 1000 < 60 ? ((Date.now() - ms) / 1000).toFixed(1) + 's' : (Math.round((Date.now() - ms) / 1000 / 6) / 10).toFixed(1) + 'min';

if (args.has('--help') || args.has('-h')) {
  console.log(`Usage: npm run test:e2e [-- --no-hub] [-- --no-cache]

Builds docker/e2e.Dockerfile and runs the Linux end-to-end steps inside it: the
provisioned runtime, the unit suite, the native Harness probes, the packaged
tarballs, and the installed-bundle Hub lifecycle. --no-hub stops after the tarball
checks, which drops the one step that never runs inside a macOS session.`);
  process.exit(0);
}

const run = (command, argv) => new Promise((resolvePromise, reject) => {
  const child = spawn(command, argv, { cwd: root, stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', code => resolvePromise(code ?? 1));
});

if (args.has('--inside')) {
  const hub = !args.has('--no-hub');
  const steps = [
    ['provision the patched developer runtime', ['npm', 'run', 'setup']],
    ['unit and component contracts', ['npm', 'test']],
    ['native Harness probes on Linux (no Seatbelt, so the PTY path runs)', ['npm', 'run', 'test:integration']],
    ['packaged tarballs: build, unpack, integrity', ['npm', 'run', 'test:package']],
    ...(hub ? [
      ['package the publishable bundle', ['npm', 'run', 'build:packages']],
      ['build the Hub release metadata', ['npm', 'run', 'release:hub']],
      ['installed bundle end to end: Hub install, agent loop, failed upgrade, rollback', ['npm', 'run', 'verify:hub']],
    ] : []),
  ];
  const started = Date.now();
  for (const [label, argv] of steps) {
    console.log(`\n[e2e] ${label}`);
    const at = Date.now();
    const code = await run(argv[0], argv.slice(1));
    if (code !== 0) {
      console.error(`\n[e2e] FAILED in ${seconds(at)}: ${label}`);
      process.exit(code);
    }
    console.log(`[e2e] ok in ${seconds(at)}: ${label}`);
  }
  console.log(`\n[e2e] ${steps.length} steps passed in ${seconds(started)} on ${process.platform} ${process.arch}`);
  process.exit(0);
}

const daemon = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
if (daemon.status !== 0) {
  console.error('The Docker daemon is not reachable, so the Linux end-to-end harness cannot run.');
  console.error('Start Docker and retry. This check is deliberately outside `npm run check`, which never requires Docker.');
  process.exit(1);
}

console.log(`[e2e] building ${image} from docker/e2e.Dockerfile (Docker ${daemon.stdout.trim()})`);
const built = await run('docker', ['build', ...(args.has('--no-cache') ? ['--no-cache'] : []), '-t', image, '-f', 'docker/e2e.Dockerfile', '.']);
if (built !== 0) {
  console.error(`[e2e] FAILED: docker build exited ${built}`);
  process.exit(built);
}

// -t: the probes exercise terminal paths, so the container gets a TTY like a real host.
const container = await run('docker', ['run', '--rm', '-t', image, 'node', 'scripts/e2e.mjs', '--inside', ...(args.has('--no-hub') ? ['--no-hub'] : [])]);
if (container !== 0) {
  console.error(`[e2e] FAILED: the container exited ${container}`);
  process.exit(container);
}
console.log('[e2e] the Linux end-to-end harness passed');
