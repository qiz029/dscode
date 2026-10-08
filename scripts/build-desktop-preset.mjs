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

const root = resolve(import.meta.dirname, '..');
export const desktopPresetPackage = '@toddzheng024/dscode-desktop-preset-probe';
const modulesToStage = [
  ['dsh-tool-bash', 'bash', patchBash], ['dsh-tool-bash-persistent', 'persistent', patchPersistent],
  ['dsh-terminal-bash', 'terminal', patchTerminalBash], ['dsh-tool-subagent', 'subagent', patchSubagent],
  ['dsh-subagent', 'subagent-core', patchSubagentCore], ['dsh-subagent-in-process-driver', 'subagent-driver', patchSubagentDriver],
  ['dsh-subagent-spawn-in-process', 'subagent-spawn'], ['dsh-subagent-fork-in-process', 'subagent-fork'],
  ['dsh-command-goal', 'command-goal', patchGoalCommand],
];

export function buildDesktopPreset(destination, runtimeDirectory) {
  const modules = join(resolve(runtimeDirectory), 'node_modules');
  const runtime = JSON.parse(readFileSync(join(modules, '@deepseek-ai/dsh/package.json'), 'utf8')).version;
  if (!['0.2.0-rc.2', '0.2.1-alpha.1'].includes(runtime)) throw Error(`Unsupported Desktop preset runtime: ${runtime}`);
  const name = desktopPresetPackage;
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
    ['custom', 'browser', 'providers', 'triggers', 'email', 'session-metrics', 'dscode'].map(plugin => readFileSync(join(root, 'plugins', plugin, 'desktop-client.mjs'), 'utf8'))));
  cpSync(join(root, 'packages/LICENSE'), join(destination, 'LICENSE'));
  const exports = { './package.json': './package.json', './cordis.patch.yml': './cordis.patch.yml',
    '.': './plugins/desktop/index.mjs', './client': './plugins/desktop/client.mjs',
    './browser': './plugins/browser/index.mjs', './auto-review': './plugins/auto-review/index.mjs',
    './policy': './plugins/dscode/index.mjs', './control': './plugins/dscode/control.mjs', './compaction': './plugins/compaction/engine.mjs', './code-review': './plugins/code-review/index.mjs', './workspace': './plugins/desktop-workspace/index.mjs',
    './credentials': './plugins/credentials/index.mjs', './custom': './plugins/custom/index.mjs',
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
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  writeFileSync(join(destination, 'package.json'), JSON.stringify({ name, version, private: true, type: 'module', license: 'MIT', exports,
    files: ['plugins', 'bin', 'docs', 'extensions', 'vendor', 'cordis.patch.yml', 'runtime-sources.json', 'THIRD_PARTY_NOTICES.md', 'README.md', 'LICENSE'],
    // Script guardians are separate Node processes and do not inherit the
    // Desktop Host's runtime resolver. Declare their direct imports explicitly.
    dependencies: { ...browserDependencies, imapflow: '2.0.5', mailparser: '3.9.28', nodemailer: '10.0.10', 'cron-parser': '5.7.0', yaml: '2.9.1', zod: '4.6.5', [desktopSystemAddon]: desktopSystemAddonVersion },
    bundledDependencies: [desktopSystemAddon],
    peerDependencies: { '@deepseek-ai/dsh': runtime }, dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', inject: ['@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-client-ui-sidebar-right'] } },
  }, null, 2) + '\n');
  writeFileSync(join(destination, 'runtime-sources.json'), JSON.stringify({ runtime, sources, nativePackages, computerUse }, null, 2) + '\n');
  notices.push(`${computerUse.package}@${computerUse.version}: MIT. https://github.com/Anionex/dsh-computer-use. Vendored runtime and unmodified universal macOS helper; license included. Local change: screenshot handoff uses the Host read_image tool. Desktop configuration, skill and progressive exposure are DSCODE adapters.\n`);
  notices.push(`Bundled ${desktopSystemAddon}@${desktopSystemAddonVersion} and its darwin/linux arm64/x64 prebuilds: BSD-3-Clause. Unmodified archives verified against package-lock.json; original licenses are included in each bundled package.\n`);
  writeFileSync(join(destination, 'THIRD_PARTY_NOTICES.md'), notices.join('\n'));
  writeFileSync(join(destination, 'README.md'), `# DSCODE Desktop preset migration fixture\n\nPrivate, unpublished qualification package for DSH ${runtime}. It stages the full DSCODE agent composition and patched shell/subagent providers against that runtime. Instructions, ancestor skills and hooks are initialized per Agent workspace and disposed with that Agent. Custom model routes and shared credentials use the production DSCODE plugins. Settings > DSCODE models adds provider editing, discovery, text/tool probes and explicit image capability. Namespaced /dscode-status, /dscode-doctor, /dscode-skills and /dscode-mcp commands provide diagnostics without replacing native commands. Doctor session traces stay in the selected workspace; warning/error logs describe the shared Host. Email inbox in the right sidebar browses the shared local inbox and explicitly adds a selected revision as external session context. It supports IMAP and Gmail OAuth setup, manual sync and opt-in background sync. Only DSCODE agents receive email sender and contact tools; sending retains the existing approval and durable receipt policy. Read docs/email.md. Session usage in the right sidebar shows recorded cost, per-turn estimates, context, cache, request speed and cached account figures for the selected DSCODE session. Read docs/session-metrics.md. Delegation board in the right sidebar reads the selected main session’s live task board, dependencies, waiting state, worktrees and verification evidence without dispatching work. Read docs/tui-commands.md. Current usage guides ship under docs; links to developer records open the source repository, whose published records may lag this unpublished package. Session cards, cost attribution and the durable session mailbox use the production DSCODE services. Durable time context records admitted inbox arrivals, relay waits and previous turn endings for DSCODE agents. Normal chat hides these marks; Trajectory exposes them. Resume and plugin reload recover bounded unreported endings. Read docs/session-communication.md for limits. Cross-session memory reuses the production evidence store and background pipeline, with prompt and retrieval scoped to DSCODE agents; native Standard sessions cannot change it through /memories. Global and session switches survive restart. Unload cancels generation and removes live registrations while retaining local files. Read docs/memory.md for sharing and cleanup behavior. The same package includes browser tools, site permissions, review policy, the extension files and Browser preview. Settings > DSCODE accounts manages the shared OpenRouter key, reads the Grok CLI login and controls OpenCode Go sign-in. DSCODE OpenRouter and DSCODE OpenCode Go use separate route IDs so native providers remain available. Settings > DSCODE schedules manages workspace-bound tasks and opt-in delivery. The saved launch preference resumes delivery only after Host initialization; stop disables resume and drains active runs and script sources. The seven UI components share one native client registration. The file-lock library and all darwin/linux arm64/x64 native prebuilds are bundled at lockfile-verified versions; the first build downloads these archives and later builds use a verified local cache. Ordinary permission modes remain available and the Host default is preserved; auto-review is an explicit selection. Build-time transforms operate only on copied modules.\n\nThis is not the complete DSCODE Host bundle; terminal UI is not supplied. The experimental native Computer Use adapter vendors the pinned 0.3.3 macOS helper with its license and integrity manifest, uses Host configuration and scoped progressive tools, and hands screenshots to read_image. It requires macOS 14 or later and separate OS/app permissions. Helper initialization, app discovery, denied app access, skill activation, resume and unload/reload were qualified; window observation, screenshots and input remain unqualified because the test helper lacks Accessibility permission. Read docs/computer-use.md for configuration and limits. Scheduling requires the application to stay open. Read docs/triggers.md for its restart, removal and permission behavior. Build a local tarball with scripts/pack-desktop-preset.mjs and follow docs/browser-use.md for installation through the official Desktop bundled CLI. Use scripts/verify-desktop-preset.mjs and scripts/verify-desktop-messaging.mjs and scripts/verify-desktop-providers.mjs plus scripts/verify-desktop-scheduler.mjs --management and scripts/verify-desktop-memory.mjs and scripts/verify-desktop-computer-use.mjs and scripts/verify-desktop-time-marks.mjs and scripts/verify-desktop-diagnostics.mjs and scripts/verify-desktop-email.mjs and scripts/verify-desktop-metrics.mjs and scripts/verify-desktop-delegation.mjs from the source checkout for isolated execution probes.\n`);
  return destination;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw Error('Usage: node scripts/build-desktop-preset.mjs <runtime-directory>');
  console.log(buildDesktopPreset(join(root, 'artifacts/desktop/preset'), process.argv[2]));
}
