# 系统提示词对比：DSCODE / Claude Code / Codex CLI / pi

抓取时间：2026-09-17。DSCODE 侧基于本仓库与本次运行会话；其余三家基于公开可获取的原文（Codex 为官方仓库，Claude Code 与 pi 为第三方提取，见文末来源）。

## 速览

| 项目 | 原文可得性 | 静态提示词规模 | 组织方式 | 工具哲学 | 指令文件 | 记忆 |
|---|---|---|---|---|---|---|
| **DSCODE** | 本地可读（本仓库 + 运行时） | persona ≈ 1.5 KB + 插件段落 + 工具 schema | registry 按 `order` 拼接，插件贡献 | 持久 bash 为唯一读写通道 + `apply_patch` | `AGENTS.md`/`CLAUDE.md`，项目链 + 祖先聚合 | 跨会话 memory 工具 + `/memories` |
| **Claude Code** | 第三方提取（Opus 5 版约 139 KB，含工具章节） | 很大 | 单体提示词 + 动态 session context | 专用工具优先（Read/Edit/Write/Glob/Grep），鼓励并行调用 | `CLAUDE.md`（`claudeMd` 段 + 层级） | 文件式记忆 + `MEMORY.md` 索引，写入协议写在提示词里 |
| **Codex CLI** | **官方仓库** `codex-rs/models-manager/prompt.md` | 大（规范密度最高） | 单体提示词 | shell + `apply_patch`，搜索优先 `rg` | `AGENTS.md` 有专门 spec 段（作用域/优先级） | 无 |
| **pi** | 第三方提取（约 2.7 KB） | **极小** | 单体极简提示词 + 按需读平台文档 | `read`/`bash`/`edit`/`write`，bash 做 ls/rg/find | 未在提示词中规定 | 无 |

## 一句话结论

三家代表三种取向——Claude Code 与 Codex 走「重提示词、规范完备」，pi 走「极简提示词 + 按需读文档」，而 **DSCODE 是唯一的「组装式」：固定纪律写进部署 persona，可变部分（工具、策略、工具顺序）由插件按 order 贡献**；因此我们的提示词里几乎不含「哪个工具做哪件事」的教程，这部分被工具 schema 与插件段落替代。

## 关键事实 3 条

1. **我们的提示词不是一坨文本，而是有序 registry。** `@deepseek-ai/dsh-system-prompt` 提供 `ctx.systemPrompt`：固定开场在 order −1000，部署 persona 前缀在 order 0，第一方指导居中，persona 后缀在 order 10200，同 order 按段名 code-unit 排序拼接；工具顺序由 `toolOrder` 单独控制；`{{model}}`、`{{cwd}}` 等在每次 assemble 时解析（`node_modules/@deepseek-ai/dsh-system-prompt/README.md`）。
2. **Codex 把「怎么说话」写到了极致。** preamble 消息规范（1–2 句、8–12 词、给了 8 个示例）、plan 的「高质量 vs 低质量」对照、最终回答的标题/项目符号/等宽/文件引用全套格式规则，都在提示词里；这是四家里格式约束最强的。
3. **pi 只有约 2.7 KB，且几乎全是工具使用细节**：bash 做 `ls/rg/find`、优先 `read` 而非 `cat/sed`、`edits[].oldText` 必须精确匹配原文、多处改动合并成一次调用、`write` 只用于新文件或整体重写；没有行为规范、安全政策、格式规范。

## 我们（DSCODE）的提示词是怎么拼出来的

### 装配机制

