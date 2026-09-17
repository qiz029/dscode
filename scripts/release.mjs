import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { hubProfileVersionSchema, profileDraftSchema, dshProfileManifestSchema } from '@dsh-plugin-hub/schemas';
import { root, manifest } from './harness.mjs';
import { stageTuiForPack } from './build-tui.mjs';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

/**
 * Pack a workspace-linked bundle into a release-local tarball.
 *
 * The vendored terminal is not on npm, so the release carries the exact bytes it
 * was validated with: the archive ships `bundles/<name>-<version>.tgz` and the
 * release declares the same npm-shaped descriptor (name@version + integrity) a
 * published package would. Our own install path consumes the embedded tarball;
 * a Hub import that must fetch from the registry needs the package published.
 */
function packLocalBundle(packageName, directory) {
  const staging = join(root, 'artifacts/local/bundle-pack');
  mkdirSync(staging, { recursive: true });
  // The staged copy exports the compiled lib because an installed package cannot
  // rely on Node's type stripping the way the repository checkout does.
  // The lock entry points at the workspace package; stage exactly that one.
  const workspace = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  if (workspace.name !== packageName) throw new Error('Workspace link ' + directory + ' is not ' + packageName);
  const source = stageTuiForPack(join(root, 'artifacts/local/tui-stage'));
  const result = spawnSync('npm', ['pack', source, '--pack-destination', staging, '--json'], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error('Could not pack ' + packageName + ': ' + (result.stderr || result.stdout || 'unknown error'));
  const [packed] = JSON.parse(result.stdout);
  const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
  return { packageName, file: join(staging, packed.filename), name: packed.filename, version: manifest.version, integrity: packed.integrity };
}

export async function buildRelease() {
  dshProfileManifestSchema.parse(manifest);
  const metadata = JSON.parse(readFileSync(join(root, 'config/preset.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const runtimeVersion = manifest.dependencies['@deepseek-ai/dsh'];
  const runtime = { range: runtimeVersion, version: runtimeVersion, integrity: lock.packages['node_modules/@deepseek-ai/dsh'].integrity };
  /** Tarballs packed for this release, keyed by archive entry name. */
  const embeddedBundles = [];
  const bundles = manifest.dsh.profile.bundles.map((packageName, i, names) => {
    const installed = lock.packages[`node_modules/${packageName}`];
    if (installed?.link) {
      const packed = packLocalBundle(packageName, join(root, installed.resolved));
      embeddedBundles.push(packed);
      return {
        packageName, selector: packed.version, version: packed.version,
        installSpec: `${packageName}@${packed.version}`, integrity: packed.integrity,
        sourceKind: 'npm', before: [], after: i ? [names[i - 1]] : [],
      };
    }
    if (!installed?.integrity || installed.version !== manifest.dependencies[packageName]) throw new Error(`Bundle not locked: ${packageName}`);
    return {
      packageName, selector: installed.version, version: installed.version,
      installSpec: `${packageName}@${installed.version}`, integrity: installed.integrity,
      sourceKind: 'npm', before: [], after: i ? [names[i - 1]] : [],
    };
  });
  const inputs = [
    { key: 'DSH_AGENTS_HOME', label: 'Isolated user skill home', description: 'Set to an absolute directory dedicated to this harness, e.g. $DSH_HOME/agents; export for both import and launch. Prevents global computer-use skill collisions.', required: true, secret: false },
    { key: 'DEEPSEEK_API_KEY', label: 'DeepSeek API key', description: 'Optional if another provider is configured via /model or /provider. Supply locally; never embed credentials in a release.', required: false, secret: true },
    { key: 'OPENROUTER_API_KEY', label: 'OpenRouter API key', description: 'Optional; /provider openrouter uses OpenRouter and its live model listing. Supply locally; never embed credentials in a release.', required: false, secret: true },
  ];
  const patchYaml = readFileSync(join(root, 'config/cordis.patch.yml'), 'utf8');
  const draft = profileDraftSchema.parse({
    schemaVersion: 1, slug: metadata.slug, name: metadata.name,
    description: metadata.description, visibility: 'private', dsh: runtimeVersion,
    runtime, bundles, patch: [], patchYaml, inputs,
  });
  const unsigned = hubProfileVersionSchema.parse({
    schemaVersion: 1, version: metadata.version, name: metadata.name,
    description: metadata.description, dsh: runtimeVersion, runtime, bundles,
    patch: [], patchYaml, inputs, publishedAt: metadata.createdAt,
    verification: { structural: 'passed', composition: 'local_required', activation: 'local_required', platform: 'darwin' },
  });
  const release = { ...unsigned, contentHash: `sha256:${createHash('sha256').update(canonical(unsigned)).digest('hex')}` };
  const directory = join(root, 'artifacts');
  mkdirSync(directory, { recursive: true });
  const json = value => JSON.stringify(value, null, 2) + '\n';
  writeFileSync(join(directory, 'profile-draft.json'), json(draft));
  writeFileSync(join(directory, 'release.json'), json(release));
  const archive = join(directory, `${metadata.slug}-${metadata.version}.dshprofile`);
  const entries = {
    'release.json': strToU8(json(release)),
    'README.txt': strToU8('Unpublished local release. Hub importer verifies release.json and contentHash. Use the repository npm ci path for the tested dependency lock. Hub installs must be activated and checked separately; their resolver does not carry npm overrides or package-lock.json. DSH_AGENTS_HOME is required to isolate global skills. No credentials included.\n'),
  };
  // The vendored terminal ships inside the archive; the Hub reader ignores extra
  // entries, and our own install path unpacks them into the profile.
  for (const bundle of embeddedBundles) entries[`bundles/${bundle.name}`] = new Uint8Array(readFileSync(bundle.file));
  writeFileSync(archive, zipSync(entries, { level: 0, mtime: new Date(metadata.createdAt) }));
  // Verify using the actual Hub CLI importer, not only our hash implementation.
  const { readProfileArchive } = await import(pathToFileURL(join(root, 'node_modules/@dsh-plugin-hub/cli/dist/profile-archive.js')).href);
  await readProfileArchive(archive);
  return { archive, release, draft };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const result = await buildRelease();
  console.log(`Validated with Hub schemas and archive reader: ${result.archive}\n${result.release.contentHash}\nNot published; Hub activation remains local_required.`);
}
