import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// The documentation library is maintained per release (see AGENTS.md): every guide is
// linked from both READMEs, the two READMEs describe the same document set, and no
// relative link points at a file that is no longer there. Run after editing any
// Markdown; `npm run lint` covers syntax and this covers the library's shape.

const LINK = /(?:\]\(<([^>]+)>|\]\(([^)\s]+?)(?:\s+["'][^"']*["'])?\))/g;
const READMES = ['README.md', 'README.zh-CN.md'];

function linkTargets(text) {
  // Markdown allows an <...> destination, optionally followed by a title; the second
  // alternative is the bare destination.
  return [...text.matchAll(LINK)].map(match => match[1] ?? match[2]);
}

function resolveLink(repo, file, link) {
  const clean = link.replace(/^<|>$/g, '').split('#')[0];
  if (!clean) return null;
  // A link is either rooted at the repository (docs/foo.md from anywhere) or relative
  // to the linking file's directory. Root wins when both could apply.
  const base = existsSync(join(repo, clean)) ? repo : dirname(join(repo, file));
  return normalize(join(base, clean));
}

export function checkDocs(repo) {
  const issues = [];
  const docs = readdirSync(join(repo, 'docs')).filter(name => name.endsWith('.md')).map(name => 'docs/' + name).sort();
  const sources = [...READMES, ...docs];
  const cache = new Map(sources.map(file => [file, readFileSync(join(repo, file), 'utf8')]));
  for (const [file, text] of cache) {
    for (const link of linkTargets(text)) {
      if (/^(?:https?:|mailto:|#)/.test(link)) continue;
      const target = resolveLink(repo, file, link);
      if (target && !existsSync(target)) issues.push(`broken link: ${file} -> ${link}`);
    }
  }
  const linked = file => new Set(linkTargets(cache.get(file)).filter(link => /^docs\//.test(link)));
  for (const readme of READMES) {
    const from = linked(readme);
    for (const doc of docs) if (!from.has(doc)) issues.push(`not indexed in ${readme}: ${doc}`);
  }
  const [first, second] = READMES.map(file => [...linked(file)].sort().join('\n'));
  if (first !== second) issues.push(`the two READMEs link to different documents (${READMES.join(' vs ')})`);
  return issues;
}

const invoked = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href === import.meta.url : false;
if (invoked) {
  const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const issues = checkDocs(repo);
  for (const issue of issues) console.log(issue);
  if (!issues.length) console.log(`Docs check: ${relative(process.cwd(), repo).split(sep).join('/') || '.'} clean`);
  else process.exitCode = 1;
}
