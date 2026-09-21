# Skills and workspace instructions

Skill discovery and body loading come from `@deepseek-ai/dsh-skill-filesystem`, and workspace instructions come from `@deepseek-ai/dsh-agent-instructions`. This page covers what each one scans, how the upward-discovery switch is configured, and where the boundary between them lies.

## Default discovery scope

| rank | Source | Path |
|---|---|---|
| 100 | `project-dsh` | `<project root>/.dsh/skills` |
| 200 | `project-agents` | `<project root>/.agents/skills` |
| 300 | `custom` | `customSkillDirs` (the ancestor mode registers here) |
| 400 | `user-dsh` | `$DSH_HOME/skills` (skipping its `.system` subdirectory) |
| 500 | `user-agents` | `$DSH_AGENTS_HOME/skills` |
| 600 | bundled | when `bundledSkillDir` is configured |

The project root is the **nearest ancestor directory containing `.git`**, or the current directory when there is none. A lower rank is scanned first and wins, a duplicate name goes to the one that appeared first, and `/skills conflicts` lists them.

Each root is scanned only for its **top-level** `<name>/SKILL.md` or `<name>.md`; a nested `**/SKILL.md` is deliberately not discovered. Frontmatter requires `name` and `description` and may add `user-invocable` and `disable-model-invocation`. The directory entries (name + description) are in the context every turn, and a body is read only when it is invoked.

## Upward discovery (ancestor mode)

On by **default**. The following three roots in **every** directory between the working directory and home are registered at rank 300:

```
<each level>/.dsh/skills
<each level>/.agents/skills
<each level>/.claude/skills
```

For example `~/Workspace/.dsh/skills` becomes visible to every project under `~/Workspace`. Rules:

- **Only headers enter the catalog**; bodies stay lazy-loaded, exactly like a project-local skill.
- **Nearest wins**: a directory closer to the cwd registers first. Rank 300 is below the project root's 100/200 and above the user roots' 400/500, so a project or ancestor skill beats a user-level one, and within rank 300 the roots are registered nearest-first, so a nearer ancestor beats a farther one. The single inversion is a directory between the working directory and the project root (for example `repo/src` while the session runs in it and `repo` is the project root): it ranks 300 while the project root's own `.dsh/skills` and `.agents/skills` rank 100/200, so the project root's definition of a duplicate name wins there.
- A project root's `.dsh/skills` and `.agents/skills` are the provider's own roots and are **not registered twice**; a project root's `.claude/skills` is not one of the provider's roots, so it is included.
- **Nothing above home is read**; when the cwd is not under home (for example `/Volumes/...`) no ancestor root is added.
- The list is resolved **once at startup**: `/cd` inside a session, or creating an ancestor skill directory, needs dscode to be reopened before it takes effect (adding, changing and removing a skill file itself still has a watcher).

### Switch

Environment variable `DSCODE_SKILL_ANCESTORS`:

| Value | Result |
|---|---|
| unset, empty, or any unrecognised value | on |
| `0`, `off`, `false`, `no`, `none`, `disable` (case-insensitive) | off |

How to turn it off:

| Way | Command / location | Scope |
|---|---|---|
| One run | `DSCODE_SKILL_ANCESTORS=0 dscode` | this launch |
| Persistent (source / tar) | the repository's or installation's `.env` (already gitignored) | every later launch |
| Persistent (npm / Hub) | `$DSCODE_HOME/.env`, by default `~/.local/share/dscode-hub/.env` | every later launch |

`config/harness.local.yml` has **no effect** on this switch: it is a DSH patch that only applies after the preset is mounted, whereas the ancestor list has to be computed before mounting.

The launcher (source form) or the bundle's bootstrap (npm/Hub form) resolves the directory list and passes it to the preset's `customSkillDirs` through `DSCODE_SKILL_ANCESTOR_DIRS`; this internal variable does not need to be set by hand.

## Workspace instructions AGENTS.md / CLAUDE.md

**Project chain (on by default)**: from the project root down to the session working directory, each directory contributes `AGENTS.md` and `CLAUDE.md`, followed by `AGENTS.local.md` and `CLAUDE.local.md`; there is also a user-level `$DSH_HOME/AGENTS.md`. The project chain does **not** cover directories above the project root.

**Above the project root (on by default, only when the file exists)**: the launcher aggregates `AGENTS.md` / `CLAUDE.md` from every level between home and the project root into `$DSH_HOME/workspace-instructions/AGENTS.md`, ordered **user-level original file first, then the farthest ancestor → the nearest ancestor**, and points the preset at that directory with `dshHome`, leaving rendering and de-duplication to upstream. When there is no ancestor instruction file at all, no file is written and `$DSH_HOME/AGENTS.md` is read exactly as before.

The byte budget keeps upstream's `maxBytes: 65536`: over budget, a wider file is dropped whole first and the most specific file is truncated last, with a visible budget notice. The ancestor aggregate file itself has a 60 KiB cap (below `maxBytes`, leaving headroom): upstream drops a **wider file over budget whole**, and the aggregate file occupies the widest user-global slot, so without a cap one oversized ancestor file would take the user-level `AGENTS.md` down with it. A single source over budget is skipped whole rather than half-truncated, and the user-level file and the nearest ancestor are kept first.

## Verification and troubleshooting

| Command | Purpose |
|---|---|
| `/skills` | the effective catalog: source, provider, user/model invocation permission |
| `/skills <name>` | description and effective path, without injecting the body |
| `/skills conflicts` | same-name overrides and their effective source |

To confirm ancestor mode is active, run `/skills` after startup: entries from an ancestor directory have `source` `custom`, and `/skills <name>` gives the file path directly. The footer's `skills` figure carries the same catalog's size and updates with it (`/statusline` toggles the item); it stays `--` until the first catalog read settles.

## Limits

- Ancestor discovery is on by default, so the content-cost of the wider scope and the fact that ancestor directories sit outside version control are the default experience; set `DSCODE_SKILL_ANCESTORS=0` to go back to the project and user roots alone.
- The ancestor list is fixed at startup and does not follow `/cd`.
- `/skills conflicts` cannot enumerate hidden candidates from a runtime or a remote provider.
