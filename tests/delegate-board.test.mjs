process.env.FORCE_COLOR = '3';
process.env.DSCODE_LANGUAGE = 'en';

import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { boardSummary, DelegateBoard, delegateBoardFor, PRIORITIES, urgency } from '../plugins/dscode/board.mjs';
import { apply } from '../plugins/dscode/index.mjs';
import { cardsThatFit, columnLines, DelegateDashboardPanel, orderCards } from '../packages/tui/src/dscode/delegate-panel.ts';
import { mount, assertFits, tick } from './fixtures/tui-mount.mjs';

const home = mkdtempSync(join(tmpdir(), 'dscode-board-'));
process.env.DSH_HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

test('tasks move pending → running → verifying → complete, with the child status read live', () => {
  const board = new DelegateBoard({ root: join(home, 'unit') });
  const status = new Map();
  const view = () => board.view('root', id => status.get(id));
  const [a, b] = board.add('root', [{ title: 'Parser', child: 'parser', detail: 'src/parser.ts' }, { title: 'Docs', child: 'docs' }]);
  assert.deepEqual([a.id, b.id], ['t1', 't2']);
  assert.throws(() => board.add('root', [{ title: 'Again', child: 'parser' }]), /already planned/);
  assert.throws(() => board.add('root', [{ title: 'Bad', child: '1bad' }]), /child name/);
  assert.equal(board.launched('root', 'nobody', 'x'), undefined, 'an unplanned child leaves the board alone');
  board.launched('root', 'parser', 'child-1');
  status.set('child-1', 'running');
  assert.deepEqual(Object.fromEntries(Object.entries(view()).map(([c, tasks]) => [c, tasks.map(task => task.id)])), { pending: ['t2'], running: ['t1'], verifying: [], complete: [] });
  status.set('child-1', 'idle');
  board.waiting('root', 'child-1', true);
  assert.deepEqual(view().running.map(task => task.id), ['t1'], 'a child waiting on the parent is still running');
  board.waiting('root', 'child-1', false);
  assert.deepEqual(view().verifying.map(task => task.id), ['t1']);
  assert.throws(() => board.complete('root', 't2', 'looked'), /only a launched task/);
  assert.throws(() => board.complete('root', 't1', ' '), /verification is required/);
  board.complete('root', 't1', 'diff reviewed; npm test passed in the worktree');
  assert.deepEqual(view().complete.map(task => task.id), ['t1']);
  board.reopen('root', 't1', 'missed a case', 'parser_b');
  assert.deepEqual(view().pending.map(task => `${task.id}/${task.child}`), ['t1/parser_b', 't2/docs']);
  board.drop('root', 't2');
  const reloaded = new DelegateBoard({ root: join(home, 'unit') });
  assert.deepEqual(reloaded.view('root', () => undefined).pending.map(task => task.note), ['missed a case'], 'the board survives a restart');
});

test('the coordinator summary names free slots and what to do next', () => {
  const task = (id, child, extra = {}) => ({ id, child, title: id, ...extra });
  const columns = { pending: [task('t3', 'c', { blockedBy: [] })], running: [task('t1', 'a', { waiting: true })], verifying: [task('t2', 'b')], complete: [] };
  const text = boardSummary(columns, { running: 1, limit: 5 });
  assert.match(text, /Ready to launch, in order: t3 \/c\. Running: t1 \/a \(asked you a question\)\. Verifying: t2 \/b\./);
  assert.match(text, /1 of 5 running, 4 free\. Launch the first 1 ready task now/);
  assert.match(text, /delegate_board complete/);
  assert.match(text, /Answer the children waiting on you/);
  assert.doesNotMatch(boardSummary(columns, { running: 5, limit: 5 }), /Launch the first/, 'no launch nudge without a free slot');
  assert.equal(boardSummary({ pending: [], running: [], verifying: [], complete: [task('t1', 'a')] }, { running: 0, limit: 5 }), '');
});

