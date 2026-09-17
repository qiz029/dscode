# dsh-code vendor 接管迁移笔记

- 日期：2026-09-16
- 基线：dsh-code 1.2.0（MIT，unlinearity）→ 落位 `packages/tui`
- 结论：终端已从「给上游打包产物打文本补丁」切换为「直接编辑上游 TS 源码」，**零构建**（靠 Node 24 的类型剥离）。27 个 TUI 补丁必须以源码改动重写，不能机械搬运。

## 一、已落地（本仓库实测）

| 项 | 状态 |
|---|---|
| vendor 位置 | `packages/tui/`（`src` 61 文件 / 26,154 行 + `cordis.patch.yml` + `LICENSE`） |
| 包身份 | `name` 保持 `dsh-code`，`version` 1.2.0-dscode.0，`private` |
| 加载方式 | `exports` 指向 `src/*.ts`，Node v24.3.0 直接执行；`dsh-code` 入口加载约 250 ms，`dsh-code/startup` 约 38 ms |
| 依赖 | 根 `package.json`：`"dsh-code": "file:packages/tui"`；`node_modules/dsh-code` 为符号链接 |
| 装配 | `provision()` 不再调用 `patchTui`；host 层 `patchRuntime`（9 个 `@deepseek-ai` 包 + macOS stdin）保留 |
| 完整性守卫 | `scripts/checks.mjs` 的开发者运行时哈希改盯 `packages/tui/src/index.ts` |
| 测试 fixture | `scripts/test-runtime.mjs` 对 workspace link 的包按 `dsh-code@1.2.0` 从 npm 取上游 tarball |

profile 的 `node_modules` 本来就是指向仓库根 `node_modules` 的符号链接，因此保持包名不变即可让 `cordis.patch.yml` 里的 `dsh-code`、`dsh-code/startup`、`dsh-code/session-query` 引用零改动。

### 为让上游源码可被 Node 直接执行而做的两处改写

Node 24 的 strip-only 模式不支持 TS **参数属性**。全量扫描 61 个文件只有 2 处：

1. `packages/tui/src/index.ts:486` — `StartupInputGate` 构造函数 → 显式字段 + 赋值
2. `packages/tui/src/session-switch.ts:17` — `SessionSwitchQueue<T>` 构造函数 → 同上

其余不受支持的语法（`enum`、`namespace`、装饰器）源码中均不存在。

## 二、关键发现：补丁锚点无法复用到源码

在 `packages/tui/src` 上直接试跑 8 个补丁函数，**全部锚点失配**（patch-errors、patch-update-tui、patch-session-bridge、patch-ime、patch-interaction、patch-footer、patch-style、patch-tui）。

原因：锚点针对 rolldown 打包后的 JS（tab 缩进、类型已剥离），且后置补丁锚定前置补丁注入的文本。

→ 27 个 TUI 补丁必须作为**源码改动**重新实现。这是本次迁移的主体工作量。

## 三、待办

### 1. 迁移 27 个 TUI 补丁到 `packages/tui/src`（按用户可见性排序）

**A. 输入与终端（建议先做）**
`patch-interaction`（Shift+Enter 换行、xterm modifyOtherKeys 归一化）、`patch-ime`（IME 光标锚点）、`patch-large-paste`、`patch-image-marker`、`patch-clipboard-image`、`patch-interrupt`（两次 Ctrl+C）、`patch-shell-mode`（`!cmd` 框架模式）、`patch-frame`

**B. 会话渲染**
`patch-session-bridge`、`patch-turn-divider`、`patch-user-background`、`patch-style`、`patch-footer`、`patch-errors`、`patch-compaction`（TUI 部分）、`patch-welcome`

**C. 命令与面板**
`patch-command-catalog`（12 条 DSCODE 命令）、`patch-language`、`patch-effort`、`patch-model-search`、`patch-provider`、`patch-openrouter`、`patch-login`、`patch-review`、`patch-update-tui`、`patch-email`（含原 `cpSync` 到 `lib/dscode-email` / `lib/dscode-providers` 的注入）

### 2. 发布打包（待决策）

`scripts/release.mjs` 现在对 workspace link 的 bundle 直接拒绝，并给出明确错误：Hub 发布需要先决定 vendor 的打包形态（发布到私有 npm / 打进 `.dshprofile` / 其它）。对应测试已 skip。

