process.env.DSCODE_UPDATE_CHECK = 'off';
process.env.FORCE_COLOR = '3';
process.env.DSCODE_LANGUAGE = 'en';

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BtwPanel,
  DscodeActivityLine,
  DscodeCompactionLine,
  DscodeEffortPanel,
  ModelPanel,
  StatusLine,
} from '../packages/tui/src/app.ts';
import { stripVTControlCharacters } from 'node:util';

import { visibleColumns } from '../packages/tui/src/render/markdown.ts';
import { liveRegionBudget } from '../packages/tui/src/render/inspector.ts';
import { createTranscriptView } from '../packages/tui/src/render/projection.ts';
import { DEFAULT_STATUSLINE_ITEMS, STATUS_ITEMS, layoutStatusBar } from '../packages/tui/src/render/status.ts';
import { formatFooter, setMetricSource } from '../plugins/session-metrics/view.mjs';
import { watchSkills } from '../packages/tui/src/skills.ts';
import { dscodeTelemetryParts } from '../packages/tui/src/dscode/telemetry.ts';
import { createBtwFeed } from '../packages/tui/src/btw.ts';
import { setTheme } from '../packages/tui/src/theme.ts';

import { mount, assertFits, tick } from './fixtures/tui-mount.mjs';

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

test('switching from MiMo medium opens the target effort picker at its own default', async () => {
  const targets = [
    deepseekRow,
    { ...deepseekRow, reasoning: { defaultEffort: 'high', efforts: ['off', 'low', 'high'].map(id => ({ id, name: id })) } },
  ];
  for (const row of targets) {
    const selected = [];
    const ui = await mount(DscodeEffortPanel, {
      row, current: 'medium', animations: false,
      select: id => selected.push(id), back: () => {}, onExit: () => {},
    });
    try {
      assert.doesNotMatch(ui.frame(), /medium/);
      await ui.write('\r');
      assert.deepEqual(selected, ['high']);
    } finally {
      ui.close();
    }
  }
});

test('the footer never borrows MiMo effort from the previous request after a model switch', async () => {
  for (const effort of [undefined, 'high']) {
    const ui = await mount(StatusLine, {
      facts: { model: 'deepseek-official/deepseek-flash', effort, title: '', cwd: '', branch: '', sessionId: '', sandbox: '', permission: '', fullSessionId: '' },
      stats: { ...createTranscriptView().stats, reasoningEffort: 'medium' },
      busy: false, columns: 120, items: ['model'], animated: false,
    }, { columns: 120 });
    try {
      assert.match(ui.frame(), /deepseek-flash/);
      assert.doesNotMatch(ui.frame(), /medium/);
      if (effort) assert.match(ui.frame(), /deepseek-flash @ high/);
    } finally {
      ui.close();
    }
  }
});

test('the status line names the session on row 1 and right-aligns finances on row 2', async () => {
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
    const [row1, row2] = ui.frame().split('\n');
    // Row 1 flows from the left into the right-anchored permission badge; the
    // idle cycle hint rides LEFT of the badge, so the badge holds its columns
    // whether or not the hint is painted.
    assert.match(row1, /Migrating the TUI · deepseek-flash @ ultra · context/, row1);
    assert.ok(row1.trimEnd().endsWith('(shift+tab to cycle) · accept-edits'), row1);
    assert.equal(visibleColumns(row1), 120, 'row 1 fills the terminal');
    assert.match(row2, /-- tps · {5}-- tps avg · {3}-- ctx\s{3,}\$0\.00 (?:🔥|❄️) · {5}-- cache$/, row2);
    assert.equal(visibleColumns(row2), 120, 'the financial group reaches the right edge');
  } finally {
    ui.close();
  }
});

test('the footer keeps skills and the complete financial group when narrow widths add a third row', async () => {
  const dispose = setMetricSource(() => ({ events: [], currentTps: 80, requestActive: true, used: 43, capacity: 100 }));
  try {
    for (const columns of [48, 60, 80, 120]) {
      const reported = [];
      const ui = await mount(StatusLine, {
        facts: { model: 'deepseek-official/deepseek-flash', effort: 'high', title: 'Trigger', cwd: '', branch: '', sessionId: '', sandbox: '', permission: 'auto', fullSessionId: 'split-footer', skills: 28 },
        stats: createTranscriptView().stats,
        busy: true, columns, items: DEFAULT_STATUSLINE_ITEMS, animated: false,
        onRows: rows => reported.push(rows),
      }, { columns });
      try {
        assertFits(ui);
        const rows = ui.frame().split('\n');
        assert.match(rows[1], /80\.0 tps.*43% ctx.*skills\s+28/);
        assert.match(rows.at(-1), /\$0\.00 (?:🔥|❄️) ·\s+-- cache$/);
        assert.equal(visibleColumns(rows.at(-1)), columns, 'finances stay right-aligned on either physical row');
        assert.equal(rows.length, columns === 120 ? 2 : 3);
        assert.equal(reported.at(-1), rows.length, 'IME and viewport receive the actual row count');
      } finally {
        ui.close();
      }
    }
  } finally {
    dispose();
  }
});

