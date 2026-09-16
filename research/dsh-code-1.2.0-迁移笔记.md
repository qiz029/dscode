# dsh-code 1.0.6 → 1.2.0 迁移笔记

- 日期：2026-09-16（DSCODE 0.7.10 开发中）
- 结论：**这是一次结构性迁移，不是版本号提升**。25 个 TUI 补丁里 **17 个锚点失效**（1.0.7 也会破 10 个）。

## 复现与量化

```sh
npm run probe:tui        # scripts/probe-tui-patches.mjs
```
输出每个补丁的失败锚点与 `resolved N/25`。1.2.0 下当前为 `8/25`。

## 上游在 1.2.0 里改了什么（已核实）

1. **Shift+Enter 换行已内建**：新代码是 `if (ctrl || shift) return "\n";`（`patch-interaction` 第 1 条原本做同样的事）→ 可转为"上游已采纳"分支。
2. **xterm modifyOtherKeys 的 Shift+Enter 仍不处理**：bundle 里 `\x1b[27;2;13~` 出现 0 次（只有 kitty `CSI u` 协议）→ `patch-interaction` 的 `normalizeKeyboardChunk` 注入仍然必要。
3. **本地命令目录改为 i18n**：条目从 `{label, description}` 变成 `{label, descriptionKey}`，渲染走 `t(command.descriptionKey)`。
   → `patch-tui.mjs` 注入的 `{"label":"/status","description":"…"}` 等条目会失效；我们新增的 `/status /doctor /mcp /skills /hooks /update` 需要提供 `cmd.*` 词条（注入上游消息表）或换成新的字段并用我们自己的 key。
4. **编辑器/输入层重构**：`Editor`、`pasteBracketRef`、`applyEdit`/`insertText` 的结构与位置都变了（`patch-interaction`、`patch-large-paste`、`patch-ime` 受影响）。
5. 其它已定位的变化点：`StatusLine`（footer）、`settledEntryLines`/`transcriptEntryLines`（turn divider、user background、style）、`Input`（effort）、`/review` handler（review）、`deepDivingVisible`（compaction）、`providerAction?.kind === "dscode-provider"`（openRouter）、footer 调用（language）。

## 失败的 17 个补丁

interaction、sessionBridge、ime、footer、style、welcome、effort、interrupt、turnDivider、userBackground、largePaste、clipboardImage、review、compaction、openRouter、pickerCommands、language

## 可选路径

| 路径 | 一次性成本 | 每版上游升级 | 备注 |
|---|---|---|---|
| 逐补丁重新对齐 | 估 3–6 天（17 个补丁，部分需要设计决策，见第 3 点） | 0.5–2 天 | 需要重跑 6 项 UI 验证 |
| fork 源码自己构建 | 估 3–8 天（dsh-code 是 MIT，随包发布 `src/` 49 文件约 20k 行；但未附 tsconfig/tsdown 配置） | 0.5–1 天（源码合并） | 锚点脆弱性归零 |
| 暂缓升级（保持 1.0.6） | 0 | — | 当前锁定组合，`npm run check` 全绿 |

## 注意

- 我们的补丁对**两版并不兼容**：一旦为 1.2.0 改写锚点，1.0.6 就会失效。迁移必须一次做完，或在补丁里同时保留两套锚点。
- `scripts/probe-tui-patches.mjs` 是这次留下的开发工具，任何上游升级前先跑它。

## 本次尝试的过程与结论（2026-09-16）

- 已把补丁闸门与依赖切到 1.2.0 并实跑，确认破坏面 17/25；随后**回滚到 1.0.6**，当前 `npm run check` 全绿、`npm run probe:tui` 为 **25/25**。
- 尝试中确认：`ime` 与 `clipboardImage` 两处只需**约 1 行的锚点调整**（已由并行子代理验证可行，回滚时一并丢弃）；`interaction` 的第一条（Shift+Enter 换行）上游已内建，可改为"已采纳"分支——本次已留下 `replaceOrAdopt()` 助手（新旧两版都安全）。
- 剩余 15 个补丁尚未对齐，其中 `review`、`openRouter`、`compaction`、`style`、`footer` 涉及面板级重构，预计需要逐个读新代码重写注入点（不是改字符串就能完事）。
- 因体量与上下文限制，本次**未完成迁移**；建议把它作为独立任务排期（或按上表选择 fork 源码路线）。

