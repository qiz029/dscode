import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';

const updates = new Map();
const ordinary = new Set(['new_page', 'navigate_page', 'select_page', 'close_page', 'take_snapshot', 'take_screenshot',
  'click', 'click_at', 'dbl_click', 'drag', 'hover', 'fill', 'fill_form', 'press_key', 'type_text', 'wait_for', 'upload_file',
  'resize_page', 'emulate', 'handle_dialog', 'get_tab_id', 'list_webmcp_tools', 'execute_webmcp_tool']);
export const needsDeveloper = (name, args = {}) =>
  name === 'navigate_page' && args.initScript !== undefined || name !== 'list_pages' && !ordinary.has(name);

export function siteOrigin(value, exact = false) {
  let url;
  try { url = new URL(value); } catch { throw Error('Use an HTTP(S) origin, for example https://example.com.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      exact && (url.pathname !== '/' || url.search || url.hash)) throw Error('Use an HTTP(S) origin without credentials, a path, query or fragment.');
  return url.origin;
}

function validate(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(k => !['developerMode', 'sites', 'revocations'].includes(k)) ||
      typeof value.developerMode !== 'boolean' || !value.sites || typeof value.sites !== 'object' || Array.isArray(value.sites)) throw Error('Invalid browser permissions file.');
  if (value.revocations !== undefined) {
    if (!value.revocations || typeof value.revocations !== 'object' || Array.isArray(value.revocations)) throw Error('Invalid browser revocations.');
    for (const [origin, revision] of Object.entries(value.revocations)) {
      if (siteOrigin(origin, true) !== origin || typeof revision !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(revision)) throw Error('Invalid browser revocation.');
    }
  }
  for (const [origin, rule] of Object.entries(value.sites)) {
    if (siteOrigin(origin, true) !== origin || !rule || typeof rule !== 'object' ||
        Object.keys(rule).some(k => !['access', 'developer'].includes(k)) ||
        !['ask', 'allow', 'block'].includes(rule.access) || typeof rule.developer !== 'boolean') throw Error('Invalid browser site permission.');
  }
  return value;
}

// SQLite supplies an OS-released cross-process guard using the bundled Node
// runtime on every Desktop platform. JSON remains the canonical policy; readers
// see either atomic version and do not wait on an editor. Never delete this guard.
async function withWriteGuard(home, action) {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const path = join(home, 'permissions.guard.sqlite');
  const guard = new DatabaseSync(path);
  try {
    // Do not open/close this inode outside SQLite: on POSIX, that can release
    // another connection's process-scoped locks (including path aliases).
    await chmod(path, 0o600);
    guard.exec('PRAGMA busy_timeout=0');
    const deadline = Date.now() + 3000;
    for (;;) {
      try { guard.exec('BEGIN IMMEDIATE'); break; }
      catch (error) {
        if (error.errcode !== 5 && error.errcode !== 6) throw error;
        if (Date.now() >= deadline) throw Error('Browser permissions are being edited by another process. Retry after it finishes.', { cause: error });
        await delay(25);
      }
    }
    // No SQLite data is written: the transaction only guards the JSON update.
    // Closing also rolls it back on failures and releases its kernel lock.
    return await action();
  } finally { guard.close(); }
}

/** User-owned grants, independent of tool-action approval and permission presets. */
export class BrowserAccess {
  constructor(home) { this.home = home; this.once = new Map(); }
  async read() {
    try { return validate(JSON.parse(await readFile(join(this.home, 'permissions.json'), 'utf8'))); }
    catch (error) { if (error.code === 'ENOENT') return { developerMode: false, sites: {} }; throw error; }
  }
  pruneTemporary(policy) {
    for (const [origin, revision] of this.once) {
      if (policy.sites[origin]?.access === 'block' || revision !== (policy.revocations?.[origin] ?? null)) this.once.delete(origin);
    }
  }
  async status() {
    const policy = await this.read(); this.pruneTemporary(policy);
    return { developerMode: policy.developerMode, sites: policy.sites, sessionSites: [...this.once.keys()] };
  }
  async update(action, value) {
    const previous = updates.get(this.home) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(() => withWriteGuard(this.home, async () => {
      const policy = await this.read();
      if (action === 'developer-mode') {
        if (!['on', 'off'].includes(value)) throw Error('Developer mode must be on or off.');
        policy.developerMode = value === 'on';
      } else {
        const origin = siteOrigin(value, true);
        if (!['allow', 'block', 'forget', 'once', 'developer-allow', 'developer-block'].includes(action)) throw Error('Unknown site permission action.');
        if (action === 'once') {
          if (policy.sites[origin]?.access === 'block') throw Error('This site is blocked. Remove its block explicitly before allowing it for this browser session.');
          this.once.set(origin, policy.revocations?.[origin] ?? null);
          return this.status();
        }
        // Persist across a block/forget cycle even if another session never
        // checks while blocked. Its old temporary grant cannot become valid again.
        if (['block', 'forget'].includes(action)) {
          policy.revocations ??= {}; policy.revocations[origin] = randomUUID();
        }
        if (action === 'forget') delete policy.sites[origin];
        else {
          const rule = policy.sites[origin] ?? { access: 'ask', developer: false };
          if (action.startsWith('developer-')) rule.developer = action === 'developer-allow';
          else { rule.access = action; if (action === 'block') rule.developer = false; }
          policy.sites[origin] = rule;
        }
      }
      validate(policy);
      await mkdir(this.home, { recursive: true, mode: 0o700 });
      const temp = join(this.home, `permissions-${randomUUID()}.tmp`);
      try {
        await writeFile(temp, JSON.stringify(policy, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
        await rename(temp, join(this.home, 'permissions.json'));
      } finally { await rm(temp, { force: true }).catch(() => {}); }
      if (['allow', 'block', 'forget'].includes(action)) this.once.delete(siteOrigin(value, true));
      return this.status();
    }));
    updates.set(this.home, next);
    try { return await next; } finally { if (updates.get(this.home) === next) updates.delete(this.home); }
  }
  async checkUrl(value, developer = false) {
    if (value === 'about:blank' && !developer) return;
    const origin = siteOrigin(value);
    const policy = await this.read(), rule = policy.sites[origin];
    this.pruneTemporary(policy);
    if (rule?.access === 'block') throw Error(`Browser site blocked: ${origin}. Only the user may change /browser site permissions.`);
    if (rule?.access !== 'allow' && !this.once.has(origin)) throw Error(`Browser site needs user permission: ${origin}. Ask the user to run /browser site once ${origin} (until stop) or /browser site allow ${origin}.`);
    if (developer && (!policy.developerMode || !rule?.developer)) throw Error(`Developer access needs explicit user permission for ${origin}. The user must enable /browser developer on and /browser developer allow ${origin}.`);
  }
  async check(name, args, pages) {
    if (name === 'list_pages') return;
    if (name === 'new_page') { await this.checkUrl(args.url); return; }
    if (!Number.isSafeInteger(args.pageId)) throw Error('Use an explicit live pageId for browser operations. List pages first.');
    const page = pages.find(p => p.id === args.pageId);
    if (!page) throw Error('Browser page unavailable. List pages first.');
    const developer = needsDeveloper(name, args);
    await this.checkUrl(page.url, developer);
    if (name === 'navigate_page' && args.url !== undefined) await this.checkUrl(args.url, developer);
  }
}
