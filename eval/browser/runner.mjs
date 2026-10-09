import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { parseArgs } from 'node:util';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { root, provision, environment, dshEntry } from '../../scripts/harness.mjs';
import { socketDirectory } from '../../plugins/session-bridge/paths.mjs';
import { CASES } from './fixture.mjs';
import { isCustomId } from '../../plugins/custom/config.mjs';
import { EVAL_KEY_ENV, resolveRoute } from './routes.mjs';

const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
const integer = (value, label, min, max) => { const n = Number(value); if (!Number.isSafeInteger(n) || n < min || n > max) throw Error(`${label} must be an integer from ${min} to ${max}`); return n; };

export function parseOptions(argv) {
  const { values } = parseArgs({ args: argv, options: {
    'self-test': { type: 'boolean' }, provider: { type: 'string', default: 'deepseek' }, model: { type: 'string' }, thinking: { type: 'string' },
    'providers-file': { type: 'string' }, 'key-env': { type: 'string' },
    cases: { type: 'string', default: CASES.join(',') }, out: { type: 'string' }, 'max-calls': { type: 'string', default: '30' },
    'max-tools': { type: 'string', default: '45' }, 'case-timeout-ms': { type: 'string', default: '240000' }, 'call-timeout-ms': { type: 'string', default: '60000' }, help: { type: 'boolean' },
  } });
  if (values.help) return { help: true };
  const cases = values.cases.split(',');
  if (new Set(cases).size !== cases.length || cases.some(id => !CASES.includes(id))) throw Error('Unknown or duplicate browser cases. Choose reservation,reference,dialog.');
  const custom = isCustomId(values.provider);
  if (values.provider !== 'deepseek' && !custom) throw Error('Choose deepseek or a saved custom provider ID.');
  if (custom && values['self-test']) throw Error('--self-test uses a scripted adapter; omit --provider for that run.');
  if (custom && values.thinking !== undefined) throw Error('Custom evaluations use the model\'s saved thinking setting; omit --thinking.');
  if (!custom && (values['providers-file'] !== undefined || values['key-env'] !== undefined)) throw Error('--providers-file and --key-env require a custom provider.');
  if (values['key-env'] !== undefined && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(values['key-env'])) throw Error('--key-env must name an environment variable, not contain a key.');
  const model = values.model ?? (custom ? '' : 'deepseek-flash');
  if (!model.trim() || /[\x00-\x1f\x7f]/.test(model) || !['disabled', 'enabled'].includes(values.thinking ?? 'disabled')) throw Error('Choose a model ID and a valid thinking setting.');
  return { selfTest: !!values['self-test'], provider: values.provider, model: values['self-test'] ? 'scripted' : model,
    ...(custom ? {} : { thinking: values.thinking ?? 'disabled' }),
    ...(values['providers-file'] ? { providersFile: resolve(values['providers-file']) } : {}),
    ...(values['key-env'] ? { keyEnv: values['key-env'] } : {}), cases,
    out: resolve(values.out ?? join(root, 'artifacts/local', `browser-eval-${Date.now()}-${randomUUID().slice(0, 8)}`)),
    maxCalls: integer(values['max-calls'], 'max-calls', 1, 100), maxTools: integer(values['max-tools'], 'max-tools', 1, 200),
    caseTimeoutMs: integer(values['case-timeout-ms'], 'case-timeout-ms', 1000, 600000), callTimeoutMs: integer(values['call-timeout-ms'], 'call-timeout-ms', 1000, 180000) };
}