## 子代理核实结果（2026-09-16，含级联失败的重要更正）

**17 个失败 ≠ 17 处上游漂移。** 补丁按顺序串联，后面的补丁会锚定前面补丁**注入的文本**，因此根补丁失败会连带把后续补丁“拖挂”成失败：

| 补丁 | 性质 | 结论 |
|---|---|---|
| `ime` | 真实漂移 | 锚点 `const inputTerminalRows = useStdout().stdout?.rows ?? 30;` → `const inputTerminalRows = inputStdout?.rows ?? 30;`；注入的 `const dscodeImeStdout = useStdout().stdout;` → `const dscodeImeStdout = inputStdout;`（上游 1.2.0 改为 `const { stdout: inputStdout } = useStdout();`）。其余 7 个锚点不变 |
| `clipboardImage` | 真实漂移 | 锚点里的 `cyclePermission` → `cycleMode`（上游重命名了 Input 的 prop），替换串同步改；其余 3 个锚点不变 |
| `turnDivider` | **级联** | 它锚定 `dscodeChatLines(entry, columns, showReasoning)`，该文本由 `patch-interaction` 注入。根补丁修好后应自动通过 |
| `userBackground` | **级联** | 其兜底 `replaceOnce` 在 `patch-interaction` 的 `CHAT_LINES_SOURCE` 存在后即被跳过；`StyledRows` 锚点在 1.2.0 原始文本里仍匹配 |
| `largePaste` | **级联** | 失败的两个锚点（`else if (action === "clear-draft")`、`}, true);`）都由 `patch-interrupt` 注入 |

子代理用**完整链路仿真**（真实 `patchText` + 真实补丁实例，并按 `patch-interaction`/`patch-interrupt` 的产物模拟其效果）确认：这 5 个补丁在 1.2.0 上全部可打。

**推论**：真实需要重新对齐的“根补丁”显著少于 17。表里的其余失败项（sessionBridge、footer、style、welcome、effort、interrupt、review、compaction、openRouter、pickerCommands、language）需按同一方法甄别根因/级联后再动手。

## 安全的迁移流程（推荐）

1. `npm pack dsh-code@<目标版本>` 解到工作区内的临时目录（不要动 `node_modules/dsh-code`）
2. `node scripts/probe-tui-patches.mjs <临时目录>` 分析；逐条修根补丁并复跑探针
3. 全部通过后，才把 `package.json` 的 `dsh-code` 与 `scripts/patch-tui.mjs` 的闸门切到目标版本，`npm install`
4. 跑 `npm run setup` + `npm run check`（含 6 项真实 Ink 验证）收尾

失败时的已知清理：
`git checkout -- scripts/patch-ime.mjs scripts/patch-turn-divider.mjs scripts/patch-user-background.mjs scripts/patch-large-paste.mjs scripts/patch-clipboard-image.mjs`

## 迁移完成（2026-09-16，DSCODE 0.7.10，最终状态）

- `dsh-code` 依赖与 `scripts/patch-tui.mjs` 闸门均已切到 **1.2.0**；`npm install` 后 `node_modules/dsh-code` 为 1.2.0。
- 探针结果：`dsh-code 1.2.0: 25/25 patches apply`（`npm run probe:tui`），`node --check node_modules/dsh-code/lib/index.mjs` 通过。
- `node scripts/harness.mjs setup` 成功；`npm test`（= `node scripts/checks.mjs unit`）**258 pass / 0 fail**。
- 补丁对 1.0.6 与 1.2.0 双版本安全（`npm run probe:tui <1.0.6 目录>` 亦为 25/25）。

### 上游 1.2.0 的结构变化（本次新发现）