test('balance, peak/off-peak and cache move together while a third footer row reduces the transcript budget', () => {
  const facts = {
    model: 'deepseek-official/deepseek-flash', title: '', cwd: '', branch: '', sessionId: '', sandbox: '', permission: 'auto', fullSessionId: '', skills: 28,
    telemetryFigures: { current: '◌   80.0 tps', average: '  65.0 tps avg', context: ' 43% ctx', money: '$0.12 / $9.86 ❄️', cache: '  90.0% cache', turn: '' },
  };
  const stats = createTranscriptView().stats;
  for (const columns of [48, 80, 120]) {
    const layout = layoutStatusBar(facts, stats, columns - 2);
    const financial = layout.row3 ?? layout.row2;
    assert.equal(financial.right.map(span => span.text).join(''), '$0.12 / $9.86 ❄️ ·   90.0% cache');
    assert.equal(layout.row3 !== undefined, columns < 120);
    assert.ok(layout.row2.left.some(group => group.id === 'skills'));
  }
  const chrome = { terminalRows: 30, composerRows: 1, menuRows: 0, gutterRows: 0, notice: false, todo: false, agents: false };
  assert.equal(liveRegionBudget({ ...chrome, statusBarRows: 3 }), liveRegionBudget({ ...chrome, statusBarRows: 2 }) - 1);
});

test('the footer keeps its geometry while a turn changes the live figures', () => {
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
    telemetry: '',
  };
  const items = ['model', 'cwd', 'mode', 'branch', 'context', 'permission', 'turns', 'durations', 'cache', 'tokens', 'title'];
  const base = createTranscriptView().stats;
  const early = {
    ...base,
    turns: 1,
    steps: 2,
    llmMs: 900,
    toolMs: 3_100,
    ttftMs: 900,
    ttftSteps: 1,
    decodeMs: 12_000,
    decodeTokens: 180,
    lastPromptTokens: 1_200,
    contextWindow: 1_000_000,
    usage: { ...base.usage, uncachedInputTokens: 2_100, outputTokens: 430, cacheReadTokens: 88_000, cacheWriteTokens: 0 },
  };
  const late = {
    ...early,
    turns: 999,
    steps: 999,
    llmMs: 9_999_000,
    toolMs: 9_999_000,
    ttftMs: 9_999_000,
    decodeMs: 9_999_000,
    decodeTokens: 999_000,
    lastPromptTokens: 999_000,
    usage: { ...base.usage, uncachedInputTokens: 999_000, outputTokens: 999_000, cacheReadTokens: 9_999_999, cacheWriteTokens: 0 },
  };
  const durationsOf = layout => [...layout.row1.left, ...layout.row2.left]
    .map(group => visibleColumns(group.spans.map(span => span.text).join('')));
  const before = layoutStatusBar(facts, early, 120, { items });
  const after = layoutStatusBar(facts, late, 120, { items });
  // Live figures reshape inside their own fixed columns: every group keeps its
  // width, so nothing after it reflows while a turn runs.
  assert.deepEqual(durationsOf(after), durationsOf(before));
  // The permission badge is the right anchor and never enters the left flow.
  assert.equal(before.row1.right.at(-1).text, 'accept-edits');
  assert.ok(!before.row1.left.some(group => group.spans.some(span => span.text === 'accept-edits')));
  assert.deepEqual(after.row1.right, before.row1.right);
  // Narrowing keeps the badge anchored: width pressure sheds left groups and
  // the cycle hint, never the right anchor.
  assert.equal(layoutStatusBar(facts, early, 60, { items }).row1.right.at(-1).text, 'accept-edits');
  // Row 2's groups keep their membership: only the terminal width may drop one.
  assert.equal(after.row2.left.length, before.row2.left.length);
});

