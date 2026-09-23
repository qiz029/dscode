/**
 * `/account`: the DeepSeek account login, from the terminal.
 *
 * DSH 0.1.7 added an account plane beside API keys: `deepseekAccount` signs in through the
 * system browser with PKCE, keeps the grant in the local credential store, and the DeepSeek
 * route resolves it for the configured inference origin — so a signed-in user needs no
 * `DEEPSEEK_API_KEY` at all. Upstream drives that plane from its Web settings page; this
 * command is DSCODE's terminal equivalent.
 *
 * The provider registers `/oauth/callback` on the Host webserver for the lifetime of one
 * attempt, which is why the TUI profile composes a loopback webserver (see
 * `packages/tui/cordis.patch.yml`). Without it the command says so instead of starting an
 * attempt the browser could never complete.
 *
 * Tokens never pass through here: the service's view is the client-safe projection, and
 * `resolveToken` stays Host-only inside the LLM route.
 *
 * @module dscode-account
 */

import { execFile } from 'node:child_process';
import { readLanguage, t } from '../i18n/messages.mjs';
import { ACTIVE_PHASES, TERMINAL_PHASES, callbackOrigin, outcomeLines, signInBlocked, statusLines } from './state.mjs';

export const name = 'dscode-account';
export const inject = ['commands'];

/** Upper bound for one terminal-driven attempt; the provider applies its own deadline too. */
const ATTEMPT_WAIT_MS = 300000;

const ok = text => ({ kind: 'success', text });
const fail = text => ({ kind: 'error', text });

/** Open a URL in the user's browser, reporting failure instead of throwing. */
export function openBrowser(url, { platform = process.platform, run = execFile } = {}) {
  return new Promise(resolve => {
    if (platform === 'win32') { resolve(false); return; }
    run(platform === 'darwin' ? 'open' : 'xdg-open', [url], { timeout: 10000 }, error => resolve(!error));
  });
}

/**
 * Follow one attempt until `done(view)` accepts it, the attempt is replaced, or the wait
 * runs out.
 *
 * `watch()` yields the current state first and then on every change, so an already
 * settled attempt returns immediately and a cancelled one does not hang. Both the
 * caller's signal and the bounded wait end the iteration.
 *
 * @param account - the account service.
 * @param id - the attempt this wait belongs to; a different attempt ends the wait.
 * @param done - predicate over each view; true stops the wait.
 * @param signal - the command's cancellation.
 * @returns the last view seen.
 */
export async function followAttempt(account, id, done, signal, { timeoutMs = ATTEMPT_WAIT_MS } = {}) {
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  let last = await account.getState();
  if (done(last)) return last;
  try {
    for await (const view of account.watch(deadline)) {
      last = view;
      const attempt = view.attempt;
      if (attempt === null || attempt.id !== id) break;
      if (done(view)) break;
    }
  } catch { /* an aborted watch leaves the last view in place */ }
  return last;
}

/** A view whose attempt carries the browser URL, or has already settled without one. */
export function authorizeReady(view, id) {
  const attempt = view.attempt;
  if (attempt === null || attempt.id !== id) return true;
  return attempt.authorizeUrl !== undefined || TERMINAL_PHASES.includes(attempt.phase);
}

/** A view whose attempt will not change again. */
export function settled(view, id) {
  const attempt = view.attempt;
  if (attempt === null || attempt.id !== id) return true;
  return TERMINAL_PHASES.includes(attempt.phase);
}

/**
 * Run one browser sign-in to settlement.
 *
 * Kept apart from the command so the whole flow — waiting for the URL, opening the
 * browser, following the attempt, reading the result — is drivable with a fake service
 * and a fake opener.
 *
 * @param service - the account service.
 * @param origin - the loopback callback origin.
 * @param locale - DSCODE interface language.
 * @param signal - the command's cancellation.
 * @param open - browser opener returning whether it launched.
 * @returns the lines to print and whether the sign-in succeeded.
 */
export async function runSignIn({ service, origin, locale, signal, open = openBrowser }) {
  // An attempt already in flight is returned unchanged rather than replaced, so this also
  // covers "resume the sign-in you started a moment ago".
  const started = await service.startSignIn(locale, origin, 'desktop');
  const attempt = started.attempt;
  if (attempt === null || attempt === undefined) return { ok: false, lines: [t(locale, 'account.startFailed')] };
  const lines = [t(locale, 'account.starting')];
  // The browser URL is not part of `startSignIn`'s answer: the provider returns as soon as
  // the attempt exists and publishes the URL once `auth_init` replies, so it is awaited
  // before anything is opened.
  const ready = await followAttempt(service, attempt.id, view => authorizeReady(view, attempt.id), signal);
  const url = ready.attempt?.id === attempt.id ? ready.attempt.authorizeUrl : undefined;
  if (url !== undefined) {
    lines.push(await open(url) ? t(locale, 'account.browserOpened') : t(locale, 'account.browserManual'));
    lines.push(url);
  }
  const final = settled(ready, attempt.id) ? ready : await followAttempt(service, attempt.id, view => settled(view, attempt.id), signal);
  const details = final.status === 'credential-stored' ? await readDetails(service) : undefined;
  return {
    ok: final.attempt?.phase === 'succeeded' || final.status === 'credential-stored',
    lines: [...lines, '', ...outcomeLines(final, details, locale)],
  };
}

export function apply(ctx) {
  const language = () => readLanguage();
  const account = () => ctx.get('deepseekAccount');

  ctx.commands.register({
    name: 'account',
    description: 'Sign in to a DeepSeek account through the browser, or read its status (/account [login|cancel|logout])',
    input: { hint: '[login|cancel|logout]' },
    handler: async ({ rawInput, signal }) => {
      const locale = language();
      const service = account();
      const argument = String(rawInput ?? '').trim().toLowerCase();
      if (service === undefined) return fail(t(locale, 'account.unavailable'));

      if (argument === '' || argument === 'status') {
        const view = await service.getState();
        const details = view.status === 'credential-stored' ? await readDetails(service) : undefined;
        return ok(statusLines(view, details, locale).join('\n'));
      }

      if (argument === 'logout' || argument === 'sign-out' || argument === 'signout') {
        const view = await service.signOut();
        return ok(statusLines(view, undefined, locale).join('\n'));
      }

      if (argument === 'cancel') {
        const current = await service.getState();
        const attempt = current.attempt;
        if (attempt === null || !ACTIVE_PHASES.includes(attempt.phase)) return ok(t(locale, 'account.nothingToCancel'));
        const view = await service.cancelSignIn(attempt.id);
        return ok(outcomeLines(view, undefined, locale).join('\n'));
      }

      if (argument !== 'login' && argument !== 'signin' && argument !== 'sign-in') {
        return fail(t(locale, 'account.usage'));
      }

      const origin = callbackOrigin(ctx.get('webServer'));
      const blocked = signInBlocked(service, origin, locale);
      if (blocked !== undefined) return fail(blocked);

      const result = await runSignIn({ service, origin, locale, signal });
      ctx.logger?.info?.(`account: sign-in ${result.ok ? 'succeeded' : 'did not complete'}`);
      return (result.ok ? ok : fail)(result.lines.join('\n'));
    },
  });
}

/** Read identity and balance, letting either failure render on its own. */
async function readDetails(service) {
  const [profile, balance] = await Promise.all([
    service.getProfile().catch(() => ({ status: 'failed' })),
    service.getBalance().catch(() => ({ status: 'failed' })),
  ]);
  return { profile: profile ?? undefined, balance: balance ?? undefined };
}
