import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { zipSync, strToU8 } from 'fflate';
import { hubProfileVersionSchema, profileDraftSchema, dshProfileManifestSchema } from '@dsh-plugin-hub/schemas';
import { root, manifest } from './harness.mjs';

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(key => value[key] !== undefined).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

export async function buildRelease() {
  dshProfileManifestSchema.parse(manifest);
  const metadata = JSON.parse(readFileSync(join(root, 'config/preset.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const runtimeVersion = manifest.dependencies['@deepseek-ai/dsh'];
  const runtime = { range: runtimeVersion, version: runtimeVersion, integrity: lock.packages['node_modules/@deepseek-ai/dsh'].integrity };
  const bundles = manifest.dsh.profile.bundles.map((packageName, i, names) => {
    const installed = lock.packages[`node_modules/${packageName}`];
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
    { key: 'OPENROUTER_API_KEY', label: 'OpenRouter API key', description: 'Optional; /provider openrouter routes the DeepSeek models through OpenRouter. Supply locally; never embed credentials in a release.', required: false, secret: true },
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
  writeFileSync(archive, zipSync({
    'release.json': strToU8(json(release)),
    'README.txt': strToU8('Unpublished local release. Hub importer verifies release.json and contentHash. Use the repository npm ci path for the tested dependency lock. Hub installs must be activated and checked separately; their resolver does not carry npm overrides or package-lock.json. DSH_AGENTS_HOME is required to isolate global skills. No credentials included.\n'),
  }, { level: 0, mtime: new Date(metadata.createdAt) }));
  // Verify using the actual Hub CLI importer, not only our hash implementation.
  const { readProfileArchive } = await import(pathToFileURL(join(root, 'node_modules/@dsh-plugin-hub/cli/dist/profile-archive.js')).href);
  await readProfileArchive(archive);
  return { archive, release, draft };
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const result = await buildRelease();
  console.log(`Validated with Hub schemas and archive reader: ${result.archive}\n${result.release.contentHash}\nNot published; Hub activation remains local_required.`);
}
