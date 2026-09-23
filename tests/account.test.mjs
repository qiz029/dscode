import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, authorizeReady, followAttempt, openBrowser, runSignIn, settled } from '../plugins/account/index.mjs';
import { balanceLine, callbackOrigin, signInBlocked, statusLines } from '../plugins/account/state.mjs';

const LINKS = { usageUrl: 'https://platform.example/usage', topUpUrl: 'https://platform.example/top_up' };
const signedOut = (attempt = null) => ({ status: 'signed-out', links: LINKS, attempt });
const signedIn = (attempt = null) => ({ status: 'credential-stored', links: LINKS, attempt });
const profile = value => ({ status: 'ready', value });

/**
 * A service double that publishes a scripted sequence of views. `watch` replays whatever
 * has not been seen yet and then waits, exactly like the upstream provider: the first
 * value is the current state, and each later change wakes the iterator.
 */
function fakeAccount(script, { startReturns } = {}) {
  const listeners = new Set();
  let index = 0;
  const current = () => script[Math.min(index, script.length - 1)];
  const advance = () => { if (index < script.length - 1) { index += 1; for (const wake of [...listeners]) wake(); } };
  return {
    calls: [],
    async getState() { return current(); },
    async startSignIn(locale, origin, source) {
      this.calls.push({ locale, origin, source });
      return startReturns ?? current();
    },
    async cancelSignIn(id) { this.calls.push({ cancel: id }); index = script.length - 1; return current(); },
    async signOut() { this.calls.push({ signOut: true }); return signedOut(); },
    async getProfile() { return profile({ id: 'u1', name: 'Todd', contact: '188****8888' }); },
    async getBalance() { return { status: 'ready', value: [{ currency: 'CNY', balance: '12.34' }], bonusWallets: [{ currency: 'CNY', balance: '5.00' }] }; },
    async *watch(signal) {
      while (!signal.aborted) {
        yield current();
        if (index >= script.length - 1) {
          await new Promise(resolve => {
            const wake = () => { listeners.delete(wake); resolve(); };
            listeners.add(wake);
            signal.addEventListener('abort', wake, { once: true });
          });
          if (signal.aborted) return;
        } else advance();
      }
    },
    advance,
  };
}

test('the callback origin is exactly the loopback form the provider accepts', () => {
  assert.equal(callbackOrigin({ port: 52781 }), 'http://127.0.0.1:52781');
  // An unmounted webserver, or one that never bound, cannot serve the callback.
  assert.equal(callbackOrigin(undefined), undefined);
  assert.equal(callbackOrigin({ port: 0 }), undefined);
  assert.equal(callbackOrigin({}), undefined);
});

test('sign-in is refused with the reason, not attempted, when a prerequisite is missing', () => {
  assert.match(signInBlocked(undefined, 'http://127.0.0.1:1', 'en'), /composes no DeepSeek account service/);
  assert.match(signInBlocked({}, undefined, 'en'), /loopback callback server/);
  assert.equal(signInBlocked({}, 'http://127.0.0.1:1', 'en'), undefined);
});

test('status reads the stored credential, identity, balance and the last attempt', () => {
  const out = statusLines(signedOut(), undefined, 'en');
  assert.match(out[0], /signed out/);
  assert.match(out.at(-2), /Usage: https:\/\/platform\.example\/usage/);
  assert.match(out.at(-1), /\/account login/);

  const details = { profile: profile({ id: 'u1', name: 'Todd', contact: '188****8888' }), balance: { status: 'ready', value: [{ currency: 'CNY', balance: '12.34' }], bonusWallets: [] } };
  const inLines = statusLines(signedIn(), details, 'en').join('\n');
  assert.match(inLines, /signed in on this machine/);
  assert.match(inLines, /Identity: Todd · 188\*\*\*\*8888/);
  assert.match(inLines, /Balance: 12\.34 CNY/);
  assert.match(inLines, /\/account logout/);

  // A failed read renders on its own without hiding the rest.
  const partial = statusLines(signedIn(), { profile: { status: 'failed' }, balance: { status: 'failed' } }, 'en').join('\n');
  assert.match(partial, /Identity: could not be read/);
  assert.match(partial, /Balance: could not be read/);
});

