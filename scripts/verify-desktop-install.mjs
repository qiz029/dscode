// Real signed macOS carrier + native dsh plugin add/remove in a disposable home.
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { stringify } from 'yaml';
import { buildDesktopPreset, desktopPresetPackage } from './build-desktop-preset.mjs';
import { packDesktopPreset } from './pack-desktop-preset.mjs';
import { removeDesktopProbeHome, seedDesktopProviderCatalogs } from './desktop-probe-home.mjs';

if (process.platform !== 'darwin' || !process.argv[2] || !process.argv[3]) throw Error('Usage on macOS: node scripts/verify-desktop-install.mjs <Harness.app> <matching-runtime-directory> [baseline-package.tgz]');
const root = resolve(import.meta.dirname, '..'), app = resolve(process.argv[2]), runtimeDirectory = resolve(process.argv[3]);
const baselinePackagePath = process.argv[4] && resolve(process.argv[4]);
execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' });
const runtime = execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleShortVersionString', join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).trim();
assert.equal(JSON.parse(readFileSync(join(runtimeDirectory, 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version, runtime);
const home = mkdtempSync(join(tmpdir(), 'dscode-desktop-install-'));
const profile = join(home, 'profiles/desktop'), executable = join(app, 'Contents/MacOS/DeepSeek Harness');
const cli = join(app, 'Contents/Resources/runtime/cli/bin/dsh');
const env = Object.fromEntries(['PATH', 'TMPDIR', 'LANG'].filter(key => process.env[key]).map(key => [key, process.env[key]]));
Object.assign(env, { HOME: join(home, 'user'), DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents'), ZDOTDIR: home,
  DSH_TELEMETRY_DISABLED: '1', DSCODE_INSTALL_PACKAGE: desktopPresetPackage,
  DSCODE_INSTALL_LEGACY_BASELINE: '0' });
if (process.env.DSCODE_TEST_CHROME) env.DSCODE_TEST_CHROME = process.env.DSCODE_TEST_CHROME;
mkdirSync(env.HOME);
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const manifest = () => json(join(profile, 'package.json'));
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const sessionHashes = () => Object.fromEntries(readdirSync(join(home, 'sessions'), { recursive: true, withFileTypes: true })
  .filter(entry => entry.isFile() && /\.jsonl(?:\.zstd)?$/.test(entry.name))
  .map(entry => [join(entry.parentPath, entry.name), hash(join(entry.parentPath, entry.name))]));
const redact = output => output.replace(/token=[^\s"&]+/g, 'token=<redacted>');
async function command(args, succeeds = true) {
  const child = spawn(cli, ['plugin', '--profile', 'desktop', ...args], { cwd: home, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = ''; child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  let timedOut = false, escalation;
  const timer = setTimeout(() => { timedOut = true; child.kill('SIGTERM'); escalation = setTimeout(() => child.kill('SIGKILL'), 5000); }, 180000);
  const code = await new Promise((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); })
    .finally(() => { clearTimeout(timer); clearTimeout(escalation); });
  assert(!timedOut, `Bundled CLI ${args[0]} did not exit within 180 seconds:\n${redact(output)}`);
  if (succeeds) assert.equal(code, 0, redact(output));
  else { assert.notEqual(code, 0); assert.match(output, /installation rejected/); }
  return output;
}
const customCancellationPhases = [], browserStopPhases = [], browserModeSettingsPhases = [], commandInputPhases = [], browserResumePhases = [], browserStatusPhases = [];
const shellPatchPhases = [];
let legacyConfigurationBaseline = false, installedBrowserAccessVerified = false, installedBrowserTabRefreshVerified = false;
async function boot(phase, version) {
  for (const file of ['install-probe-result.json', 'install-probe-failure.txt']) rmSync(join(home, file), { force: true });
  const child = spawn(executable, ['--user-data-dir=' + join(home, 'electron-data')], { cwd: home,
    env: { ...env, DSCODE_INSTALL_PHASE: phase, DSCODE_INSTALL_VERSION: version ?? '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '', ready = false;
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { output += data; });
  const exited = new Promise((resolve, reject) => { child.once('exit', (code, signal) => resolve({ code, signal })); child.once('error', reject); });
  try {
    for (let i = 0; i < (phase === 'reinstalled' && env.DSCODE_TEST_CHROME ? 1800 : 600); i++) {
      if (existsSync(join(home, 'install-probe-failure.txt'))) throw Error(readFileSync(join(home, 'install-probe-failure.txt'), 'utf8'));
      ready = phase === 'initialize' ? output.includes('dsh web:') : existsSync(join(home, 'install-probe-result.json'));
      if (ready || child.exitCode !== null || child.signalCode !== null) break;
      await delay(100);
    }
    assert(ready, redact(output));
    if (phase !== 'initialize') {
      const result = json(join(home, 'install-probe-result.json'));
      assert.equal(result.phase, phase);
      assert.equal(result.shellPatchVerified, ['upgraded', 'rejected', 'reinstalled'].includes(phase));
      if (result.shellPatchVerified) shellPatchPhases.push(phase);
      const expectedCancellation = phase !== 'removed' && !(legacyConfigurationBaseline && phase === 'installed');
      assert.equal(result.customCancellationVerified, expectedCancellation);
      if (result.customCancellationVerified) customCancellationPhases.push(phase);
      assert.equal(result.browserStopVerified, ['upgraded', 'rejected', 'reinstalled'].includes(phase));
      if (result.browserStopVerified) browserStopPhases.push(phase);
      assert.equal(result.browserConfigurationVerified, phase !== 'removed');
      assert.equal(result.browserModeSettingsVerified, ['upgraded', 'rejected', 'reinstalled'].includes(phase));
      if (result.browserModeSettingsVerified) browserModeSettingsPhases.push(phase);
      assert.equal(result.commandInputsVerified, ['upgraded', 'rejected', 'reinstalled'].includes(phase));
      if (result.commandInputsVerified) commandInputPhases.push(phase);
      assert.equal(result.browserResumeVerified, ['upgraded', 'rejected', 'reinstalled'].includes(phase) && Boolean(env.DSCODE_TEST_CHROME));
      if (result.browserResumeVerified) browserResumePhases.push(phase);
      assert.equal(result.browserStatusVerified, ['upgraded', 'rejected', 'reinstalled'].includes(phase) && Boolean(env.DSCODE_TEST_CHROME));
      if (result.browserStatusVerified) browserStatusPhases.push(phase);
      assert.equal(result.browserTabRefreshVerified, phase === 'reinstalled' && Boolean(env.DSCODE_TEST_CHROME));
      if (result.browserTabRefreshVerified) installedBrowserTabRefreshVerified = true;
      assert.equal(result.installedBrowserAccessVerified, phase === 'reinstalled' && Boolean(env.DSCODE_TEST_CHROME));
      if (result.installedBrowserAccessVerified) installedBrowserAccessVerified = true;
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
    await exited.finally(() => clearTimeout(timer));
  }
  console.log('PASS official Desktop boot: ' + phase);
}
try {
  seedDesktopProviderCatalogs(home);
  const delegationWorkspace = join(home, 'delegation-workspace');
  mkdirSync(delegationWorkspace);
  execFileSync('git', ['init', '--quiet', delegationWorkspace], { env });
  execFileSync('git', ['-C', delegationWorkspace, '-c', 'user.name=Desktop Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'Fixture baseline'], { env });
  const staged = buildDesktopPreset(join(home, 'staged'), runtimeDirectory);
  const original = json(join(staged, 'package.json'));
  const pack = () => {
    const result = JSON.parse(execFileSync('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', home], { cwd: staged, encoding: 'utf8' }))[0];
    return join(home, result.filename);
  };
  const currentPackage = packDesktopPreset(runtimeDirectory, join(home, 'packages'));
  const initialPackage = baselinePackagePath ? json(baselinePackagePath + '.json') : currentPackage;
  const initial = baselinePackagePath ?? currentPackage.path;
  assert.equal(initialPackage.name, desktopPresetPackage);
  assert.equal(initialPackage.runtime, runtime);
  assert.equal(hash(initial), initialPackage.sha256, 'Baseline package differs from its receipt');
  const implementationEntries = ['plugins/custom/config.mjs', 'plugins/browser/config.mjs', 'plugins/browser/files.mjs',
    'plugins/computer-use/desktop-host.mjs', 'plugins/memory/index.mjs', 'plugins/dscode/index.mjs', 'vendor/bash/index.js', 'vendor/terminal/index.js',
    'plugins/code-review/index.mjs', 'plugins/session-bridge/index.mjs', 'plugins/tui-tools/index.mjs',
    'plugins/browser/index.mjs', 'plugins/browser/connection.mjs', 'plugins/browser/preview.mjs',
    'plugins/browser/mcp-entry.mjs', 'plugins/browser/screenshots.mjs', 'plugins/browser/presentation.mjs',
    'plugins/browser/desktop-host.mjs', 'plugins/browser/desktop-client.mjs', 'plugins/desktop/client.mjs',
    ...['manifest.json', 'popup.html', 'popup.css', 'popup.mjs', 'worker.mjs', 'protocol.mjs'].map(file => 'extensions/browser/' + file)];
  const baselineImplementation = Object.fromEntries(implementationEntries.map(entry => [entry,
    createHash('sha256').update(execFileSync('tar', ['-xOf', initial, 'package/' + entry])).digest('hex')]));
  const currentImplementation = Object.fromEntries(implementationEntries.map(entry => [entry, hash(join(staged, entry))]));
  const changedImplementationEntries = implementationEntries.filter(entry => baselineImplementation[entry] !== currentImplementation[entry]);
  if (baselinePackagePath) assert(changedImplementationEntries.length > 0, 'Baseline must contain an older configuration or browser implementation');
  const baselineConfigSha256 = baselineImplementation['plugins/custom/config.mjs'];
  const currentConfigSha256 = currentImplementation['plugins/custom/config.mjs'];
  legacyConfigurationBaseline = Boolean(baselinePackagePath && baselineConfigSha256 !== currentConfigSha256);
  env.DSCODE_INSTALL_LEGACY_BASELINE = legacyConfigurationBaseline ? '1' : '0';
  const assertInstalledImplementation = expected => {
    for (const [entry, digest] of Object.entries(expected)) assert.equal(hash(join(profile, 'node_modules', desktopPresetPackage, entry)), digest, `Installed ${entry} differs from its package`);
  };
  const installedBrowserVersions = {};
  const assertInstalledBrowserVersion = (phase, expected) => {
    const installedManifest = join(profile, 'node_modules', desktopPresetPackage, 'package.json');
    const actual = json(createRequire(installedManifest).resolve('chrome-devtools-mcp/package.json')).version;
    assert.equal(actual, expected, 'Installed Chrome MCP differs from the package dependency');
    installedBrowserVersions[phase] = actual;
  };
  const upgradedVersion = original.version + '-desktop-lifecycle.1';
  writeFileSync(join(staged, 'package.json'), JSON.stringify({ ...original, version: upgradedVersion }));
  const upgraded = pack();
  writeFileSync(join(staged, 'package.json'), JSON.stringify({ ...original, version: original.version + '-desktop-incompatible.1', peerDependencies: { '@deepseek-ai/dsh': '999.0.0' } }));
  const incompatible = pack();
  rmSync(staged, { recursive: true, force: true });
  // Let the official application create its own reserved profile first.
  await boot('initialize');
  const baseline = manifest().dsh.profile.bundles;
  mkdirSync(join(profile, 'scripts'), { recursive: true });
  cpSync(join(root, 'scripts/desktop-install-probe.mjs'), join(profile, 'scripts/probe.mjs'));
  cpSync(join(root, 'scripts/verify-browser-access.mjs'), join(profile, 'scripts/browser-access-probe.mjs'));
  const userPatch = stringify([{ id: 'product-analytics', config: { enabled: false } },
    { insert: [{ id: 'desktop-install-probe', name: join(profile, 'scripts/probe.mjs') }] }]);
  writeFileSync(join(profile, 'cordis.patch.yml'), userPatch);
  await command(['add', initial, '--ignore-scripts']);
  assertInstalledImplementation(baselineImplementation);
  assertInstalledBrowserVersion('installed', JSON.parse(execFileSync('tar', ['-xOf', initial, 'package/package.json'], { encoding: 'utf8' })).dependencies['chrome-devtools-mcp']);
  assert(manifest().dsh.profile.bundles.includes(desktopPresetPackage));
  assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), userPatch);
  assert(!existsSync(join(profile, 'node_modules/@deepseek-ai/dsh')), 'Plugin install created a second core runtime');
  for (const native of initialPackage.nativePackages) {
    const installed = json(join(profile, 'node_modules', desktopPresetPackage, 'node_modules', native.name, 'package.json'));
    assert.equal(installed.name, native.name); assert.equal(installed.version, native.version);
  }
  const browserLaunch = { mode: 'persistent', headless: true,
    executablePath: process.env.DSCODE_TEST_CHROME ?? join(home, 'Chrome for Testing', 'chrome'), webmcp: true, profile: 'lifecycle' };
  mkdirSync(join(home, 'browser'), { recursive: true });
  writeFileSync(join(home, 'browser/config.json'), JSON.stringify(browserLaunch, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(join(home, 'browser-install-launch.json'), JSON.stringify(browserLaunch));
  await boot('installed', initialPackage.version);
  const files = ['user/.dscode/providers.yaml', 'user/.dscode/credentials.yaml', 'browser/config.json', 'browser/permissions.json', 'browser/permissions.guard.sqlite',
    'config/desktop-scheduler.json', 'profiles/desktop/.dsh/triggers/lifecycle-scheduled.yml',
    'desktop-email/preferences.json', ...readdirSync(join(home, 'user/.dscode/email')).filter(name => name.endsWith('.json')).map(name => 'user/.dscode/email/' + name)];
  const guardPath = join(home, 'browser/permissions.guard.sqlite');
  const guardInode = statSync(guardPath).ino;
  const before = files.map(file => hash(join(home, file)));
  const patchBeforeUpgrade = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8');
  await command(['add', upgraded, '--ignore-scripts']);
  assertInstalledImplementation(currentImplementation);
  assertInstalledBrowserVersion('upgraded', original.dependencies['chrome-devtools-mcp']);
  assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), patchBeforeUpgrade);
  assert.deepEqual(files.map(file => hash(join(home, file))), before);
  await boot('upgraded', upgradedVersion);
  const beforeRejected = ['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'].map(file => hash(join(profile, file)));
  await command(['add', incompatible, '--ignore-scripts'], false);
  assertInstalledImplementation(currentImplementation);
  assertInstalledBrowserVersion('rejected', original.dependencies['chrome-devtools-mcp']);
  assert.deepEqual(['package.json', 'pnpm-lock.yaml', 'cordis.patch.yml'].map(file => hash(join(profile, file))), beforeRejected);
  await boot('rejected', upgradedVersion);
  const sessionsBeforeRemove = sessionHashes();
  assert(Object.keys(sessionsBeforeRemove).length > 0, 'Expected a real persisted session');
  // Native renderer startup can save interface preferences. Compare each CLI
  // mutation with the state immediately before that operation.
  const patchBeforeRemove = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8');
  await command(['remove', desktopPresetPackage, '--config.ignore-scripts=true']);
  assert.deepEqual(manifest().dsh.profile.bundles, baseline);
  assert(!existsSync(join(profile, 'node_modules', desktopPresetPackage)));
  assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), patchBeforeRemove);
  assert.deepEqual(files.map(file => hash(join(home, file))), before);
  assert.deepEqual(sessionHashes(), sessionsBeforeRemove);
  await boot('removed');
  const patchBeforeReinstall = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8');
  await command(['add', currentPackage.path, '--ignore-scripts']);
  assertInstalledImplementation(currentImplementation);
  assertInstalledBrowserVersion('reinstalled', original.dependencies['chrome-devtools-mcp']);
  assert.equal(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8'), patchBeforeReinstall);
  assert.deepEqual(files.map(file => hash(join(home, file))), before);
  await boot('reinstalled', original.version);
  assert.equal(statSync(guardPath).ino, guardInode, 'Installation operations replaced the shared permission guard');
  const receipt = { runtime, surface: 'official macOS Desktop and bundled CLI', nativeInstall: true, nativeUpgrade: true,
    incompatibleUpdateRejected: true, previousVersionBootsAfterRejection: true, nativeRemove: true, baseHostBootsAfterRemoval: true,
    customConfigurationPreserved: true, customModelChoicesPreserved: true, customDefaultOutputPreserved: !legacyConfigurationBaseline,
    customNumericOutputPreserved: legacyConfigurationBaseline,
    customModelRegistryRestored: true, customSettingsRpcWithdrawnOnRemove: true,
    customExplicitDiscoveryAndTestCancellation: true, customOptionalMetadataCancellation: true, customCancellationPhases,
    credentialsPreserved: true, browserPermissionsPreserved: true, browserRevocationsPreserved: true, browserGuardInodePreserved: true,
    browserColdPermissionsEnforced: true, temporaryBrowserGrantRevoked: true, browserPreviewRpcWithdrawnOnRemove: true,
    browserStopPhases, browserConfigurationPreserved: true, browserModeSettingsPhases, commandInputPhases, browserResumePhases, browserStatusPhases,
    installedBrowserTabRefreshVerified,
    installedBrowserAccessVerified, installedBrowserVersions, sessionResumedAfterUpgrade: true,
    userPatchPreserved: true, sessionFilesPreservedOnRemove: true, reinstallResumesSession: true, noSecondCoreRuntime: true,
    nativeCommunicationTools: true, namespacedDiagnostics: true, bundledGuides: true, shellPatchPhases,
    deferredMailboxPreserved: true, deferredResumeDoesNotWake: true,
    idempotencySurvivesUpgradeAndReinstall: true, singleDeliveryAfterReinstall: true, communicationWithdrawnOnRemove: true,
    providerAccountsPreserved: true, accountRpcWithdrawnOnRemove: true,
    schedulerPreferencePreserved: true, scheduledDefinitionAndJobPreserved: true,
    schedulingResumesAfterUpgradeAndReinstall: true, schedulingRpcWithdrawnOnRemove: true,
    emailInboxAndContactsPreserved: true, emailPreferencePreserved: true,
    emailAdmissionDedupAfterUpgradeAndReinstall: true, emailRpcWithdrawnOnRemove: true,
    sessionUsageAvailableAfterInstallAndResume: true, usageRpcWithdrawnOnRemove: true,
    delegationBoardPreserved: true, delegationRpcWithdrawnOnRemove: true,
    namedChildResumedAfterUpgradeAndReinstall: true, childWorktreePreserved: true,
    installedChildShellUsesPreservedWorktree: true,
    waitingQuestionSurvivesUpgrade: true, installedChildAliasReserved: true,
    bundledNativePackages: currentPackage.nativePackages,
    olderImplementationMigration: Boolean(baselinePackagePath), baselinePackageSha256: initialPackage.sha256,
    baselineConfigSha256, currentConfigSha256, changedImplementationEntries, baselineImplementation, currentImplementation,
    packageSha256: currentPackage.sha256, packageIntegrity: currentPackage.integrity, liveModelInference: false };
  mkdirSync(join(root, 'artifacts/local'), { recursive: true });
  writeFileSync(join(root, 'artifacts/local', baselinePackagePath ? 'desktop-install-migration.json' : 'desktop-install.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log('DESKTOP_INSTALL_PASSED ' + JSON.stringify(receipt));
} finally {
  removeDesktopProbeHome(home);
}
