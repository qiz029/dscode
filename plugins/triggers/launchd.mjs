// Installing a trigger into the system scheduler. launchd owns the clock
// (docs/triggers-design.md), so this module turns one definition into a
// LaunchAgent plist and, for anything launchd cannot express, into the crontab
// line a person can paste. Nothing here runs a session or decides anything about
// a run: it is text generation plus two launchctl calls.
//
// Only shapes launchd can express are accepted on purpose. A cron expression it
// cannot map (ranges, steps, lists) fails the install with a message rather than
// silently scheduling something else.

import { join } from 'node:path';

/** Label prefix for a DSCODE trigger agent; one label per trigger id. */
export const AGENT_LABEL_PREFIX = 'ai.dscode.trigger.';

/** Where an installed agent's plist and its launchd output live. */
export const agentPath = (home, id) => join(home, 'triggers', 'agents', `${id}.plist`);
export const agentStdoutPath = (home, id) => join(home, 'triggers', 'agents', `${id}.log`);
export const agentLabel = id => `${AGENT_LABEL_PREFIX}${id}`;

const CRON_FIELDS = ['Minute', 'Hour', 'Day', 'Month', 'Weekday'];

/**
 * Map a five-field cron expression onto launchd's StartCalendarInterval keys.
 * Only `*` and plain numbers are accepted: launchd has no syntax for ranges,
 * steps or lists, so those are refused instead of approximated.
 * @param cron - `minute hour day month weekday`.
 * @returns the keys an integer-valued StartCalendarInterval may carry.
 * @throws {Error} with a user-facing message for anything launchd cannot express.
 */
export function cronToCalendarInterval(cron) {
  const fields = String(cron).trim().split(/\s+/u);
  if (fields.length !== 5) throw new Error('the cron expression needs five fields (minute hour day month weekday)');
  const interval = {};
  fields.forEach((field, index) => {
    if (field === '*') return;
    if (!/^\d{1,2}$/u.test(field)) {
      throw new Error(`launchd cannot schedule "${field}" in the ${CRON_FIELDS[index]} field: use intervals for a cadence, or plain numbers here`);
    }
    interval[CRON_FIELDS[index]] = Number(field);
  });
  if (Object.keys(interval).length === 0) throw new Error('a cron expression of five "*" fields would fire every minute; use an interval instead');
  return interval;
}

/** Escape the five XML characters a plist value may contain. */
const xml = value => String(value).replace(/[<>&"']/gu, char => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[char]));

/**
 * Build the LaunchAgent plist for one definition.
 * @param definition - a normalized definition.
 * @param options - `{ home, dscodePath, project }`; `dscodePath` must be absolute.
 * @returns the plist XML.
 * @throws {Error} when the source has no schedule to install.
 */
export function launchAgent(definition, { home, dscodePath, project }) {
  const args = [dscodePath, 'trigger', 'run', definition.id, '--project', project];
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    `  <key>Label</key><string>${xml(agentLabel(definition.id))}</string>`,
    '  <key>ProgramArguments</key>',
    '  <array>',
    ...args.map(argument => `    <string>${xml(argument)}</string>`),
    '  </array>',
    `  <key>WorkingDirectory</key><string>${xml(definition.workspace)}</string>`,
    '  <key>ProcessType</key><string>Background</string>',
    `  <key>StandardOutPath</key><string>${xml(agentStdoutPath(home, definition.id))}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(agentStdoutPath(home, definition.id))}</string>`,
  ];
  const { kind } = definition.source;
  if (kind === 'interval') lines.push(`  <key>StartInterval</key><integer>${definition.source.seconds}</integer>`);
  else if (kind === 'poll') lines.push(`  <key>StartInterval</key><integer>${definition.source.everySeconds}</integer>`);
  else if (kind === 'calendar') {
    const interval = cronToCalendarInterval(definition.source.cron);
    lines.push('  <key>StartCalendarInterval</key>', '  <dict>', ...Object.entries(interval).map(([key, value]) => `    <key>${key}</key><integer>${value}</integer>`), '  </dict>');
  } else if (kind === 'watch') {
    lines.push('  <key>WatchPaths</key>', '  <array>', ...definition.source.paths.map(path => `    <string>${xml(path)}</string>`), '  </array>');
  } else {
    throw new Error(`a "${kind}" source has nothing to schedule: producers post into its spool with "dscode trigger emit ${definition.id}"`);
  }
  lines.push('</dict>', '</plist>', '');
  return lines.join('\n');
}

/**
 * The crontab line for the same schedule, for a machine without launchd.
 * @returns the line, or a comment explaining why there is none.
 */
export function crontabLine(definition, { dscodePath, project }) {
  const command = `${dscodePath} trigger run ${definition.id} --project ${project}`;
  if (definition.source.kind === 'calendar') return `${definition.source.cron} ${command}`;
  const seconds = definition.source.kind === 'interval' ? definition.source.seconds
    : definition.source.kind === 'poll' ? definition.source.everySeconds : undefined;
  if (seconds === undefined) return `# ${definition.id}: a "${definition.source.kind}" source has no crontab form; producers post events instead`;
  if (seconds % 60 !== 0) return `# ${definition.id}: ${seconds}s is not a whole number of minutes; cron runs at minute resolution`;
  const minutes = seconds / 60;
  return minutes < 60 ? `*/${minutes} * * * * ${command}` : `0 */${Math.round(minutes / 60)} * * * ${command}`;
}
