import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { patchTui } from './patch-tui.mjs';
import { dscodeFilterModels, patchModelSearch } from './patch-model-search.mjs';

// /model on the real patched Ink panel: typing searches at once (letters are never shortcuts),
// the first Enter or arrow focuses the first match, Enter on a focused row selects it, Esc
// clears the search and then closes, Tab opens providers and Ctrl+R retries.
const root = new URL('../', import.meta.url);
patchTui(root.pathname);
const source = readFileSync(new URL('node_modules/dsh-code/lib/index.mjs', root), 'utf8');
assert.equal(patchModelSearch(source), source, 'the model search patch is idempotent');
assert.throws(() => patchModelSearch('unknown upstream'), /drift/);
const entry = new URL(`node_modules/dsh-code/lib/.dscode-model-search-probe-${process.pid}.mjs`, root);
writeFileSync(entry, source + '\nexport { ModelPanel, render, import_react as react, visibleColumns };\n');
const tick = (ms = 40) => new Promise(resolve => setTimeout(resolve, ms));
const row = (provider, providerName, model, modelName) => ({ provider, providerName, model, modelName, reasoning: { efforts: [] } });
const rows = [
  row('deepseek-official', 'DeepSeek', 'deepseek-flash', 'DeepSeek Flash'),
  row('openrouter', 'OpenRouter', 'deepseek/deepseek-v4-flash', 'DeepSeek V4 Flash'),
  row('openrouter', 'OpenRouter', 'anthropic/claude-sonnet-4.5', 'Anthropic: Claude Sonnet 4.5'),
  row('openrouter', 'OpenRouter', 'openai/gpt-5', 'OpenAI: GPT-5'),
  row('openrouter', 'OpenRouter', 'qwen/qwen3-coder', 'Qwen: Qwen3 Coder'),
];
assert.deepEqual(dscodeFilterModels(rows, 'openrouter CLAUDE').map(item => item.model), ['anthropic/claude-sonnet-4.5'], 'every word must match, ignoring case');
assert.deepEqual(dscodeFilterModels(rows, 'deepseek').map(item => item.model).sort(), ['deepseek-flash', 'deepseek/deepseek-v4-flash'], 'ranked results keep only matching rows');
assert.equal(dscodeFilterModels(rows, '   '), rows);
try {
  const ui = await import(entry.href);
  async function panel(run, columns = 80) {
    const stdin = new PassThrough(), stdout = new PassThrough(), stderr = new PassThrough();
    Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
    Object.assign(stdout, { columns, rows: 30, isTTY: true });
    const frames = [], errors = [], selected = [], actions = [];
    stdout.on('data', data => frames.push(data.toString()));
    stderr.on('data', data => errors.push(data.toString()));
    const mounted = ui.render(ui.react.createElement(ui.ModelPanel, {
      directory: { rows, failures: [] }, current: 'deepseek-official/deepseek-flash',
      onSelect: item => selected.push(`${item.provider}/${item.model}`), onProviders: () => actions.push('providers'),
      onRetry: () => actions.push('retry'), onClose: () => actions.push('close'),
    }), { stdin, stdout, stderr, debug: true, patchConsole: false, exitOnCtrlC: false });
    const frame = () => frames.map(value => stripVTControlCharacters(value)).filter(value => value.trim() !== '').at(-1) ?? '';
    try {
      await tick();
      assert(frames.length > 0, `No model panel render: ${errors.join('')}`);
      await run({ input: async value => { stdin.write(value); await tick(); }, frame, selected, actions });
      assert.equal(errors.length, 0, errors.join(''));
      for (const line of frame().split('\n')) assert(ui.visibleColumns(line) <= columns, `Overflow at ${columns} columns: ${line}`);
    } finally { mounted.unmount(); mounted.cleanup(); stdin.destroy(); stdout.destroy(); stderr.destroy(); }
  }
  for (const columns of [48, 80, 120]) {
    await panel(async ({ input, frame, selected, actions }) => {
      if (columns >= 80) assert.match(frame(), /1\/5 · type to search/, frame());
      assert.match(frame(), /❯ DeepSeek · DeepSeek Flash/, 'the current model is focused on open');
      await input('claude');
      assert.match(frame(), /Claude Sonnet 4\.5/);
      assert.doesNotMatch(frame(), /GPT-5|Qwen3/);
      assert.doesNotMatch(frame(), /❯/, 'a changed search focuses nothing');
      if (columns >= 80) assert.match(frame(), /1 match · search: claude/, frame());
      await input('q');
      await input('r');
      assert.deepEqual(actions, [], 'typed q and r search instead of closing or retrying');
      assert.match(frame(), /no models match the search/);
      await input('\x7f');
      await input('\x7f');
      await input('\r');
      assert.deepEqual(selected, [], 'the first Enter only focuses the first match');
      assert.match(frame(), /❯ OpenRouter · Anthropic: Claude/);
      await input('\r');
      assert.deepEqual(selected, ['openrouter/anthropic/claude-sonnet-4.5'], 'Enter on the focused row selects it');
    }, columns);
  }
  await panel(async ({ input, frame, selected, actions }) => {
    await input('deepseek');
    const ranked = dscodeFilterModels(rows, 'deepseek');
    await input('\x1b[B');
    assert.match(frame(), new RegExp(`❯ ${ranked[0].providerName} · ${ranked[0].modelName}`), 'the first arrow focuses the first match');
    await input('\x1b[B');
    await input('\r');
    assert.deepEqual(selected, [`${ranked[1].provider}/${ranked[1].model}`], 'arrows then move the focus');
    await input('\x1b');
    await tick();
    assert.match(frame(), /GPT-5/, 'Esc clears the search');
    assert.match(frame(), /1\/5 · type to search/);
    assert.deepEqual(actions, []);
    await input('\t');
    await input('\x12');
    await input('\x1b');
    await tick();
    assert.deepEqual(actions, ['providers', 'retry', 'close'], 'Tab, Ctrl+R, and Esc on an empty search keep their actions');
  });
  await panel(async ({ input, selected }) => {
    await input('\r');
    assert.deepEqual(selected, ['deepseek-official/deepseek-flash'], 'Enter right after opening selects the focused current model');
  });
  console.log('Model search passed: real Ink /model panel searches as you type, focuses the first match on Enter or an arrow, selects on Enter, clears then closes on Esc, and keeps Tab and Ctrl+R.');
} finally { rmSync(entry, { force: true }); }