### 3. 测试基础设施

- 补丁函数与其单测（`tests/patches`、`ime`、`interaction` 等）验证的是已退役的机制，应随迁移逐步改写为对 `packages/tui/src` 的断言
- `scripts/test-runtime.mjs` 的补丁 fixture 与 6 项 `verify-tui-*` 脚本同理

### 4. 已知既有失败（与本次改动无关）

`tests/session-metrics.test.mjs`「the model header leads the footer and sheds the provider before the money」在 UTC 18:18（off-peak ❄️）失败、在 UTC 08:29（peak 🔥）通过：`formatFooter` 的宽度预算在 92 列正好卡边界，emoji 变体宽度差 1 列即翻盘。该测试文件不引用 `dsh-code`。建议给它注入时钟或放宽列宽断言。

## 四、验收状态

| 检查 | 结果 |
|---|---|
| `npm run setup` | 通过 |
| `npm run config`（全量 cordis dump） | 通过 |
| 源码入口加载（`dsh-code` / `startup` / `app.ts`） | 通过 |
| `npm test`（unit） | 258 tests：254 pass / **1 fail（第三节第 4 项，既有）** / 3 skipped（补丁与发布断言） |
| 交互式 TUI 实机启动 | 未验证（需真实 TTY，见下） |

## 五、尚未验证

- 真实 TTY 下的 TUI 启动与日常交互（本环境无法提供终端输入）
- 迁移 A 组后，输入/IME/滚动等 6 项 `verify-tui-*` 仍需重建

## 六、迁移进度（持续更新）

迁移方式：把补丁的 "from → to" 直接在 `packages/tui/src` 实现。DSCODE 自有逻辑集中放在 `src/dscode/`，上游文件只做最小接线，便于后续合上游。

### 已完成（源码改动，12 个）

