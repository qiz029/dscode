import { CronExpressionParser } from 'cron-parser';

export function validateCalendar(cron, timezone) {
  if (cron.trim().split(/\s+/u).length !== 5) throw new Error('source.cron must have five fields (minute hour day month weekday)');
  if (!/^[\d*/,\-\s]+$/u.test(cron)) throw new Error('source.cron supports numeric fields, *, ranges, lists and steps');
  new Intl.DateTimeFormat('en', { timeZone: timezone }).format(0);
  CronExpressionParser.parse(cron, { tz: timezone }).next();
}

export function nextFiring(source, after) {
  if (source.kind === 'calendar') return CronExpressionParser.parse(source.cron, { tz: source.timezone, currentDate: after }).next().getTime();
  return after + (source.seconds ?? source.everySeconds) * 1000;
}

/** Coalesce all overdue occurrences to the latest one, without iterating years. */
export function dueFiring(source, nextAt, now) {
  if (now < nextAt) return undefined;
  const scheduledAt = source.kind === 'calendar'
    ? CronExpressionParser.parse(source.cron, { tz: source.timezone, currentDate: now + 1 }).prev().getTime()
    : nextAt + Math.floor((now - nextAt) / ((source.seconds ?? source.everySeconds) * 1000)) * (source.seconds ?? source.everySeconds) * 1000;
  return { scheduledAt, nextAt: nextFiring(source, now), skipped: source.misfire === 'skip' && now - scheduledAt >= 60000 };
}

export function dueTime({ after, at }, now = Date.now()) {
  if ((after === undefined) === (at === undefined)) throw new Error('schedule needs exactly one of --after or --at');
  let due;
  if (after !== undefined) {
    const match = /^(\d+(?:\.\d+)?)(s|m|h|d)$/u.exec(after);
    if (!match) throw new Error('--after expects a duration such as 30s, 10m, 2h or 1d');
    due = now + Number(match[1]) * { s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]];
  } else {
    const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/u.exec(at);
    if (!match) throw new Error('--at needs an ISO timestamp with Z or an explicit UTC offset');
    due = Date.parse(at);
    const offset = match[2] === 'Z' ? 0 : (match[2][0] === '-' ? -1 : 1) * (Number(match[2].slice(1, 3)) * 60 + Number(match[2].slice(4))) * 60000;
    if (!Number.isFinite(due) || new Date(due + offset).toISOString().slice(0, 19) !== match[1]) throw new Error('--at is not a valid calendar timestamp');
  }
  if (!Number.isSafeInteger(due) || due <= now || due > 8640000000000000) throw new Error('the scheduled time must be in the future');
  return due;
}
