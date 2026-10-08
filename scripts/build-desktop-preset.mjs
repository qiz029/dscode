// Migration fixture: stage the complete agent composition against a new Host.
// This is not the complete DSCODE Host bundle or an installation command.
import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { createHash } from 'node:crypto';
import { presetDeclaration } from './preset.mjs';
import { replaceOnce } from './patch-util.mjs';
import { patchBash, patchPersistent, patchTerminalBash, patchSubagent, patchSubagentCore, patchSubagentDriver, patchGoalCommand } from './patch-runtime.mjs';
import { composeDesktopClient } from './compose-desktop-client.mjs';
import { browserDependencies } from './build-browser-desktop.mjs';
import { bundleDesktopSystemAddon, desktopSystemAddon, desktopSystemAddonVersion } from './desktop-native-bundle.mjs';
import { bundleDesktopComputerUse } from './desktop-computer-use-bundle.mjs';
import { bundleDesktopDocs } from './desktop-docs.mjs';
import { desktopPackageMetadata, desktopPresetPackage, desktopHubListing } from './desktop-package.mjs';

const root = resolve(import.meta.dirname, '..');
export { desktopPresetPackage };
export const desktopDependencies = { ...browserDependencies, '@dsh-plugin-hub/schemas': '0.5.0', semver: '7.8.5', imapflow: '2.0.5', mailparser: '3.9.28', nodemailer: '10.0.10', 'cron-parser': '5.7.0', yaml: '2.9.1', zod: '4.6.5', [desktopSystemAddon]: desktopSystemAddonVersion };
const modulesToStage = [
  ['dsh-tool-bash', 'bash', patchBash], ['dsh-tool-bash-persistent', 'persistent', patchPersistent],
  ['dsh-terminal-bash', 'terminal', patchTerminalBash], ['dsh-tool-subagent', 'subagent', patchSubagent],
  ['dsh-subagent', 'subagent-core', patchSubagentCore], ['dsh-subagent-in-process-driver', 'subagent-driver', patchSubagentDriver],
  ['dsh-subagent-spawn-in-process', 'subagent-spawn'], ['dsh-subagent-fork-in-process', 'subagent-fork'],
  ['dsh-command-goal', 'command-goal', patchGoalCommand],
];

