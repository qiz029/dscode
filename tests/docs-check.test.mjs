import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkDocs } from '../scripts/check-docs.mjs';

test('the maintained docs library has no broken links and both READMEs index every guide', () => {
  assert.deepEqual(checkDocs(process.cwd()), []);
});

test('the docs check rejects broken links, unindexed guides and README drift', t => {
  const repo = mkdtempSync(join(tmpdir(), 'dscode-docs-check-'));
  t.after(() => rmSync(repo, { recursive: true, force: true }));
  mkdirSync(join(repo, 'docs'), { recursive: true });
  const write = (file, text) => writeFileSync(join(repo, file), text);
  write('docs/guide.md', '# Guide\n');
  write('docs/orphan.md', '# Orphan\n');
  write('README.md', '[guide](docs/guide.md) [gone](docs/missing.md)\n');
  write('README.zh-CN.md', '[guide](docs/guide.md)\n');
  const issues = checkDocs(repo);
  assert(issues.some(issue => issue.includes('broken link: README.md -> docs/missing.md')), issues.join('; '));
  assert(issues.some(issue => issue.includes('not indexed in README.zh-CN.md: docs/orphan.md')), issues.join('; '));
  assert(issues.some(issue => issue.includes('link to different documents')), issues.join('; '));
  // Title and angle-bracket forms must not be mistaken for broken or missing paths.
  write('README.zh-CN.md', '[guide](<docs/guide.md> "Guide") [orphan](docs/orphan.md)\n');
  write('README.md', '[guide](docs/guide.md "Guide") [orphan](docs/orphan.md)\n');
  assert.deepEqual(checkDocs(repo), []);
});
