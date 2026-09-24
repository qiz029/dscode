import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';

export const COLUMNS = ['pending', 'running', 'verifying', 'complete'];
export const PRIORITIES = ['high', 'normal', 'low'];
const MAX_TASKS = 50;
const rank = task => PRIORITIES.indexOf(task.priority ?? 'normal');
const order = (a, b) => (a.urgency ?? rank(a)) - (b.urgency ?? rank(b)) || Number(a.id.slice(1)) - Number(b.id.slice(1));

/**
 * Each open task's effective rank: its own priority or that of any open task that
 * (transitively) waits on it, whichever is higher, so work that unblocks a
 * high-priority task is launched first.
 */
export function urgency(tasks) {
  const open = tasks.filter(task => task.stage !== 'complete');
  const dependents = new Map(open.map(task => [task.id, []]));
  for (const task of open) for (const id of task.dependsOn ?? []) dependents.get(id)?.push(task);
  const memo = new Map();
  const visit = (task, seen) => {
    if (memo.has(task.id)) return memo.get(task.id);
    let best = rank(task);
    for (const next of dependents.get(task.id) ?? []) if (!seen.has(next.id)) best = Math.min(best, visit(next, new Set([...seen, next.id])));
    memo.set(task.id, best);
    return best;
  };
  return new Map(open.map(task => [task.id, visit(task, new Set([task.id]))]));
}
const priority = value => {
  if (value === undefined) return 'normal';
  if (!PRIORITIES.includes(value)) throw new Error(`priority must be one of ${PRIORITIES.join(', ')}`);
  return value;
};
const text = (value, label, max) => {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} is required`);
  if (value.length > max) throw new Error(`${label} exceeds ${max} characters`);
  return value.trim();
};

// One delegate board per root session. A task is stored as pending, launched or
// complete; running and verifying are read from the child agent, so the board
// cannot drift from what the children are actually doing. A pending task is
// ready once every task it depends on is complete, and blocked until then.
export class DelegateBoard {
  constructor({ root, childName = /^[A-Za-z](?:[A-Za-z0-9_]{0,8}[A-Za-z])?$/ }) {
    this.root = root; this.childName = childName; this.boards = new Map(); this.listeners = new Set();
    mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  path(sessionId) { return join(this.root, createHash('sha256').update(sessionId).digest('hex').slice(0, 32) + '.json'); }
  load(sessionId) {
    if (!this.boards.has(sessionId)) {
      let tasks = [];
      try { tasks = JSON.parse(readFileSync(this.path(sessionId), 'utf8')).tasks ?? []; } catch { /* No board yet. */ }
      this.boards.set(sessionId, { tasks });
    }
    return this.boards.get(sessionId);
  }
  save(sessionId) {
    const path = this.path(sessionId), tmp = `${path}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: 1, sessionId, tasks: this.load(sessionId).tasks }), { mode: 0o600 });
    renameSync(tmp, path);
    for (const listener of this.listeners) try { listener(sessionId); } catch { /* A viewer must not break the board. */ }
  }
  onChange(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  task(sessionId, id) {
    const found = this.load(sessionId).tasks.find(task => task.id === id);
    if (!found) throw new Error(`Unknown task ${id}`);
    return found;
  }
  checkName(sessionId, name, except) {
    if (typeof name !== 'string' || !this.childName.test(name)) throw new Error('child name must be 1-10 characters of letters, digits or underscores, starting and ending with a letter');
    if (this.load(sessionId).tasks.some(task => task !== except && task.stage !== 'complete' && task.child === name)) throw new Error(`child name /${name} is already planned for an open task`);
    return name;
  }
  /** Task ids for `depends_on` entries, each a task id (t3) or a planned child name, open tasks first. */
  resolve(tasks, refs, self) {
    if (refs === undefined) return [];
    if (!Array.isArray(refs)) throw new Error('depends_on must be an array of task ids or child names');
    const ids = [];
    for (const ref of refs) {
      const found = tasks.find(task => task.id === ref)
        ?? tasks.find(task => task.stage !== 'complete' && task.child === ref)
        ?? tasks.findLast(task => task.child === ref);
      if (!found) throw new Error(`depends_on names no task: ${ref}`);
      if (found === self) throw new Error(`${self.id} cannot depend on itself`);
      if (!ids.includes(found.id)) ids.push(found.id);
    }
    return ids;
  }
  /** Reject a dependency cycle, naming it. */
  acyclic(tasks) {
    const byId = new Map(tasks.map(task => [task.id, task]));
    const state = new Map();
    const visit = (task, path) => {
      if (state.get(task.id) === 'done') return;
      if (state.get(task.id) === 'active') throw new Error(`dependency cycle: ${[...path, task.id].join(' → ')}`);
      state.set(task.id, 'active');
      for (const id of task.dependsOn ?? []) if (byId.has(id)) visit(byId.get(id), [...path, task.id]);
      state.set(task.id, 'done');
    };
    for (const task of tasks) visit(task, []);
  }
  add(sessionId, items) {
    const board = this.load(sessionId);
    if (!Array.isArray(items) || !items.length) throw new Error('tasks must be a non-empty array');
    if (board.tasks.length + items.length > MAX_TASKS) throw new Error(`a board holds at most ${MAX_TASKS} tasks`);
    let next = board.tasks.reduce((max, task) => Math.max(max, Number(task.id.slice(1))), 0);
    const added = [];
    for (const item of items) {
      const task = { id: `t${++next}`, title: text(item?.title, 'title', 120), stage: 'pending', priority: priority(item?.priority), updatedAt: Date.now() };
      task.child = this.checkName(sessionId, item?.child, task);
      if (added.some(other => other.child === task.child)) throw new Error(`child name /${task.child} is used twice`);
      if (item.detail !== undefined) task.detail = text(item.detail, 'detail', 2000);
      added.push(task);
    }
    // Dependencies may name tasks of the same batch, so they resolve once every id exists.
    const all = [...board.tasks, ...added];
    items.forEach((item, index) => { added[index].dependsOn = this.resolve(all, item.depends_on, added[index]); });
    this.acyclic(all);
    board.tasks.push(...added);
    this.save(sessionId);
    return added;
  }
  /** Change a pending task's priority or dependencies. */
  update(sessionId, id, { priority: nextPriority, depends_on: refs }) {
    const board = this.load(sessionId);
    const task = this.task(sessionId, id);
    if (task.stage !== 'pending') throw new Error(`Task ${id} is ${task.stage}; only a pending task can be re-planned`);
    const before = { priority: task.priority, dependsOn: task.dependsOn };
    if (nextPriority !== undefined) task.priority = priority(nextPriority);
    if (refs !== undefined) task.dependsOn = this.resolve(board.tasks, refs, task);
    try { this.acyclic(board.tasks); } catch (error) { Object.assign(task, before); throw error; }
    task.updatedAt = Date.now();
    this.save(sessionId);
    return task;
  }
  /** Dependencies of `task` that are not complete yet. */
  blockers(sessionId, task) {
    const tasks = this.load(sessionId).tasks;
    return (task.dependsOn ?? []).filter(id => tasks.find(other => other.id === id)?.stage !== 'complete');
  }
  /** Why launching `child` must wait, or undefined when its task is ready or it has none. */
  launchBlocked(sessionId, child) {
    const task = this.load(sessionId).tasks.find(t => t.stage === 'pending' && t.child === child);
    const waits = task ? this.blockers(sessionId, task) : [];
    return waits.length ? `Task ${task.id} /${child} depends on ${waits.join(', ')}, which ${waits.length === 1 ? 'is' : 'are'} not complete yet. Launch a ready task instead, or change the plan with delegate_board update.` : undefined;
  }
  /** A subagent started under a pending task's planned name takes that task. */
  launched(sessionId, child, subagentId, worktree) {
    const task = this.load(sessionId).tasks.find(t => t.stage === 'pending' && t.child === child);
    if (!task) return undefined;
    Object.assign(task, { stage: 'launched', subagentId, waiting: false, updatedAt: Date.now(), ...(worktree ? { worktree } : {}) });
    this.save(sessionId);
    return task;
  }
  /** Questions from a child keep its task running until the parent answers. */
  waiting(sessionId, subagentId, value) {
    const task = this.load(sessionId).tasks.find(t => t.stage === 'launched' && t.subagentId === subagentId);
    if (!task || task.waiting === value) return;
    Object.assign(task, { waiting: value, updatedAt: Date.now() });
    this.save(sessionId);
  }
  complete(sessionId, id, verification) {
    const task = this.task(sessionId, id);
    if (task.stage !== 'launched') throw new Error(`Task ${id} is ${task.stage}; only a launched task can be completed after verification`);
    Object.assign(task, { stage: 'complete', verification: text(verification, 'verification', 2000), waiting: false, updatedAt: Date.now() });
    this.save(sessionId);
    return task;
  }
  reopen(sessionId, id, reason, child) {
    const task = this.task(sessionId, id);
    if (task.stage === 'pending') throw new Error(`Task ${id} is already pending`);
    const name = child === undefined ? task.child : this.checkName(sessionId, child, task);
    delete task.subagentId; delete task.verification; delete task.worktree;
    Object.assign(task, { stage: 'pending', child: name, note: text(reason, 'reason', 2000), waiting: false, updatedAt: Date.now() });
    this.save(sessionId);
    return task;
  }
  /** Remove a task; tasks that depended on it no longer wait for it. */
  drop(sessionId, id) {
    const board = this.load(sessionId);
    const task = this.task(sessionId, id);
    board.tasks.splice(board.tasks.indexOf(task), 1);
    const released = [];
    for (const other of board.tasks) {
      if (!other.dependsOn?.includes(id)) continue;
      other.dependsOn = other.dependsOn.filter(dep => dep !== id);
      released.push(other.id);
    }
    this.save(sessionId);
    return { task, released };
  }
  clear(sessionId) { this.load(sessionId).tasks = []; this.save(sessionId); }
  /** Tasks grouped by column; `status(subagentId)` is the child agent's live status. */
  view(sessionId, status) {
    const columns = Object.fromEntries(COLUMNS.map(column => [column, []]));
    const tasks = this.load(sessionId).tasks;
    const urgent = urgency(tasks);
    for (const task of tasks) {
      const column = task.stage === 'launched' ? (status(task.subagentId) === 'running' || task.waiting ? 'running' : 'verifying') : task.stage;
      columns[column].push({ ...task, priority: task.priority ?? 'normal', column, ...(urgent.has(task.id) ? { urgency: urgent.get(task.id) } : {}), ...(column === 'pending' ? { blockedBy: this.blockers(sessionId, task) } : {}) });
    }
    // Verify what unblocks the most urgent work first, too.
    columns.verifying.sort(order);
    // Pending runs in launch order: ready before blocked, then by effective priority and id.
    columns.pending.sort((a, b) => Number(a.blockedBy.length > 0) - Number(b.blockedBy.length > 0) || order(a, b));
    return columns;
  }
}

