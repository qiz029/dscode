import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Self-update for tar installations: download the release tarball, verify it against the
// release's sha256 digest, stage a full install beside the old one, migrate local state
// and swap the directories in place, so the `dscode` command serves the new version at
// the same path. The npm/Hub launcher updates itself in packages/launcher; a source
// checkout is refused below.

export const REPOSITORY = 'qiz029/dscode';
export const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;
const RUNTIME_GUARD = /\/dscode(\.mjs)? update/;
/** Marks a tree whose node_modules came with the release; its content is the platform it was installed for. */
export const PREBUILT_MARKER = '.dscode-prebuilt';

export function parseUpdateArgs(argv = []) {
  if (argv.length > 1 || argv[0] && argv[0].startsWith('-')) throw Error('Usage: dscode update [exact-version]');
  // The TUI's `/update` schedules "latest" when the user names no version, and it reads
  // as the default on the command line too.
  if (argv[0] === 'latest') return { version: undefined };
  if (argv[0] !== undefined && !VERSION_PATTERN.test(argv[0])) throw Error(`Usage: dscode update [exact-version]; "${argv[0]}" is not an exact version.`);
  return { version: argv[0] };
}

/**
 * The release's tarball asset, or undefined when the release does not carry one for `wanted`.
 * With a `platform` the prebuilt tarball for it wins: it already holds node_modules, so the
 * update never reaches an npm registry. The source tarball remains the fallback.
 */
export function releaseAsset(body, wanted, platform) {
  const version = String(body?.tag_name ?? '').replace(/^v/, '');
  if (body?.draft || body?.prerelease || !VERSION_PATTERN.test(version) || wanted !== undefined && version !== wanted) return undefined;
  const assets = Array.isArray(body?.assets) ? body.assets : [];
  const named = name => assets.find(candidate => candidate?.name === name && candidate.browser_download_url);
  const prebuilt = platform === undefined ? undefined : named(`dscode-${version}-${platform}.tar.gz`);
  const asset = prebuilt ?? named(`dscode-${version}.tar.gz`);
  if (!asset) return undefined;
  const digest = typeof asset.digest === 'string' && asset.digest.startsWith('sha256:') ? asset.digest.slice('sha256:'.length) : undefined;
  return { version, url: asset.browser_download_url, digest, size: asset.size, prebuilt: prebuilt !== undefined };
}

export function verifyDigest(buffer, digest) {
  return digest === undefined || createHash('sha256').update(buffer).digest('hex') === digest;
}

/** Move the previous installation's state into the staged tree; provision() rebuilds the profile's node_modules link. */
export function migrateState(from, to) {
  const runtime = join(from, '.runtime');
  if (existsSync(runtime)) {
    renameSync(runtime, join(to, '.runtime'));
    rmSync(join(to, '.runtime/profiles/tui/node_modules'), { recursive: true, force: true });
  }
  if (existsSync(join(from, '.env'))) cpSync(join(from, '.env'), join(to, '.env'));
  // Every local config file survives, but release-shipped defaults (already present in the
  // staged tree) come from the new version, so an old copy cannot roll them back.
  const config = join(from, 'config');
  if (existsSync(config)) {
    for (const entry of readdirSync(config)) {
      const target = join(to, 'config', entry);
      if (existsSync(target)) continue;
      mkdirSync(join(to, 'config'), { recursive: true });
      cpSync(join(config, entry), target, { recursive: true });
    }
  }
}

const defaultExec = (argv, { cwd, capture = false } = {}) => {
  const result = spawnSync(argv[0], argv.slice(1), { cwd, ...(capture ? { stdio: ['ignore', 'pipe', 'ignore'], encoding: 'utf8' } : { stdio: 'inherit' }) });
  if (result.error) throw Error(`${argv[0]} could not be started: ${result.error.message}`);
  if (result.status !== 0) throw Error(`${argv.join(' ')} exited with ${result.status ?? result.signal}.`);
  return result.stdout ?? '';
};

/**
 * Update a git checkout in place: pull the branch it tracks, then reinstall the locked
 * dependencies and reprovision. Untracked files are ignored (a pull only overwrites them
 * when git would refuse anyway); a tracked modification, an explicit version or a running
 * session refuses before anything changes.
 */
export function updateCheckout({ installDir, wanted, exec, busy, readVersion }) {
  if (wanted) throw Error('A source checkout tracks its own branch; run "dscode update" without a version, or check out the tag yourself.');
  if (busy()) throw Error(`DSCODE is running from ${installDir}. Exit its sessions before updating.`);
  if (exec(['git', 'status', '--porcelain', '--untracked-files=no'], { cwd: installDir, capture: true }).trim()) {
    throw Error(`The source checkout at ${installDir} has uncommitted changes. Commit or stash them, then run dscode update again.`);
  }
  const head = () => exec(['git', 'rev-parse', 'HEAD'], { cwd: installDir, capture: true }).trim();
  const before = head(), from = readVersion();
  exec(['git', 'pull', '--ff-only'], { cwd: installDir });
  if (head() === before) return { status: 'current', version: from };
  console.log('Installing dependencies and reprovisioning the profile…');
  exec(['npm', 'ci', '--ignore-scripts', '--no-audit'], { cwd: installDir });
  exec(['npm', 'run', 'setup'], { cwd: installDir });
  const to = readVersion();
  console.log(`Updated dscode ${from} → ${to}.`);
  return { status: 'updated', from, to, method: 'git' };
}

