import test from 'node:test';
import assert from 'node:assert/strict';
import { waitForDesktopHub } from '../scripts/desktop-hub-sync.mjs';

const name = '@publisher/desktop', version = '1.2.3';
const record = { versions: [{ version }] };
const options = { packageName: name, version, log() {} };

test('new npm package visibility retries missing packuments and stale Hub versions', async () => {
  let syncs = 0, lookups = 0;
  const sleeps = [];
  const value = await waitForDesktopHub({ ...options, attempts: 4,
    sync: async () => ++syncs < 3 ? { status: 'rejected', reason: 'package_not_found' } : { status: 'accepted' },
    lookup: async () => ++lookups === 1 ? { versions: [{ version: '1.2.2' }] } : record,
    sleep: async ms => { sleeps.push(ms); },
  });
  assert.equal(value, record); assert.equal(syncs, 4); assert.equal(lookups, 2);
  assert.deepEqual(sleeps, [15000, 15000, 15000]);
});

test('policy rejection and credential errors cannot be hidden by propagation retry', async () => {
  for (const reason of ['not_a_dsh_bundle_or_profile', 'package_identity_mismatch']) {
    let calls = 0;
    await assert.rejects(waitForDesktopHub({ ...options,
      sync: async () => { calls++; return { status: 'rejected', reason }; },
      lookup: async () => assert.fail('must not look up a rejected package'),
      sleep: async () => assert.fail('must not retry policy rejection'),
    }), new RegExp(reason));
    assert.equal(calls, 1);
  }
  const error = Error('Hub API 401: unauthorized');
  await assert.rejects(waitForDesktopHub({ ...options, sync: async () => { throw error; },
    sleep: async () => assert.fail('must not retry credentials'),
  }), value => value === error);
});

test('exhausted visibility retry fails and never treats another version as success', async () => {
  let syncs = 0, sleeps = 0;
  await assert.rejects(waitForDesktopHub({ ...options, attempts: 2,
    sync: async () => { syncs++; return { status: 'accepted' }; },
    lookup: async () => ({ versions: [{ version: '9.9.9' }] }),
    sleep: async () => { sleeps++; },
  }), /after 2 attempts/);
  assert.equal(syncs, 2); assert.equal(sleeps, 1);
});
