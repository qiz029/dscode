import { composePlugins } from './composition.mjs';
import { cpSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { replaceOnce } from './patch-util.mjs';
import { patchRuntime } from './patch-runtime.mjs';
import { buildTui } from './build-tui.mjs';
const root = resolve(import.meta.dirname, '..');
const read = path => readFileSync(join(root, path), 'utf8');
const original = JSON.parse(read('package.json'));
const lock = JSON.parse(read('package-lock.json'));
const version = original.version;
const name = '@toddzheng024/dscode-bundle';
const out = join(root, 'artifacts/npm');
mkdirSync(out, { recursive: true });
const write = (dir, path, data) => writeFileSync(join(dir, path), typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
const copy = (src, dest) => cpSync(join(root, src), dest, { recursive: true });
// Pin the full shared DSH graph explicitly: dependency overrides are ignored when
// a package is installed below another root. Ordinary external dependencies use
// the versions verified in the development lock, without carrying local paths.
const dependencies = {};
for (const [path, pkg] of Object.entries(lock.packages)) {
  if (path.startsWith('node_modules/@deepseek-ai/') && !path.slice(13).includes('/node_modules/') && !pkg.os && !pkg.cpu) dependencies[path.slice(13)] = pkg.version;
}
for (const [pkg] of Object.entries(original.dependencies)) dependencies[pkg] = lock.packages['node_modules/' + pkg].version;
for (const pkg of ['commander', 'eventsource-parser']) dependencies[pkg] = lock.packages['node_modules/' + pkg].version;
const bundle = join(out, 'bundle');
rmSync(bundle, { recursive: true, force: true }); mkdirSync(bundle);
copy('packages/bundle/bootstrap.mjs', join(bundle, 'bootstrap.mjs'));
for (const dir of ['plugins', 'presets', 'bin']) copy(dir, join(bundle, dir));
rmSync(join(bundle, 'bin/dscode.mjs')); // only launcher owns the global dscode bin
mkdirSync(join(bundle, 'vendor'));
// Patch only our staging copies, never the developer or recipient install.
const stage = join(out, '.vendor-stage');
rmSync(stage, { recursive: true, force: true }); mkdirSync(join(stage, 'node_modules'), { recursive: true });
for (const pkg of ['@deepseek-ai/dsh-tool-subagent', '@deepseek-ai/dsh-subagent', '@deepseek-ai/dsh-subagent-in-process-driver', '@deepseek-ai/dsh-subagent-spawn-in-process', '@deepseek-ai/dsh-subagent-fork-in-process', '@deepseek-ai/dsh-llm-deepseek', '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-bash-persistent', '@deepseek-ai/dsh-terminal-bash', '@deepseek-ai/dsh-compaction-basic']) {
  copy('node_modules/' + pkg, join(stage, 'node_modules', pkg));
}
patchRuntime(stage, { requireMacStdin: false });
const notices = [];
for (const [pkg, dest] of [['@deepseek-ai/dsh-tool-subagent','subagent'], ['@deepseek-ai/dsh-subagent','subagent-core'], ['@deepseek-ai/dsh-subagent-in-process-driver','subagent-driver'], ['@deepseek-ai/dsh-subagent-spawn-in-process','subagent-spawn'], ['@deepseek-ai/dsh-subagent-fork-in-process','subagent-fork'], ['@deepseek-ai/dsh-llm-deepseek','deepseek'], ['@deepseek-ai/dsh-tool-bash','bash'], ['@deepseek-ai/dsh-tool-bash-persistent','persistent'], ['@deepseek-ai/dsh-terminal-bash','terminal'], ['@deepseek-ai/dsh-compaction-basic','compaction-basic']]) {
  const src = join(stage, 'node_modules', pkg);
  cpSync(join(src, 'lib'), join(bundle, 'vendor', dest), { recursive: true });
  const meta = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
  notices.push(`${pkg}@${meta.version}: ${meta.license}; ${JSON.stringify(meta.repository)}\nLocal changes: DSCODE effort, shell control, TUI commands and footer.\n`);
  const license = readdirSync(src).find(f => /^licen[cs]e(?:\.|$)/i.test(f));
  if (license) cpSync(join(src, license), join(bundle, 'vendor', dest, 'LICENSE'));
}
// The vendored terminal ships compiled: an installed package lives under node_modules,
// where Node refuses to strip types, so packages/tui/lib is what gets loaded. The source
// tree keeps relative "../../../plugins/..." imports, which resolve identically here
// because vendor/tui mirrors packages/tui one level down.
buildTui();
// Keep the source tree's depth: lib/ sits one level under the package, so the compiled
// '../../../plugins/...' imports resolve to the bundle root exactly as they do in the repo.
cpSync(join(root, 'packages/tui/lib'), join(bundle, 'vendor/tui/lib'), { recursive: true });
const tuiMeta = JSON.parse(readFileSync(join(root, 'packages/tui/package.json'), 'utf8'));
notices.push(`dsh-code (DSCODE vendored terminal, forked from dsh-code@${tuiMeta.version.split('-')[0]}): ${tuiMeta.license}; https://github.com/unlinearity/dsh-code\nLocal changes: DSCODE UI (welcome header, activity line, footer telemetry, effort bar), commands, panels and paste handling.\n`);
for (const [file, from, to] of [
  ['compaction-basic/index.js', '../../../../plugins/compaction/threshold.mjs', '../../plugins/compaction/threshold.mjs'],
  ['subagent/index.js', '../../../../plugins/worktree-subagent/worktree.mjs', '../../plugins/worktree-subagent/worktree.mjs'],
  ['subagent/index.js', 'from "@deepseek-ai/dsh-subagent"', 'from "../subagent-core/index.js"'],
  ['subagent-driver/index.js', 'from "@deepseek-ai/dsh-subagent"', 'from "../subagent-core/index.js"'],
  ['subagent-spawn/index.js', 'from "@deepseek-ai/dsh-subagent-in-process-driver"', 'from "../subagent-driver/index.js"'],
  ['subagent-fork/index.js', 'from "@deepseek-ai/dsh-subagent-in-process-driver"', 'from "../subagent-driver/index.js"'],
]) {
  const filePath = join(bundle, 'vendor', file);
  writeFileSync(filePath, replaceOnce(readFileSync(filePath, 'utf8'), from, to));
}
rmSync(stage, { recursive: true, force: true });
let preset = read('presets/dscode/agent.cordis.yml').replaceAll("'@deepseek-ai/dsh-tool-subagent'", `'${name}/subagent'`).replace('DSCODE_POLICY_PLUGIN', `'${name}/policy'`).replace('DSCODE_REVIEW_PLUGIN', `'${name}/code-review'`).replaceAll("'@deepseek-ai/dsh-tool-bash'", `'${name}/bash'`).replaceAll("'@deepseek-ai/dsh-tool-bash-persistent'", `'${name}/persistent'`).replaceAll("'@deepseek-ai/dsh-terminal-bash'", `'${name}/terminal'`).replaceAll("'@deepseek-ai/dsh-compaction-basic'", `'${name}/compaction-basic'`);
preset = replaceOnce(preset,
  "  name: '@deepseek-ai/dsh-mcp-client'\n  config:\n    serverName: chrome",
  "  name: '@deepseek-ai/dsh-mcp-client'\n  inject: [dscodePaths]\n  config:\n    serverName: chrome");
preset = replaceOnce(preset,
  `command: !!js "process.env.DSH_TUI_CHROME_ENTRY ? process.execPath : 'npx'"`,
  'command: !!js process.execPath');
preset = replaceOnce(preset,
  `args: !!js "[...(process.env.DSH_TUI_CHROME_ENTRY ? [process.env.DSH_TUI_CHROME_ENTRY] : ['--yes', 'chrome-devtools-mcp@1.9.0']), '--isolated', '--no-usage-statistics', '--no-performance-crux']"`,
  `args: !!js "[ctx.dscodePaths.chrome, '--isolated', '--no-usage-statistics', '--no-performance-crux']"`);
write(bundle, 'presets/dscode/agent.cordis.yml', preset);
let patch = read('node_modules/@deepseek-ai/dsh-base/cordis.patch.yml') + '\n' + read('node_modules/@anionex/dsh-computer-use/cordis.patch.yml') + '\n' + read('node_modules/dsh-code/cordis.patch.yml').replaceAll("'dsh-code/startup'", `'${name}/startup'`).replaceAll("'dsh-code/session-query'", `'${name}/session-query'`).replaceAll("'dsh-code'", `'${name}/tui'`);
for (const [upstream, replacement] of [
  ['@deepseek-ai/dsh-subagent', 'subagent-core'],
  ['@deepseek-ai/dsh-subagent-spawn-in-process', 'subagent-spawn'],
  ['@deepseek-ai/dsh-subagent-fork-in-process', 'subagent-fork'],
]) patch = patch.replaceAll(`name: '${upstream}'`, `name: '${name}/${replacement}'`);
patch += '\n' + read('config/cordis.patch.yml') + '\n' + read('config/auto-review.patch.yml');
patch += '\n' + composePlugins({ bundle: name });
// Hub can compose the bundle repeatedly; the inserted provider must already
// use its final name so the next pass does not conflict with the override.
patch = replaceOnce(patch, "name: '@deepseek-ai/dsh-credentials-local'", `name: '${name}/credentials'`);
patch += `
- id: llm-deepseek
  disabled: true
- insert:
    - id: dscode-deepseek
      name: '${name}/deepseek'
    - id: dscode-bootstrap
      name: '${name}/bootstrap'
`;
write(bundle, 'cordis.patch.yml', patch);
const exports = { './email-tools':'./plugins/email-tools/index.mjs', './imap':'./plugins/email/imap.mjs', './gmail':'./plugins/email/gmail.mjs', './email':'./plugins/email/inbox.mjs', './package.json':'./package.json', './cordis.patch.yml':'./cordis.patch.yml', './credentials':'./plugins/credentials/index.mjs', './memory':'./plugins/memory/index.mjs', './session-bridge':'./plugins/session-bridge/index.mjs', './session-cards':'./plugins/session-cards/index.mjs' };
for (const [key, file] of Object.entries({subagent:'vendor/subagent/index.js','subagent-core':'vendor/subagent-core/index.js','subagent-driver':'vendor/subagent-driver/index.js','subagent-spawn':'vendor/subagent-spawn/index.js','subagent-fork':'vendor/subagent-fork/index.js',bootstrap:'bootstrap.mjs',tui:'vendor/tui/lib/index.mjs',startup:'vendor/tui/lib/startup.mjs','session-query':'vendor/tui/lib/session-query.mjs','invariant':'vendor/tui/lib/invariant.mjs',deepseek:'vendor/deepseek/index.js',bash:'vendor/bash/index.js',persistent:'vendor/persistent/index.js',terminal:'vendor/terminal/index.js','compaction-basic':'vendor/compaction-basic/index.js',policy:'plugins/dscode/index.mjs','code-review':'plugins/code-review/index.mjs','auto-review':'plugins/auto-review/index.mjs','session-metrics':'plugins/session-metrics/index.mjs',openrouter:'plugins/openrouter/index.mjs',grok:'plugins/grok/index.mjs','tui-tools':'plugins/tui-tools/index.mjs'})) exports['./'+key] = './'+file;
const shared = { version, type:'module', license:'MIT', author:'Todd Zheng', engines:original.engines, publishConfig:{access:'public'}, repository: process.env.DSCODE_REPOSITORY ? {type:'git',url:process.env.DSCODE_REPOSITORY} : original.repository };
write(bundle, 'package.json', { ...shared, name, description:'DSCODE coding harness: minimal persistent shell, Ultra subagents, auto review, Chrome, computer use and session telemetry.', files:['bootstrap.mjs','cordis.patch.yml','plugins','presets','bin','vendor','THIRD_PARTY_NOTICES.md'], exports, dependencies, dsh:{bundle:{patch:'./cordis.patch.yml'},hub:{schemaVersion:1,displayName:'DSCODE',summary:'A complete DeepSeek coding agent with persistent shell, Ultra collaboration and automatic permission review.',description:'macOS coding TUI with Chrome MCP, Computer Use, skills, compaction, goals, hooks and session telemetry. Requires the DSCODE profile and its pinned DSH runtime.',categories:['community'],keywords:['coding','tui','deepseek-harness'],compatibility:{dsh:dependencies['@deepseek-ai/dsh'],node:original.engines.node,platforms:['darwin'],surfaces:['headless'],hmr:'restart'},entryIds:['dscode-bootstrap'],before:[],after:[],channel:'stable'}} });
write(bundle, 'THIRD_PARTY_NOTICES.md', notices.join('\n'));
write(bundle, 'README.md', '# DSCODE bundle\n\nInstall through the DSCODE Hub preset, or use `npm install -g @toddzheng024/dscode` then `dscode`.\n\nRequires DSH ' + dependencies['@deepseek-ai/dsh'] + ', macOS 14+, Node 22.19+ or 24+, and Chrome. Includes modified upstream modules; see THIRD_PARTY_NOTICES.md. No install-time patches or scripts.\n');
const launcher = join(out, 'launcher');
rmSync(launcher, { recursive:true, force:true }); mkdirSync(launcher);
copy('packages/launcher', launcher);
copy('plugins/email', join(launcher, 'email'));
mkdirSync(join(launcher, 'session-bridge'), { recursive: true });
for (const file of ['client.mjs', 'paths.mjs']) copy('plugins/session-bridge/' + file, join(launcher, 'session-bridge', file));
mkdirSync(join(launcher, 'exec'), { recursive: true });
copy('plugins/exec/cli.mjs', join(launcher, 'exec', 'cli.mjs'));
write(launcher, 'cli.mjs', read('packages/launcher/cli.mjs').replace('../../plugins/session-bridge/client.mjs', './session-bridge/client.mjs').replace('../../plugins/email/cli.mjs', './email/cli.mjs'));
write(launcher, 'package.json', { ...shared, name:'@toddzheng024/dscode', description:'One-command launcher for the DSCODE Hub coding harness preset.', bin:{dscode:'./cli.mjs'}, files:['cli.mjs','manager.mjs','locks.mjs','release.json','tools','session-bridge','email','exec'], dependencies:{imapflow:original.dependencies.imapflow,mailparser:original.dependencies.mailparser,'@dsh-plugin-hub/cli': original.devDependencies['@dsh-plugin-hub/cli'].replace(/^[^0-9]*/, ''),'@deepseek-ai/node-addon-system':'0.1.2',pnpm:'10.15.1'}, });
write(launcher, 'release.json', {slug:'dscode',version,runtime:dependencies['@deepseek-ai/dsh'],bundle:name});
for (const dir of [bundle,launcher]) {
  copy('packages/LICENSE', join(dir,'LICENSE'));
  const result=spawnSync('npm',['pack','--ignore-scripts','--json','--pack-destination',out],{cwd:dir,encoding:'utf8'});
  if(result.status!==0) throw Error(result.stderr);
  write(out, dir===bundle?'bundle-pack.json':'launcher-pack.json',JSON.parse(result.stdout));
  console.log(JSON.parse(result.stdout)[0].filename);
}