test('the dscode plugin tracks launches and questions on the board and serves it to the TUI', async () => {
  let execute, tool, assemble, preStep;
  const sections = new Map();
  const live = new Map();
  const effects = [];
  const owner = { status: 'running', options: {}, session: { id: 'root', header: {}, requestHeader: () => ({ config: { reasoningEffort: 'high' } }) } };
  live.set('root', owner);
  apply({
    effect: fn => effects.push(fn()),
    tools: { register: definition => { tool = definition; } },
    systemPrompt: { section: section => sections.set(section.name, section) },
    on: (event, cb) => { if (event === 'tools/execute') execute = cb; if (event === 'system-prompt/assemble') assemble = cb; if (event === 'agent/pre-step') preStep = cb; },
    commands: { register() {} },
    agents: { list: () => [...live.values()], get: id => live.get(id) },
  });
  try {
    assert.equal(tool.name, 'delegate_board');
    const call = args => tool.execute(args, { agent: owner });
    assert.deepEqual((await call({ action: 'add', tasks: [{ title: 'Parser', child: 'parser' }, { title: 'Docs', child: 'docs' }] })).board.pending.map(t => t.id), ['t1', 't2']);
    const step = async (agent = owner) => (await preStep({ agent }, async () => ({ kind: 'enter', messages: [{ id: 'prompt' }] }))).messages;
    const injected = await step();
    assert.equal(injected.length, 2, 'a changed board rides ahead of the step');
    assert.equal(injected[0].source.kind, 'dscode-delegate-board');
    assert.equal(injected[0].source.form, 'snapshot');
    assert.match(injected[0].content[0].text, /0 of 5 running, 5 free\. Launch the first 2 ready tasks now/);
    assert.equal(injected[1].id, 'prompt');
    assert.deepEqual((await step()).map(m => m.id), ['prompt'], 'an unchanged board is not sent again, so the request prefix stays cached');
    assert.equal(sections.has('dscode:delegate-board'), false, 'the board never edits the system prompt');
    await execute({ name: 'subagent', arguments: { name: 'parser' }, agent: owner }, () => {
      live.set('child-1', { status: 'running', options: {}, session: { id: 'child-1', header: { origin: 'subagent', parentSession: 'root' } } });
      return { kind: 'continuable', subagentId: 'child-1' };
    });
    assert.deepEqual(delegateBoardFor('root').columns.running.map(t => t.id), ['t1']);
    assert.match((await step())[0].content[0].text, /Running: t1 \/parser/, 'the launch changed the board, so it is sent again');
    assert.equal(delegateBoardFor('root').running, 1);
    const child = live.get('child-1');
    child.status = 'idle';
    await execute({ name: 'send_message', arguments: { agent_id: '/', message: 'which API?' }, agent: child }, () => 'sent');
    assert.equal(delegateBoardFor('root').columns.running[0].waiting, true);
    await execute({ name: 'send_message', arguments: { agent_id: '/parser', message: 'the new one' }, agent: owner }, () => 'sent');
    assert.deepEqual(delegateBoardFor('root').columns.verifying.map(t => t.id), ['t1'], 'answered and idle: verifying');
    assert.match((await call({ action: 'complete', task_id: 't1', verification: 'reviewed diff, tests pass' })).board.complete[0].id, /t1/);
    assert.match((await tool.execute({ action: 'list' }, { agent: child })).error, /Only the coordinating agent/);
    assert.deepEqual((await step(child)).map(m => m.id), ['prompt'], 'children never receive the board');
    const assembled = await assemble({}, { scope: { session: { header: { origin: 'subagent', agentPreset: 'dscode' } } } }, async () => ({ tools: [{ name: 'delegate_board' }, { name: 'bash' }], sections: [] }));
    assert.deepEqual(assembled.tools.map(t => t.name), ['bash'], 'children never see the board tool');
  } finally { for (const dispose of effects) dispose?.(); }
});

const snapshot = {
  running: 2, limit: 5,
  columns: {
    pending: [{ id: 't4', child: 'tests', title: 'Add regression tests' }],
    running: [{ id: 't1', child: 'parser', title: 'Rewrite the tokenizer' }, { id: 't2', child: 'cli', title: 'Wire the flag', waiting: true }],
    verifying: [{ id: 't3', child: 'docs', title: 'Update the guide' }],
    complete: [],
  },
};