/** One-paragraph board state for the coordinator's next step; empty when nothing is open. */
export function boardSummary(columns, { running, limit }) {
  const open = columns.pending.length + columns.running.length + columns.verifying.length;
  if (!open) return '';
  const all = COLUMNS.flatMap(column => columns[column]);
  const byId = new Map(all.map(task => [task.id, task]));
  const inherited = task => task.urgency !== undefined && task.urgency < PRIORITIES.indexOf(task.priority ?? 'normal');
  const name = task => `${task.id} /${task.child}${task.priority && task.priority !== 'normal' ? ` [${task.priority}]` : ''}${inherited(task) ? ` [${PRIORITIES[task.urgency]} via its dependents]` : ''}`;
  const list = tasks => tasks.map(task => `${name(task)}${task.waiting ? ' (asked you a question)' : ''}`).join(', ') || 'none';
  const ready = columns.pending.filter(task => !task.blockedBy?.length);
  const blocked = columns.pending.filter(task => task.blockedBy?.length);
  const free = Math.max(0, limit - running);
  // A ready task with dependencies starts from their verified changes: name where they are.
  const inputs = ready.filter(task => task.dependsOn?.length).map(task => `${task.id} builds on ${task.dependsOn.map(id => `${id} (${byId.get(id)?.worktree ?? 'worktree unknown'})`).join(', ')}`);
  const parts = [
    `Delegate board. Ready to launch, in order: ${list(ready)}.`,
    blocked.length ? ` Blocked: ${blocked.map(task => `${name(task)} waits on ${task.blockedBy.join(', ')}`).join('; ')}.` : '',
    ` Running: ${list(columns.running)}. Verifying: ${list(columns.verifying)}. Complete: ${columns.complete.length}.`,
    ` Child slots: ${running} of ${limit} running, ${free} free.`,
    ready.length && free ? ` Launch the first ${Math.min(free, ready.length)} ready ${Math.min(free, ready.length) === 1 ? 'task' : 'tasks'} now, in the order above, each with subagent named as planned and worktree: true.` : '',
    inputs.length ? ` ${inputs.join('; ')}: tell each such child to bring those changes in first, as the protocol describes.` : '',
    !ready.length && blocked.length && !columns.running.length && !columns.verifying.length ? ' Every pending task is blocked and nothing is in flight: fix the plan with delegate_board update or drop.' : '',
    columns.verifying.length ? ' Verify each verifying task in its worktree, then record the outcome with delegate_board complete (with the evidence) or reopen, or send the child fixes. Verify tasks that others depend on first.' : '',
    columns.running.some(task => task.waiting) ? ' Answer the children waiting on you.' : '',
  ];
  return parts.join('');
}

// The in-process TUI reads the current root session's board through this bridge,
// the same way the footer reads session metrics.
let source;
export function setBoardSource(next) { source = next; return () => { if (source === next) source = undefined; }; }
/** `{ columns, running, limit }` for a root session, or undefined when no board source is mounted. */
export function delegateBoardFor(sessionId) { return source?.(sessionId); }
