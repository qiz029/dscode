import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { socketDirectory } from '../plugins/session-bridge/paths.mjs';
import { parseOpenRouterModels } from '../plugins/openrouter/models.mjs';
import { LISTING } from '../tests/fixtures/openrouter-listing.mjs';

// Model pickers may enumerate every provider before a probe selects its route.
export function seedDesktopProviderCatalogs(home) {
  writeFileSync(join(home, 'openrouter-models.json'), JSON.stringify({ version: 2, fetchedAt: Date.now(), models: parseOpenRouterModels(LISTING) }));
  writeFileSync(join(home, 'grok-models.json'), JSON.stringify({ version: 1, fetchedAt: Date.now(), models: {
    'grok-4.6': { name: 'Grok fixture', contextWindow: 131072, maxOutput: 4096, efforts: ['low', 'high'], defaultEffort: 'high' },
  } }));
}

// Socket names hash the canonical home, so resolve them before deleting it.
export function removeDesktopProbeHome(home) {
  try {
    rmSync(socketDirectory(home), { recursive: true, force: true });
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
