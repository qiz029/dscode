process.env.DSCODE_UPDATE_CHECK = 'off';
process.env.FORCE_COLOR = '3';
process.env.DSCODE_LANGUAGE = 'en';

import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { createElement } from 'react';
import { render } from 'ink';
import {
  DscodeActivityLine,
  DscodeCompactionLine,
  DscodeEffortPanel,
  ModelPanel,
  StatusLine,
} from '../packages/tui/src/app.ts';
import { visibleColumns } from '../packages/tui/src/render/markdown.ts';
import { createTranscriptView } from '../packages/tui/src/render/projection.ts';
import { setTheme } from '../packages/tui/src/theme.ts';

// These render the vendored terminal's own components into an in-memory stream, so
// "the patch produced this frame" becomes "the source produces this frame".

const tick = (ms = 60) => new Promise(resolve => setTimeout(resolve, ms));

async function mount(Component, props, { columns = 80, rows = 30 } = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.assign(stdin, { isTTY: true, setRawMode() {}, ref() {}, unref() {} });
  Object.assign(stdout, { columns, rows, isTTY: true });
  const frames = [];
  const errors = [];
  stdout.on('data', data => frames.push(data.toString()));
  stderr.on('data', data => errors.push(data.toString()));
  const mounted = render(createElement(Component, props), { stdin, stdout, stderr, debug: true, patchConsole: false, exitOnCtrlC: false });
  await tick();
  /** Ink writes one frame per update in debug mode; the last frame carrying text is the current picture. */
  const frame = () => {
    for (let index = frames.length - 1; index >= 0; index--) {
      const text = stripVTControlCharacters(frames[index]);
      if (text.trim() !== '') return text;
    }
    return '';
  };
  return {
    frame,
    frames,
    errors,
    columns,
    async write(value) {
      stdin.write(value);
      await tick(45);
    },
    close() {
      mounted.unmount();
      mounted.cleanup();
      stdin.destroy();
      stdout.destroy();
      stderr.destroy();
    },
  };
}

/** Every rendered row must fit the terminal width. */
function assertFits(ui) {
  assert.equal(ui.errors.length, 0, ui.errors.join(''));
  const text = ui.frame();
  assert.notEqual(text.trim(), '', 'the component rendered nothing');
  // Every frame Ink wrote must fit the terminal width, not only the current picture.
  for (const frame of ui.frames ?? []) {
    for (const line of stripVTControlCharacters(frame).split('\n')) {
      assert(visibleColumns(line) <= ui.columns, `overflow at ${ui.columns} columns: ${line}`);
    }
  }
}

const deepseekRow = {
  provider: 'deepseek-official',
  providerName: 'DeepSeek',
  model: 'deepseek-flash',
  modelName: 'deepseek-flash',
  reasoning: { defaultEffort: 'high', efforts: ['off', 'low', 'high', 'max', 'ultra'].map(id => ({ id, name: id, description: `Choose ${id}` })) },
};

test('the effort bar renders four detents and moves the cursor between them', async () => {
  for (const theme of ['dark', 'light']) {
    for (const columns of [48, 80, 120]) {
      setTheme(theme);
      const selected = [];
      const ui = await mount(DscodeEffortPanel, {
        row: deepseekRow,
        current: 'high',
        animations: false,
        select: id => selected.push(id),
        back: () => {},
        onExit: () => {},
      }, { columns });
      try {
        assertFits(ui);
        assert.match(ui.frame(), /low\s+high\s+max\s+ultra/, ui.frame());
        // Right arrow: high -> max -> ultra; Enter commits the highlighted detent.
        await ui.write('\u001b[C');
        await ui.write('\u001b[C');
        await ui.write('\r');
        assert.deepEqual(selected, ['ultra'], 'Enter selects the highlighted detent');
        assertFits(ui);
      } finally {
        ui.close();
      }
    }
  }
  setTheme('dark');
});

