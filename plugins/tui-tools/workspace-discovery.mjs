import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';

// Discovery above the project root, bounded at the home directory rather than the
// filesystem root: a shared workspace directory such as ~/Workspace can contribute
// skills and instructions to every project below it, while nothing outside the
// operator's own tree can.
export const ancestorSkillRoots = Object.freeze(['.dsh/skills', '.agents/skills', '.claude/skills']);
export const instructionFileCandidates = Object.freeze(['AGENTS.md', 'CLAUDE.md']);
export const projectRootMarkers = Object.freeze(['.git']);

export const ENABLED_VALUES = Object.freeze(['1', 'true', 'on', 'yes']);
// Fail closed: only the documented enable spellings arm a switch, so an operator
// writing "no", "none" or "disable" cannot accidentally turn on a feature that
// reads untrusted project content.
export const enabledFlag = (value) => ENABLED_VALUES.includes(String(value ?? '').trim().toLowerCase());
export const skillAncestorsEnabled = (env = process.env) => enabledFlag(env.DSCODE_SKILL_ANCESTORS);

// A symlinked $HOME (or a /Volumes mount) must not break the boundary test: the
// launcher passes an already-resolved session directory while os.homedir() returns
// whatever $HOME says, so the comparison canonicalizes both sides. The chain itself
// keeps the caller's logical paths, which is what the skill and instruction probes
// then stat.
const canonical = path => { try { return realpathSync(path); } catch { return resolve(path); } };

// Every directory from the working directory up to home, nearest first. An empty
// list means home is not an ancestor, and the mode then contributes nothing.
export function ancestorChain({ cwd, home }) {
  const start = resolve(cwd);
  const stop = resolve(home);
  const canonicalStop = canonical(stop);
  const canonicalStart = canonical(start);
  if (canonicalStart !== canonicalStop && !canonicalStart.startsWith(canonicalStop + sep)) return [];
  const chain = [];
  for (let current = start; ;) {
    chain.push(current);
    if (canonical(current) === canonicalStop) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return chain;
}

export function projectRootOf({ cwd, markers = projectRootMarkers }) {
  const start = resolve(cwd);
  for (let current = start; ;) {
    if (markers.some(marker => existsSync(join(current, marker)))) return current;
    const parent = dirname(current);
    if (parent === current) return start;
    current = parent;
  }
}

export function ancestorSkillDirs({ cwd, home, env = process.env }) {
  if (!skillAncestorsEnabled(env)) return [];
  const projectRoot = projectRootOf({ cwd });
  const dirs = [];
  for (const dir of ancestorChain({ cwd, home })) {
    for (const root of ancestorSkillRoots) {
      // The provider already scans these two at rank 100/200 for the owning project.
      if (dir === projectRoot && (root === '.dsh/skills' || root === '.agents/skills')) continue;
      const path = join(dir, root);
      if (existsSync(path) && !dirs.includes(path)) dirs.push(path);
    }
  }
  return dirs;
}

// Instruction files strictly above the project root, farthest first so the chain
// still reads broad to specific. The project chain itself stays upstream's job.
export function ancestorInstructionFiles({ cwd, home }) {
  const chain = ancestorChain({ cwd, home });
  // The chain runs from the working directory outward, so everything after the
  // project root is above it; reversing restores broad-to-specific order.
  const stop = chain.indexOf(projectRootOf({ cwd }));
  const above = (stop === -1 ? chain : chain.slice(stop + 1)).reverse();
  const files = [];
  for (const dir of above) {
    for (const name of instructionFileCandidates) {
      const path = join(dir, name);
      if (existsSync(path)) files.push(path);
    }
  }
  return files;
}

// The provider ignores a source file that cannot fit its render budget, and the
// aggregate below occupies the broadest (user-global) slot: without a bound, one
// oversized ancestor file would take the user-global instructions down with it.
// Stay under the preset's 64 KiB maxBytes with headroom.
export const AGGREGATE_BUDGET_BYTES = 60 * 1024;

// The upstream provider owns exactly one user-global instruction file, so ancestor
// files are folded in behind it. With no ancestor file this writes nothing and
// changes nothing: the provider keeps reading $DSH_HOME/AGENTS.md where it always did.
// The user-global file is always written: dropping it in favour of its descendants
// would silently replace what the user wrote with what the project wrote. Ancestors
// are then added nearest-first while the budget allows, and a source that would
// overflow is skipped whole rather than truncated mid-file.
export function writeWorkspaceInstructions({ cwd, home, stateDir }) {
  const files = ancestorInstructionFiles({ cwd, home });
  if (!files.length) return undefined;
  const userGlobal = join(stateDir, 'AGENTS.md');
  const texts = new Map();
  if (existsSync(userGlobal)) texts.set(userGlobal, readFileSync(userGlobal, 'utf8').trim());
  for (const file of files) texts.set(file, readFileSync(file, 'utf8').trim());
  const written = [...texts.keys()];
  const priority = written[0] === userGlobal ? [userGlobal, ...written.slice(1).reverse()] : [...written].reverse();
  const kept = new Set();
  let bytes = 0;
  for (const source of priority) {
    const size = Buffer.byteLength(texts.get(source), 'utf8') + 2;
    if (kept.size > 0 && bytes + size > AGGREGATE_BUDGET_BYTES) continue;
    kept.add(source);
    bytes += size;
  }
  const directory = join(stateDir, 'workspace-instructions');
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'AGENTS.md'), written.filter(source => kept.has(source)).map(source => texts.get(source)).join('\n\n') + '\n', { mode: 0o600 });
  return directory;
}