export function buildDesktopPreset(destination, runtimeDirectory, options = {}) {
  const modules = join(resolve(runtimeDirectory), 'node_modules');
  const runtime = JSON.parse(readFileSync(join(modules, '@deepseek-ai/dsh/package.json'), 'utf8')).version;
  if (!['0.2.0-rc.2', '0.2.1-alpha.1'].includes(runtime)) throw Error(`Unsupported Desktop preset runtime: ${runtime}`);
  const name = desktopPresetPackage;
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const metadata = desktopPackageMetadata(version, runtime, options);
  mkdirSync(destination, { recursive: true });
  const nativePackages = bundleDesktopSystemAddon(destination);
  cpSync(join(root, 'plugins'), join(destination, 'plugins'), { recursive: true });
  mkdirSync(join(destination, 'bin'), { recursive: true });
  cpSync(join(root, 'bin/apply_patch'), join(destination, 'bin/apply_patch'));
  // Agent-facing instructions resolve the matching local guides when present.
  bundleDesktopDocs(root, destination);
  const computerUse = bundleDesktopComputerUse(destination);
  cpSync(join(root, 'extensions/browser'), join(destination, 'extensions/browser'), { recursive: true });
  writeFileSync(join(destination, 'plugins/desktop/client.mjs'), composeDesktopClient(name,
    ['custom', 'browser', 'providers', 'triggers', 'email', 'session-metrics', 'dscode', 'hub'].map(plugin => readFileSync(join(root, 'plugins', plugin, 'desktop-client.mjs'), 'utf8'))));
  cpSync(join(root, 'packages/LICENSE'), join(destination, 'LICENSE'));
  cpSync(join(root, 'assets/desktop-icon.svg'), join(destination, 'icon.svg'));
  cpSync(join(root, 'packages/desktop/locale'), join(destination, 'locale'), { recursive: true });
  const exports = { './package.json': './package.json', './cordis.patch.yml': './cordis.patch.yml',
    '.': './plugins/desktop/index.mjs', './client': './plugins/desktop/client.mjs',
    './browser': './plugins/browser/index.mjs', './auto-review': './plugins/auto-review/index.mjs',
    './policy': './plugins/dscode/index.mjs', './control': './plugins/dscode/control.mjs', './compaction': './plugins/compaction/engine.mjs', './code-review': './plugins/code-review/index.mjs', './workspace': './plugins/desktop-workspace/index.mjs',
    './credentials': './plugins/credentials/index.mjs', './custom': './plugins/custom/index.mjs', './hub': './plugins/hub/desktop-host.mjs',
    './openrouter': './plugins/openrouter/index.mjs', './grok': './plugins/grok/index.mjs', './opencode-go': './plugins/opencode-go/index.mjs', './jev': './plugins/jev/index.mjs',
    './session-metrics': './plugins/session-metrics/index.mjs', './session-cards': './plugins/session-cards/index.mjs', './session-bridge': './plugins/session-bridge/index.mjs', './triggers': './plugins/triggers/desktop-host.mjs',
    './email': './plugins/email/desktop-host.mjs', './memory': './plugins/memory/desktop-host.mjs', './computer-use': './plugins/computer-use/desktop-host.mjs',
    './time-marks': './plugins/time-marks/desktop-host.mjs', './diagnostics': './plugins/tui-tools/desktop-host.mjs', './metrics-ui': './plugins/session-metrics/desktop-host.mjs', './delegation-ui': './plugins/dscode/desktop-host.mjs' };
  const sources = [], notices = [];
  for (const [pkg, key, patch] of modulesToStage) {
    const source = join(modules, '@deepseek-ai', pkg);
    const meta = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    if (meta.version !== runtime) throw Error(`Mixed runtime: ${pkg}@${meta.version}, expected ${runtime}`);
    const target = join(destination, 'vendor', key);
    cpSync(join(source, 'lib'), target, { recursive: true });
    const before = readFileSync(join(target, 'index.js'), 'utf8');
    let adapted = patch ? patch(before) : before;
    if (key === 'terminal' || key === 'bash') {
      const anchor = key === 'terminal' ? 'const common = {' : 'const request = {';
      const property = key === 'terminal' ? '...desktopShellEnvironment(),' : 'env: desktopShellEnvironment(),';
      adapted = `import { desktopShellEnvironment } from '../../plugins/desktop/shell-environment.mjs';\n` +
        replaceOnce(adapted, anchor, `${anchor}\n${property}`);
    }
    writeFileSync(join(target, 'index.js'), adapted);
    exports[`./${key}`] = `./vendor/${key}/index.js`;
    sources.push({ package: meta.name, version: meta.version, entrySha256: createHash('sha256').update(before).digest('hex') });
    notices.push(`${meta.name}@${meta.version}: ${meta.license}. ${JSON.stringify(meta.repository)}\nLocal changes: DSCODE shell capture/reset, named fallback shell, child names/effort/worktrees and goal round caps.\n`);
    const license = readdirSync(source).find(file => /^licen[cs]e(?:\.|$)/i.test(file));
    if (license) cpSync(join(source, license), join(target, 'LICENSE'));
  }
  for (const [file, from, to] of [
    ['subagent', '../../../../plugins/worktree-subagent/worktree.mjs', '../../plugins/worktree-subagent/worktree.mjs'],
    ['subagent', 'from "@deepseek-ai/dsh-subagent"', 'from "../subagent-core/index.js"'],
    ['subagent-driver', 'from "@deepseek-ai/dsh-subagent"', 'from "../subagent-core/index.js"'],
    ['subagent-spawn', 'from "@deepseek-ai/dsh-subagent-in-process-driver"', 'from "../subagent-driver/index.js"'],
    ['subagent-fork', 'from "@deepseek-ai/dsh-subagent-in-process-driver"', 'from "../subagent-driver/index.js"'],
  ]) {
    const path = join(destination, 'vendor', file, 'index.js');
    writeFileSync(path, replaceOnce(readFileSync(path, 'utf8'), from, to));
  }
  let preset = readFileSync(join(root, 'presets/dscode/agent.cordis.yml'), 'utf8');
  for (const [from, to] of [
    ["'@deepseek-ai/dsh-tool-bash'", `'${name}/bash'`],
    ["'@deepseek-ai/dsh-tool-bash-persistent'", `'${name}/persistent'`],
    ["'@deepseek-ai/dsh-terminal-bash'", `'${name}/terminal'`],
    ["'@deepseek-ai/dsh-tool-subagent'", `'${name}/subagent'`],
    ["'@deepseek-ai/dsh-command-goal'", `'${name}/command-goal'`],
    ['DSCODE_POLICY_PLUGIN', `'${name}/policy'`], ['DSCODE_COMPACTION_PLUGIN', `'${name}/compaction'`], ['DSCODE_REVIEW_PLUGIN', `'${name}/code-review'`],
    ['DSCODE_CONTROL_PLUGIN', `'${name}/control'`],
  ]) preset = preset.replaceAll(from, to);
  preset = replaceOnce(preset, `      name: '${name}/policy'`, `      name: '${name}/policy'\n      config: { desktop: true }`);
  // Desktop can hold unrelated workspaces at once. Agent creation mounts these
  // providers with session-owned paths instead of process-global launcher data.
  for (const id of ['agent-instructions', 'skill-filesystem']) {
    preset = replaceOnce(preset, `\n- id: ${id}\n`, `\n- id: ${id}\n  disabled: true\n`);
  }
  const providers = [['subagent', 'subagent-core'], ['subagent-spawn-in-process', 'subagent-spawn', 'spawn'], ['subagent-fork-in-process', 'subagent-fork', 'fork']];
  const permissionPresets = parse(readFileSync(join(root, 'config/auto-review.patch.yml'), 'utf8'))[0].config.presets;
  // Native inference chooses the first matching sandbox/approval pair. Keep
  // ordinary modes ahead of aliases that intentionally use the same pair.
  const desktopPermissions = Object.fromEntries(['read-only', 'workspace-write', 'danger-full-access', 'auto-review', 'ask'].map(id => [id, permissionPresets[id]]));
  const patch = stringify([
    { id: 'credentials', disabled: true },
    // The patcher replaces this map as a whole. Carry the ordinary presets too,
    // and leave defaultPreset alone so loading the bundle does not change it.
    { id: 'permission', config: { presets: desktopPermissions } },
    ...providers.map(([id]) => ({ id, disabled: true })),
    { insert: providers.map(([id, key, providerName]) => ({ id: `dscode-${id}`, name: `${name}/${key}`, ...(providerName ? { config: { providerName } } : {}) })) },
    { insert: [{ id: 'dscode-credentials', name: `${name}/credentials` }, { id: 'dscode-desktop-workspace', name: `${name}/workspace` },
      { id: 'dscode-custom', name: `${name}/custom` }, { id: 'dscode-desktop', name },
      { id: 'dscode-hub', name: `${name}/hub` },
      { id: 'dscode-openrouter', name: `${name}/openrouter`, config: { providerName: 'dscode-openrouter' } },
      { id: 'dscode-grok', name: `${name}/grok` }, { id: 'dscode-opencode-go', name: `${name}/opencode-go`, config: { providerName: 'dscode-opencode-go' } },
      { id: 'dscode-jev', name: `${name}/jev` },
      { id: 'dscode-session-metrics', name: `${name}/session-metrics` }, { id: 'dscode-session-cards', name: `${name}/session-cards` },
      { id: 'dscode-desktop-metrics', name: `${name}/metrics-ui` },
      { id: 'dscode-desktop-delegation', name: `${name}/delegation-ui` },
      { id: 'dscode-session-bridge', name: `${name}/session-bridge` },
      { id: 'dscode-memory', name: `${name}/memory` },
      { id: 'dscode-email', name: `${name}/email` },
      { id: 'dscode-time-marks', name: `${name}/time-marks` },
      { id: 'dscode-desktop-diagnostics', name: `${name}/diagnostics` },
      { id: 'dscode-desktop-computer-use', name: `${name}/computer-use`, config: { observationTtlMs: 30000, allowAllApps: false,
        interaction: { focusPolicy: 'preserve', keyboardPolicy: 'preserve', pointerInputPolicy: 'targeted', cursorVisualization: 'visible' } } },
      { id: 'dscode-desktop-triggers', name: `${name}/triggers` },
      { id: 'dscode-browser', name: `${name}/browser` }, { id: 'dscode-auto-review', name: `${name}/auto-review` }] },
  ]) + '\n' + presetDeclaration(root, preset);
  writeFileSync(join(destination, 'cordis.patch.yml'), patch);
  writeFileSync(join(destination, 'package.json'), JSON.stringify({ ...metadata, exports: { ...exports, './icon': './icon.svg', './locale/*': './locale/*' },
    files: ['plugins', 'bin', 'docs', 'extensions', 'vendor', 'locale', 'icon.svg', 'cordis.patch.yml', 'runtime-sources.json', 'THIRD_PARTY_NOTICES.md', 'README.md', 'LICENSE'],
    // Script guardians are separate Node processes and do not inherit the
    // Desktop Host's runtime resolver. Declare their direct imports explicitly.
    dependencies: desktopDependencies,
    bundledDependencies: [desktopSystemAddon],
    peerDependencies: { '@deepseek-ai/dsh': runtime }, dsh: { bundle: { patch: './cordis.patch.yml' }, hub: desktopHubListing(runtime), client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-client-ui-sidebar-right'] } },
  }, null, 2) + '\n');
  writeFileSync(join(destination, 'runtime-sources.json'), JSON.stringify({ runtime, sources, nativePackages, computerUse }, null, 2) + '\n');
  notices.push(`${computerUse.package}@${computerUse.version}: MIT. https://github.com/Anionex/dsh-computer-use. Vendored runtime and unmodified universal macOS helper; license included. Local change: screenshot handoff uses the Host read_image tool. Desktop configuration, skill and progressive exposure are DSCODE adapters.\n`);
  notices.push(`Bundled ${desktopSystemAddon}@${desktopSystemAddonVersion} and its darwin/linux arm64/x64 prebuilds: BSD-3-Clause. Unmodified archives verified against package-lock.json; original licenses are included in each bundled package.\n`);
  writeFileSync(join(destination, 'THIRD_PARTY_NOTICES.md'), notices.join('\n'));
  const readme = readFileSync(join(root, 'packages/desktop/README.md'), 'utf8')
    .replaceAll('{{VERSION}}', version).replaceAll('{{RUNTIME}}', runtime)
    .replaceAll('{{BUILD_KIND}}', metadata.private ? 'Local candidate; not published.' : 'Preview release candidate; publication is a separate step.');
  writeFileSync(join(destination, 'README.md'), readme);
  return destination;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw Error('Usage: node scripts/build-desktop-preset.mjs <runtime-directory>');
  console.log(buildDesktopPreset(join(root, 'artifacts/desktop/preset'), process.argv[2]));
}