test('the status line leads with the title and pins the telemetry right', async () => {
  const facts = {
    model: 'deepseek-official/deepseek-flash',
    effort: 'ultra',
    title: 'Migrating the TUI',
    cwd: 'proj',
    branch: 'main',
    sessionId: 'abc123',
    sandbox: '',
    plan: false,
    permission: 'accept-edits',
    fullSessionId: 's-1',
    telemetry: 'current: ~12.3 tps | cache hit: 96.0%',
  };
  // A real stats object keeps every field the status line reads populated.
  const base = createTranscriptView().stats;
  const stats = {
    ...base,
    turns: 2,
    steps: 3,
    lastPromptTokens: 4300,
    contextWindow: 10000,
    reasoningEffort: 'ultra',
    usage: { ...base.usage, uncachedInputTokens: 4000, cacheReadTokens: 300, cacheWriteTokens: 0, outputTokens: 900 },
  };
  const ui = await mount(StatusLine, {
    facts,
    stats,
    busy: false,
    columns: 120,
    items: ['model', 'title', 'permission', 'context'],
    animated: false,
  }, { columns: 120 });
  try {
    assertFits(ui);
    const text = ui.frame();
    // Row 1 leads with the title and carries the permission badge beside it.
    assert.match(text, /Migrating the TUI ｜ accept-edits/, text);
    // Row 2's right edge is the telemetry: the provider: model @ effort header plus the live figures.
    assert.match(text, /deepseek-flash @ ultra \| current: /, text);
    assert.match(text, /cache hit:/, text);
  } finally {
    ui.close();
  }
});

test('the activity line names the running tool and reports the turn', async () => {
  const entries = [
    { kind: 'tool', name: 'bash', preview: 'ls -la', state: 'running', arguments: '{"description":"list the tree"}' },
  ];
  const ui = await mount(DscodeActivityLine, { entries, streaming: true, since: Date.now() - 5000, animated: false }, { columns: 100 });
  try {
    assertFits(ui);
    const text = ui.frame();
    assert.match(text, /Running · bash/, text);
    assert.match(text, /this turn/, text);
    assert.match(text, /Esc to interrupt/, text);
  } finally {
    ui.close();
  }
});

test('the compaction indicator draws the board with its label', async () => {
  const ui = await mount(DscodeCompactionLine, { since: Date.now() - 3000, rows: 5, animated: false }, { columns: 100 });
  try {
    assertFits(ui);
    assert.match(ui.frame(), /Compacting context, please wait/, ui.frame());
  } finally {
    ui.close();
  }
});

test('the model picker lists one provider and narrows as you type', async () => {
  const directory = {
    rows: [
      { provider: 'openrouter', providerName: 'OpenRouter', model: 'z-ai/glm-5.3', modelName: 'GLM 5.3' },
      { provider: 'openrouter', providerName: 'OpenRouter', model: 'z-ai/glm-5.2', modelName: 'GLM 5.2' },
      { provider: 'openrouter', providerName: 'OpenRouter', model: 'moonshotai/kimi-k2.6', modelName: 'Kimi K2.6' },
    ],
    failures: [],
  };
  const picked = [];
  const ui = await mount(ModelPanel, {
    directory,
    error: undefined,
    current: 'openrouter/z-ai/glm-5.3',
    onSelect: row => picked.push(row.modelName),
    onProviders: undefined,
    onRetry: () => {},
    onClose: () => {},
  }, { columns: 100 });
  try {
    assertFits(ui);
    assert.match(ui.frame(), /GLM 5\.2/, ui.frame());
    assert.match(ui.frame(), /GLM 5\.3/, ui.frame());
    assert.match(ui.frame(), /Kimi K2\.6/, ui.frame());
    // Typing 'glm' leaves only the GLM rows, still in natural order.
    await ui.write('glm');
    const narrowed = ui.frame();
    assert.match(narrowed, /GLM 5\.2/);
    assert.match(narrowed, /GLM 5\.3/);
    assert.doesNotMatch(narrowed, /Kimi/);
  } finally {
    ui.close();
  }
});