| 补丁 | 落点 | 说明 |
|---|---|---|
| `patch-errors` | `render/projection.ts` ×2 | 非用户取消、非 max-tokens 的终态改用 error 行 |
| `patch-image-marker` | `app.ts` | 图片附件 chip 显示 `[Image N]` |
| `/clear`（原 `patch-tui`） | `app.ts` + `locales` | 先停回合再新建会话；`notice.clearBusy` |
| `patch-interrupt` | `app.ts` + `index.ts` + `locales` | `ctrlCAction` 状态机、模态下 Ctrl+C 可用、第二次按下快速退出 |
| `patch-clipboard-image` | `src/dscode/clipboard-image/` + `app.ts` | helper 移入 TUI 包；Ctrl+V 读剪贴板图片。**修正**原补丁把 `cycleMode` 改名却不改使用点的缺陷 |
| `patch-user-background` | `render/lines.ts` + `src/dscode/chat.ts` + `app.ts` | `StyledLine.background`；wrap 后的 prompt 补成连续背景带 |
| `patch-interaction` | `keyboard.ts` + `app.ts` + `index.ts` + `locales` | modifyOtherKeys 的 Shift+Enter、`dscodeChatLines` verbose 渲染、`/verbose`、运行中工具行、`submitMode` 默认 steer、退出打印 resume 提示 |
| `patch-session-bridge` | `render/projection.ts` | relay 消息进 replay 分支并渲染为可见用户回合（`dscodeVisibleRelay`） |
| `patch-footer` | `render/status.ts` + `app.ts` | `StatusFacts.telemetry`/`fullSessionId`；metrics 段每秒刷新并钉在第二行右侧、计入宽度预算；行宽钉住 `columns` |
| `patch-turn-divider` | `render/projection.ts` + `src/dscode/chat.ts` | **按意图实现**：原补丁读的 `entry.turnEnded` 从未被设置过；现在投影在回合结束时标记末条回复，渲染层据此收尾一条分隔线 |
| `patch-review` | `app.ts` | 整块接管上游原生 picker，改走 DSCODE 共享 review 服务（`dispatch`） |
| `patch-update-tui` | `app.ts` + `locales` | 启动时一次 registry 读取（8 秒上限、失败静默），发现新版本用 notice 提示 `/update` |
| `patch-style` | `render/status.ts` + `app.ts` + `kernel-panels.ts` + `src/dscode/telemetry.ts` | 整只替换 `Header`（DSCODE 身份行）、新增 `DscodeActivityLine`（轨道 spinner + 回合计时）、`AgentsLine`；footer 改为「标题+权限领行 1、`provider: model @ effort` 进 telemetry 表头、telemetry 钉行 2 右侧」；分隔符统一 `｜`；telemetry 的 tps/cache 分级着色；默认状态栏项收敛为 6 项 |
| `patch-welcome` | `src/dscode/welcome.ts` + `app.ts` | 第二次整只替换 `Header`（最终形态）：涟漪像素雪花 + 会话事实面板；`welcomePath` 折叠长路径、`welcomeArtRows` 半块打包、`dscodePadEnd` CJK 安全补齐 |
| `patch-compaction`（app 侧） | `app.ts` | Tetris 指示器 `DscodeCompactionLine`、`dscodeCompacting`/`dscodeCompactionRows` 预算（5 行或 1 行）、live 区与审计让位；模型切换确认面板待 `patch-provider` 之后迁移 |
| `patch-frame` | `app.ts` + `scripts/patch-ink.mjs` | todo 槽位在回合中让给活动行、streamRows/审计预算扣掉压缩行；第 4 点（Ink 帧底部锚定）改的是 `ink/build/log-update.js`，已抽成独立依赖补丁并由 `provision` 调用 |
| `patch-login` + `patch-provider` | `app.ts` + `index.ts` + `provider-settings.ts` + `locales` | 一步迁到终态：`/login [provider]` 与 `/provider` 在附件/历史/入队之前拦截（参数可能是粘贴的密钥，绝不回显）；`DscodeLoginPanel`（多 provider 版）与 `DscodeProviderPanel`；`dscodeSwitchProvider` 声明路由 → 缺密钥则先登录再续 → 落到对端模型；`providerAction` 新增 `dscode-key`/`dscode-provider`；`dscodeEnsureProviderRoute` 由 index.ts 注入 |
| `patch-compaction`（确认面板） | `app.ts` + `index.ts` | `dscodeRequestModel` 包装 `/model` 选择：切换目标与当前一致或测量不可用时直接落；会压缩时先弹 `DscodeCompactionConfirmPanel`（y/n）；宿主侧 `dscodeCompactionPreviewFor` 用 `tokenMeter`+`llm.resolveModelInfo`+`pricedThresholdRatio` 度量 |
| `patch-email` | `app.ts` + `locales` | `DscodeEmailPanel` + `DscodeImapSetup` 两个面板（从 `scripts/*-panel.mjs` 半自动搬运）；Gmail/IMAP connector 每 30 秒同步、会话切换即关闭；`/email` 在附件/历史之前拦截；面板随 Esc 关闭并让出转录区；选中邮件用 `props.steer` 注入本轮（v4 形态，不再走草稿回填） |
| `patch-effort` | `app.ts` | DSCODE 的四档力度条 `DscodeEffortBar`（low/high/max/ultra）+ `DscodeUltraRipple`/`DscodeUltraFocus` 涟漪动画；上游面板改名 `NativeEffortPanel`，`DscodeEffortPanel` 只在目录匹配四档时接管；选中 ultra 时在 composer 播放 1.1 秒脉冲（`effortSurface`/`ultraPulse` 两个 Input props） |
| `patch-model-search` | `app.ts` + `index.ts` | 上游 `ModelPanel` 整段被 DSCODE 版替换（8086→8884 字符）：`dscodeFilterModels` 的 BM25 检索（名称权重 3 / id 2 / provider 1，边打边匹配前缀，全词命中优先，结果按标签自然序）；Esc 先清搜索再关闭、Tab 切 provider、Ctrl+R 重试；`/model` 打开前先迁移早前版本写入的 inert pi-ai OpenRouter 配置 |
| `patch-openrouter` + `patch-picker-commands` | `app.ts` + `index.ts` + `locales` | `/openrouter` 账户面板（余额/本密钥用量/全部密钥/30 天消费）+ 可选管理密钥面板；宿主辅助（credentials 解析、管理密钥校验与保存、账户加载）从 app.ts 导出给 index.ts 注入；保存 OpenRouter API key 后先offer 管理钥匙再续切换；picker 命令（`/provider` `/login` `/openrouter`）在菜单上按 Enter 直接执行而不是补全文本 |
| `patch-large-paste` | `src/dscode/paste.ts` + `app.ts` | 超过 200 字符的粘贴折叠成 `[Pasted Content N chars]` 标记、提交时展开复原；标记对编辑与光标移动是原子的（整体删除/替换、光标吸附到边缘）；`!`/`/` 开头的行保留原文以便命令路由；共 17 处挂钩（插入、删除、行首尾、垂直移动、清空草稿、附件准备、粘贴事件、历史回填） |
| `patch-interaction`（尾项）+ `patch-command-catalog` | `app.ts` + `src/dscode/flags.ts` + `locales` | 裸 `!command` 走 `/shell-exec` 的同一交接（有附件时仍是普通提示）；verbose 开关持久化到 `~/.dsh/dsh-code/verbose.json`（读写失败安全降级）；命令目录补齐 status/doctor/mcp/skills/hooks 五条与对应词条 |

