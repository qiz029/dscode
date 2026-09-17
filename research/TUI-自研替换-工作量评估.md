# DSCODE TUI 完全自研：工作量评估

- 日期：2026-09-16
- 评测对象：当前工作树（v0.7.12，dsh-code 1.2.0，@deepseek-ai/dsh-* 0.1.5-rc.2）
- 结论一句话：**"升级总出问题"的根因是文本锚点补丁，不是 dsh-code 本身；消灭这个痛点只需要 vendor 上游源码（1.5–3 周），而从零自研一套 TUI 要 3–4.5 个月、且换掉的是"渲染与交互层"而非 26k 行全部。**

## 一、现状量化（本仓库实测）

| 项目 | 数量 | 来源 |
|---|---|---|
| 上游 TUI 源码 | 61 文件 / 26,154 行 TS | `node_modules/dsh-code/src` |
| 　　其中 app.ts | 6,600 行 | 同上 |
| 　　其中 render/ | 7,240 行 | markdown/宽度/编辑器/工具预览/状态/usage/投影 |
| 　　其中 index.ts（runner） | 2,322 行 | 同上 |
| 　　其中面板类 | 3,646 行 | kernel-panels 1,398 + 各 panel + inspector |
| 　　其中 i18n 词条 | 977 行 | locales/en.ts + zh.ts |
| 编译产物 | 94,096 行 | `lib/*.mjs` |
| host 组装 | 241 行 | `cordis.patch.yml` |
| 我们的 TUI 文本补丁 | 31 文件 / 2,866 行 | `scripts/patch-*.mjs` |
| 当前探针状态 | **27/27 patches apply** | `npm run probe:tui` |
| 自研插件 | 6,212 行 | `plugins/`（与 TUI 耦合：session-cards / session-metrics / tui-tools / email / ultra / memory / auto-review / openrouter） |
| TUI 验证资产 | 6 个真实 Ink 验证 806 行 + tests 4,797 行（部分） + 探针 78 行 | `scripts/verify-tui-*.mjs`、`scripts/probe-tui-patches.mjs` |

### 升级成本实测（痛点证据）

| 事件 | 破坏面 | 改动量 |
|---|---|---|
| dsh-code 1.0.6 → 1.2.0 | 17/25 锚点失配（含级联），需要按新源码重写注入点 | 一次结构性迁移 |
| v0.7.11 发布提交 | — | 30 文件 / 434 行（补丁+验证） |
| v0.7.12 发布提交 | — | 324 行（补丁+验证） |

> 参考：`research/dsh-code-1.2.0-迁移笔记.md` 已记录同一结论——"这是一次结构性迁移，不是版本号提升"。

## 二、"完全自研"实际要实现的模块

自研换掉的是**客户端渲染与交互层**；session / agent / tools / sandbox / 权限 / 持久化仍由 `@deepseek-ai/dsh-*` host 平面提供。

| # | 模块 | 上游对应 | 自研工作量估算 |
|---|---|---|---|
| 1 | 渲染基座（宽度/换行/markdown/diff 着色/主题调色板/动画/终端标题/resize） | render/ 7,240 + theme 462 | 5,000–7,000 行 |
| 2 | 输入与编辑器（编辑器内核、按键映射、IME 锚点、括号粘贴、大粘贴、history、@mention、slash 补全、fuzzy） | editor/editor-keys/keyboard/mentions/input-split/render/editor+ime+fuzzy | 3,500–4,500 行 |
| 3 | 会话视图与投影（session log → transcript、工具预览/详情、streaming、footer/状态、turn 分隔、compaction、token/成本/缓存统计） | store/projection/status/tool-preview/tool-detail/usage | 3,000–4,000 行 |
| 4 | 面板与交互（审批、user questions、权限、授权登录、模型选择与搜索、provider 设置、主题/语言、update、skills/hooks/plugin inventory、subagents、schedule、email、会话目录/切换/fork、git workflow） | kernel-panels 1,398 + 各 panel 3,646 + models/provider-settings 等 | 5,000–7,000 行 |
| 5 | 命令系统与 i18n（本地命令目录、slash 分发、12 条 DSCODE 命令、中英词条） | commands.ts + locales 977 | 1,000–1,500 行 |
| 6 | host 接线与验证（tui-startup、runner 行、profile 组装、6 项 Ink 验证、单测） | index.ts/startup.ts + scripts | 1,500–2,500 行 |

**合计 ≈ 20,000–27,000 行**（与上游 26k 同量级，符合"功能对齐"的预期）。

### 工期估算（单人全职，已熟悉该代码库）

