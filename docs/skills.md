# Skills 与工作区指令

DSCODE 的 skill 发现与正文加载由 `@deepseek-ai/dsh-skill-filesystem` 提供，工作区指令由 `@deepseek-ai/dsh-agent-instructions` 提供。本页说明它们各自扫描哪里、向上发现的开关怎么配，以及两者的边界。

## 默认发现范围

| rank | 来源 | 路径 |
|---|---|---|
| 100 | `project-dsh` | `<项目根>/.dsh/skills` |
| 200 | `project-agents` | `<项目根>/.agents/skills` |
| 300 | `custom` | `customSkillDirs`（祖先模式注册到这里） |
| 400 | `user-dsh` | `$DSH_HOME/skills`（跳过其 `.system` 子目录） |
| 500 | `user-agents` | `$DSH_AGENTS_HOME/skills` |
| 600 | bundled | 配置了 `bundledSkillDir` 时 |

项目根是**最近的含 `.git` 的祖先目录**，没有就用当前目录。rank 小的先扫描并优先，同名以先出现的为准，`/skills conflicts` 会列出来。

每个根只扫描其**顶层**的 `<name>/SKILL.md` 或 `<name>.md`；嵌套的 `**/SKILL.md` 刻意不发现。frontmatter 必需 `name` 与 `description`，可选 `user-invocable`、`disable-model-invocation`。目录项（name + description）每轮都在上下文里，正文只在调用时读取。

## 向上发现（祖先模式）

默认**关闭**。开启后，项目根到 home 之间**每一层**目录的下列三个根都会以 rank 300 注册：

```
<每一层>/.dsh/skills
<每一层>/.agents/skills
<每一层>/.claude/skills
```

例如 `~/Workspace/.dsh/skills` 会被 `~/Workspace` 下所有项目看到。规则：

- **只有 header 进 catalog**，正文仍然懒加载——和项目内的 skill 完全一致。
- **就近优先**：离 cwd 越近的目录先注册。rank 300 整体低于项目根的 100/200、高于用户根 400/500，所以项目内优先于祖先、祖先优先于用户级。
- 项目根的 `.dsh/skills`、`.agents/skills` 是 provider 自己的根，**不会重复注册**；项目根的 `.claude/skills` 不是 provider 的根，会被纳入。
- **home 之上不读**；cwd 不在 home 之下（例如 `/Volumes/...`）时不会加任何祖先根。
- 列表在**启动时解析一次**：会话内 `/cd` 或新建祖先 skill 目录都需要重开 dscode 才生效（skill 文件自身的增删改仍有 watcher）。

### 开关

环境变量 `DSCODE_SKILL_ANCESTORS`：

| 取值 | 结果 |
|---|---|
| 未设置、空串、`0`、`off`、`false` | 关闭 |
| 其它任意值（`1`、`true`、`on`、`yes`…，大小写不敏感） | 开启 |

设置方式：

| 方式 | 命令 / 位置 | 生效范围 |
|---|---|---|
| 单次 | `DSCODE_SKILL_ANCESTORS=1 dscode` | 这一次启动 |
| 持久（源码 / tar 形态） | 仓库或安装目录的 `.env`（已被 gitignore） | 之后每次启动 |
| 持久（npm / Hub 形态） | `$DSCODE_HOME/.env`，默认 `~/.local/share/dscode-hub/.env` | 之后每次启动 |

`config/harness.local.yml` 对这个开关**无效**：它是 DSH 的 patch，只在 preset 挂载之后起作用，而祖先列表必须在挂载前算好。

启动器（源码形态）或 bundle 的 bootstrap（npm/Hub 形态）解析出目录列表后，通过 `DSCODE_SKILL_ANCESTOR_DIRS` 传给 preset 的 `customSkillDirs`；这个内部变量不需要手工设置。

## 工作区指令 AGENTS.md / CLAUDE.md

**项目链（默认生效）**：从项目根往下到会话工作目录，每个目录读 `AGENTS.md`、`CLAUDE.md`，随后读 `AGENTS.local.md`、`CLAUDE.local.md`；另有用户级 `$DSH_HOME/AGENTS.md`。项目链**不覆盖**项目根之上的目录。

**项目根之上（默认生效，仅当文件存在）**：launcher 把 home 到项目根之上的每一层的 `AGENTS.md` / `CLAUDE.md` 聚合写到 `$DSH_HOME/workspace-instructions/AGENTS.md`，顺序是**用户级原文件在前，然后最远祖先 → 最近祖先**，preset 用 `dshHome` 指向该目录，其余交给上游的渲染与去重。没有任何祖先指令文件时不写任何文件，`$DSH_HOME/AGENTS.md` 的读取方式与之前完全相同。

字节预算沿用上游的 `maxBytes: 65536`：超预算时先整份丢掉更宽的文件，最后才截断最具体的文件，并给出可见的预算提示。祖先聚合文件自身有 60 KiB 上限（低于 `maxBytes`，留出余量）：上游对**超预算的宽文件是整份忽略**，而聚合文件正占最宽的 user-global 槽位，不设限的话一个超大的祖先文件会把用户级 `AGENTS.md` 一起带走。超出预算的单个来源整份跳过、不做半截截断，且用户级文件与最近的祖先优先保留。

## 验证与排查

| 命令 | 用途 |
|---|---|
| `/skills` | 有效 catalog：来源、provider、user/model 调用权限 |
| `/skills <name>` | 描述与生效路径，不注入正文 |
| `/skills conflicts` | 同名覆盖及其生效来源 |

确认祖先模式已生效：启动后跑 `/skills`，来自祖先目录的条目 `source` 为 `custom`；`/skills <name>` 会直接给出文件路径。

## 限制

- 祖先模式默认关闭：祖先目录不在版本控制内、无法随项目 review，且目录项常驻上下文，范围越大开销越高。
- 祖先列表在启动时确定，不随 `/cd` 变化。
- `/skills conflicts` 无法枚举运行时或远程 provider 的隐藏候选。
