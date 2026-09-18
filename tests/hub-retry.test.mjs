import test from 'node:test';
import assert from 'node:assert/strict';
import { transientHubFailure, withHubRetry } from '../scripts/hub-retry.mjs';

test('transientHubFailure retries 5xx and transport errors but never a 4xx', () => {
  assert.equal(transientHubFailure(new Error('Hub API 503: <h1>Error: Server Error</h1>')), true);
  assert.equal(transientHubFailure(new Error('Hub API 500: internal error')), true);
  assert.equal(transientHubFailure(new TypeError('fetch failed')), true);
  assert.equal(transientHubFailure(new Error('The operation was aborted due to timeout')), true);
  assert.equal(transientHubFailure(new Error('socket hang up')), true);
  assert.equal(transientHubFailure(new Error('Hub API 401: invalid token')), false);
  assert.equal(transientHubFailure(new Error('Hub API 404: no such profile')), false);
  assert.equal(transientHubFailure(new Error('Hub API 409: version_is_immutable')), false);
  assert.equal(transientHubFailure(new Error('Hub API returned text/html, expected JSON')), false);
  assert.equal(transientHubFailure(new Error('Hub authentication is required')), false);
});

test('a transient Hub failure is retried and the eventual answer returned', async () => {
  const sleeps = [];
  let calls = 0;
  const result = await withHubRetry(async () => {
    calls += 1;
    if (calls < 3) throw new Error('Hub API 503: <h1>Error: Server Error</h1>');
    return 'profile';
  }, { attempts: 5, delayMs: 25, sleep: ms => { sleeps.push(ms); return Promise.resolve(); } });
  assert.equal(result, 'profile');
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [25, 25]);
});

test('a 4xx is the answer, not a retry', async () => {
  let calls = 0;
  await assert.rejects(
    withHubRetry(async () => { calls += 1; throw new Error('Hub API 401: invalid token'); }, { sleep: () => { throw new Error('a 4xx must not sleep between attempts'); } }),
    /Hub API 401/);
  assert.equal(calls, 1);
});

test('an outage still fails the release after the attempts run out', async () => {
  let calls = 0;
  await assert.rejects(
    withHubRetry(async () => { calls += 1; throw new Error('Hub API 503: down'); }, { attempts: 3, delayMs: 1, sleep: () => Promise.resolve() }),
    /Hub API 503/);
  assert.equal(calls, 3, 'the last error is rethrown instead of publishing blind');
});

test('a non-transient error from our own code is never retried', async () => {
  let calls = 0;
  await assert.rejects(
    withHubRetry(async () => { calls += 1; throw new Error('the candidate archive is incomplete'); }, { sleep: () => { throw new Error('must not sleep'); } }),
    /candidate archive is incomplete/);
  assert.equal(calls, 1);
});

test('the real client turns a 503 into the error this retry classifies', async t => {
  // `get` is where the client raises `Hub API <status>`, so the fixture stays a bare JSON
  // body instead of a full payload that `profile()` would have to pass the Hub schema with.
  const { createServer } = await import('node:http');
  const { HubApiClient } = await import('../node_modules/@dsh-plugin-hub/cli/dist/api-client.js');
  let calls = 0;
  const server = createServer((request, response) => {
    calls += 1;
    if (calls === 1) { response.writeHead(503, { 'content-type': 'text/html' }); response.end('<h1>Error: Server Error</h1>'); return; }
    response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify({ slug: 'dscode', visibility: 'public', latestVersion: '0.7.14' }));
  });
  await new Promise(ready => server.listen(0, '127.0.0.1', ready));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new HubApiClient('http://127.0.0.1:' + server.address().port + '/api/v1', () => 'token');
  const profile = await withHubRetry(() => client.get('/profiles/dscode'), { delayMs: 1, sleep: () => Promise.resolve() });
  assert.equal(profile.visibility, 'public');
  assert.equal(calls, 2, 'the first 503 was retried instead of aborting the publish job');
});

test('a non-Error rejection is retried and named in the retry line', async () => {
  const logged = [];
  const write = console.log;
  console.log = (...args) => logged.push(args.join(' '));
  try {
    let calls = 0;
    await assert.rejects(
      withHubRetry(async () => { calls += 1; throw 'timed out'; }, { attempts: 2, delayMs: 1, sleep: () => Promise.resolve() }),
      message => message === 'timed out');
    assert.equal(calls, 2);
    assert.match(logged.join('\n'), /timed out — retrying \(2\/2\)/);
  } finally { console.log = write; }
});