| 形态 | 到"不输现在"的工期 |
|---|---|
| C1 从零自研 Ink TUI（可参考/移植上游 MIT 源码） | 约 3–4.5 个月 |
| C2 换成非 Ink 渲染栈的新前端（自绘/Web/Tauri 等） | 约 4.5–7.5 个月，且终端兼容矩阵是全新风险 |
| 最小可用内核（会话/流式/工具/审批/输入/IME/滚动/模型切换） | 5–8 周，约 6,000–9,000 行 |

## 三、自研消不掉的那部分成本

即使 TUI 完全自有，以下仍需跟着上游走：

1. `patchRuntime` 对 **9 个 `@deepseek-ai` 包**的补丁：`dsh-tool-subagent`、`dsh-subagent`、`dsh-subagent-in-process-driver`、`dsh-llm-deepseek`、`dsh-tool-bash`、`dsh-tool-bash-persistent`、`dsh-terminal-bash`、`dsh-compaction-basic`、`dsh-subprocess-local`（macOS stdin 探测）。
2. `cordis.patch.yml` 241 行的 row 组装（上游 rc 版本改 row id/config 时会破）。
3. **19 个 host 服务契约**（`ctx.get`）：credentials、settings、llm、attachments、authorization、sessionProjections、commands、skills、sessionTitle、sessions、sessionReferenceResolver、sessionPersistence、permissionPresets、loader、jobs、appExit、agents、agentPresets、agentDefaultModel。
4. 上游 TUI 白拿的持续改进（新终端协议、composer/header 重构、内建 /language 与 /review 等）——自研后要自己实现或自己放弃。

## 四、三条路线对比

| 路线 | 一次性成本 | 每次上游升级 | 拿到什么 | 主要风险 |
|---|---|---|---|---|
| **A 维持文本补丁** | 0 | 0.5–2 天 + 6 项 UI 验证 | 现状 | 锚点静默失配（现有 `probe:tui` 可兜底） |
| **B vendor 上游源码改造** ⭐ | 1.5–3 周 | 0.5–1 天 merge 冲突 | 完全控制 + 锚点脆弱性归零 | 需自行补齐上游未附的构建配置；merge 冲突仍需处理 |
| **C1 从零自研 Ink TUI** | 3–4.5 个月 | host 适配（TUI 部分归零） | 完全自有 | 重新踩一遍终端/IME/滚动坑；上游新功能靠自己 |
| **C2 非 Ink 新前端** | 4.5–7.5 个月 | 同 C1 | 产品形态自由 | 渲染栈与兼容矩阵全新 |

## 五、建议

**先做 B。** 依据：`dsh-code` 是 MIT 许可且随包发布完整源码（61 文件 / 1.2M，`exports` 暴露 `./src/*`），可合法 vendor 并保留版权声明。用户抱怨的"每次升级引入问题"根因是**文本锚点**，B 直接消除它，成本约 1.5–3 周，远低于 C1 的 3–4.5 个月。

只有当目标包含"不再是 Ink / 不再只是终端 TUI"或"产品形态要与上游显著不同"时，C 才划算；**单为升级痛苦不值得从零写 26k 行**。

### B 的执行要点

1. `npm pack dsh-code@1.2.0` 解包到 `packages/tui/`（vendor，保留 MIT LICENSE 与版权声明）。
2. 补齐上游未附的构建配置（tsconfig/tsdown），或沿用其 `src/` + tsx 源码加载路径。
3. 把 31 个文本补丁一次性转换为对 vendor 源码的直接修改，随后删除 `scripts/patch-*.mjs` 与探针。
4. `plugins/` 与 `cordis.patch.yml`（host 平面）保持不变。
5. 之后每次上游升级：取新版 `src/` 做三路合并，冲突集中在被改过的文件上——是**显式的合并/编译错误**，不再是静默失配。

## 六、风险与跟踪指标

- 风险：vendor 后上游重构（如 1.2.0 整只替换 `Header`）仍会造成冲突；上游若变动启动契约（`tui-startup` / `tui-runner` 行）仍需跟；TUI bug 的修复责任从上游转到自己。
- 跟踪：`npm run probe:tui` 通过率（现状 27/27）；每次上游发布的补丁 churn 行数（0.7.11: 434、0.7.12: 324）；6 项真实 Ink 验证的状态。

> 数据来源：本仓库实测（`node_modules/dsh-code`、`scripts/`、`plugins/`、`git log`）与 `research/dsh-code-1.2.0-迁移笔记.md`。工期与行数为估算，非实测。