test('the telemetry tint keeps every figure and label, tinting only the readings', () => {
  // The producer's own string is the input: the tint must be lossless, or a
  // qualifier would silently disappear from the rendered footer.
  const value = formatFooter({ cost: 0.42, unknown: false, pending: 0, cache: 87.3 }, 12.8, 200, { current: 24.6, average: 18.2 }, 'en', 'deepseek-official');
  const parts = dscodeTelemetryParts(value);
  assert.equal(parts.map(part => part.text).join(''), value, 'the tint keeps every character');
  assert.deepEqual(parts.filter(part => part.tone !== null), [
    { text: '24.6 tps', tone: 'yellow' },
    { text: '18.2 tps', tone: 'yellow' },
    { text: '87.3%', tone: 'red' },
  ], 'only the readings carry a tier');
  assert.deepEqual(dscodeTelemetryParts(' 99.0% cache').filter(part => part.tone !== null), [{ text: '99.0%', tone: 'blue' }]);
  assert.deepEqual(dscodeTelemetryParts('260.0 tps').filter(part => part.tone !== null), [{ text: '260.0 tps', tone: 'purple' }]);
  assert.deepEqual(dscodeTelemetryParts('    -- tps ·     -- cache').filter(part => part.tone !== null), [], 'an unknown reading keeps the surrounding colour');
});

