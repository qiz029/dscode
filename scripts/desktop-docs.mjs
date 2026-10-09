import { cpSync, existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

// Developer records contain local verification receipts, not installed usage.
const records = new Set(['verification.md', 'session-messaging-design.md', 'cloud-webapp-host.md',
  'triggers-design.md', 'CONTEXT-HANDOFF.md', 'maintainability.md', 'vendored-tui-upgrade.md']);
const repository = 'https://github.com/qiz029/dscode/blob/main/';

/** Carry current guides; links to unbundled developer files stay repository links. */
export function bundleDesktopDocs(root, destination) {
  const source = join(root, 'docs'), target = join(destination, 'docs');
  if (resolve(source) === resolve(target)) throw Error('Desktop docs destination must be a separate build directory');
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true, filter: path => !records.has(relative(source, path)) });
  const files = readdirSync(target, { recursive: true, withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith('.md'));
  for (const entry of files) {
    const path = join(entry.parentPath, entry.name), sourcePath = join(source, relative(target, path));
    const text = readFileSync(path, 'utf8').replace(/\]\(([^\s)]+)\)/g, (match, link) => {
      if (/^(?:[a-z]+:|#)/i.test(link)) return match;
      const [file, ...fragment] = link.split('#');
      if (existsSync(resolve(dirname(path), file))) return match;
      const sourceTarget = resolve(dirname(sourcePath), file), repoPath = relative(root, sourceTarget).split(sep).join('/');
      if (!existsSync(sourceTarget) || repoPath.startsWith('../')) throw Error(`Unresolved Desktop documentation link: ${sourcePath} -> ${link}`);
      return `](${repository}${repoPath}${fragment.length ? '#' + fragment.join('#') : ''})`;
    });
    writeFileSync(path, text);
  }
}