### 判定为「上游已采纳」（无需迁移）

| 补丁 | 依据 |
|---|---|
| `patch-ime` | 源码已有 `useImeCursorAnchor`；补丁在 1.2.0 上即 no-op |
| `patch-interaction` 的 Shift+Enter 换行 | 源码已内建 `if (ctrl \|\| shift) return "\n"` |
| `patch-interaction` 的 Input 换行 | 源码 `if (input === '\n' \|\| input === '\r')` 已把换行当编辑插入 |
| `patch-interaction` 的 live-reasoning 行预算 | 上游 `streamingActive`/`reasoningRows` 已覆盖且更细，补丁两条替换是静默 no-op |
| `patch-image-marker` 的 PASTE 标记清理 | `stripPasteMarkers` 已处理 `\x1b` 前缀 |
| `patch-language` 的 `/language` 面板与持久化 | 上游自带 `openLanguage`、`LanguagePanel`、`languageOpen`、`language.json` |

### 发布：.dshprofile 打包（已完成）

`buildRelease()` 现在把 workspace link 的 bundle 用 `npm pack` 打成 `bundles/<name>-<version>.tgz`（347 KB / 71 文件）内嵌进归档，release.json 里仍以 npm 形态描述（`installSpec: dsh-code@1.2.0-dscode.0` + 该 tarball 的 integrity + `sourceKind: npm`）。实测产物：

| 项 | 值 |
|---|---|
| 归档 | `artifacts/todd-coding-tui-0.7.12.dshprofile`（360 KB，上限 5 MB） |
| 条目 | `release.json`、`README.txt`、`bundles/dsh-code-1.2.0-dscode.0.tgz` |
| bundles | dsh-base（npm）、**dsh-code@1.2.0-dscode.0（内嵌 tarball）**、computer-use（npm） |

**需要知道的限制**：Hub 的 `readProfileArchive` 只读 `release.json`（校验 contentHash），归档里的额外条目它不会使用；它的安装路径按 `installSpec` 走 npm/github。所以：

- 自有安装路径（`npm run setup` / `dscode` launcher）本来就用仓库内的 vendor 源码，不依赖这个 tarball；
- 要把 profile **分发给别人**，仍需要把 `@toddzheng024/dsh-code` 发布到 npm（或 GitHub），否则对方的 importer 会解析不到；归档里的 tarball 是给自有导入工具/离线场景备的物料。

### 清理（已完成）

删除的退役资产：

| 类别 | 数量 | 说明 |
|---|---|---|
| 补丁脚本 | 27 | `patch-tui` + 26 个 TUI 补丁 + `probe-tui-patches` |
| UI 验证脚本 | 6 | `verify-tui-scroll/style/viewport`、`verify-effort-bar`、`verify-login`、`verify-model-search`（996 行，全部依赖 `patchTui` + fixture 里的 `lib/index.mjs`） |
| 脚本项 | 2 | `probe:tui`、`test:ui`（`check` 链同步移除该套件） |

保留（仍在用）：`patch-runtime`、`patch-mac-stdin`、`patch-stdin-stall`、`patch-compaction`（只剩 host 侧 `patchCompactionBasic`）、`patch-ink`、`patch-util`——`scripts/patch-*.mjs` 由 32 个降到 6 个。

