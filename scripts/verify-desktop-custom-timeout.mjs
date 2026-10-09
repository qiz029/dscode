// Real Desktop settings RPC against a slow loopback model; no live inference.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

if (!process.argv[2] || !process.argv[3]) throw Error('Usage: node scripts/verify-desktop-custom-timeout.mjs <matching-runtime> <Harness.app>');
const root = resolve(import.meta.dirname, '..'), output = join(root, 'artifacts/local');
mkdirSync(output, { recursive: true });
const receiptPath = join(output, 'desktop-custom-timeout.json');
rmSync(receiptPath, { force: true });
const child = spawn(process.execPath, [join(import.meta.dirname, 'verify-desktop-model-ui.mjs'), process.argv[2], process.argv[3]], {
  cwd: root, env: { ...process.env, DSCODE_UI_MODEL_DELAY_MS: '35000' }, stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '', readiness, fixture, outcome, receipt;
child.stdout.on('data', chunk => {
  log += chunk;
  const line = log.split('\n').find(line => line.startsWith('DESKTOP_MODELS_UI_READY '));
  if (line) readiness = JSON.parse(line.slice('DESKTOP_MODELS_UI_READY '.length));
  const fixtureLine = log.split('\n').find(line => line.startsWith('DESKTOP_MODELS_UI_FIXTURE '));
  if (fixtureLine) fixture = JSON.parse(fixtureLine.slice('DESKTOP_MODELS_UI_FIXTURE '.length));
});
child.stderr.on('data', chunk => { log += chunk; });
const exited = new Promise((resolve, reject) => {
  child.once('exit', (code, signal) => { outcome = { code, signal }; resolve(outcome); });
  child.once('error', reject);
});
const waitFor = async (predicate, description, timeout = 60000) => {
  const until = Date.now() + timeout;
  while (!predicate() && !outcome && Date.now() < until) await delay(50);
  assert(predicate(), `Did not observe ${description}; child exit: ${JSON.stringify(outcome)}`);
};
const occurrences = marker => log.split(marker).length - 1;
try {
  await waitFor(() => Boolean(readiness), 'Desktop Host readiness');
  const origin = new URL(readiness.url).origin;
  const auth = await fetch(readiness.url, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
  const cookie = auth.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  assert(cookie, 'Missing fixture authentication cookie');
  const profile = { id: 'custom-cold-start', name: 'Cold start fixture', baseURL: readiness.modelUrl,
    api: 'chat-completions', auth: 'bearer', timeoutMs: 180000, models: [{ id: 'desktop-ui-vision', contextWindow: 32768 }] };
  const request = (idleTimeoutMs, signal) => fetch(origin + '/api/dscode-custom', {
    method: 'POST', signal, headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: 'cold-start-fixture', method: 'dscode-custom',
      payload: { action: 'test', profile: { ...profile, timeoutMs: idleTimeoutMs }, model: 'desktop-ui-vision', key: 'desktop-ui-fixture-key' } }),
  });
  const result = async response => {
    assert.equal(response.status, 200);
    const body = await response.json(); assert(body.result.ok, body.result.error?.message); return body.result.value;
  };
  const started = Date.now();
  const stages = await result(await request(180000, AbortSignal.timeout(60000)));
  assert.deepEqual(stages.map(stage => stage.status), ['passed', 'passed', 'passed', 'not tested'], JSON.stringify(stages));
  const elapsedMs = Date.now() - started;
  assert(elapsedMs >= 35000, 'The model fixture did not exercise the old 30-second deadline');
  console.log('PASS Desktop test survived 35-second cold start');

  const controller = new AbortController(), beforeStart = occurrences('DESKTOP_MODEL_DELAY_STARTED'), beforeCancel = occurrences('DESKTOP_MODEL_DELAY_CANCELLED');
  const cancelled = request(180000, controller.signal).then(response => ({ response }), error => ({ error }));
  await waitFor(() => occurrences('DESKTOP_MODEL_DELAY_STARTED') > beforeStart, 'second model request');
  controller.abort();
  assert((await cancelled).error, 'Aborting the caller unexpectedly completed the response');
  await waitFor(() => occurrences('DESKTOP_MODEL_DELAY_CANCELLED') > beforeCancel, 'upstream model request cancellation', 10000);
  console.log('PASS Desktop caller cancellation reached model HTTP request');

  const idleStarted = Date.now();
  const idleStages = await result(await request(100, AbortSignal.timeout(10000)));
  assert.equal(idleStages.at(-1).status, 'failed');
  assert.match(idleStages.at(-1).message, /idle timeout after 100ms/);
  assert(Date.now() - idleStarted < 10000);
  console.log('PASS configured model idle timeout remains enforced');
  const hostSource = join(fixture.home, 'profiles/desktop/node_modules/@toddzheng024/dscode-desktop/plugins/custom/desktop-host.mjs');
  receipt = {
    surface: 'official macOS Desktop authenticated settings RPC', coldStartMs: 35000, elapsedMs,
    runtime: JSON.parse(readFileSync(join(resolve(process.argv[2]), 'node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version,
    installedHostSourceSha256: createHash('sha256').update(readFileSync(hostSource)).digest('hex'),
    completedTestStages: stages.map(stage => stage.status), callerAbortReachesModel: true, configuredIdleTimeoutEnforced: true,
    liveInference: false, renderedControls: false,
  };
} finally {
  if (!outcome) child.kill('SIGTERM');
  const timer = setTimeout(() => child.kill('SIGKILL'), 10000);
  const stopped = await exited.finally(() => clearTimeout(timer));
  writeFileSync(join(output, 'desktop-custom-timeout-host.log'), log.replace(/token=[^\s"&]+/g, 'token=[redacted]'));
  assert.equal(stopped.code, 0, `Desktop fixture cleanup failed: ${JSON.stringify(stopped)}`);
}
writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
