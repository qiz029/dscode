import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * Read the DSCODE agent composition with its plugin placeholders resolved.
 *
 * `agent.cordis.yml` names three DSCODE plugins through placeholders, because a source
 * checkout mounts them by absolute path and the npm bundle by export name.
 *
 * @param root - repository root.
 * @returns the composition text, ready to be declared.
 */
export function dscodeComposition(root) {
  return readFileSync(join(root, 'presets/dscode/agent.cordis.yml'), 'utf8')
    .replace('DSCODE_POLICY_PLUGIN', JSON.stringify(join(root, 'plugins/dscode/index.mjs')))
    .replace('DSCODE_REVIEW_PLUGIN', JSON.stringify(join(root, 'plugins/code-review/index.mjs')))
    .replace('DSCODE_COMPACTION_PLUGIN', JSON.stringify(join(root, 'plugins/compaction/engine.mjs')));
}

/**
 * Render the DSCODE preset as one `@deepseek-ai/dsh-agent-preset` declaration row.
 *
 * DSH 0.1.7 retired preset discovery from directories: the registry reads declaration
 * ROWS and neither scans a root nor accepts a preset path, so the composition travels
 * inside the profile patch instead of a provisioned `agent-presets` tree. The rows are
 * indented as text rather than re-serialised, which keeps both the `!!js` expressions
 * and the comments that explain why each row sits in the realm it does.
 *
 * @param root - repository root, holding the preset's metadata.
 * @param composition - the agent composition rows, placeholders already resolved.
 * @returns one patch document declaring the preset.
 */
export function presetDeclaration(root, composition) {
  const meta = parse(readFileSync(join(root, 'presets/dscode/preset.yml'), 'utf8'));
  const rows = composition.split('\n').map(line => (line.trim() === '' ? '' : ' '.repeat(10) + line)).join('\n');
  return [
    '# The DSCODE preset: one `@deepseek-ai/dsh-agent-preset` declaration carrying the',
    '# agent-plane composition of `presets/dscode/agent.cordis.yml`.',
    '- insert:',
    '    - id: preset-dscode',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: dscode',
    `        name: ${JSON.stringify(meta.name)}`,
    `        description: ${JSON.stringify(meta.description)}`,
    `        order: ${meta.order}`,
    '        plugins:',
    rows.replace(/\n+$/, ''),
    '',
  ].join('\n');
}