装配与 fixture 改造：

- `build-packages.mjs` 不再调用 `patchTui`；
- `test-runtime.mjs` 的 fixture 改为直接装入 vendored 源码（`applyTerminalSource`），与真实安装形态一致；
- `dscodeFilterModels` 移入 `src/dscode/model-search.ts` 并导出，测试直接对该模块断言。

测试改造：删除 `tests/ime.test.mjs`；`patches.test.mjs` 重写为对 vendored 源码的断言；`model-search`、`i18n`、`session-bridge`、`openrouter-account`、`update-command`、`compaction`、`email`、`tui-tools`、`code-review` 逐个裁剪——服务级与模块级断言保留，专测补丁注入的移除，能改对源码断言的改过去。

结果：

| 检查 | 结果 |
|---|---|
| `npm test`（unit） | **240 tests / 240 pass / 0 fail / 0 skipped** |
| `npx eslint .` | 无输出（干净） |
| `npm run setup` | 通过 |

**验证缺口（需要说明）**：删掉的 6 个 UI 验证脚本覆盖的是"补丁后 bundle 的真实 Ink 渲染"（滚动、视口、样式、effort 条、登录面板、模型搜索菜单）。它们验证的机制已不存在，因此删除；要重建同等粒度的 UI 验证，需要把状态行/面板等组件从 `app.ts` 导出后用 ink 渲染到内存流，或依赖实机 TTY。

### UI 验证重建（渲染级）

被删掉的 6 个 verify 脚本覆盖的是"补丁后 bundle 的 Ink 渲染"。现在改为**直接渲染 vendored 组件的源码**，不再需要"复制 bundle + 追加 export"那套探针：

- `app.ts` 导出 14 个可渲染组件：`DscodeEffortPanel`/`DscodeEffortBar`、`DscodeLoginPanel`、`DscodeProviderPanel`、`DscodeOpenRouterPanel`、`DscodeManagementKeyPanel`、`ModelPanel`、`StatusLine`、`DscodeActivityLine`、`DscodeCompactionLine`、`DscodeCompactionConfirmPanel`、`Header`、`DscodeEmailPanel`、`DscodeImapSetup`；
- 新增 `tests/tui-render.test.mjs`：用 ink 渲染到内存流（PassThrough），断言真实帧内容并检查**每一帧**都不超过终端宽度。覆盖：

| 用例 | 断言要点 |
|---|---|
| 力度条 | 四档 `low high max ultra` 同排；方向键移动后 Enter 提交 `ultra`；dark/light × 48/80/120 列不溢出 |
| 状态行 | 行 1 `标题 ｜ 权限`；行 2 右侧 telemetry 带 `provider: model @ effort` 表头与 cache hit |
| 活动行 | `Running · bash`、`this turn`、`Esc to interrupt` |
| 压缩指示器 | 板面与 `Compacting context, please wait` |
| 模型选择器 | 只列当前 provider、按标签自然序；输入 `glm` 后只剩 GLM 两行 |

过程中的两个技术点（供后续写渲染测试参考）：ink 在 debug 模式**逐帧写增量**，取"最后一帧"常常只有光标控制符——要回溯到最近一帧含文本的输出；`StatusLine` 需要**完整的 `TranscriptStats`**（用 `createTranscriptView().stats` 起步，手写对象会缺 `usage.uncachedInputTokens` 之类的字段而让组件抛错）。

结果：`npm test` **245 tests / 245 pass / 0 fail / 0 skipped**；`npx eslint .` 无输出。

仍未覆盖：**实机 TTY** 下的整体交互（本环境禁止 openpty）。

### 发布形态需要预编译（本轮发现并修复）

跑 `npm run test:package` 时暴露了一个真实缺陷：**Node 的类型剥离在 `node_modules` 下被拒绝**（`Stripping types is currently unsupported for files under node_modules`）。仓库检出直接跑 `packages/tui/src` 没问题，但任何**安装后的**形态（`.dshprofile` 里的 bundle、npm bundle）都加载不了 TS 源码——也就是说，迁移完成后两条发布路径其实都是坏的。

修复：

