import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const execFileAsync = promisify(execFile);
const clip = text => String(text ?? '').slice(-4000);

export const TOOL_SCHEMAS = [
  { name: 'read_file', description: 'Read one available UTF-8 project file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false } },
  { name: 'write_file', description: 'Replace one allowed source file with complete UTF-8 contents.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'], additionalProperties: false } },
  { name: 'run_tests', description: 'Run the visible project checks. Hidden checks run only after you finish.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
];

// Checks are trusted fixture code. The model cannot edit them. This child has
// no API credential and Node's permission model limits filesystem access.
export async function runCheck(workspace, checkPath, signal) {
  const actualWorkspace = realpathSync(workspace);
  const actualCheck = realpathSync(checkPath);
  try {
    const { stdout, stderr } = await execFileAsync(process.execPath, [
      '--permission', `--allow-fs-read=${actualWorkspace}`, `--allow-fs-read=${actualCheck}`, actualCheck,
    ], { cwd: actualWorkspace, timeout: 5000, maxBuffer: 128000, signal,
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: actualWorkspace, TMPDIR: actualWorkspace, EVAL_WORKSPACE: actualWorkspace } });
    return { ok: true, output: clip(stdout), stderr: clip(stderr) };
  } catch (error) {
    return { ok: false, output: clip(error.stdout), stderr: clip(error.stderr), error: error.killed ? 'check-timeout' : 'check-failed' };
  }
}

export function createWorkspace(root, item) {
  mkdirSync(root); // Never reuse a previous branch's files.
  const initial = new Map(Object.entries(item.files));
  for (const [path, content] of initial) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, content, { flag: 'wx' });
  }
  const readable = new Set(initial.keys());
  const writable = new Set(item.writable);
  return {
    root,
    files: () => [...readable].sort(),
    changes: () => [...writable].filter(path => readFileSync(join(root, path), 'utf8') !== initial.get(path)),
    async execute(name, argumentText, signal) {
      let args;
      try { args = JSON.parse(argumentText); }
      catch { return { ok: false, error: 'invalid-tool-arguments' }; }
      if (!args || typeof args !== 'object' || Array.isArray(args)) return { ok: false, error: 'invalid-tool-arguments' };
      if (name === 'read_file') {
        if (Object.keys(args).length !== 1 || !readable.has(args.path)) return { ok: false, error: 'path-not-readable' };
        return { ok: true, content: readFileSync(join(root, args.path), 'utf8') };
      }
      if (name === 'write_file') {
        if (Object.keys(args).length !== 2 || !writable.has(args.path) || typeof args.content !== 'string' || args.content.length > 20000) return { ok: false, error: 'path-or-content-not-writable' };
        writeFileSync(join(root, args.path), args.content);
        return { ok: true, path: args.path, bytes: Buffer.byteLength(args.content) };
      }
      if (name === 'run_tests') {
        if (Object.keys(args).length) return { ok: false, error: 'invalid-tool-arguments' };
        return runCheck(root, join(root, 'visible.mjs'), signal);
      }
      return { ok: false, error: 'unknown-tool' };
    },
  };
}