1. **本地命令目录 i18n 化**：条目为 `{ label, descriptionKey }`，`/help` 与补全都走 `t(command.descriptionKey)`。新增 `scripts/patch-command-catalog.mjs` 统一承载 DSCODE 自己的 12 个命令行（状态/doctor/mcp/skills/hooks/update/verbose/language/email/login/provider/openrouter）及其消息键 `cmd.dscode.*`，做法是给上游 `t()` 注入一个回退分支（`dscodeCommandMessages()`），而不是改写上游消息表 —— 上游 `MessageKey` 是每版增长的联合类型，直接往 `en`/`zh` 里塞键会在未来源码合并时类型不通过。
2. **`Header` 组件被整只替换**：1.2.0 的 header 是鲸鱼 glyph，签名为 `function Header({ resumed })`，不再是 DSCODE 的 `{ resumed, cwd, branch, title }`；`computeSettledRows` 的 `headerFacts` 形参与调用点都要重新注入。
3. **`StatusLine` 签名变化**：`({ facts, stats, busy, columns, items, onRows, animated })`。
4. **`Input` 签名变化**：首参为 `inputStdout`（`const { stdout: inputStdout } = useStdout();`），`openLanguage`/`saveLanguage` 已内建。
5. **上游已内建 `/language`**（en|zh）与 `/review`（带 `openReviewPicker`/`parseReviewArgument` 的完整块）：DSCODE 的 `/language` dispatch 必须插到上游处理块**之前**才生效；`/review` 则整块认领。
6. **`computeSettledRows` 仍是 1.0.6 形状**（`rowCap = SETTLED_ROW_CAP`），只是 Header 调用点变了。
7. `buildCandidates` 的 permission 徽章被上游拆成 `planStation ? "plan on" : permission`，且 `badge` 赋值被挪出块外 —— 原地最小替换会留下多余花括号。
8. `message.source.kind === "user" || message.source.kind === "plugin" && REMINDER_PLUGINS.has(...)`：1.2.0 让 reminder 插件走同一 replay 分支。
9. `deepDivingVisible` 上游改为 `busy && !streamingActive`。
10. 上游 1.2.0 已有 `LanguagePanel` / `languageOpen` 状态 / `openLanguage` prop，DSCODE 注入的同类符号须改名（`DscodeLanguagePanel`）或改为条件注入以避免重复声明。

### 改动的补丁

| 补丁 | 说明 |
|---|---|
| `patch-command-catalog.mjs`（新增） | 12 个 DSCODE 命令行 + `cmd.dscode.*` 消息键；按 `t()` 查找形状判定 generation |
| `patch-tui.mjs` | 目录注入改走 `catalogEntry`；键化/旧版两条分支；i18n 回退只在键化目录上安装 |
| `patch-interaction.mjs` | `/todos` 锚点换 `descriptionKey` 形状；`/verbose` 行条件注入（1.2.0 目录已自带） |
| `patch-language.mjs` | `/language` dispatch 锚到上游同款 `if` 之前；verbose 行/面板状态/prop 全部条件注入；注入面板改名 `DscodeLanguagePanel` |
| `patch-login.mjs` / `patch-email.mjs` / `patch-provider.mjs` / `patch-openrouter.mjs` | catalog 行改为 `catalogEntry(...)`，且只在目录未自带该行时插入（避免重复行）；provider 的 `openLogin` 块锚点改为 tab 缩进 |
| `patch-ime.mjs` | `inputTerminalRows`/`dscodeImeStdout` 改锚 `inputStdout` |
| `patch-clipboard-image.mjs` | `cyclePermission` → `cycleMode` |
| `patch-session-bridge.mjs` | 双 generation 条件扩展（1.2.0 的 reminder 子句 / 旧版裸 user 条件） |
| `patch-footer.mjs` | `StatusLine` 新签名 |
| `patch-style.mjs` | Header 重写为 `{ cwd, model, effort, animated }`；`headerFacts` 形参与调用点；permission 块含 `planStation` 与尾部 `badge` |
| `patch-welcome.mjs` | 按 `function Header(` 定位替换；facts 注入容忍 style 已注入/旧版两种 |
| `patch-effort.mjs` | `Input` 锚点含 `frozenHint` |
| `patch-interrupt.mjs` | 提示文案锚点去引号（1.2.0 文案在 i18n 值内，原替换串会多出双引号破坏 JSON） |
| `patch-compaction.mjs` | `deepDivingVisible` 锚点改为 style 已替换后的 `busy` |
| `patch-review.mjs` | 认领 1.2.0 完整 `/review` 块；保留原 `Unsupported` 报错 |
| `patch-review.mjs` / `patch-picker-*` / `patch-tui` 其余 | 相应锚点/条件调整 |