- 新增 `scripts/build-tui.mjs`：用 TypeScript 逐文件转译 `src/**/*.ts` → `lib/**/*.mjs`（保留相对导入，把显式 `.ts` 说明符改写为 `.mjs`；不打包、不压缩），非 TS 资源原样复制。配套 `stageTuiForPack()` 产出"发布用的包"：主入口指向 `lib`，同时带上 `src` 供查阅。
- `release.mjs` 的 `packLocalBundle` 改为从 stage 打包，因此 `.dshprofile` 内嵌的 tarball 含 `package/lib/index.mjs` + `package/src/**`（141 个文件）。
- `build-packages.mjs` 不再从 `node_modules/dsh-code/lib`（补丁产物）复制，改为编译后复制到 `vendor/tui/lib/`——**保持源码树的深度**，这样编译产物里的 `../../../plugins/...` 仍然解析到 bundle 根，无需任何 path 重写。
- `verify-packages.mjs` 的断言从"补丁标记"改为编译源码的可观察事实（`dispatch(text)`、`DscodeProviderPanel`、`DscodeOpenRouterPanel`、compaction 导入路径），并容忍单/双引号。
- 另外删掉两个孤儿脚本（`scripts/email-panel.mjs`、`scripts/imap-panel.mjs`，其组件已迁入 `app.ts`），`typescript@5` 进 devDependencies，`packages/tui/lib/` 进 .gitignore 与 eslint ignores。

结果：`npm test` **245/245**、`npx eslint .` 干净、`npm run test:package` 通过（build-packages + verify-packages）、`buildRelease()` 产出带编译产物的 `.dshprofile`。

**取舍说明**：仓库日常运行仍然是"零构建"（直接跑 `src`，改完即生效）；只有发布帧需要 `npm run build:tui`（由打包步骤自动调用）。

### 遗漏与修复：shell mode（用户报告）

