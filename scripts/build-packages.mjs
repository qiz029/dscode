import { composePlugins } from './composition.mjs';
import { cpSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { patchTui } from './patch-tui.mjs';
import { patchRuntime, replaceOnce } from './patch-runtime.mjs';
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
for (const pkg of ['@deepseek-ai/dsh-tool-subagent', 'dsh-code', '@deepseek-ai/dsh-llm-deepseek', '@deepseek-ai/dsh-tool-bash', '@deepseek-ai/dsh-tool-bash-persistent']) {
  copy('node_modules/' + pkg, join(stage, 'node_modules', pkg));
}
patchTui(stage); patchRuntime(stage);
const notices = [];
for (const [pkg, dest] of [['@deepseek-ai/dsh-tool-subagent','subagent'], ['dsh-code','tui'], ['@deepseek-ai/dsh-llm-deepseek','deepseek'], ['@deepseek-ai/dsh-tool-bash','bash'], ['@deepseek-ai/dsh-tool-bash-persistent','persistent']]) {
  const src = join(stage, 'node_modules', pkg);
  cpSync(join(src, 'lib'), join(bundle, 'vendor', dest), { recursive: true });
  const meta = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
  notices.push(`${pkg}@${meta.version}: ${meta.license}; ${JSON.stringify(meta.repository)}\nLocal changes: DSCODE effort, shell control, TUI commands and footer.\n`);
  const license = readdirSync(src).find(f => /^licen[cs]e(?:\.|$)/i.test(f));
  if (license) cpSync(join(src, license), join(bundle, 'vendor', dest, 'LICENSE'));
}
const tui = join(bundle, 'vendor/tui/index.mjs');
writeFileSync(tui, readFileSync(tui, 'utf8').replace('new URL("../package.json", import.meta.url)', 'new URL("../../package.json", import.meta.url)').replace(/import \{ footerFor as dscodeFooterFor \} from [^\n]+;/, 'import { footerFor as dscodeFooterFor } from "../../plugins/session-metrics/view.mjs";'));
rmSync(stage, { recursive: true, force: true });
let preset = read('presets/dscode/agent.cordis.yml').replaceAll("'@deepseek-ai/dsh-tool-subagent'", `'${name}/subagent'`).replace('DSCODE_POLICY_PLUGIN', `'${name}/policy'`).replaceAll("'@deepseek-ai/dsh-tool-bash'", `'${name}/bash'`).replaceAll("'@deepseek-ai/dsh-tool-bash-persistent'", `'${name}/persistent'`);
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
let patch = read('node_modules/@deepseek-ai/dsh-base/cordis.patch.yml') + '\n' + read('node_modules/@anionex/dsh-computer-use/cordis.patch.yml') + '\n' + read('node_modules/dsh-code/cordis.patch.yml').replaceAll("'dsh-code/startup'", `'${name}/startup'`).replaceAll("'dsh-code'", `'${name}/tui'`);
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
const exports = { './package.json':'./package.json', './cordis.patch.yml':'./cordis.patch.yml', './credentials':'./plugins/credentials/index.mjs', './memory':'./plugins/memory/index.mjs', './session-bridge':'./plugins/session-bridge/index.mjs', './session-cards':'./plugins/session-cards/index.mjs' };
for (const [key, file] of Object.entries({subagent:'vendor/subagent/index.js',bootstrap:'bootstrap.mjs',tui:'vendor/tui/index.mjs',startup:'vendor/tui/startup.mjs',deepseek:'vendor/deepseek/index.js',bash:'vendor/bash/index.js',persistent:'vendor/persistent/index.js',policy:'plugins/dscode/index.mjs','auto-review':'plugins/auto-review/index.mjs','session-metrics':'plugins/session-metrics/index.mjs','tui-tools':'plugins/tui-tools/index.mjs'})) exports['./'+key] = './'+file;
const shared = { version, type:'module', license:'MIT', author:'Todd Zheng', engines:original.engines, publishConfig:{access:'public'}, repository: process.env.DSCODE_REPOSITORY ? {type:'git',url:process.env.DSCODE_REPOSITORY} : original.repository };
write(bundle, 'package.json', { ...shared, name, description:'DSCODE coding harness: minimal persistent shell, Ultra subagents, auto review, Chrome, computer use and session telemetry.', files:['bootstrap.mjs','cordis.patch.yml','plugins','presets','bin','vendor','THIRD_PARTY_NOTICES.md'], exports, dependencies, dsh:{bundle:{patch:'./cordis.patch.yml'},hub:{schemaVersion:1,displayName:'DSCODE',summary:'A complete DeepSeek coding agent with persistent shell, Ultra collaboration and automatic permission review.',description:'macOS coding TUI with Chrome MCP, Computer Use, skills, compaction, goals, hooks and session telemetry. Requires the DSCODE profile and its pinned DSH runtime.',categories:['community'],keywords:['coding','tui','deepseek-harness'],compatibility:{dsh:'0.1.5-rc.1',node:original.engines.node,platforms:['darwin'],surfaces:['headless'],hmr:'restart'},entryIds:['dscode-bootstrap'],before:[],after:[],channel:'stable'}} });
write(bundle, 'THIRD_PARTY_NOTICES.md', notices.join('\n'));
write(bundle, 'README.md', '# DSCODE bundle\n\nInstall through the DSCODE Hub preset, or use `npm install -g @toddzheng024/dscode` then `dscode`.\n\nRequires DSH 0.1.5-rc.1, macOS 14+, Node 22.19+ or 24+, and Chrome. Includes modified upstream modules; see THIRD_PARTY_NOTICES.md. No install-time patches or scripts.\n');
const launcher = join(out, 'launcher');
rmSync(launcher, { recursive:true, force:true }); mkdirSync(launcher);
copy('packages/launcher', launcher);
mkdirSync(join(launcher, 'session-bridge'), { recursive: true });
for (const file of ['client.mjs', 'paths.mjs']) copy('plugins/session-bridge/' + file, join(launcher, 'session-bridge', file));
write(launcher, 'cli.mjs', read('packages/launcher/cli.mjs').replace('../../plugins/session-bridge/client.mjs', './session-bridge/client.mjs'));
write(launcher, 'package.json', { ...shared, name:'@toddzheng024/dscode', description:'One-command launcher for the DSCODE Hub coding harness preset.', bin:{dscode:'./cli.mjs'}, files:['cli.mjs','manager.mjs','locks.mjs','release.json','tools','session-bridge'], dependencies:{'@dsh-plugin-hub/cli':'0.2.0','@deepseek-ai/node-addon-system':'0.1.2',pnpm:'10.15.1'}, });
write(launcher, 'release.json', {slug:'dscode',version,runtime:'0.1.5-rc.1',bundle:name});
for (const dir of [bundle,launcher]) {
  copy('packages/LICENSE', join(dir,'LICENSE'));
  const result=spawnSync('npm',['pack','--ignore-scripts','--json','--pack-destination',out],{cwd:dir,encoding:'utf8'});
  if(result.status!==0) throw Error(result.stderr);
  write(out, dir===bundle?'bundle-pack.json':'launcher-pack.json',JSON.parse(result.stdout));
  console.log(JSON.parse(result.stdout)[0].filename);
}