export async function selfUpdate(argv = [], options = {}) {
  const { version: wanted } = parseUpdateArgs(argv);
  const installDir = resolve(options.installDir ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
  const fetchImpl = options.fetchImpl ?? fetch;
  const exec = options.exec ?? defaultExec;
  const readVersion = () => JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')).version;
  const busy = () => exec(['ps', '-axo', 'command='], { capture: true })
    .split('\n').some(line => line.includes(installDir) && !RUNTIME_GUARD.test(line));
  // A git working tree updates through git: the tarball swap below would replace the
  // checkout itself. Both paths refuse while a session runs from this directory.
  if (existsSync(join(installDir, '.git'))) return updateCheckout({ installDir, wanted, exec, busy, readVersion });
  const current = readVersion();
  if (busy()) throw Error(`DSCODE is running from ${installDir}. Exit its sessions before updating.`);
  const endpoint = wanted === undefined ? `https://api.github.com/repos/${REPOSITORY}/releases/latest` : `https://api.github.com/repos/${REPOSITORY}/releases/tags/v${wanted}`;
  const response = await fetchImpl(endpoint, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'dscode-self-update' } });
  if (!response.ok) throw Error(wanted === undefined ? `Could not read the latest DSCODE release (HTTP ${response.status}).` : `DSCODE ${wanted} has no GitHub release (HTTP ${response.status}).`);
  const platform = options.platform ?? `${process.platform}-${process.arch}`;
  const asset = releaseAsset(await response.json(), wanted, platform);
  if (!asset) throw Error(`Release ${wanted ?? 'latest'} carries no dscode tarball.`);
  if (asset.version === current) return { status: 'current', version: current };
  if (!asset.digest) throw Error('The release tarball has no sha256 digest; refusing an unverified download.');
  console.log(`Downloading DSCODE ${asset.version}…`);
  const download = await fetchImpl(asset.url, { headers: { 'user-agent': 'dscode-self-update' } });
  if (!download.ok) throw Error(`Downloading ${asset.url} failed (HTTP ${download.status}).`);
  const tarball = Buffer.from(await download.arrayBuffer());
  if (!verifyDigest(tarball, asset.digest)) throw Error('The downloaded tarball does not match the release digest; nothing was installed.');
  const parent = dirname(installDir);
  const work = join(parent, `.dscode-update-${process.pid}`);
  const staged = join(work, 'staged');
  const archive = join(work, `dscode-${asset.version}.tar.gz`);
  mkdirSync(staged, { recursive: true });
  writeFileSync(archive, tarball, { mode: 0o600 });
  try {
    exec(['tar', '-xzf', archive], { cwd: staged });
    if (!existsSync(join(staged, 'package.json'))) throw Error('The release tarball has an unexpected layout.');
    migrateState(installDir, staged);
    // A prebuilt tree needs neither npm nor a registry; trust the marker only with the
    // dependencies beside it and for this platform, and install from the lockfile otherwise.
    const marker = join(staged, PREBUILT_MARKER);
    if (existsSync(marker) && existsSync(join(staged, 'node_modules')) && readFileSync(marker, 'utf8').trim() === platform) {
      console.log('Reprovisioning the profile…');
      exec([process.execPath, 'scripts/harness.mjs', 'setup'], { cwd: staged });
    } else {
      console.log('Installing dependencies and reprovisioning the profile…');
      exec(['npm', 'ci', '--ignore-scripts', '--no-audit'], { cwd: staged });
      exec(['npm', 'run', 'setup'], { cwd: staged });
    }
    // The command path never changes, so existing `dscode` links serve the new tree as soon as this rename lands.
    // The session check runs again at the swap itself; a session started during the
    // minutes of npm ci otherwise has its state directory renamed underneath it.
    if (busy()) throw Error(`DSCODE started while the update was staged. Exit its sessions and run the update again; nothing was changed.`);
    const backup = join(parent, `.dscode-backup-${current}`);
    const backupDir = existsSync(backup) ? `${backup}-${Date.now()}` : backup;
    renameSync(installDir, backupDir);
    try { renameSync(staged, installDir); }
    catch (error) { renameSync(backupDir, installDir); throw error; }
    const installed = JSON.parse(readFileSync(join(installDir, 'package.json'), 'utf8')).version;
    if (installed !== asset.version) throw Error(`The swapped installation reports ${installed}, expected ${asset.version}.`);
    console.log(`Updated dscode ${current} → ${asset.version}.\nPrevious installation kept at ${backupDir}; run "dscode update ${current}" to go back, or remove that directory to discard it.`);
    return { status: 'updated', from: current, to: asset.version, backup: backupDir };
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}
