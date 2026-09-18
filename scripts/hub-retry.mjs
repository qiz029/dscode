// The publish job talks to the Hub at the worst possible moment, and the Hub answers a
// transient 5xx under load. One "Hub API 503" in the credential check aborted a whole release
// (v0.7.13: the publish job failed before its bundle, profile, launcher and GitHub release
// steps), so every Hub call goes through a bounded retry here. A 5xx response or a transport
// failure is tried again; a 4xx — bad token, missing package, immutable version — is the
// caller's answer and is never retried.
const ATTEMPTS = 5, DELAY_MS = 3000;

function positive(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

/** Whether a Hub failure is transient: a 5xx response or a transport error, never a 4xx. */
export function transientHubFailure(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (/^Hub API 4\d\d:/.test(message)) return false;
  if (/^Hub API 5\d\d:/.test(message)) return true;
  return /fetch failed|network|socket hang up|timed out|timeout|aborted|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i.test(message);
}

/**
 * Run one Hub call, retrying a transient failure until `attempts` total tries are used up.
 * The last error is rethrown: an outage still fails the release instead of publishing blind.
 * `DSCODE_HUB_RETRY_ATTEMPTS` and `DSCODE_HUB_RETRY_MS` tune the two defaults.
 */
export async function withHubRetry(operation, options = {}) {
  const attempts = Math.trunc(positive(options.attempts ?? process.env.DSCODE_HUB_RETRY_ATTEMPTS, ATTEMPTS));
  const delayMs = positive(options.delayMs ?? process.env.DSCODE_HUB_RETRY_MS, DELAY_MS);
  const sleep = options.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const label = options.label ?? 'Hub API';
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt >= attempts || !transientHubFailure(error)) throw error;
      // A rejected string or plain object still has to name itself in the retry line.
      console.log(`${label}: ${error instanceof Error ? error.message : String(error)} — retrying (${attempt + 1}/${attempts})`);
      await sleep(delayMs);
    }
  }
}
