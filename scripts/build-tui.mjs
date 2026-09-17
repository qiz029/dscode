import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const root = resolve(import.meta.dirname, '..');
const source = join(root, 'packages/tui/src');
const destination = join(root, 'packages/tui/lib');

/**
 * Compile the vendored terminal for distribution.
 *
 * The repository runs `packages/tui/src` directly through Node's type stripping, but
 * installed packages live under `node_modules`, where stripping is refused — so the
 * published forms (.dshprofile bundle, npm bundle) must carry real JavaScript. This
 * transpiles every source file and rewrites the explicit `.ts` import specifiers to
 * `.mjs`, nothing else: type-only information is erased, no bundling, no minification.
 */
export function buildTui({ quiet = false } = {}) {
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? walk(join(directory, entry.name))
    : [join(directory, entry.name)]);
  let compiled = 0, copied = 0;
  for (const file of walk(source)) {
    const target = join(destination, relative(source, file));
    mkdirSync(join(target, '..'), { recursive: true });
    if (!file.endsWith('.ts')) {
      cpSync(file, target);
      copied += 1;
      continue;
    }
    const code = readFileSync(file, 'utf8');
    const { outputText, diagnostics } = ts.transpileModule(code, {
      fileName: file,
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, sourceMap: false },
      reportDiagnostics: true,
    });
    const fatal = (diagnostics ?? []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
    if (fatal.length > 0) {
      throw new Error('Could not transpile ' + relative(root, file) + ': ' + ts.flattenDiagnosticMessageText(fatal[0].messageText, ' '));
    }
    // Relative imports carry explicit .ts extensions; the compiled tree is .mjs.
    const rewritten = outputText.replace(/(from\s+['"])(\.[^'"]+)\.ts(['"])/g, '$1$2.mjs$3');
    writeFileSync(target.replace(/\.ts$/, '.mjs'), rewritten);
    compiled += 1;
  }
  if (!quiet) console.log(`TUI build: ${compiled} modules compiled, ${copied} assets copied → packages/tui/lib`);
  return destination;
}

/**
 * Stage a publishable copy of the terminal: the compiled entry points plus the
 * sources for reference. The workspace manifest exports `src` (Node strips types
 * there); the staged manifest exports `lib`, because an installed package lives
 * under node_modules where stripping is refused.
 */
export function stageTuiForPack(directory, { quiet = true } = {}) {
  buildTui({ quiet });
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  for (const entry of ['src', 'lib']) cpSync(join(root, 'packages/tui', entry), join(directory, entry), { recursive: true });
  for (const entry of ['cordis.patch.yml', 'LICENSE']) cpSync(join(root, 'packages/tui', entry), join(directory, entry));
  const manifest = JSON.parse(readFileSync(join(root, 'packages/tui/package.json'), 'utf8'));
  manifest.main = 'lib/index.mjs';
  manifest.exports = {
    '.': { default: './lib/index.mjs' },
    './startup': { default: './lib/startup.mjs' },
    './session-query': { default: './lib/session-query.mjs' },
    './invariant': { default: './lib/invariant.mjs' },
    './cordis.patch.yml': './cordis.patch.yml',
    './package.json': './package.json',
  };
  manifest.files = ['lib', 'src', 'cordis.patch.yml', 'LICENSE'];
  writeFileSync(join(directory, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  return directory;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) buildTui();