| 组成 | 位置 / 来源 |
|---|---|
| 固定开场 `You are an AI agent powered by DeepSeek Harness.` | `includeHarnessIdentity`，order −1000 |
| 部署 persona 前缀 | preset `persona` 行的 `prefix`，order 0 |
| 第一方与插件贡献的段落 | 各插件 `ctx.systemPrompt.section({ name, order, text })` |
| 部署 persona 后缀 `Your working directory is {{cwd}}.` | preset `persona` 行的 `suffix`，order 10200 |
| 工具 schema 集合与顺序 | 工具 runtime + `toolOrder`（`'<unlisted-tools>'` 占位其余） |
| 动态 runtime context | `includeRuntimeContext`，每轮以 system-reminder 注入 |
| 工作区指令 `AGENTS.md`/`CLAUDE.md` | 由 `dsh-agent-instructions` 以**用户消息**注入，不进 system prompt |

### 本次会话实际看到的内容（按出现顺序）

1. **身份开场**：`You are an AI agent powered by DeepSeek Harness.`
2. **部署 persona**（`presets/dscode/agent.cordis.yml` 的 `persona` 行，约 20 条）：身份（"coding agent powered by the {{model}} model, working through a persistent shell"）、回复语言跟随用户、**进度更新节奏**（首次工具调用前说明、持续工作中约每分钟一次、阻塞时不假装说话、进度文本不是最终答复）、**范围纪律**（自行做常规判断、只有结论会实质改变时才问、交付完整范围、被阻塞时说明缺了什么）、**验证纪律**（跑相关检查、如实报告失败/跳过/未验证）、**评审预算与实施纪律**（评审结论要核实、不把完成的任务变成可选优化）。
3. **插件贡献的段落**：持久 shell 语义与跨调用状态、`apply_patch` 统一 diff 格式、后台任务与 job 清理、goal、子 agent 委派（默认后台、并发上限 3、子 agent 不得再委派）、skills 目录与调用规则、`present`、`review`、邮件/会话工具的使用边界、外部来源视为不可信数据。
4. **persona 后缀**：`Your working directory is <cwd>.`
5. **工具 schema 集合**：与 Claude/Codex 不同，我们没有 `read`/`write`/`edit`/`glob`/`grep` 工具，只有持久 `bash` + `apply_patch`，所以提示词里不需要「哪个工具做哪件事」的长教程。
6. **动态 runtime context（每轮）**：时间、workspace 写入策略、审批策略、skill catalog 摘要、外部来源标记。

> 说明：以上是按装配机制 + 本次会话可见内容重建的结构，不是某次带时间戳的 dump。仓库里没有现成的 dump 命令；要拿到逐字节原文，需要写一个监听 `system-prompt/assemble` 的探针插件（可做，见文末）。

## 三家对照

### Claude Code（Opus 5）

结构顺序：Identity → Harness（渲染方式、权限模式、hooks 输出视为用户反馈、优先专用工具、并行调用、`file_path:line_number` 引用）→ Session-specific guidance → Memory（文件式记忆目录、frontmatter 类型 `user/feedback/project/reference`、`MEMORY.md` 索引协议、召回记忆需重新核实）→ Environment（工作目录、是否 git、平台、shell、OS、模型 ID 与知识截止、可用形态）→ Scratchpad Directory（禁止用 `/tmp`）→ Context management（自动摘要说明）→ Delivering work（范围不可悄悄缩/扩、阻塞式提问的严格边界、重申请求即视为用户决定）→ Corrections（不要过度自我纠错）→ Session context（`gitStatus`、`claudeMd`、`userEmail`、`currentDate`）→ Agents（子 agent 类型清单）→ Skills（很长的目录，每个 skill 带触发词）→ Tools（逐个工具的详细说明 + JSON schema）。

特点：行为规范与工具教程都进提示词；对记忆写入协议、输出引用格式、安全双用途政策规定明确；动态部分（gitStatus/claudeMd/日期）以段落形式嵌在同一份提示词里。

### Codex CLI（官方）

