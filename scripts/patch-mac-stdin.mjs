import { replaceOnce } from './patch-util.mjs';

// macOS exposes neither the waiting syscall (Linux reads /proc/<pid>/syscall)
// nor a wait channel: `ps -o wchan` prints "-" for every user process. A command
// blocked on terminal input is therefore recognised by what its process group
// visibly does: it owns the shell's terminal, every member is asleep, its CPU
// time has stopped advancing, and no member holds a network socket it could be
// waiting on instead. The freeze window keeps work in flight from looking like
// a wait, and the caller throttles the probe.
export const STDIN_PROBE_MS = 250;
/** Idle probes back off up to this multiple: a long command polls the process table far less often. */
export const STDIN_PROBE_MAX_MULTIPLE = 8;
export const STDIN_FREEZE_MS = 1200;

/** `ps -o time=` prints either `MM:SS.ss` or `HH:MM:SS.ss`. */
export function cpuSeconds(text) {
  const values = String(text).split(':').map(part => Number(part));
  if (values.length < 2 || values.some(value => !Number.isFinite(value))) return undefined;
  return values.reduce((total, value) => total * 60 + value, 0);
}

/** Parse rows of `ps -o pid=,pgid=,tty=,state=,time=`. */
export function parseProcessRows(text) {
  return String(text).split('\n').flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s*$/.exec(line);
    return match === null ? [] : [{ pid: Number(match[1]), pgid: Number(match[2]), tty: match[3], state: match[4], cpu: cpuSeconds(match[5]) }];
  });
}

/** Pids in `pids` that hold no network file, so a silent process cannot be waiting on one. */
export function withoutSockets(text, pids) {
  const holders = new Set(String(text).split('\n').flatMap(line => {
    const match = /^p(\d+)$/.exec(line.trim());
    return match === null ? [] : [Number(match[1])];
  }));
  return pids.filter(pid => !holders.has(pid));
}

export function socketFreePids(internals, pids) {
  if (pids.length === 0) return [];
  try {
    return withoutSockets(internals.exec('/usr/sbin/lsof', ['-nP', '-a', '-p', pids.join(','), '-i', '-Fp']), pids);
  } catch (error) {
    // lsof exits 1 when nothing matched: no sockets, not a failed probe.
    return error?.status === 1 ? [...pids] : [];
  }
}

/**
 * Verdict for one probe. `previous` is the snapshot the earlier probe returned,
 * so a wait is reported only after the group stayed asleep and CPU-idle for the
 * whole freeze window.
 */
export function stdinWaitVerdict(rows, previous, now, pgid, shellPid, freezeMs) {
  const shell = rows.find(row => row.pid === shellPid);
  if (shell === undefined || shell.tty === '??' || shell.tty === '-') return { waiting: false, pids: [], snapshot: undefined };
  const members = rows.filter(row => row.pgid === pgid && row.pid !== shellPid && row.tty === shell.tty);
  if (members.length === 0) return { waiting: false, pids: [], snapshot: undefined };
  const pids = members.map(row => row.pid);
  const cpu = new Map(members.map(row => [row.pid, row.cpu]));
  const asleep = members.every(row => row.cpu !== undefined && (row.state.startsWith('S') || row.state.startsWith('U')));
  const frozen = asleep && previous !== undefined && members.every(row => previous.cpu.get(row.pid) === row.cpu);
  if (!frozen) return { waiting: false, pids, snapshot: { since: asleep ? now : undefined, cpu } };
  const since = previous.since ?? now;
  return { waiting: now - since >= freezeMs, pids, snapshot: { since, cpu } };
}

const MAC_INSPECTOR_STUB = ['\tisStdinWaiting(_pgid, _shellPid) {', '\t\treturn false;', '\t}'].join('\n');

