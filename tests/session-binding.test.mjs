process.env.DSCODE_UPDATE_CHECK = 'off';
process.env.FORCE_COLOR = '0';
process.env.DSCODE_LANGUAGE = 'en';

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sessionFolderMatches } from '../packages/tui/src/session-directory.ts';
import { resolveTarget, resumeFolderWarning } from '../packages/tui/src/index.ts';

// A session chooses its folder once, at creation, and the header keeps it. These
// tests pin the folder comparison and the CLI resolver every --resume/--continue
// launch goes through: a resume across folders still lands on the session's own
// folder, and only the notice differs.

const header = (id, cwd) => ({ id, cwd, createdAt: 1, parentSession: undefined, origin: undefined });

test('one folder matches itself, and a different or prefixed folder does not', () => {
  assert.equal(sessionFolderMatches('/work/a', '/work/a'), true);
  assert.equal(sessionFolderMatches('/work/a', '/work/b'), false);
  // A prefix is not a match: /work/a must not accept /work/ab.
  assert.equal(sessionFolderMatches('/work/a', '/work/ab'), false);
  // The same folder spelled in two Unicode normal forms is one folder, even
  // when neither path exists on this host (no realpath to canonicalize).
  assert.equal(sessionFolderMatches('/work/e\u0301tude', '/work/\u00e9tude'), true);
  // A pre-cwd header stays resumable anywhere.
  assert.equal(sessionFolderMatches(undefined, '/work/b'), true);
  assert.equal(sessionFolderMatches('', '/work/b'), true);
});

test('a symlinked or macOS /var path resolves to the same folder', t => {
  const root = mkdtempSync(join(tmpdir(), 'dscode-binding-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const real = join(root, 'project');
  const link = join(root, 'link');
  mkdirSync(real);
  symlinkSync(real, link, 'dir');
  assert.equal(sessionFolderMatches(link, real), true);
  assert.equal(sessionFolderMatches(real, link), true);
});

test('resolveTarget still resumes a session pinned to another folder', async () => {
  // The folder binding no longer blocks the resume: the session works in its
  // own folder and the runner's notice is what reports the move, so the
  // resolver only has to hand back the target.
  const persistence = { list: async () => [{ header: header('session-a', '/work/a') }] };
  const crossed = await resolveTarget({ kind: 'resume', sessionId: 'session-a' }, persistence, '/work/b');
  assert.deepEqual(crossed, { sessionId: 'session-a', resume: true });
  const same = await resolveTarget({ kind: 'resume', sessionId: 'session-a' }, persistence, '/work/a');
  assert.deepEqual(same, { sessionId: 'session-a', resume: true });
});

test('resolveTarget still resumes a pre-cwd session and reports id-prefix ambiguity', async () => {
  const legacy = { list: async () => [{ header: header('session-legacy', undefined) }] };
  assert.deepEqual(
    await resolveTarget({ kind: 'resume', sessionId: 'session-leg' }, legacy, '/work/b'),
    { sessionId: 'session-legacy', resume: true },
  );
  const ambiguous = {
    list: async () => [{ header: header('session-aaa', '/work/a') }, { header: header('session-aab', '/work/a') }],
  };
  await assert.rejects(
    resolveTarget({ kind: 'resume', sessionId: 'session-aa' }, ambiguous, '/work/a'),
    /ambiguous/i,
  );
});

test('the cross-folder notice names both folders and stays silent when they agree', () => {
  const warning = resumeFolderWarning('/work/a', '/work/b');
  assert.match(warning, /belongs to \/work\/a/);
  assert.match(warning, /launched in \/work\/b/);
  assert.equal(resumeFolderWarning('/work/a', '/work/a'), undefined);
  // A pre-cwd session runs where it was launched: there is no move to report.
  assert.equal(resumeFolderWarning(undefined, '/work/b'), undefined);
});

test('--continue keeps its current-folder scope', async () => {
  const persistence = {
    list: async () => [
      { header: { ...header('session-a', '/work/a'), createdAt: 1 } },
      { header: { ...header('session-b', '/work/b'), createdAt: 2 } },
    ],
  };
  const local = await resolveTarget({ kind: 'latest' }, persistence, '/work/a');
  assert.deepEqual(local, { sessionId: 'session-a', resume: true });
  await assert.rejects(resolveTarget({ kind: 'latest' }, persistence, '/work/c'), /no persisted session/);
});
