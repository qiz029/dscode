import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
export function provisionPreset(root, home) {
  const presets = join(home, 'agent-presets');
  const target = join(presets, 'dscode');
  mkdirSync(target, { recursive: true });
  const source = join(root, 'presets/dscode');
  writeFileSync(join(target, 'preset.yml'), readFileSync(join(source, 'preset.yml')));
  writeFileSync(join(target, 'agent.cordis.yml'), readFileSync(join(source, 'agent.cordis.yml'), 'utf8')
    .replace('DSCODE_POLICY_PLUGIN', JSON.stringify(join(root, 'plugins/dscode/index.mjs')))
    .replace('DSCODE_REVIEW_PLUGIN', JSON.stringify(join(root, 'plugins/code-review/index.mjs')))
    .replace('DSCODE_COMPACTION_PLUGIN', JSON.stringify(join(root, 'plugins/compaction/engine.mjs'))));
  return presets;
}