test('the dashboard shows four columns, marks waiting children and closes on Esc', async () => {
  let closed = 0;
  const ui = await mount(DelegateDashboardPanel, { load: () => snapshot, close: () => { closed += 1; } }, { columns: 120, rows: 44 });
  try {
    assertFits(ui);
    const text = ui.frame();
    assert.match(text, /◆ Delegate board\s+slots ▰▰▰▰▱▱▱▱▱▱ 2\/5\s+✓ 0\/4 done/, 'the title row carries the slot meter and progress');
    assert.match(text, /○ Pending\s+1\s+│\s+● Running\s+2\s+│\s+◐ Verifying\s+1\s+│\s+✓ Complete\s+0/, 'columns are divided by vertical rules');
    const lines = text.split('\n');
    const card = lines.findIndex(line => line.includes('○ t4 /tests'));
    assert(card > 0, text);
    assert.match(lines[card - 1], /╭─+╮ │ ╭─+╮/, 'each task is its own bordered card');
    assert.match(lines[card + 1], /Add regression tests/);
    assert.match(lines[card + 2], /╰─+╯/);
    assert.match(text, /● t2 \/cli {2}\? /, 'a waiting child carries the ? badge');
    assert(text.indexOf('t2 /cli') < text.indexOf('t1 /parser'), 'a child waiting on the main agent leads its column');
    assert.match(text, /│ empty/, 'an empty column says so');
    await ui.write('\u001b');
    await tick(80);
    assert.equal(closed, 1);
  } finally { ui.close(); }
});

test('a short terminal folds every card to one line instead of hiding them', async () => {
  const ui = await mount(DelegateDashboardPanel, { load: () => snapshot, close() {} }, { columns: 120, rows: 30 });
  try {
    assertFits(ui);
    const text = ui.frame();
    assert.match(text, /● t2 \/cli {2}\? {2}Wire/);
    assert.match(text, /● t1 \/parser Rewrit/);
    assert.doesNotMatch(text, /more/, 'both running cards fit once compact');
  } finally { ui.close(); }
});

test('a narrow terminal stacks the columns and an empty board says how to start', async () => {
  const narrow = await mount(DelegateDashboardPanel, { load: () => snapshot, close() {} }, { columns: 44, rows: 30 });
  try {
    assertFits(narrow);
    assert.match(narrow.frame(), /Pending\s+1[\s\S]*t4 \/tests[\s\S]*Running\s+2[\s\S]*Verifying\s+1[\s\S]*Complete\s+0/);
  } finally { narrow.close(); }
  const empty = await mount(DelegateDashboardPanel, { load: () => undefined, close() {} }, { columns: 80, rows: 30 });
  try {
    assertFits(empty);
    assert.match(empty.frame(), /no delegated tasks yet · start with \/delegate <task>/);
  } finally { empty.close(); }
});

test('waiting cards lead and the rest keep their order', () => {
  const tasks = [{ id: 't1' }, { id: 't2', waiting: true }, { id: 't3' }, { id: 't4', waiting: true }];
  assert.deepEqual(orderCards(tasks).map(task => task.id), ['t2', 't4', 't1', 't3']);
  const plain = [{ id: 't1' }];
  assert.equal(orderCards(plain), plain);
});

test('cards that do not fit leave a row for +N', () => {
  assert.equal(cardsThatFit(2, 8), 2);
  assert.equal(cardsThatFit(3, 8), 1, 'two cards would fill all eight rows with nothing left for +N');
  assert.equal(cardsThatFit(3, 9), 2);
  assert.equal(cardsThatFit(5, 3), 0);
});

test('a column longer than its rows ends in a +N line', () => {
  const tasks = Array.from({ length: 5 }, (_, i) => ({ id: `t${i + 1}`, child: `c${i}x`, title: 'x' }));
  assert.deepEqual(columnLines(tasks, 3), ['t1 /c0x x', 't2 /c1x x', '+3 more']);
  assert.equal(columnLines(tasks, 5).length, 5);
  assert.deepEqual(columnLines(tasks, 0), []);
});

