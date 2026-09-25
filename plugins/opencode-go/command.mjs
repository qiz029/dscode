import { t } from '../i18n/messages.mjs';
import { openBrowser } from '../account/index.mjs';
import { completeGrant, grantSummary, pollDeviceToken, startDeviceLogin } from './oauth.mjs';

// `/opencode`: sign in to OpenCode Go with an OpenCode account. A command settles with one
// result and cannot print while it waits, and the device flow needs the code in front of the
// user before approval, so `login` answers at once with the code and URL and keeps polling
// in the background; `/opencode` reports how it ended.

const ok = text => ({ kind: 'success', text });
const fail = text => ({ kind: 'error', text });
const who = summary => [summary.email, summary.orgName].filter(Boolean).join(' · ') || 'OpenCode account';

/**
 * The login state machine behind the command, kept apart so a test can drive it with fakes.
 * @param deps - `store` (`write`, `remove`), `grant()` for the stored grant, optional `onSignedIn()`,
 *   `fetch`, `open(url)`, `sleep(ms)`, `now()` and `log(message)`.
 */
export class OpenCodeLogin {
  constructor(deps) {
    this.deps = deps;
    this.attempt = undefined;
    this.outcome = undefined;
  }

  now() {
    return this.deps.now?.() ?? Date.now();
  }

  /** Status lines: the stored login, an attempt in flight, the last outcome. */
  async status(locale) {
    const lines = [];
    if (this.attempt !== undefined) lines.push(t(locale, 'opencode.pending', { code: this.attempt.device.userCode }), this.attempt.device.url);
    else if (this.outcome !== undefined) lines.push(this.outcome);
    const grant = await this.deps.grant();
    if (grant !== undefined) {
      const summary = grantSummary(grant, this.now());
      lines.push(t(locale, 'opencode.signedIn', { who: who(summary), days: summary.expiresInDays }));
    } else if (this.attempt === undefined) lines.push(t(locale, 'opencode.signedOut'));
    return lines;
  }

  /** Start a login, or show the one already waiting. */
  async login(locale) {
    if (this.attempt !== undefined) return { ok: true, lines: await this.status(locale) };
    let device;
    try {
      device = await startDeviceLogin({ ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}), now: this.now() });
    } catch (error) {
      return { ok: false, lines: [t(locale, 'opencode.startFailed', { reason: error.message })] };
    }
    const controller = new AbortController();
    const attempt = { device, controller };
    this.attempt = attempt;
    this.outcome = undefined;
    attempt.done = this.follow(attempt, locale);
    const opened = await (this.deps.open ?? openBrowser)(device.url);
    return {
      ok: true,
      lines: [
        t(locale, 'opencode.started', { code: device.userCode, minutes: Math.max(1, Math.round((device.expiresAt - this.now()) / 60000)) }),
        t(locale, opened ? 'opencode.browserOpened' : 'opencode.browserManual'),
        device.url,
      ],
    };
  }

  /** Poll to the end, store the grant on approval, and record how it ended. */
  async follow(attempt, locale) {
    const options = { ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}), signal: attempt.controller.signal, ...(this.deps.sleep ? { sleep: this.deps.sleep } : {}), now: () => this.now() };
    try {
      const token = await pollDeviceToken(attempt.device, options);
      const grant = await completeGrant(token, { ...(this.deps.fetch ? { fetch: this.deps.fetch } : {}), now: this.now() });
      await this.deps.store.write(JSON.stringify(grant));
      this.outcome = t(locale, 'opencode.succeeded', { who: who(grantSummary(grant, this.now())) });
      this.deps.log?.('signed in');
      this.deps.onSignedIn?.();
    } catch (error) {
      this.outcome = attempt.controller.signal.aborted ? t(locale, 'opencode.cancelled') : t(locale, 'opencode.failed', { reason: error.message });
      this.deps.log?.(`sign-in did not complete: ${error.message}`);
    } finally {
      if (this.attempt === attempt) this.attempt = undefined;
    }
  }

  cancel(locale) {
    const attempt = this.attempt;
    if (attempt === undefined) return t(locale, 'opencode.nothingToCancel');
    attempt.controller.abort(new Error('cancelled'));
    this.attempt = undefined;
    this.outcome = t(locale, 'opencode.cancelled');
    return this.outcome;
  }

  async logout(locale) {
    this.attempt?.controller.abort(new Error('signed out'));
    this.attempt = undefined;
    this.outcome = undefined;
    await this.deps.store.remove();
    return t(locale, 'opencode.loggedOut');
  }

  dispose() {
    this.attempt?.controller.abort(new Error('disposed'));
    this.attempt = undefined;
  }
}

/** The `/opencode` command descriptor over one login machine. */
export function openCodeCommand(login, language) {
  return {
    name: 'opencode',
    description: 'Sign in to OpenCode Go with an OpenCode account, or read the login (/opencode [login|cancel|logout])',
    input: { hint: '[login|cancel|logout]' },
    handler: async ({ rawInput }) => {
      const locale = language();
      const argument = String(rawInput ?? '').trim().toLowerCase();
      if (argument === '' || argument === 'status') return ok((await login.status(locale)).join('\n'));
      if (argument === 'login' || argument === 'signin' || argument === 'sign-in') {
        const result = await login.login(locale);
        return (result.ok ? ok : fail)(result.lines.join('\n'));
      }
      if (argument === 'cancel') return ok(login.cancel(locale));
      if (argument === 'logout' || argument === 'signout' || argument === 'sign-out') return ok(await login.logout(locale));
      return fail(t(locale, 'opencode.usage'));
    },
  };
}
