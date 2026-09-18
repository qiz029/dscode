import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { parse } from 'yaml';
import { AGGREGATE_BUDGET_BYTES, ancestorChain, ancestorInstructionFiles, ancestorSkillDirs, skillAncestorsEnabled, writeWorkspaceInstructions } from '../plugins/tui-tools/workspace-discovery.mjs';

const write = (path, text = '') => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text); };
const skill = path => write(join(path, 'SKILL.md'), '---\nname: x\ndescription: x\n---\nbody\n');

function scaffold() {
  const home = mkdtempSync(join(tmpdir(), 'dscode-workspace-'));
  const project = join(home, 'ws/proj');
  mkdirSync(join(project, '.git'), { recursive: true });
  return { home, project, state: join(home, 'state'), cleanup: () => rmSync(home, { recursive: true, force: true }) };
}

test('the ancestor chain stops at home and is empty when home is not an ancestor', () => {
  assert.deepEqual(ancestorChain({ cwd: '/a/b/c', home: '/a' }), ['/a/b/c', '/a/b', '/a']);
  assert.deepEqual(ancestorChain({ cwd: '/a', home: '/a' }), ['/a']);
  assert.deepEqual(ancestorChain({ cwd: '/elsewhere/proj', home: '/a' }), []);
});

test('skill ancestors are opt-in and skip the roots the provider already scans', () => {
  const { home, project, cleanup } = scaffold();
  try {
    const workspace = join(home, 'ws');
    skill(join(project, '.dsh/skills/proj-skill'));
    skill(join(project, '.claude/skills/claude-skill'));
    skill(join(workspace, '.dsh/skills/ws-skill'));
    skill(join(workspace, '.agents/skills/ws-agents-skill'));
    assert.equal(skillAncestorsEnabled({}), false);
    assert.equal(skillAncestorsEnabled({ DSCODE_SKILL_ANCESTORS: 'no' }), false);
    assert.equal(skillAncestorsEnabled({ DSCODE_SKILL_ANCESTORS: 'yes' }), true);
    assert.deepEqual(ancestorSkillDirs({ cwd: project, home, env: {} }), []);
    assert.deepEqual(ancestorSkillDirs({ cwd: project, home, env: { DSCODE_SKILL_ANCESTORS: '1' } }), [
      join(project, '.claude/skills'),
      join(workspace, '.dsh/skills'),
      join(workspace, '.agents/skills'),
    ]);
  } finally {
    cleanup();
  }
});

test('only instruction files strictly above the project root are collected, farthest first', () => {
  const { home, project, cleanup } = scaffold();
  try {
    const workspace = join(home, 'ws');
    write(join(home, 'AGENTS.md'), 'home global\n');
    write(join(workspace, 'AGENTS.md'), 'workspace\n');
    write(join(workspace, 'CLAUDE.md'), 'workspace claude\n');
    write(join(project, 'AGENTS.md'), 'project\n');
    assert.deepEqual(ancestorInstructionFiles({ cwd: project, home }), [
      join(home, 'AGENTS.md'), join(workspace, 'AGENTS.md'), join(workspace, 'CLAUDE.md'),
    ]);
  } finally {
    cleanup();
  }
});

test('ancestor instructions are folded in front of the user-global file, and nothing is written without them', () => {
  const { home, project, state, cleanup } = scaffold();
  try {
    assert.equal(writeWorkspaceInstructions({ cwd: project, home, stateDir: state }), undefined);
    assert.equal(existsSync(join(state, 'workspace-instructions')), false);
    const workspace = join(home, 'ws');
    write(join(workspace, 'AGENTS.md'), 'workspace rules\n');
    write(join(state, 'AGENTS.md'), 'user global\n');
    const directory = writeWorkspaceInstructions({ cwd: project, home, stateDir: state });
    assert.equal(directory, join(state, 'workspace-instructions'));
    const aggregated = join(directory, 'AGENTS.md');
    assert.equal(readFileSync(aggregated, 'utf8'), 'user global\n\nworkspace rules\n');
    assert.equal(statSync(aggregated).mode & 0o777, 0o600);
  } finally {
    cleanup();
  }
});

test('the preset reads both ancestor results from the launcher environment', () => {
  const decode = text => parse(text, { customTags: [{ tag: 'tag:yaml.org,2002:js', resolve: value => value }] });
  const rows = decode(readFileSync(new URL('../presets/dscode/agent.cordis.yml', import.meta.url), 'utf8')).flatMap(row => row.insert ?? [row]);
  const skills = rows.find(row => row.id === 'skill-filesystem');
  const instructions = rows.find(row => row.id === 'agent-instructions');
  assert.match(String(skills.config.customSkillDirs), /DSCODE_SKILL_ANCESTOR_DIRS/);
  assert.equal(instructions.config.dshHome, 'process.env.DSCODE_INSTRUCTION_HOME');
  assert.equal(instructions.config.maxBytes, 65536);
});

test('the aggregate is bounded so an oversized ancestor cannot take the user-global file down with it', () => {
  const { home, project, state, cleanup } = scaffold();
  try {
    write(join(state, 'AGENTS.md'), 'user global\n');
    write(join(home, 'AGENTS.md'), 'home rules\n');
    write(join(home, 'ws/AGENTS.md'), `'x'.repeat(70 * 1024)\n`);
    const directory = writeWorkspaceInstructions({ cwd: project, home, stateDir: state });
    assert.equal(directory, join(state, 'workspace-instructions'));
    const aggregatedPath = join(directory, 'AGENTS.md');
    const aggregated = readFileSync(aggregatedPath, 'utf8');
    assert.match(aggregated, /user global/);
    assert.match(aggregated, /home rules/);
    assert(!aggregated.includes('xxxx'), 'the oversized ancestor must be dropped whole');
    assert(statSync(aggregatedPath).size < AGGREGATE_BUDGET_BYTES, 'the aggregate must stay under the provider render budget');
  } finally {
    cleanup();
  }
});

test('a symlinked home still bounds ancestor discovery in both directions', () => {
  const base = mkdtempSync(join(tmpdir(), 'dscode-symlink-'));
  const real = join(base, 'real-home');
  const link = join(base, 'link-home');
  const project = join(real, 'ws/proj');
  try {
    mkdirSync(join(project, '.git'), { recursive: true });
    skill(join(real, 'ws/.dsh/skills/ws-skill'));
    symlinkSync(real, link, 'dir');
    assert.deepEqual(ancestorChain({ cwd: project, home: link }), [project, join(real, 'ws'), real]);
    assert.deepEqual(ancestorChain({ cwd: join(link, 'ws/proj'), home: real }), [join(link, 'ws/proj'), join(link, 'ws'), link], 'cwd reached through the link keeps its logical chain and stops at the linked home');
    assert.deepEqual(ancestorSkillDirs({ cwd: project, home: link, env: { DSCODE_SKILL_ANCESTORS: '1' } }), [join(real, 'ws/.dsh/skills')]);
    assert.deepEqual(ancestorChain({ cwd: join(base, 'elsewhere'), home: link }), [], 'a cwd outside the real home stays out');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