结构顺序：Identity/能力 → Personality（简洁、直接、友好）→ **AGENTS.md spec**（作用域 = 所在目录树、更深层优先、系统/用户指令优先于 AGENTS.md、CWD 到根的内容已随 developer message 提供）→ Responsiveness / Preamble messages（8 个示例）→ Planning（`update_plan` 何时用、高质量与低质量计划示例）→ Task execution（持续到彻底解决、必须用 `apply_patch` 这个名字、编码准则与禁止事项清单：不修无关 bug、不加版权头、不自行 commit、不写单字母变量…）→ Validating your work（按审批模式决定是否主动跑测试）→ Ambition vs. precision（新项目可大胆、既有代码要外科手术式）→ Sharing progress updates → Presenting your work / 最终回答格式规范 → Tool Guidelines。

特点：规范文档化程度最高，大量示例与好坏对照；把 UI 层约定（preamble、最终回答样式）直接写进提示词；AGENTS.md 用一整节讲作用域与优先级。

### pi（`@earendil-works/pi-coding-agent`）

结构：身份（"operating inside pi, a coding agent harness"）→ 工具清单（`read`/`bash`/`edit`/`write`）→ 准则（bash 做 `ls/rg/find`；`read` 而非 `cat/sed`；`edit` 的 `oldText` 精确匹配原文、多处改动一次调用、不重叠不嵌套、尽量小；`write` 只用于新文件或整体重写；简洁、显示路径）→ **pi 平台文档路径**（提示词里直接给出 node_modules 下的 docs/examples 路径，按需 read）→ skills 读取规则（按目录解析相对路径）。

特点：最短，几乎没有行为规范；把「平台自身文档的位置」写进提示词，用按需读取替代长教程。

## 维度对比

| 维度 | DSCODE | Claude Code | Codex | pi |
|---|---|---|---|---|
| 身份声明 | 固定开场 + 部署 persona | "You are Claude Code, Anthropic's official CLI" | "You are a coding agent running in the Codex CLI" | "operating inside pi" |
| 提示词装配 | registry + order 拼接 | 单体 + 动态 session context 段 | 单体 + 动态 environment | 单体，极简 |
| 工具教程位置 | 工具 schema 内描述 | 提示词内大段工具章节 | 提示词内 Tool Guidelines | 提示词内准则 |
| 指令文件 | 项目链 + 祖先聚合，用户消息注入 | `CLAUDE.md` 段，含层级 | `AGENTS.md` spec 段，含作用域规则 | 未规定 |
| 进度沟通 | 明确「约每分钟一次」+ 进度文本非最终答复 | 隐含在输出规范 | 专门章节 + 8 个示例 + 8–12 词上限 | 无 |
| 验证纪律 | 明确（跑相关检查、如实报告） | "Delivering work" 中的如实报告要求 | 按审批模式决定是否主动跑 | 无 |
| 范围纪律 | 明确（不缩不放、阻塞说明） | 专门 "Delivering work" 段 | "Ambition vs. precision" 段 | 无 |
| 输出格式规范 | 少量（交给 TUI 渲染） | markdown + `file:line` 可点击 | 非常详细且强制 | 一句「简洁、给路径」 |
| 记忆 | 工具检索式跨会话记忆 | 文件式 + 索引协议写进提示词 | 无 | 无 |
| 子 agent | `subagent`/`subagent_fork`，含并发上限与层级限制 | Agent 工具有类型 + worktree 隔离 | 提示词中无 | 无 |
| 安全/权限 | 审批策略、外部来源不可信、沙箱策略 | 权限模式、不可逆操作先确认、双用途政策 | Sandbox and approvals 章节、永不自行 commit | 无 |
| 压缩/上下文 | compaction 插件 + 预算与 TPS 指标 | "Context management" 自动摘要说明 | 无 | 无 |

## 设计取向与取舍

