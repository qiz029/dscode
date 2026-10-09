import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path, { join } from 'node:path';

export const browserHome = () => join(resolveDshHome(), 'browser');
export const DEFAULT_CONFIG = Object.freeze({ mode: 'persistent', headless: false });

export function validateConfig(input, paths = path) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw Error('Browser configuration must be an object.');
  for (const key of Object.keys(input)) if (!['mode', 'headless', 'profile', 'url', 'executablePath', 'webmcp'].includes(key)) throw Error(`Unknown browser setting: ${key}`);
  const config = { ...DEFAULT_CONFIG, ...input };
  if (!['persistent', 'isolated', 'connect', 'auto', 'extension'].includes(config.mode)) throw Error('Browser mode must be persistent, isolated, connect, auto or extension.');
  if (typeof config.headless !== 'boolean') throw Error('headless must be a boolean.');
  if (config.webmcp !== undefined && typeof config.webmcp !== 'boolean') throw Error('webmcp must be a boolean.');
  if (config.profile !== undefined && (typeof config.profile !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(config.profile))) throw Error('Profile names use 1–64 letters, digits, underscores or hyphens.');
  if (config.profile && config.mode !== 'persistent') throw Error('Named profiles require persistent mode.');
  if (config.mode === 'connect') {
    const url = new URL(config.url);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw Error('Connect requires a loopback HTTP debugging URL, for example http://127.0.0.1:9222.');
    config.url = url.origin;
  } else if (config.url !== undefined) throw Error('A debugging URL requires connect mode.');
  if (config.executablePath !== undefined && (typeof config.executablePath !== 'string' || !paths.isAbsolute(config.executablePath))) throw Error('executablePath must be an absolute path.');
  if (['connect', 'auto', 'extension'].includes(config.mode) && (config.headless || config.executablePath)) throw Error('Existing browser modes do not accept headless or executablePath.');
  return config;
}

export async function readConfig(home) {
  try { return validateConfig(JSON.parse(await readFile(join(home, 'config.json'), 'utf8'))); }
  catch (error) { if (error.code === 'ENOENT') return { ...DEFAULT_CONFIG }; throw error; }
}

export async function saveConfig(home, value) {
  const config = validateConfig(value);
  await mkdir(home, { recursive: true, mode: 0o700 });
  const temporary = join(home, `config-${process.pid}-${randomUUID()}.tmp`);
  await writeFile(temporary, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
  await rename(temporary, join(home, 'config.json'));
  return config;
}

export function launchOptions(home, sessionId, value) {
  const config = validateConfig(value);
  const args = ['--no-usage-statistics', '--no-performance-crux', '--experimental-structured-content', '--experimental-vision', '--page-id-routing'];
  if (config.webmcp) {
    args.push('--category-experimental-webmcp');
    if (['persistent', 'isolated'].includes(config.mode)) args.push('--chrome-arg=--enable-features=WebMCP');
  }
  let profile;
  if (config.mode === 'persistent') {
    const name = config.profile ? `named-${config.profile}` : `session-${createHash('sha256').update(sessionId).digest('hex').slice(0, 24)}`;
    profile = join(home, 'profiles', name);
    args.push('--user-data-dir', profile);
  } else if (config.mode === 'isolated') args.push('--isolated');
  else if (config.mode === 'connect') args.push('--browser-url', config.url);
  else if (config.mode === 'auto') args.push('--auto-connect');
  if (config.headless) args.push('--headless', '--viewport', '1280x800');
  if (config.executablePath) args.push('--executable-path', config.executablePath);
  return { config, args, profile };
}
