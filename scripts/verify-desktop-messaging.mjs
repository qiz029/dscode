// Qualify the packed Desktop composition with the shared real-Host probes.
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { stringify } from 'yaml';
import { packDesktopPreset } from './pack-desktop-preset.mjs';
import { desktopPresetPackage } from './build-desktop-preset.mjs';
import { removeDesktopProbeHome, seedDesktopProviderCatalogs } from './desktop-probe-home.mjs';

if (!process.argv[2]) throw Error('Usage: node scripts/verify-desktop-messaging.mjs <independent-runtime-directory>');
const root = resolve(import.meta.dirname, '..'), runtimeDirectory = resolve(process.argv[2]);
const modules = join(runtimeDirectory, 'node_modules');
const home = mkdtempSync(join(tmpdir(), 'dscode-desktop-messaging-'));
try {
  seedDesktopProviderCatalogs(home);
  const packed = packDesktopPreset(runtimeDirectory, join(home, 'packages'));
  const installed = join(home, 'installed'); mkdirSync(installed);
  execFileSync('tar', ['-xzf', packed.path, '-C', installed]);
  const bundle = join(installed, 'package'), profile = join(home, 'profiles/test');
  symlinkSync(modules, join(home, 'node_modules'));
  symlinkSync(join(bundle, 'plugins'), join(home, 'plugins'));
  mkdirSync(join(profile, 'node_modules/@toddzheng024'), { recursive: true });
  symlinkSync(bundle, join(profile, 'node_modules', desktopPresetPackage));
  symlinkSync(join(modules, '@deepseek-ai'), join(profile, 'node_modules/@deepseek-ai'));
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ private: true, type: 'module', dependencies: { [desktopPresetPackage]: `file:${bundle}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', desktopPresetPackage] } } }));
  mkdirSync(join(home, 'scripts')); mkdirSync(join(home, 'user')); mkdirSync(join(home, 'workspace'));
  for (const file of ['session-cards-probe.mjs', 'session-messaging-probe.mjs', 'desktop-messaging-scope-probe.mjs']) cpSync(join(root, 'scripts', file), join(home, 'scripts', file));
  const env = Object.fromEntries(['PATH', 'TMPDIR', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
  Object.assign(env, { HOME: join(home, 'user'), DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', ZDOTDIR: home,
    DSCODE_MESSAGING_RUNTIME: join(modules, '@deepseek-ai/dsh/lib/bin.js'), DSCODE_MESSAGING_PROFILE: 'test' });
  execFileSync('git', ['init', '--quiet', join(home, 'workspace')], { env });
  const checks = [];
  for (const scenario of ['cards', 'messaging', 'scope']) {
    const patch = join(profile, 'cordis.patch.yml');
    writeFileSync(patch, stringify([
      { id: 'frontend', disabled: true }, { id: 'webserver', config: { host: '127.0.0.1', port: 0 } },
      { id: 'web-runtime', config: { openBrowser: false } }, { id: 'product-analytics', config: { enabled: false } },
      { id: 'dscode-session-cards', config: { enabled: scenario === 'cards', minMessages: 1, debounceMs: 0, cooldownMs: 0 } },
      { insert: [{ id: 'desktop-messaging-probe', name: join(home, 'scripts', scenario === 'scope' ? 'desktop-messaging-scope-probe.mjs' : `session-${scenario}-probe.mjs`) }] },
    ]));
    // Children reuse this profile patch once; an extra empty layer satisfies the
    // shared probe's explicit --patch argument without double-mounting its rows.
    const overlay = join(home, 'empty.patch.yml'); writeFileSync(overlay, '[]\n');
    const child = spawn(process.execPath, [env.DSCODE_MESSAGING_RUNTIME, '--profile', 'test', '--no-open'], {
      cwd: join(home, 'workspace'), env: { ...env, DSCODE_MESSAGING_PATCH: overlay }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
    const timer = setTimeout(() => child.kill('SIGTERM'), 90000);
    const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); }).finally(() => clearTimeout(timer));
    const marker = `SESSION_${scenario.toUpperCase()}_PROBE_PASSED`;
    assert.equal(code, 0, output.replace(/token=[^\s"&]+/g, 'token=<redacted>'));
    assert(output.includes(marker), output);
    checks.push(scenario);
    console.log(output.split('\n').find(line => line.startsWith(marker)));
  }
  const receipt = { runtime: packed.runtime, surface: 'independent native Host', packageSha256: packed.sha256,
    packedComposition: true, checks, nativeCardsAndCostAttribution: true, twoHosts: true,
    durableDeferRecovery: true, nativeToolReply: true, singleDelivery: true, cancellation: true,
    nativePresetExcluded: true, childBudgetsInherited: true, disposalWithdrawsOwners: true, liveModelInference: false };
  mkdirSync(join(root, 'artifacts/local'), { recursive: true });
  writeFileSync(join(root, `artifacts/local/desktop-messaging-${packed.runtime}.json`), JSON.stringify(receipt, null, 2) + '\n');
  console.log('DESKTOP_MESSAGING_PASSED ' + JSON.stringify(receipt));
} finally {
  removeDesktopProbeHome(home);
}