用户反馈"新的 binary 好像 shell mode 的效果没了"。核对后确认：**\`patch-shell-mode.mjs\` 在迁移期被遗漏**——27 个补丁里我逐条读了 26 个，唯独它的 \`\\\`!cmd\\\`\` 框架效果没有落地，随后在批量删除退役脚本时被一并删掉，于是"framed composer"消失（命令本身仍能执行，因为 \`!cmd\` 的 dispatch 是我在 \`patch-interaction\` 里迁的）。

已按原补丁恢复 9 处：

| 落点 | 效果 |
|---|---|
| \`dscodeShellDraft\` | 草稿以 \`!\` 开头即进入 shell mode |
| 行数上报 | hint 行计入 composer 行数预算 |
| \`promptGlyph\` | shell draft 时让步，让 \`!\` 领行 |
| \`bandFill\` / \`band\` | **框架化**：品牌色圆角边框、不做填充，宽度与行数与填充带一致 |
| Esc 阶梯 | 在 completion 菜单之后、notice/interrupt 之前：去掉 \`!\` 退出模式（光标左移一位跟随） |
| hint 行 | 品牌色 \`composer.shellMode\`（\`! shell mode · esc exits\`，词条来自 \`plugins/i18n\`，六语言齐备） |
| 两处 glyph 渲染 | frozen 与编辑态都要让 bang 领行 |

**核对方法（本轮补做，杜绝再犯）**：用 \`git show HEAD:scripts/patch-tui.mjs\` 取回原始补丁链，逐个对照迁移清单——27 个 import 里除 \`patch-util\`（工具）与 \`patch-compaction\`（host 侧保留）外，只有 \`patch-shell-mode\` 缺失；并核对了 \`patch-tui.mjs\` 的内联改动（\`patchText\`、命令目录注入、\`plugins/email\` 与 \`plugins/providers\` 的复制）——catalog 现为 9 条（\`status/doctor/mcp/skills/hooks/email/login/provider/openrouter\`，另有 \`update\`/\`verbose\`/\`language\` 用上游键），两个 plugins 目录改为源码直接 import，无需复制。

**防回归**：\`tests/patches.test.mjs\` 新增断言覆盖 shell mode 的四个特征（draft 判定、hint 词条、品牌色圆角边框、Esc 去 bang）。回归 **246 tests / 246 pass**。

**生效方式**：\`npm start\`（源码模式）立即生效；已构建的产物需要重新打包——\`npm run build:packages\`（npm bundle）或 \`npm run release\`（.dshprofile）。

### 后续改动：shell mode 隐藏感叹号（源码改动）

用户反馈：shell mode 下已输入的感叹号不必出现在输入框里——模式已由品牌色圆角边框与 hint 行表达。改动全部落在 `packages/tui/src/app.ts`：

| 落点 | 效果 |
|---|---|
| `editorValue = dscodeShellDraft ? value.slice(1) : value` | 编辑器视图去掉路由前缀 |
| `clampCursor(editorValue, dscodeShellDraft ? Math.max(0, cursor - 1) : cursor)` | 光标同步左移一列，显示与编辑坐标一致 |
| `verboseLine(editorValue, …)`（frozen 分支） | 面板冻结 composer 时同样不显示感叹号 |
| `promptGlyph` 保持空白占位 | 边框已表达模式，缩进与普通草稿等宽 |

范围说明：`value`/`cursor` 仍是真实草稿——提交路由、粘贴标记、命令补全、行数预算、Esc 退出阶梯都不变，只是编辑器不再绘制首个感叹号字符。草稿恰为单个感叹号时编辑器显示空行（占位符判定仍看真实草稿是否为空，避免在框内提示 type a message）。

验证：`tests/patches.test.mjs` 的 shell mode 用例新增 3 条断言（隐藏感叹号、光标同步、frozen 行）；`npm test` **246 tests / 245 pass / 1 fail**，唯一失败是既有 off-peak 用例 `tests/session-metrics.test.mjs`（❄️ 宽度预算边界，与本改动无关）；`npx eslint .` 无输出。


### 待迁移

- 删除退役的 patch 脚本/探针，并改造依赖补丁管线的测试
- 实机 TUI 验证（本环境无 pty）

### 已修掉的缺陷

- **`openLogin`/`openProvider` 只加了类型没加解构**：`patch-provider` 迁移时写进了 `InputProps` 与 App 传递处，却漏了 `function Input({ … })` 的解构列表，运行时会取到 `undefined`；本轮随 `patch-email` 一并补齐（`openEmail, openLogin, openProvider`）。
- `dscodeT` 的界面语言：DSCODE 的消息表把简体中文键作 `zh-CN`，而终端 `getLanguage()` 返回 `zh`，直接查表永远回退英文。现在先经 `normalizeLanguage()` 归一，中文界面下 DSCODE 自有文案（活动行、压缩提示、agents 行等）才真正生效。

### 需要留意的边界

`packages/tui/src` 里已出现对仓库其它目录的相对引用（`../../../plugins/session-metrics/view.mjs`、`../../../plugins/tui-tools/update.mjs`、`../../../plugins/compaction/…`）。发布按 `.dshprofile` 打包整个仓库时成立，但若将来把 TUI 作为独立 npm 包发布，需要把这些模块一并纳入包内。

### 补丁链的真实依赖（第 4 轮查明）

用「未打补丁的上游 lib」跑一遍完整 `patchTui`，再与源码对照，确认了几个关键依赖：

- `patch-style` 把 `const deepDivingVisible = busy && !streamingActive` 改写成 `busy`（**移除 streamingActive 的抑制**），并**整只替换 `Header`**、定义 `DscodeActivityLine`（含 spinner/orbit、tps 着色）取代 `patch-interaction` 先注入的裸工具行。
- `patch-compaction` 的锚点 `const deepDivingVisible = busy;` 依赖上一步的产物，最终形态是 `busy || dscodeCompacting`；它的 Tetris 行又插在 `DscodeActivityLine` 之前。
- `patch-frame` 依赖 `patch-compaction` 的 `dscodeCompactionRows`，其第 4 点还改 `node_modules/ink/build/log-update.js`（依赖内部补丁，vendor 源码消不掉）。
- `patch-welcome` 也参与 `liveBudget` 的改写。

**结论**：`style → welcome → compaction → frame` 必须按序整体迁移，不能单独搬其中一个。第 4 轮先完成了 `compaction` 的投影状态位（13 处），app.ts 侧要等 `patch-style` 的 `DscodeActivityLine` 落地后再接。

另外核对过：发布包里的 `lib/index.mjs` 与随包 `src/` 内容一致；缓存里两个 `dsh-code@1.2.0` 的 tarball（integrity 不同）解包后 `src` 完全相同。
