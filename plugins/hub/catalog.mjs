import { z } from 'zod';
import { npmPackageNameSchema, exactSemverSchema, pluginRecordSchema, registrySearchResponseSchema } from '@dsh-plugin-hub/schemas';
import semver from 'semver';

export const hubApi = 'https://api.dshpluginhub.ai/api/v1';
export const hubWebsite = 'https://dshpluginhub.ai';
const searchInput = z.object({ query: z.string().max(300).default(''), category: z.string().max(60).default(''), cursor: z.string().max(2000).optional(), page: z.number().int().min(1).max(100000).default(1) }).strict();
const categoriesSchema = z.object({ items: z.array(z.object({ name: z.string().min(1).max(60), displayName: z.string().max(120),
  displayNameZh: z.string().max(120).optional(), description: z.string().max(2000).optional(), descriptionZh: z.string().max(2000).optional(), count: z.number().int().nonnegative() })).max(100) });

/** Read-only access to our public Hub. Never executes catalog-provided commands. */
export class HubCatalog {
  constructor({ fetch: fetcher = globalThis.fetch, timeoutMs = 15000, maxBytes = 4 * 1024 * 1024 } = {}) {
    this.fetch = fetcher; this.timeoutMs = timeoutMs; this.maxBytes = maxBytes;
  }
  async get(path, schema, signal) {
    const response = await this.fetch(`${hubApi}${path}`, { headers: { accept: 'application/json' }, redirect: 'error',
      signal: AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(signal ? [signal] : [])]) });
    if (!response.ok) { await response.body?.cancel(); throw Error(`Plugin Hub request failed (HTTP ${response.status}).`); }
    const chunks = []; let size = 0;
    const reader = response.body?.getReader();
    if (!reader) throw Error('Plugin Hub returned an empty response.');
    try {
      while (true) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > this.maxBytes) throw Error('Plugin Hub response is too large.');
        chunks.push(value);
      }
    } finally { await reader.cancel(); reader.releaseLock(); }
    let payload; try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw Error('Plugin Hub returned invalid JSON.'); }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) throw Error('Plugin Hub returned unsupported catalog data.');
    return parsed.data;
  }
  categories(signal) { return this.get('/categories', categoriesSchema, signal); }
  async search(input = {}, signal) {
    const { query, category, cursor, page } = searchInput.parse(input);
    const params = new URLSearchParams({ q: query.trim(), limit: '20' });
    if (category) params.set('category', category);
    if (cursor) params.set('cursor', cursor);
    else params.set('page', String(page));
    const result = await this.get(`/packages?${params}`, registrySearchResponseSchema, signal);
    return { ...result, nextPage: !cursor && typeof result.total === 'number' && result.items.length > 0 && page * 20 < result.total ? page + 1 : null };
  }
  async package(packageName, signal) {
    return this.get(`/packages/resolve?name=${encodeURIComponent(npmPackageNameSchema.parse(packageName))}`, pluginRecordSchema, signal);
  }
}

/** Hub metadata is a preflight hint. Official pluginManager remains the installation authority. */
export function desktopCandidate(record, environment, version = record.latestVersion) {
  exactSemverSchema.parse(version);
  const release = record.versions.find(item => item.version === version);
  const reasons = [];
  if (record.deprecated) reasons.push('This package is deprecated.');
  if (!release) return { version, spec: null, reasons: [...reasons, 'This version is absent from the Hub.'] };
  if (release.yanked) reasons.push('This version was withdrawn.');
  const source = release.source;
  const sameIdentity = release.manifest.name === record.packageName && release.manifest.version === version &&
    source.kind === 'npm' && source.packageName === record.packageName && source.version === version;
  if (!sameIdentity) reasons.push('Desktop installation requires matching npm package and version metadata.');
  const { dsh, node, platforms, surfaces } = release.compatibility;
  if (!surfaces.some(value => ['desktop', 'web', 'any'].includes(value))) reasons.push('This version does not support the Desktop interface.');
  if (platforms.length && !platforms.includes(environment.platform)) reasons.push(`This version does not support ${environment.platform}.`);
  if (!semver.validRange(dsh) || !semver.satisfies(environment.runtime, dsh, { includePrerelease: true })) reasons.push(`Requires DSH ${dsh}; this Desktop uses ${environment.runtime}.`);
  if (node && (!semver.validRange(node) || !semver.satisfies(environment.node, node))) reasons.push(`Requires Node ${node}; this Host uses ${environment.node}.`);
  // Construct the exact spec ourselves; never pass source.installSpec or tarballUrl to the installer.
  return { version, spec: sameIdentity ? `${record.packageName}@${version}` : null, reasons, compatibility: release.compatibility };
}

export function catalogSummary(record) {
  return { packageName: record.packageName, displayName: record.displayName, summary: record.summary,
    latestVersion: record.latestVersion, categories: record.categories, claimed: record.claimed, verified: record.verified,
    deprecated: record.deprecated, security: record.security ?? null, weeklyDownloads: record.weeklyDownloads,
    url: `${hubWebsite}/plugins/${encodeURIComponent(record.slug)}` };
}

export function catalogDetail(record, environment) {
  return { ...catalogSummary(record), description: record.description, repository: record.repository,
    license: record.license ?? null, candidate: desktopCandidate(record, environment) };
}