test('TPS activity animates independently while numbers stay exact and stops during tool waits', async () => {
  for (const animated of [false, true]) {
    let requestActive = true;
    const dispose = setMetricSource(() => ({ events: [], currentTps: 80, requestActive }));
    const ui = await mount(StatusLine, {
      facts: { model: 'deepseek-official/deepseek-flash', title: '', cwd: '', branch: '', sessionId: '', sandbox: '', permission: '', fullSessionId: 'tps-activity' },
      stats: createTranscriptView().stats,
      busy: true, columns: 120, items: ['model'], animated,
    }, { columns: 120 });
    try {
      await tick(300);
      assertFits(ui);
      const frames = ui.frames.map(frame => stripVTControlCharacters(frame)).filter(frame => frame.includes('80.0 tps'));
      assert.ok(frames.length > 0);
      for (const frame of frames) {
        assert.match(frame, /80\.0 tps/);
        assert.doesNotMatch(frame, /~/);
      }
      if (animated) {
        const markers = new Set(frames.map(frame => frame.match(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/)?.[0]).filter(Boolean));
        assert.ok(markers.size >= 2, 'request activity moves even with a constant measured TPS');
      } else {
        assert.match(ui.frame(), /◌ +80\.0 tps/, 'animations off retains a static activity marker');
        assert.doesNotMatch(ui.frame(), /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
      }
      // The turn remains busy (for example, a tool is running), but the model
      // request has ended. The footer's regular poll must remove the marker.
      requestActive = false;
      await tick(1100);
      assert.match(ui.frame(), /80\.0 tps/);
      assert.doesNotMatch(ui.frame(), /[◌⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
      assertFits(ui);
    } finally {
      ui.close();
      dispose();
    }
  }
});

test('the footer reports the loaded skill count from the live catalog', () => {
  const facts = {
    model: 'deepseek-official/deepseek-flash',
    effort: 'ultra',
    title: '',
    cwd: 'proj',
    branch: '',
    sessionId: 'abc123',
    sandbox: '',
    plan: false,
    permission: 'accept-edits',
    fullSessionId: 's-1',
    telemetry: '',
  };
  const stats = createTranscriptView().stats;
  const row2 = layout => layout.row2.left.map(group => group.spans.map(span => span.text).join('')).join('');
  assert.ok(STATUS_ITEMS.some(item => item.id === 'skills' && item.side === 'left'), 'the item is selectable');
  assert.ok(DEFAULT_STATUSLINE_ITEMS.includes('skills'), 'the item is on by default');
  assert.match(row2(layoutStatusBar({ ...facts, skills: 32 }, stats, 120, { items: ['skills'] })), /skills\s+32/);
  // Before the catalog read settles the figure keeps its columns as a placeholder.
  assert.match(row2(layoutStatusBar({ ...facts, skills: undefined }, stats, 120, { items: ['skills'] })), /skills\s+--/);
});

test('the skills view exposes the catalog size and notifies on a count-only change', async () => {
  const entry = (name, userInvocable) => ({ name, description: name, invocation: { userInvocable, modelInvocable: true } });
  let catalog = [entry('beta', true)];
  const ctx = { get: name => name === 'skills' ? { list: () => Promise.resolve(catalog) } : undefined, on: () => {} };
  const view = watchSkills(ctx, '/ws');
  const flushes = [];
  view.subscribe(() => flushes.push(view.count));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(view.count, 1, 'the catalog size is exposed after the first read');
  assert.deepEqual(view.rows.map(row => row.name), ['beta']);
  catalog = [entry('beta', true), entry('alpha', false)];
  view.setAgent({ session: { header: { cwd: '/ws' } } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(view.count, 2, 'a model-only skill still moves the count');
  assert.deepEqual(view.rows.map(row => row.name), ['beta'], 'user-invocable rows are unchanged');
  assert.deepEqual(flushes, [1, 2], 'the count-only change notifies subscribers');
});

test('a failed catalog read clears the previous workspace figure even when the error repeats', async () => {
  const entry = { name: 'beta', description: 'beta', invocation: { userInvocable: true, modelInvocable: true } };
  let failure;
  let change = () => {};
  const ctx = {
    get: name => name === 'skills' ? { list: () => failure === undefined ? Promise.resolve([entry]) : Promise.reject(failure) } : undefined,
    on: (event, handler) => { if (event === 'skills/change') change = handler; },
  };
  const view = watchSkills(ctx, '/ws');
  const flushes = [];
  view.subscribe(() => flushes.push(view.count));
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(view.count, 1);
  failure = new Error('read failed');
  change();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(view.count, 1, 'the last good figure survives for the same target');
  assert.equal(view.error, 'read failed');
  view.setAgent({ session: { header: { cwd: '/ws' } } });
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.equal(view.count, undefined, 'another workspace starts from no figure');
  assert.deepEqual(view.rows, []);
  assert.equal(flushes.at(-1), undefined, 'the clearing reaches subscribers');
});

test('the btw panel reads a side answer without touching the main transcript', async () => {
  const feed = createBtwFeed();
  const at = Date.now();
  feed.begin({ id: 's-btw', question: 'why is the cache cold?', at });
  feed.apply('s-btw', { seq: 0, type: 'user/message', time: at, data: { id: 'u1', source: { kind: 'user' }, content: [{ type: 'text', text: 'why is the cache cold?' }] } });
  feed.apply('s-btw', { seq: 1, type: 'assistant/message', time: at, data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'because the first turn fills it' }] }, usage: { inputTokens: 1, outputTokens: 1 } } });
  feed.settle('s-btw', 'done');
  const closed = [];
  const ui = await mount(BtwPanel, {
    feed,
    runs: feed.list(),
    selected: 's-btw',
    onSelect: () => {},
    onClose: () => closed.push(true),
  }, { columns: 100 });
  try {
    assertFits(ui);
    const text = ui.frame();
    assert.match(text, /Side questions \(btw\)/, text);
    assert.match(text, /answered/, text);
    assert.match(text, /why is the cache cold\?/, text);
    assert.match(text, /because the first turn fills it/, text);
    assert.match(text, /esc closes/, text);
    await ui.write('\u001b');
    assert.deepEqual(closed, [true], 'esc closes the panel');
    assertFits(ui);
  } finally {
    ui.close();
  }
});

test('the activity line reports cross-session traffic under its own glyph', async () => {
  // A request waiting on another session blocks the turn exactly like a running
  // tool, so it must be visible there. Ink's colour is environment-dependent
  // (chalk quantizes by depth and a non-TTY child paints none), so the colour
  // rule is asserted at the shared token: see the palette distinctness test.
  const communication = {
    rows: [{ id: 'call-1', direction: 'sent', peer: 'session-target', kind: 'request', mode: 'queue', preview: 'do it', at: 1000, pending: false, failed: false }],
    waiting: [{ peer: 'session-target', since: 1000 }],
  };
  const ui = await mount(DscodeActivityLine, { entries: [], streaming: false, since: 0, animated: false, communication }, { columns: 100 });
  try {
    assertFits(ui);
    const text = stripVTControlCharacters(ui.frame());
    assert.match(text, /⇄ waiting for session-target/);
    assert.doesNotMatch(text, /Running|Replying|Thinking/);
  } finally {
    ui.close();
  }
});

test('without cross-session traffic the activity line shows no cross-session glyph', async () => {
  const ui = await mount(DscodeActivityLine, { entries: [], streaming: false, since: 0, animated: false, communication: { rows: [], waiting: [] } }, { columns: 100 });
  try {
    assertFits(ui);
    assert.doesNotMatch(stripVTControlCharacters(ui.frame()), /waiting for|sending to|⇄/);
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