### 测试侧

- `tests/i18n.test.mjs`、`tests/code-review.test.mjs`、`tests/session-bridge.test.mjs`、`tests/email.test.mjs`、`tests/update-command.test.mjs`、`tests/openrouter-account.test.mjs` 的部分 needle 仍指向 1.0.6 文本（`/verbose` 行形状、`/review` 旧块、`view.pending` 缺失、`{"label":"/update","description":...}`），已按 1.2.0 的真实产物更新为 `catalogEntry(...)` / 新块形状 / 补 `pending` 字段。
- `.npmrc` 增加 `cache=.npm-cache`：测试运行时用 `npm pack` 准备上游 fixture，默认走 `~/.npm` 会撞到 sandbox/权限，本地缓存目录让 `npm test` 在受限环境下也能跑；`.npm-cache/` 已加入 `.gitignore`。

### 未解决 / 需要留意

- **不再有**未对齐的补丁；`.migrate/`、临时脚本已清理（`node_modules/.runtime` 为 setup 产物）。
- `/update` 在 1.2.0 里上游已有自己的面板，DSCODE 目录里仍有一条同名行（与 1.0.6 的行为一致）——重复行是历史行为，未在本次变更。
- `/language` 与上游 `/language`（en|zh）现在都可能出现在补全里；DSCODE 的六语言面板由我们的 dispatch 先命中。上游 `setLanguage` 与 DSCODE 的 `dscodeLocale` 目前是两个状态，切语言后 DSCODE 自有文案与上游文案可能不同步 —— 这是本次未深入的点，建议后续单独处理。
- `npm run check`（较慢的那套真实 Ink 验证）未跑，按约定留给最终验收。

## 迁移完成（2026-09-16）

`npm run check` **exit=0**：lint、258 单测、integration（含 login runtime / memory / exec / session-bridge / cards）、4 项真实 Ink UI（render / scrollback / effort bar / model search）、打包检查、44 评估测试全部通过。

### 补丁层

25/25 可打；新增 `scripts/patch-command-catalog.mjs` 统一命令目录（上游 1.2.0 改为 i18n `descriptionKey`，选择给上游 `t()` 注入回退分支而不是改上游消息表，避免未来合并时的类型冲突）。逐补丁改动见子代理报告（style/welcome/effort/interrupt/compaction/review/openRouter/language/session-bridge/footer/ime/clipboard-image/login/email/provider）。

### 验收阶段发现并修掉的问题（这次迁移的真实坑）

1. `verify-exec`：dsh-code 1.2.0 的 cordis 补丁启用了 `time-context`，它作为**新的一条 user 消息**注入时间块；假模型回显的就不再是用户输入。修法是让**测试内的假模型**跳过注入的上下文（产品行为不动，headless exec 保留时间感知）。
2. `verify-tui-style`：断言硬编码了 1.0.6 的主题色（`48;2;46;48;52`）。1.2.0 的 `composerBand` 变了（RGB 数组），而用户消息行的背景带其实**照常绘制**。改为断言"用户行带背景带"，主题无关；TPS 的 warn 色也从 palette 派生。
3. `verify-tui-viewport` / `verify-effort-bar`：1.2.0 的 `view` 新增 `pending: {'next-turn','next-step'}`、App 新增 `recordHistory` prop，两个 App 级探针的夹具需补齐（渲染时报 `Cannot read properties of undefined (reading 'next-turn')`）。
4. lint：子代理遗留的未使用导入。

### 遗留/需要知道

- 子代理额外改了 6 个测试文件的锚点文本 + `.npmrc`（`cache=.npm-cache`，沙箱规避）+ `.gitignore`（`.npm-cache/`）。
- 独立评审未取得结论（diff >160KiB；reviewer 输出 token 耗尽）。
- `/language` 的下游同步（上游 `setLanguage` vs DSCODE `dscodeLocale`）本次只保证可用不崩，建议单独排期。