test('a new /delegate clears a finished board but keeps one with open tasks', async () => {
  const { spawnSync } = await import('node:child_process');
  const { writeFileSync } = await import('node:fs');
  const repo = mkdtempSync(join(tmpdir(), 'dscode-delegate-clear-'));
  const git = (...args) => assert.equal(spawnSync('git', ['-C', repo, ...args]).status, 0);
  git('init', '-q');
  writeFileSync(join(repo, 'a.txt'), 'a\n');
  git('add', 'a.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'initial');
  let execute, tool, delegate;
  const effects = [];
  const live = new Map();
  const owner = { status: 'idle', options: {}, followup() {}, session: { id: 'clear-root', header: { cwd: repo }, requestHeader: () => ({ config: { reasoningEffort: 'high' } }) } };
  live.set('clear-root', owner);
  apply({
    effect: fn => effects.push(fn()),
    tools: { register: definition => { tool = definition; } },
    systemPrompt: { section() {} },
    on: (event, cb) => { if (event === 'tools/execute') execute = cb; },
    commands: { register: definition => { if (definition.name === 'delegate') delegate = definition; } },
    agents: { list: () => [...live.values()], get: id => live.get(id) },
  });
  try {
    const call = args => tool.execute(args, { agent: owner });
    await call({ action: 'add', tasks: [{ title: 'Done', child: 'done' }, { title: 'Open', child: 'open' }] });
    await execute({ name: 'subagent', arguments: { name: 'done' }, agent: owner }, () => ({ kind: 'continuable', subagentId: 'c-done' }));
    await call({ action: 'complete', task_id: 't1', verification: 'checked' });
    await delegate.handler({ agent: owner, rawInput: 'next task', attachments: [] });
    assert.equal(delegateBoardFor('clear-root').columns.pending.length, 1, 'an open task keeps the board');
    await call({ action: 'drop', task_id: 't2' });
    await delegate.handler({ agent: owner, rawInput: 'next task', attachments: [] });
    assert.deepEqual(Object.values(delegateBoardFor('clear-root').columns).map(tasks => tasks.length), [0, 0, 0, 0], 'a finished board starts fresh');
  } finally {
    for (const dispose of effects) dispose?.();
    rmSync(repo, { recursive: true, force: true });
  }
});

test('priorities order the ready tasks and dependencies hold tasks back until their inputs are complete', () => {
  const board = new DelegateBoard({ root: join(home, 'deps') });
  const status = new Map();
  const view = () => board.view('root', id => status.get(id));
  board.add('root', [
    { title: 'Schema', child: 'schema', priority: 'high' },
    { title: 'API', child: 'api', depends_on: ['schema'] },
    { title: 'Docs', child: 'docs', priority: 'low' },
    { title: 'CLI', child: 'cli' },
    { title: 'E2E', child: 'e2e', priority: 'high', depends_on: ['api', 't4'] },
  ]);
  assert.deepEqual(view().pending.map(t => `${t.id}:${t.blockedBy.join('+') || 'ready'}`), ['t1:ready', 't4:ready', 't3:ready', 't2:t1', 't5:t2+t4'], 'ready first, then blocked, each by effective priority');
  assert.deepEqual([...urgency(board.load('root').tasks)].map(([id, value]) => `${id}:${PRIORITIES[value]}`), ['t1:high', 't2:high', 't3:low', 't4:high', 't5:high'], 'e2e is high, so api, cli and schema under it are too');
  assert.throws(() => board.add('root', [{ title: 'Self', child: 'self', depends_on: ['self'] }]), /cannot depend on itself/);
  assert.throws(() => board.add('root', [{ title: 'Nope', child: 'nope', depends_on: ['ghost'] }]), /names no task: ghost/);
  assert.throws(() => board.update('root', 't1', { depends_on: ['e2e'] }), /dependency cycle: t1 → t5 → t2 → t1|dependency cycle/);
  assert.deepEqual(board.task('root', 't1').dependsOn, [], 'a rejected update leaves the plan unchanged');
  assert.throws(() => board.add('root', [{ title: 'Bad', child: 'bad', priority: 'urgent' }]), /priority must be one of high, normal, low/);
  assert.match(board.launchBlocked('root', 'api'), /Task t2 \/api depends on t1, which is not complete yet/);
  assert.equal(board.launchBlocked('root', 'schema'), undefined);
  board.launched('root', 'schema', 'c1', '/repo/.dscode-worktrees/one');
  status.set('c1', 'idle');
  board.complete('root', 't1', 'tests pass');
  assert.equal(board.launchBlocked('root', 'api'), undefined, 'completing the dependency readies its dependents');
  const summary = boardSummary(view(), { running: 0, limit: 5 });
  assert.match(summary, /Ready to launch, in order: t2 \/api \[high via its dependents\], t4 \/cli \[high via its dependents\], t3 \/docs \[low\]\./, 'work that unblocks a high-priority task goes first');
  assert.match(summary, /Blocked: t5 \/e2e \[high\] waits on t2, t4\./);
  assert.match(summary, /t2 builds on t1 \(\/repo\/\.dscode-worktrees\/one\)/, 'a ready dependent is told where its input lives');
  board.update('root', 't3', { priority: 'high' });
  assert.deepEqual(view().pending.filter(t => !t.blockedBy.length).map(t => t.id), ['t2', 't3', 't4'], 're-prioritising moves docs from last to among the high-priority work');
  const { released } = board.drop('root', 't4');
  assert.deepEqual(released, ['t5']);
  assert.deepEqual(board.task('root', 't5').dependsOn, ['t2'], 'dropping a task releases what waited on it');
});

test('a stalled plan is called out', () => {
  const columns = { pending: [{ id: 't2', child: 'b', title: 'b', blockedBy: ['t1'] }], running: [], verifying: [], complete: [] };
  assert.match(boardSummary(columns, { running: 0, limit: 5 }), /Every pending task is blocked and nothing is in flight/);
});

test('the plugin refuses to launch a blocked task and records the worktree of a launched one', async () => {
  let execute, tool;
  const effects = [];
  const live = new Map();
  const owner = { status: 'running', options: {}, session: { id: 'deps-root', header: {}, requestHeader: () => ({ config: { reasoningEffort: 'high' } }) } };
  live.set('deps-root', owner);
  apply({
    effect: fn => effects.push(fn()),
    tools: { register: definition => { tool = definition; } },
    systemPrompt: { section() {} },
    on: (event, cb) => { if (event === 'tools/execute') execute = cb; },
    commands: { register() {} },
    agents: { list: () => [...live.values()], get: id => live.get(id) },
  });
  try {
    const added = await tool.execute({ action: 'add', tasks: [{ title: 'Base', child: 'base' }, { title: 'Top', child: 'top', depends_on: ['base'], priority: 'high' }] }, { agent: owner });
    assert.deepEqual(added.board.pending.map(t => [t.id, t.priority, t.blocked_by ?? []]), [['t1', 'normal', []], ['t2', 'high', ['t1']]]);
    let started = 0;
    await assert.rejects(execute({ name: 'subagent', arguments: { name: 'top' }, agent: owner }, () => { started++; }), /depends on t1/);
    assert.equal(started, 0, 'a blocked launch never reaches the subagent tool');
    await execute({ name: 'subagent', arguments: { name: 'base' }, agent: owner }, () => ({ kind: 'continuable', subagentId: 'c-base', worktree: '/repo/.dscode-worktrees/base' }));
    assert.equal(delegateBoardFor('deps-root').columns.verifying[0].worktree, '/repo/.dscode-worktrees/base');
  } finally { for (const dispose of effects) dispose?.(); }
});

test('cards show priority marks and what a blocked task waits on', async () => {
  const board = { running: 0, limit: 5, columns: {
    pending: [
      { id: 't2', child: 'cli', title: 'Wire the flag', priority: 'high', blockedBy: [] },
      { id: 't4', child: 'docs', title: 'Guide', priority: 'low', blockedBy: [] },
      { id: 't3', child: 'e2e', title: 'End to end', priority: 'normal', blockedBy: ['t1', 't2'] },
    ],
    running: [], verifying: [], complete: [{ id: 't1', child: 'schema', title: 'Schema', priority: 'high' }],
  } };
  const ui = await mount(DelegateDashboardPanel, { load: () => board, close() {} }, { columns: 120, rows: 44 });
  try {
    assertFits(ui);
    const text = ui.frame();
    assert.match(text, /○ t2 \/cli ▲/);
    assert.match(text, /○ t4 \/docs ▼/);
    assert.match(text, /◌ t3 \/e2e/, 'a blocked task shows a hollow mark');
    assert.match(text, /after t1,t2 · End to/);
    assert.match(text, /✓ t1 \/schema\s+│/, 'a complete task drops its priority mark');
    assert.match(text, /▲ high priority/);
  } finally { ui.close(); }
});