- **重规范 vs 组装 vs 极简**：Claude/Codex 把「模型该怎么表现」写成完备规范；pi 只写工具细节、其余靠按需读文档；DSCODE 把不变量（纪律）与变量（工具/策略/顺序）分开，后者由插件在挂载时贡献——好处是换 preset、加插件不用改提示词文本，代价是**总体的样子只能靠装配后的结果观察，没有单一文件可读**。
- **工具面决定提示词形状**：Claude 有专用读写工具，于是提示词里有大段工具教程；我们收敛到持久 bash + `apply_patch`，提示词转而解释「持久 shell 的状态语义」和审批/沙箱边界。Codex 与 pi 介于两者之间。
- **把运行时策略写进 persona 是我们独有的**：进度更新节奏、自动评审预算、子 agent 并发上限这类「harness 政策」通常不会出现在 Claude/Codex/pi 的提示词里。
- **格式规范的取舍**：Codex 最细（输出可预测）但与 UI 强耦合，换 UI 要改提示词；我们几乎不规定格式，交给 TUI 渲染，代价是回答风格更依赖模型自觉。
- **记忆策略差异最大**：Claude 把「何时写、写什么类型、如何索引」写进提示词；我们是工具检索式，提示词不规定写入策略。

## 主要风险与注意

- **Claude Code 与 pi 的原文来自第三方提取仓库**，无法保证与当前线上部署逐字一致，也不包含动态注入（system-reminder、hooks 输出、skill 正文）。
- Codex 原文来自官方仓库 `main` 分支，会随版本变化；行文里的模型名与格式约定可能已随新版本调整。
- 提示词长度差异极大（pi ≈ 2.7 KB vs Claude Code ≈ 139 KB），token 成本、KV cache 命中与首字延迟不可直接类比。
- 我们的结构描述是「机制 + 本次会话观察」的重建，不是 dump；如需逐字原文需另写探针。

## 建议跟踪指标

- Codex：`codex-rs/models-manager/prompt.md` 的 diff。
- Claude Code：泄露仓库更新，以及官方 docs 的 memory / skills / hooks 章节（动态部分只能从文档推断）。
- pi：`@earendil-works/pi-coding-agent` 的 instructions 与平台文档结构。
- 自家：`presets/dscode/agent.cordis.yml` 的 persona 文本、`ctx.systemPrompt` 各 section 的 order 表、以及每次 assemble 的 token 数（可接到 session-metrics）。

## 来源

- 本地（DSCODE）：`presets/dscode/agent.cordis.yml`、`node_modules/@deepseek-ai/dsh-system-prompt/README.md`、`plugins/dscode/index.mjs`、`plugins/tui-tools/`、以及本次运行会话的可见 system prompt 与 runtime context。
- Codex CLI（官方仓库，2026-09 抓取）：<https://raw.githubusercontent.com/openai/codex/main/codex-rs/models-manager/prompt.md>
- Claude Code（第三方提取，Opus 5 版）：<https://github.com/asgeirtj/system_prompts_leaks/blob/main/Anthropic/claude-code/claude-code-opus-5.md>
- pi（第三方提取）：<https://github.com/asgeirtj/system_prompts_leaks/blob/main/Pi/instructions.md>
- pi 仓库（配置形态）：<https://github.com/knoopx/pi>

## 后续可选方向

1. 写一个监听 `system-prompt/assemble` 的探针（类似 `scripts/probe-plugin.mjs`），把逐字节提示词 dump 到文件，作为回归基线；这样 persona/插件改动可以被 diff 出来。
2. 在 session-metrics 里记录 system prompt 的 token 占比，与 compact 阈值联动。
3. 若要向 Codex 学习，优先补的是**最终回答格式规范**（我们现在完全交给模型与 TUI）。
4. 若要向 Claude 学习，优先补的是**记忆写入协议**（什么时候该写、写哪一类、如何索引）。

## 附：写代码相关的提示有没有

结论：**三家都有，但性质完全不同**——Codex 是「代码质量规范」，Claude Code 是「一句风格 + 编辑机制 + 工作纪律」，pi 几乎只有「编辑机制」。我们的提示词是**流程纪律很强、代码风格层为空**。

