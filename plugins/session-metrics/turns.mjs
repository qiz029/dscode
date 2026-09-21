// Per-turn cost attribution and the session budget gate. The footer reports the
// whole session's spend and /usage reports tokens per turn; these functions
// answer what neither does with that ledger: which turn spent the money, so the
// footer can show the last completed turn and /usage can price each one.

/**
 * Turn windows from the session's own events. `turn/start` opens a window and
 * `turn/end` closes it; an unterminated turn stays open to `Infinity` so the
 * turn in flight still attributes its settled calls. Windows come back in
 * ascending start order, which the attribution lookup below depends on.
 */
export function turnWindows(events = []) {
  const open = new Map();
  const windows = [];
  for (const event of events) {
    const turn = event.data?.turn;
    // A boundary without a time cannot place a window or a call inside one. It
    // is skipped rather than stored: a NaN edge would make the ascending-search
    // contract false and silently orphan every call of that turn.
    if (!Number.isFinite(turn) || !Number.isFinite(event.time)) continue;
    if (event.type === 'turn/start') {
      const existing = open.get(turn);
      // A resumed turn can re-emit its start; keep the earliest boundary.
      open.set(turn, existing === undefined ? event.time : Math.min(existing, event.time));
    } else if (event.type === 'turn/end') {
      const start = open.get(turn);
      if (start === undefined) continue;
      open.delete(turn);
      windows.push({ turn, start, end: event.time });
    }
  }
  for (const [turn, start] of open) windows.push({ turn, start, end: Infinity });
  return windows.sort((left, right) => left.start - right.start || left.turn - right.turn);
}

/**
 * The clauses a call is priced against: each turn's window, with an open turn
 * (no `turn/end`) bounded by the next turn's start. An interrupted turn must not
 * swallow every later turn, while the turn genuinely in flight keeps running to
 * `Infinity`. Satisfies {@link attributeCostByTurn}'s ascending-start contract.
 */
export function turnBounds(events = []) {
  return turnWindows(events).map((window, index, windows) => ({
    turn: window.turn,
    start: window.start,
    // Math.max keeps the window non-inverted even for a log whose timestamps
    // are out of order; an inverted bound would break the ascending search.
    end: window.end === Infinity && index + 1 < windows.length ? Math.max(window.start, windows[index + 1].start) : window.end,
  }));
}

/**
 * The window containing `time`, by binary search over the ascending bounds. The
 * index is the FIRST window starting after `time`, so the one before it is the
 * only candidate that can contain it; `-1` means no turn was running.
 * @param bounds - ascending {@link turnBounds} rows.
 * @param time - the call's start time (`time` prices the call, so it is also when the turn ran).
 * @returns the bounds index, or -1 when `time` falls in no window.
 */
export function turnAt(bounds, time) {
  let low = 0, high = bounds.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (bounds[mid].start <= time) low = mid + 1;
    else high = mid;
  }
  const candidate = bounds[low - 1];
  return candidate !== undefined && time <= candidate.end ? low - 1 : -1;
}

/**
 * Cost and call count per turn. Roughly O(calls × log turns), so the footer can
 * ask for the last turn once a second. A call is attributed by its start time,
 * and a call outside every window (before the first `turn/start`, in a gap
 * between two turns, or a backfilled row without one) is reported under
 * `unattributed` rather than dropped.
 * @param rows - ledger rows (`{ kind, time, cost, purpose }`).
 * @param events - the session's events, for the turn windows.
 * @returns One bucket per turn, plus `lastTurn` (the newest turn that is no
 *   longer running, undefined while none has stopped), the `unattributed` total
 *   and whether any of it was unpriceable. A turn that never emitted `turn/end`
 *   still counts as stopped once the next turn opens its window.
 */
export function attributeCostByTurn(rows = [], events = []) {
  const bounds = turnBounds(events);
  const turns = bounds.map(bound => ({ turn: bound.turn, cost: 0, calls: 0, unknown: false }));
  let unattributed = 0;
  let unattributedUnknown = false;
  for (const row of rows ?? []) {
    if (row?.kind !== 'end') continue;
    const at = turnAt(bounds, row.time);
    if (at === -1) {
      // Outside every window the spend still exists: an unpriceable row must be
      // visible as such rather than counted as nothing.
      if (Number.isFinite(row.cost)) unattributed += row.cost;
      else unattributedUnknown = true;
      continue;
    }
    turns[at].calls += 1;
    if (Number.isFinite(row.cost)) turns[at].cost += row.cost;
    else turns[at].unknown = true;
  }
  let lastTurn;
  for (let index = bounds.length - 1; index >= 0; index -= 1) {
    if (bounds[index].end !== Infinity) { lastTurn = turns[index]; break; }
  }
  return { turns, lastTurn, unattributed, unattributedUnknown };
}

/**
 * The budget gate's verdict. A missing or non-positive limit means no budget is
 * set, so the gate never fires and the footer shows no budget slot. `warn` is
 * the alerting share; `over` means the next prompt would spend past the limit.
 */
export function evaluateBudget(spent, limit, options = {}) {
  const warnPercent = Number.isFinite(options.warnPercent) ? options.warnPercent : 80
  if (!Number.isFinite(limit) || limit <= 0) return { state: 'unset', limit: null, spent, ratio: null, percent: null, warnPercent }
  const safeSpent = Number.isFinite(spent) ? spent : 0
  const ratio = safeSpent / limit
  return {
    state: ratio >= 1 ? 'over' : ratio * 100 >= warnPercent ? 'warn' : 'ok',
    limit, spent: safeSpent, ratio,
    percent: Math.round(ratio * 100),
    warnPercent,
  }
}

/** Parse the `DSCODE_SESSION_BUDGET_USD`-style value; anything else is no budget. */
export function parseBudget(value) {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null
  if (typeof value !== 'string') return null
  const parsed = Number.parseFloat(value.trim())
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}
