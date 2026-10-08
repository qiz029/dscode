import { setTimeout as delay } from 'node:timers/promises';

// A version endpoint can become visible before the Hub's npm packument fetch.
// Retry only this post-publication visibility gap; policy and auth errors remain
// fatal. The caller must validate identity/integrity after the version appears.
export async function waitForDesktopHub({ packageName, version, sync, lookup,
  attempts = 40, sleep = delay, log = console.log }) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const result = await sync();
    if (result.status === 'accepted') {
      const record = await lookup();
      if (record.versions.some(item => item.version === version)) return record;
    } else if (result.status !== 'rejected' || result.reason !== 'package_not_found') {
      throw Error(`Hub rejected ${packageName}: ${result.reason ?? result.status}`);
    }
    if (attempt < attempts) {
      log(`Waiting for Hub visibility of ${packageName}@${version} (${attempt}/${attempts})`);
      await sleep(15000);
    }
  }
  throw Error(`Hub still cannot resolve ${packageName}@${version} after ${attempts} attempts. Rerun after npm propagation completes.`);
}