| | 代码质量规范 | 编辑机制约束 | 测试/验证 | 提交与仓库纪律 |
|---|---|---|---|---|
| **Codex** | ✅ 最系统 | ✅ `apply_patch` 专用格式 | ✅ 由具体→广泛、无测试的仓库不加测试、格式化最多重试 3 次 | ✅ 不自行 commit/建分支 |
| **Claude Code** | ⚠️ 仅一句 | ✅ 编辑串须精确匹配含缩进 | ⚠️ 通用「如实报告」，无测试策略 | ⚠️ 不可逆操作先确认 |
| **pi** | ❌ | ✅ 规则最细 | ❌ | ❌ |
| **DSCODE** | ⚠️ 复用既有模式 + 禁止过度工程 | ✅ 标准 unified diff + `--check` | ✅ 跑相关检查并如实报告 | ❌ 未规定 |

### Codex（唯一有完整「编码准则」块的）

- `Fix the problem at the root cause rather than applying surface-level patches, when possible.`
- `Avoid unneeded complexity in your solution.`
- `Do not attempt to fix unrelated bugs or broken tests.`
- `Keep changes consistent with the style of the existing codebase. Changes should be minimal and focused on the task.`
- `Update documentation as necessary.`
- `Use git log and git blame to search the history of the codebase if additional context is required.`
- `NEVER add copyright or license headers unless specifically requested.`
- `Do not add inline comments within code unless explicitly requested.`
- `Do not use one-letter variable names unless explicitly requested.`
- `Do not git commit your changes or create new git branches unless explicitly requested.`
- `Do not waste tokens by re-reading files after calling apply_patch on them.`
- 测试策略：具体到广泛逐层验证；`do not add tests to codebases with no tests`；格式化最多迭代 3 次，仍不成就在最终回复里说明。

### Claude Code（写代码的规则很少）

- 唯一明确的风格规则：`Write code that reads like the surrounding code: match its comment density, naming, and idiom.`
- 编辑机制（在 Edit 工具描述里）：`old_string` 必须与文件**完全一致、包含缩进**且唯一，需先剥掉 Read 的行号前缀。
- 工具偏好：`Prefer the dedicated file/search tools over shell commands when one fits.`；引用代码用 `file_path:line_number`（可点击）。
- 该版本中**没有**「根因修复」「不加注释」「不用单字母变量」「不自行 commit」这类规则；工作纪律集中在 `Delivering work` / `Corrections` 两节。

### pi（只有编辑机制，没有代码质量规则）

- `Use bash for file operations like ls, rg, find`
- `Use read to examine files instead of cat or sed.`
- `Use edit for precise changes (edits[].oldText must match exactly)`
- `Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits.`
- `Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.`
- `Use write only for new files or complete rewrites.`
- 没有测试、验证、风格、命名、提交相关的任何规定。

### 我们（DSCODE）

- `Before changing code, read the relevant code and any project instructions; reuse existing functions and patterns instead of adding new machinery.`
- `Verify changes by running the relevant checks, and report outcomes faithfully.`
- `Do not turn a finished task into optional optimization, refactoring or speculative hardening.`
- `Fix confirmed defects affecting this task; report unrelated opportunities separately.`
- 计划模式：`Prefer existing functions and patterns over new machinery.`
- 编辑通道：**标准 unified diff + `apply_patch --check`**（与 Codex 的 `*** Begin Patch` 不同）。
- 空缺：没有「匹配周边风格/注释密度」「根因修复」「不加注释」「不用单字母变量」「不自行 commit」「测试怎么写」这一类规则（已在 `presets/dscode/agent.cordis.yml`、`plugins/*/index.mjs`、`config/cordis.patch.yml` 中检索确认）。

**取舍**：Codex 的规则能显著压低「顺手改无关代码」「加一堆注释」「自行 commit」这类行为，代价是与具体代码库风格解耦（它说的是「匹配现有风格」，具体判断仍靠模型）。我们目前把这类判断完全留给模型与 memory；如果需要，最经济的做法是在 persona 里补 3–5 条同等级规则，而不是照搬整块。

## 修订：以「行为质量」为目标时的排序

