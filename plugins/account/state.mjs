/**
 * Pure rendering and validation for the DeepSeek account surface.
 *
 * The account service (`@deepseek-ai/dsh-deepseek-account`) owns the login protocol: a
 * system-browser sign-in with PKCE, a callback the provider registers on the Host
 * webserver, and a grant kept in the local credential store. Nothing here touches that
 * protocol — it turns one `AccountView` (plus the optional profile and balance reads)
 * into the lines `/account` prints, so the command stays a thin driver and every rule
 * below is testable without a Host.
 *
 * Credentials never reach this module: `AccountView` is the client-safe projection and
 * carries no token.
 *
 * @module dscode-account/state
 */

import { t } from '../i18n/messages.mjs';

/** Attempt phases that will not change again without a new sign-in. */
export const TERMINAL_PHASES = Object.freeze(['succeeded', 'cancelled', 'expired', 'failed']);

/** Phases during which a sign-in is still moving. */
export const ACTIVE_PHASES = Object.freeze(['initializing', 'waiting-browser', 'exchanging', 'committing']);

/**
 * The browser-reachable callback origin for one sign-in.
 *
 * The provider accepts exactly `http://127.0.0.1:<port>` (or localhost/[::1]) with a
 * non-zero explicit port and no path, because that is the loopback redirect the browser
 * is sent back to. An unmounted or unbound webserver has no origin, and the caller
 * reports that rather than starting an attempt that cannot complete.
 *
 * @param webServer - the Host webserver service, or undefined when none is composed.
 * @returns the origin, or undefined when no login can be served.
 */
export function callbackOrigin(webServer) {
  const port = webServer?.port;
  if (!Number.isInteger(port) || port <= 0) return undefined;
  return `http://127.0.0.1:${port}`;
}

/** One wallet as `12.34 CNY`, keeping the server's decimal string exactly. */
export function formatWallet(wallet) {
  return `${wallet.balance} ${wallet.currency}`;
}

/**
 * The balance line, or undefined when the deployment reported none.
 *
 * Recharge and bonus wallets stay separate: upstream keeps them apart because a bonus
 * wallet is not spendable credit in the same sense, and a failed query supplies neither.
 */
export function balanceLine(balance, locale) {
  if (balance === undefined || balance === null) return undefined;
  if (balance.status !== 'ready') return t(locale, 'account.balanceFailed');
  const wallets = balance.value.map(formatWallet).join(', ');
  const bonus = balance.bonusWallets.map(formatWallet).join(', ');
  if (wallets === '' && bonus === '') return t(locale, 'account.balanceEmpty');
  const parts = [wallets === '' ? undefined : wallets, bonus === '' ? undefined : t(locale, 'account.bonus', { wallets: bonus })];
  return t(locale, 'account.balance', { wallets: parts.filter(Boolean).join(' · ') });
}

/** The identity line, or undefined when the deployment reported none. */
export function profileLine(profile, locale) {
  if (profile === undefined || profile === null) return undefined;
  if (profile.status !== 'ready') return t(locale, 'account.profileFailed');
  const { name, contact, id } = profile.value;
  const identity = [name, contact].filter(value => typeof value === 'string' && value !== '').join(' · ');
  return t(locale, 'account.profile', { identity: identity === '' ? (id ?? t(locale, 'account.unknownIdentity')) : identity });
}

/** One line for the latest attempt, including a terminal outcome, or undefined when there was none. */
export function attemptLine(attempt, locale) {
  if (attempt === null || attempt === undefined) return undefined;
  const phase = t(locale, `account.phase.${attempt.phase}`);
  if (attempt.errorCode === undefined) return t(locale, 'account.attempt', { phase });
  return t(locale, 'account.attemptFailed', { phase, reason: t(locale, `account.error.${attempt.errorCode}`) });
}

/**
 * Render `/account` with no argument: stored-credential status, the identity and balance
 * when they were read, the latest attempt, and the platform's own pages.
 *
 * `credential-stored` is deliberately not a claim that the server still accepts the
 * grant — upstream stores no expiry — so the wording says what is on this machine.
 *
 * @param view - client-safe account state.
 * @param details - optional profile and balance reads; absent when signed out or unread.
 * @param locale - DSCODE interface language.
 * @returns the lines to print, in order.
 */
export function statusLines(view, details, locale) {
  const signedIn = view.status === 'credential-stored';
  const lines = [t(locale, signedIn ? 'account.signedIn' : 'account.signedOut')];
  if (signedIn) {
    for (const line of [profileLine(details?.profile, locale), balanceLine(details?.balance, locale)]) if (line !== undefined) lines.push(line);
  }
  const attempt = attemptLine(view.attempt, locale);
  if (attempt !== undefined) lines.push(attempt);
  lines.push(t(locale, 'account.links', { usage: view.links.usageUrl, topUp: view.links.topUpUrl }));
  lines.push(t(locale, signedIn ? 'account.hintSignedIn' : 'account.hintSignedOut'));
  return lines;
}

/**
 * Why a sign-in cannot start, or undefined when it can.
 *
 * @param account - the account service, or undefined when the deployment composes none.
 * @param origin - the resolved callback origin from {@link callbackOrigin}.
 * @param locale - DSCODE interface language.
 */
export function signInBlocked(account, origin, locale) {
  if (account === undefined) return t(locale, 'account.unavailable');
  if (origin === undefined) return t(locale, 'account.noCallback');
  return undefined;
}

/** The lines printed once an attempt settles. */
export function outcomeLines(view, details, locale) {
  const phase = view.attempt?.phase;
  if (phase === 'succeeded') return statusLines(view, details, locale);
  return [attemptLine(view.attempt, locale) ?? t(locale, 'account.signedOut')];
}