test('bonus wallets stay separate from recharge balance', () => {
  assert.equal(balanceLine({ status: 'ready', value: [{ currency: 'CNY', balance: '1.00' }], bonusWallets: [{ currency: 'USD', balance: '2.00' }] }, 'en'),
    'Balance: 1.00 CNY · bonus 2.00 USD');
  assert.equal(balanceLine({ status: 'ready', value: [], bonusWallets: [] }, 'en'), 'Balance: no wallet reported.');
  assert.equal(balanceLine(undefined, 'en'), undefined);
});

test('a failed attempt names the phase and the safe reason', () => {
  const lines = statusLines(signedOut({ id: 'a1', phase: 'failed', errorCode: 'network' }), undefined, 'en').join('\n');
  assert.match(lines, /Last sign-in: failed \(the platform could not be reached\)/);
});

test('the attempt predicates stop at the URL and at settlement, and release a replaced attempt', () => {
  assert.equal(authorizeReady(signedOut({ id: 'a1', phase: 'initializing' }), 'a1'), false);
  assert.equal(authorizeReady(signedOut({ id: 'a1', phase: 'waiting-browser', authorizeUrl: 'https://p/x' }), 'a1'), true);
  assert.equal(authorizeReady(signedOut({ id: 'a1', phase: 'failed' }), 'a1'), true, 'a settled attempt never waits for a URL');
  assert.equal(authorizeReady(signedOut({ id: 'a2', phase: 'initializing' }), 'a1'), true, 'another attempt ends this wait');
  assert.equal(settled(signedIn({ id: 'a1', phase: 'committing' }), 'a1'), false);
  assert.equal(settled(signedIn({ id: 'a1', phase: 'succeeded' }), 'a1'), true);
  assert.equal(settled(signedOut(null), 'a1'), true);
});

test('following an attempt returns as soon as the predicate holds, and survives an abort', async () => {
  const account = fakeAccount([
    signedOut({ id: 'a1', phase: 'initializing' }),
    signedOut({ id: 'a1', phase: 'waiting-browser', authorizeUrl: 'https://platform.example/dsh/authorize?authorize_id=1' }),
  ]);
  const ready = await followAttempt(account, 'a1', view => authorizeReady(view, 'a1'), new AbortController().signal, { timeoutMs: 5000 });
  assert.equal(ready.attempt.phase, 'waiting-browser');

  // A wait that outlives its budget reports the last view instead of hanging or throwing.
  const stuck = fakeAccount([signedOut({ id: 'a1', phase: 'initializing' })]);
  const last = await followAttempt(stuck, 'a1', view => settled(view, 'a1'), new AbortController().signal, { timeoutMs: 40 });
  assert.equal(last.attempt.phase, 'initializing');
});

test('one sign-in waits for the URL, opens it once, and reports the committed account', async () => {
  const account = fakeAccount([
    signedOut({ id: 'a1', phase: 'initializing' }),
    signedOut({ id: 'a1', phase: 'waiting-browser', authorizeUrl: 'https://platform.example/dsh/authorize?authorize_id=1' }),
    signedOut({ id: 'a1', phase: 'exchanging' }),
    signedIn({ id: 'a1', phase: 'succeeded' }),
  ], { startReturns: signedOut({ id: 'a1', phase: 'initializing' }) });
  const opened = [];
  const result = await runSignIn({ service: account, origin: 'http://127.0.0.1:4242', locale: 'en', signal: new AbortController().signal, open: async url => { opened.push(url); return true; } });
  assert.equal(result.ok, true);
  assert.deepEqual(opened, ['https://platform.example/dsh/authorize?authorize_id=1'], 'the browser is opened once, with the published URL');
  assert.deepEqual(account.calls[0], { locale: 'en', origin: 'http://127.0.0.1:4242', source: 'desktop' });
  const text = result.lines.join('\n');
  assert.match(text, /The browser was opened/);
  assert.match(text, /signed in on this machine/);
  assert.match(text, /Identity: Todd/);
});

