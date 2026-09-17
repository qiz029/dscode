import { execFile as execFileCallback } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, chmod, mkdir, mkdtemp, readFile, rename, rm } from 'node:fs/promises';
import { rmSync } from 'node:fs';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFile = promisify(execFileCallback);
const source = fileURLToPath(new URL('./clipboard-image.swift', import.meta.url));
const cache = join(tmpdir(), `dscode-clipboard-helper-${process.getuid?.() ?? 'user'}`);
const clipboardDirs = new Set();
let compiler;
let cleanupRegistered = false;

async function helperBinary() {
  if (process.platform !== 'darwin') throw Error('Clipboard image paste requires macOS');
  if (compiler) return compiler;
  compiler = (async () => {
    const hash = createHash('sha256').update(await readFile(source)).update(process.arch).digest('hex').slice(0, 16);
    const binary = join(cache, `clipboard-image-${hash}`);
    try { await access(binary, constants.X_OK); return binary; } catch {}
    await mkdir(cache, { recursive: true, mode: 0o700 });
    const moduleCache = join(cache, 'swift-modules');
    await mkdir(moduleCache, { recursive: true, mode: 0o700 });
    const temporary = `${binary}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await execFile('swiftc', [source, '-o', temporary], {
        timeout: 120_000,
        maxBuffer: 64 * 1024,
        env: { ...process.env, CLANG_MODULE_CACHE_PATH: moduleCache, SWIFT_MODULE_CACHE_PATH: moduleCache },
      });
      await chmod(temporary, 0o700);
      await rename(temporary, binary);
    } catch {
      await rm(temporary, { force: true });
      throw Error('Clipboard image helper unavailable; install Xcode Command Line Tools');
    }
    return binary;
  })();
  try { return await compiler; } catch (error) { compiler = undefined; throw error; }
}

export async function readClipboardImage() {
  const binary = await helperBinary();
  const directory = await mkdtemp(join(tmpdir(), 'dscode-clipboard-image-'));
  const path = join(directory, 'image.png');
  try {
    await execFile(binary, [path], { timeout: 10_000, maxBuffer: 1024 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if (error?.code === 2) throw Error('Clipboard has no image', { cause: error });
    if (error?.code === 4) throw Error('Clipboard image is too large', { cause: error });
    throw Error('Could not read clipboard image', { cause: error });
  }
  clipboardDirs.add(directory);
  if (!cleanupRegistered) {
    cleanupRegistered = true;
    process.once('exit', () => { for (const dir of clipboardDirs) rmSync(dir, { recursive: true, force: true }); });
  }
  return path;
}

/** Exercise the compiled helper against a private named pasteboard. */
export async function verifyClipboardImageHelper() {
  const binary = await helperBinary();
  await execFile(binary, ['--self-test'], { timeout: 10_000, maxBuffer: 1024 });
}