// Injected as class source, so every line carries the bundle's own tab indent.
const MAC_INSPECTOR_PROBE = [
  '\tisStdinWaiting(pgid, shellPid) {',
  '\t\tconst now = Date.now();',
  '\t\tconst cached = dscodeStdinWaitProbes.get(this);',
  '\t\tconst state = cached ?? { at: 0, idle: 0, waiting: false, snapshot: void 0 };',
  '\t\tif (cached !== void 0 && now - cached.at < dscodeStdinProbeMs * Math.min(dscodeStdinProbeMax, 2 ** state.idle)) return cached.waiting;',
  '\t\tstate.at = now;',
  '\t\tdscodeStdinWaitProbes.set(this, state);',
  '\t\tlet rows;',
  '\t\ttry {',
  '\t\t\trows = parseProcessRows(this.internals.exec("/bin/ps", ["-o", "pid=,pgid=,tty=,state=,time=", "-ax"]));',
  '\t\t} catch (_unreadableProcessTable) {',
  '\t\t\tstate.waiting = false;',
  '\t\t\tstate.snapshot = void 0;',
  '\t\t\treturn false;',
  '\t\t}',
  '\t\tconst verdict = stdinWaitVerdict(rows, state.snapshot, now, pgid, shellPid, dscodeStdinFreezeMs);',
  '\t\t// Idle probes back off; any change in group state restarts the fast poll.',
  '\t\tconst changed = state.snapshot === void 0 || verdict.snapshot === void 0 || state.snapshot.since !== verdict.snapshot.since || state.snapshot.cpu.size !== verdict.snapshot.cpu.size;',
  '\t\tstate.idle = verdict.waiting || changed ? 0 : state.idle + 1;',
  '\t\tstate.snapshot = verdict.snapshot;',
  '\t\tstate.waiting = verdict.waiting && socketFreePids(this.internals, verdict.pids).length > 0;',
  '\t\treturn state.waiting;',
  '\t}',
].join('\n');

export const MAC_INSPECTOR_ANCHOR = [
  '\t\t\treturn Number.isSafeInteger(value) && value > 0 ? value : void 0;',
  '\t\t} catch (_missingProcess) {',
  '\t\t\treturn;',
  '\t\t}',
  '\t}',
  MAC_INSPECTOR_STUB,
].join('\n');

/** Replace the macOS inspector's `isStdinWaiting` stub with the process-table probe. */
export function patchMacStdin(text) {
  if (text.includes('// dscode-mac-stdin-wait-v1')) {
    if (text.includes('const dscodeStdinProbeMax =')) return text;
    const oldProbe = MAC_INSPECTOR_PROBE
      .replace('\t\tconst state = cached ?? { at: 0, idle: 0, waiting: false, snapshot: void 0 };\n\t\tif (cached !== void 0 && now - cached.at < dscodeStdinProbeMs * Math.min(dscodeStdinProbeMax, 2 ** state.idle)) return cached.waiting;', '\t\tif (cached !== void 0 && now - cached.at < dscodeStdinProbeMs) return cached.waiting;\n\t\tconst state = cached ?? { at: 0, waiting: false, snapshot: void 0 };')
      .replace(/\t\t\/\/ Idle probes back off;[^\n]*\n\t\tconst changed = [^\n]*\n\t\tstate.idle = [^\n]*\n/, '');
    return replaceOnce(text, oldProbe, MAC_INSPECTOR_PROBE).replace('// dscode-mac-stdin-wait-v1', `// dscode-mac-stdin-wait-v1\nconst dscodeStdinProbeMax = ${STDIN_PROBE_MAX_MULTIPLE};`);
  }
  const helpers = [cpuSeconds, parseProcessRows, withoutSockets, socketFreePids, stdinWaitVerdict].map(fn => fn.toString()).join('\n');
  const head = `// dscode-mac-stdin-wait-v1\nconst dscodeStdinProbeMs = ${STDIN_PROBE_MS};\nconst dscodeStdinProbeMax = ${STDIN_PROBE_MAX_MULTIPLE};\nconst dscodeStdinFreezeMs = ${STDIN_FREEZE_MS};\nconst dscodeStdinWaitProbes = new WeakMap();\n`;
  return head + helpers + '\n' + replaceOnce(text, MAC_INSPECTOR_ANCHOR, MAC_INSPECTOR_ANCHOR.replace(MAC_INSPECTOR_STUB, MAC_INSPECTOR_PROBE));
}