test('a sign-in the browser never completes fails with the reason and no credential', async () => {
  const account = fakeAccount([
    signedOut({ id: 'a1', phase: 'waiting-browser', authorizeUrl: 'https://platform.example/dsh/authorize?authorize_id=1' }),
    signedOut({ id: 'a1', phase: 'expired', errorCode: 'expired' }),
  ], { startReturns: signedOut({ id: 'a1', phase: 'waiting-browser', authorizeUrl: 'https://platform.example/dsh/authorize?authorize_id=1' }) });
  const result = await runSignIn({ service: account, origin: 'http://127.0.0.1:4242', locale: 'en', signal: new AbortController().signal, open: async () => false });
  assert.equal(result.ok, false);
  const text = result.lines.join('\n');
  assert.match(text, /Open this URL/, 'a browser that did not launch leaves the URL to open by hand');
  assert.match(text, /Last sign-in: expired \(the attempt timed out\)/);
});

/** Drive the registered command with a stub Host. */
function command(service, webServer) {
  let registered;
  const ctx = {
    commands: { register: definition => { registered = definition; } },
    logger: { info() {} },
    get: name => (name === 'deepseekAccount' ? service : name === 'webServer' ? webServer : undefined),
  };
  apply(ctx);
  return (rawInput = '') => registered.handler({ rawInput, signal: new AbortController().signal });
}

test('the command answers status, cancellation, sign-out, usage and every missing prerequisite', async () => {
  const account = fakeAccount([signedIn(null)]);
  const run = command(account, { port: 4242 });

  const status = await run('');
  assert.equal(status.kind, 'success');
  assert.match(status.text, /signed in on this machine/);

  const nothing = await run('cancel');
  assert.match(nothing.text, /No sign-in is in progress/);

  const out = await run('logout');
  assert.equal(out.kind, 'success');
  assert.match(out.text, /signed out/);
  assert(account.calls.some(call => call.signOut === true));

  const usage = await run('bogus');
  assert.equal(usage.kind, 'error');
  assert.match(usage.text, /Usage: \/account \[login\|cancel\|logout\]/);

  // Without the loopback server the login is refused before any platform request.
  const noServer = command(fakeAccount([signedOut()]), undefined);
  const refused = await noServer('login');
  assert.equal(refused.kind, 'error');
  assert.match(refused.text, /loopback callback server/);

  // A deployment that composes no account service says so for every subcommand.
  const absent = command(undefined, { port: 4242 });
  for (const input of ['', 'login', 'logout']) {
    const result = await absent(input);
    assert.equal(result.kind, 'error');
    assert.match(result.text, /composes no DeepSeek account service/);
  }
});

test('cancelling an active attempt goes through the service and reports the outcome', async () => {
  const account = fakeAccount([
    signedOut({ id: 'a1', phase: 'waiting-browser', authorizeUrl: 'https://platform.example/dsh/authorize' }),
    signedOut({ id: 'a1', phase: 'cancelled' }),
  ]);
  const result = await command(account, { port: 4242 })('cancel');
  assert.equal(result.kind, 'success');
  assert.match(result.text, /Last sign-in: cancelled/);
  assert(account.calls.some(call => call.cancel === 'a1'));
});

test('the browser opener reports failure instead of throwing, and never runs on Windows', async () => {
  assert.equal(await openBrowser('https://example.test', { platform: 'win32', run: () => { throw Error('must not run'); } }), false);
  assert.equal(await openBrowser('https://example.test', { platform: 'darwin', run: (_bin, _args, _options, done) => done(Error('no opener')) }), false);
  const launched = [];
  assert.equal(await openBrowser('https://example.test', { platform: 'linux', run: (bin, args, _options, done) => { launched.push([bin, ...args]); done(null); } }), true);
  assert.deepEqual(launched, [['xdg-open', 'https://example.test']]);
});