export async function runEvaluation(options) {
  // A missing credential must not create a plausible zero/green quality report.
  const { route, key } = await resolveRoute(options);
  if (existsSync(options.out)) throw Error('Choose a new output directory; existing reports are never overwritten.');
  const home = mkdtempSync(join(tmpdir(), 'dscode-browser-eval-'));
  const manifest = { version: 1, status: 'running', startedAt: new Date().toISOString(), ...options,
    backend: route.backend, endpoint: route.endpoint ?? null,
    route: { provider: route.provider, api: route.api, contextWindow: route.contextWindow,
      ...(route.profile ? { model: route.profile.models[0], backend: route.profile.backend, auth: route.profile.auth,
        configHash: createHash('sha256').update(JSON.stringify(route.profile)).digest('hex') } : {}) },
    modelRevision: options.selfTest ? null : 'Requested alias only; the provider may change its underlying revision.',
    scope: 'Native DSCODE agent and browser plugin, fresh headless Chrome, DOM/UI tasks on disposable loopback fixtures. No personal profile, external site or JavaScript evaluation. Scripted runs do not measure model quality.',
    hashes: Object.fromEntries(['eval/browser/host.mjs', 'eval/browser/fixture.mjs', 'eval/browser/scripted.mjs', 'eval/browser/runner.mjs', 'eval/browser/routes.mjs', 'eval/compaction/adapters.mjs',
      'plugins/custom/adapter.mjs', 'plugins/custom/config.mjs', 'plugins/custom/images.mjs', 'plugins/custom/wire.mjs', 'plugins/providers/chat-messages.mjs', 'plugins/providers/chat-stream.mjs', 'plugins/providers/http-errors.mjs',
      'plugins/browser/index.mjs', 'plugins/browser/connection.mjs', 'plugins/browser/config.mjs', 'plugins/browser/access.mjs', 'plugins/browser/review.mjs', 'plugins/browser/files.mjs', 'plugins/browser/presentation.mjs', 'plugins/browser/SKILL.md', 'plugins/auto-review/policy.mjs', 'plugins/dscode/index.mjs', 'presets/dscode/agent.cordis.yml', 'package-lock.json'].map(name => [name, hash(join(root, name))])),
  };
  let child, interrupted = false, hardTimedOut = false, outputCreated = false;
  const save = () => writeFileSync(join(options.out, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  const interrupt = () => { interrupted = true; child?.kill('SIGTERM'); };
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  let hardTimer;
  try {
    mkdirSync(dirname(options.out), { recursive: true });
    mkdirSync(options.out); outputCreated = true; save();
    provision(home, { cwd: home });
    mkdirSync(join(home, 'browser'), { recursive: true });
    writeFileSync(join(home, 'browser/config.json'), JSON.stringify({ mode: 'isolated', headless: true, ...(process.env.DSCODE_TEST_CHROME ? { executablePath: process.env.DSCODE_TEST_CHROME } : {}) }));
    const optionsFile = join(home, 'eval-options.json');
    writeFileSync(optionsFile, JSON.stringify({ ...options, route, workspace: home }), { mode: 0o600 });
    const patch = join(home, 'eval.patch.yml');
    writeFileSync(patch, `- id: tui-startup\n  disabled: true\n- id: tui-runner\n  disabled: true\n- id: dscode-memory\n  config:\n    enabled: false\n- id: dscode-session-cards\n  config:\n    enabled: false\n- insert:\n    - id: browser-evaluation\n      name: ${JSON.stringify(join(root, 'eval/browser/host.mjs'))}\n`);
    child = spawn(process.execPath, [dshEntry, '--profile', 'tui', '--patch', patch], { cwd: home,
      env: { ...environment(home, home), [EVAL_KEY_ENV]: key ?? '', DSCODE_BROWSER_EVAL_OPTIONS: optionsFile }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '', finished = false;
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split('\n'); buffer = lines.pop().slice(-65536);
      for (const line of lines) {
        if (line.startsWith('BROWSER_EVAL_CASE:')) console.log(line);
        if (line === 'BROWSER_EVAL_FINISHED') finished = true;
      }
    });
    // Host stderr can contain provider diagnostics. Drain it without copying
    // request/credential material into a shareable report or console.
    child.stderr.on('data', () => {});
    hardTimer = setTimeout(() => { hardTimedOut = true; child.kill('SIGKILL'); }, options.cases.length * (options.caseTimeoutMs + 70000) + 60000);
    const code = await new Promise((resolveExit, reject) => { child.once('error', reject); child.once('exit', (code, signal) => resolveExit(signal ? null : code)); });
    manifest.status = interrupted ? 'interrupted' : hardTimedOut ? 'timed-out' : finished ? 'completed' : 'runtime-failure';
    manifest.exitCode = code;
    const resultsFile = join(options.out, 'results.json');
    const results = existsSync(resultsFile) ? JSON.parse(readFileSync(resultsFile, 'utf8')) : { qualityScore: null, rows: [] };
    // Crashes/deadlines preserve partial rows, never a misleading full score.
    if (manifest.status !== 'completed') { results.qualityScore = null; results.infrastructurePassed = false; writeFileSync(resultsFile, JSON.stringify(results, null, 2) + '\n'); }
    writeFileSync(join(options.out, 'report.md'), report(manifest, results));
    console.log(`Report: ${join(options.out, 'report.md')}`);
    return { manifest, results, code: manifest.status === 'completed' && code === 0 ? 0 : 1 };
  } catch (error) { manifest.status = 'runtime-failure'; throw error; }
  finally {
    clearTimeout(hardTimer);
    process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt);
    manifest.finishedAt = new Date().toISOString(); if (outputCreated) save();
    rmSync(socketDirectory(home), { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  }
}

export function report(manifest, results) {
  const label = manifest.selfTest ? 'Scripted pipeline self-test — no model quality score' : `Live model: ${manifest.model} (${manifest.route?.provider ?? manifest.provider ?? 'deepseek'})`;
  return `# Browser evaluation\n\n${label}\n\nStatus: ${manifest.status}. ` +
    (results.qualityScore === null ? 'Quality score: not measured.\n' : `Task success: ${Math.round(results.qualityScore * 100)}%.\n`) +
    '\n| Case | Outcome | Model calls | Tool calls | Tool errors | Handoffs | Duplicate submissions | Seconds |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n' +
    results.rows.map(r => `| ${r.id} | ${r.success ? 'pass' : 'fail'} | ${r.modelCalls} | ${r.toolCalls} | ${r.toolErrors} | ${r.handoffs} | ${r.oracle?.duplicateSubmissions ?? 'unknown'} | ${(r.elapsedMs / 1000).toFixed(1)} |`).join('\n') +
    '\n\nSuccess requires the correct single server-side submission, reading its random receipt, keeping the result tab and completing within budget. Model claims alone do not pass. Ordinary UI actions on these disposable fixtures are preauthorized. Handoffs are recorded but not automatically completed. Tool errors may be recoverable and do not alone fail a task.\n\nThis small DOM task suite does not establish visual, production-login, external-site or Codex-equivalence quality. No Codex comparison is implied. See manifest.json for budgets and source hashes, results.json for independent checks, and traces.jsonl for tool activity.\n';
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseOptions(argv);
  if (options.help) { console.log('npm run eval:browser -- [--self-test] [--provider deepseek|custom-ID] [--model MODEL] [--thinking disabled|enabled] [--providers-file PATH] [--key-env VARIABLE] [--cases reservation,reference,dialog] [--max-calls 30] [--max-tools 45] [--case-timeout-ms 240000] [--call-timeout-ms 60000] [--out new-directory]\nDeepSeek requires DEEPSEEK_API_KEY. Custom runs require an explicit model and use its saved API, context, image and thinking settings; credentials come from the native shared store/environment, or --key-env. No-auth custom endpoints need no key. --self-test measures infrastructure only.'); return; }
  process.exitCode = (await runEvaluation(options)).code;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { console.error(error.message); process.exitCode = 1; });