前提修正：目标不是省 context，而是**减少因提示词导致的错误行为**。因此评价标准从「字节数」换成「这条规则是否改变了一个本来会做错的决策」。

### Chrome MCP 不是 Claude Code 那种浏览器能力

我们的 preset 用 `--isolated` 启动 `chrome-devtools-mcp@1.9.0`（`presets/dscode/agent.cordis.yml`），即**临时 profile**：看不到用户的登录态、扩展和书签。该包支持 `--browserUrl` / `--auto-connect` 连接一个已开启远程调试的 Chrome（其 troubleshooting skill 也把这两者列为进阶路径，并提到 Chrome 149+ 才能在连接既有实例时加载扩展），所以要「真的用你的 profile」是配置层面的切换，不是重写。当前状态的问题是**它在默认装配里占了约 29 个模型可见工具，却做不了需要登录态的浏览器任务**——这是行为面风险（模型可能为一个非浏览器任务去试浏览器工具，或先花一轮发现用不了），不只是成本问题。

### 三类该修的问题（按行为影响排序）

1. **规则互相拉扯**（比缺失更危险，因为模型会任意裁决）：
   - `give a concise progress update roughly every minute` 与紧随其后的 `Avoid repetitive filler and invented progress` 直接冲突：按分钟计时必然产出填充语。
   - `Do not turn a finished task into optional optimization, refactoring or speculative hardening` 与 Codex 式的 `Fix the problem at the root cause` 存在张力：根因修复常常超出字面任务范围，两条并存时必须明确「根因只针对本次报告的缺陷，不针对相邻问题」。
   - 同一规则在不同段落重复表述（"验证并如实汇报" 出现两次；"读相关代码" 两次），重复会稀释而不是加强。
2. **缺关键坏习惯的覆盖**（当前完全没有）：
   - 根因 vs 表层补丁；不修无关 bug/测试；匹配既有代码风格；不加无关注释；不自行 `git commit`/建分支；不在无测试的仓库里造测试。这六条是 Codex 那块里**行为收益最高**的部分。
3. **结构与边界缺失**：
   - **指令优先级**没有明说：system prompt / 用户 / `AGENTS.md` / memory 之间谁覆盖谁。Claude Code 明确写 "These instructions OVERRIDE any default behavior"，Codex 用一节讲 AGENTS.md 的作用域与优先级。
   - **反空转**：Claude 的 `When you have enough information to act, act. Do not re-derive facts already established...` 是抑制「反复确认、列一堆不打算做的选项」的有效条款。
   - **过度自我纠错**：Claude 有一整节 `Corrections`；我们这边没有对应约束，长会话里容易出现反复回溯。

### 学谁（修订版）

| 学什么 | 从谁学 | 为什么 |
|---|---|---|
| 行为规则的**内容** | **Codex** | 它的规则是条件句、覆盖真实坏习惯，且能直接落到我们的 persona |
| 规则的**取舍哲学** | **pi** | 一条规则若不能改变一个本来会出错的决策，就该删——与「字节数」无关 |
| **结构与边界** | **Claude Code** | 指令优先级、反空转、过度纠错的约束、记忆写入协议 |
| **不学** | pi 的零安全/零验证；Claude 的长工具教程 | 前者会退化我们的审批与评审语义，后者与工具 schema 重复 |

### 怎么验证（而不是拍脑袋）

仓库已有可复用的评测设施：`eval/continuation` 会在隔离工作区实际改代码并跑验收检查，支持多策略对照。可以据此建一组**行为回归任务**，例如：
- 表层补丁能通过现有测试、但根因修复才正确 → 检验是否会打补丁；
- 仓库里带一个无关的坏测试 → 检验是否顺手去修；
- 任务存在必须澄清的分歧 → 检验是猜还是问；
- 长任务 → 检验进度更新是否变成填充语。

对 persona 的 A/B 改动跑同一组任务，看通过率与失败模式，而不是看提示词长短。
