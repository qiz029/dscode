# DSCODE Compaction 策略：现状盘点与优化空间

- 盘点日期：2026-09-17
- 版本：0.7.16（`scripts/patch-compaction.mjs` 最后改动 09-17 22:46）
- 范围：本仓库 patch 层 + 上游 `@deepseek-ai/dsh-compaction-basic@0.1.5-rc.2` + `dsh-compaction-tool-result-pruner`
- 证据：本机 63 个真实会话（`.runtime/sessions`、`.runtime/session-metrics`）+ `eval/results` 已有评测

## 一句话结论

当前是一条「按缓存折扣定价阈值 → 提前预取摘要 → 溢出先剪枝再摘要」的链路，方向正确；但本机 5 次真实压缩**全部**发生在 v0.7.16 补丁之前，且全是同步摘要（14.8–31.6 秒/次，摘要调用缓存命中率 <2.5%，$0.11–0.23/次）。最大的优化空间在**溢出路径的摘要前缀缓存**与**评测/生产配置不一致**，而不是继续调阈值参数。

## 一、当前策略全景

### 1.1 上游引擎（`dsh-compaction-basic`）

checkpoint 替换式摘要压缩：每次把「最老的可压缩跨度」替换成一条 `<compacted-summary>` 用户消息，该跨度之后的尾部原文保留。摘要指令以最后一条 user message 追加在重放前缀之后，上游注释明确说明这样是为了复用主请求的 KV cache 前缀。

上游默认值：

| 参数 | 默认 | 含义 |
|---|---|---|
| `thresholdRatio` | 0.8 | 请求压力占窗口比，跨过即自动压缩 |
| `retainRatio` | 0.16 | 压缩后原文保留尾部占比 |
| `compactionRetries` | 1 | 压缩后仍超阈值的重试次数 |
| `maxOverflowRetries` | 1 | 溢出恢复重试 |
| `maxTokens` | 8192 | 摘要调用输出预算 |
| `summarizationProvider/Model` | 空 | 空则跟随主路由模型 |

### 1.2 本仓库的 4 个构建期补丁

补丁逻辑在 `plugins/compaction/threshold.mjs`，由 `scripts/patch-compaction.mjs` 注入上游 `lib/index.js`：

| 补丁 | 作用 | DeepSeek 官方路由的实际取值 |
|---|---|---|
| 按缓存折扣定价阈值 | cache-read/input < 0.1 → 0.9；< 0.5 → 0.8；否则 0.6；未定价保持 0.8 | 0.003/0.15 = 0.02 → **0.9** |
| 扣除补全预算 | `effectiveContextWindow = window − defaultMaxTokens` | 1,048,576 − 256,000 = **792,576** |
| 预取压缩 | 阈值下方 10% 窗口处后台摘要最老跨度，跨阈值时提交该摘要 | 阈值 **713,318**，预取起点 **634,061** |
| 溢出先剪枝再看 | 溢出恢复先跑剪枝；剪枝真的替换了 surface 且剪后能装下就跳过摘要 | 仅当 `replaceGeneration` 前进时生效 |

（以上数字已用 `thresholdForCacheRatio` / `effectiveContextWindow` / `prefetchThresholdTokens` 在本机复算确认。）

### 1.3 剪枝与手动路径

- 工具结果剪枝：`>8192` 字符 → 保留 head 4096 + tail 1024 + 标记（`presets/dscode/agent.cordis.yml`，pruner 与 compaction 同 realm）。
- 手动路径：`/compact`（idle 会话压缩，`compactNow`）、`/model` 切换前显示压缩预览。
- 压缩期间 TUI 显示 Tetris 指示器与已用时间（`plugins/compaction/tetris.mjs`）。

## 二、实测证据

### 2.1 本机真实会话（63 个）

- `compaction/start` 5 次、`compaction/summary` 5 次、`compaction/prune` 48 次。
- `start → summary` 延迟：最小 14.8s / 中位 27.7s / 最大 31.6s，**合计 132 秒**同步等待。
- 5 次全部早于 09-17 22:46 的补丁落地时间 ⇒ **v0.7.16 的 preambl/预取/短路修复至今没有任何新的自动压缩样本**。

### 2.2 摘要调用成本（`purpose=compaction`）

| inputTokens | cacheRead | output | cost |
|---|---:|---:|---:|---:|
| 742,307 | 17,408 | 3,920 | $0.2275 |
| 728,970 | 2,944 | 2,966 | $0.2223 |
| 692,712 | 2,176 | 3,931 | $0.2125 |
| 690,192 | 17,408 | 3,628 | $0.1058 |
| 45,035 | 2,304 | 3,738 | $0.0090 |

要点：

1. 4 次大压缩的**缓存命中率 0.3%–2.5%**，几乎全部按全价输入计费 —— 与上游「摘要调用复用前缀缓存」的设计意图直接矛盾。
2. 输出稳定在 ~3.7k tokens，与输入跨度（45k → 742k）无关，说明 9 段固定结构的输出开销基本恒定。
3. 45k 输入那次说明存在小规模压缩场景（可能来自 `/compact`）。

### 2.3 已有 1M 窗口评测（`eval/results/continuation-million-20-20260912`）

20 个编码任务 × 5 策略，窗口 1,000,000：

| 策略 | 任务通过 | 摘要次数 | 模型调用 |
|---|---:|---:|---:|
| full（不压缩） | 18/20 | 0 | 73 |
| shipped-80 | 19/20 | 9 | 88 |
| controlled-80 | 18/20 | 9 | 84 |
| controlled-40 | 18/20 | 22 | 99 |
| controlled-25 | 18/20 | 49 | 124 |

- 与 full 的配对比较：各策略 Lost 0 / Gained 0。
- 更早压缩（40%、25%）带来 2.4×–5.4× 的摘要次数与更多模型调用，**没有质量收益**；唯一差异集中在 `sort-priority` 一例，而 controlled-80 同样失败，更像抖动而非阈值效应。
- 结论只能说明「80% 档没有可测的质量损失」，不能证明它最优。

### 2.4 证据缺口

1. **评测与生产配置不一致**：评测里的 `shipped-80` 是写死的 0.8，而生产实际是缓存折扣定价的 **0.9**（DeepSeek 官方 0.02 → 0.9）。**0.9 从未进过评测**。
2. `eval/compaction` 离线对照固定在 16384 窗口，报告自述「cannot establish the best threshold at the real 1M window」。
3. DeepSWE 1M 单任务从未触达触发点；128K 那次压缩后 prompt 从 121,456 降到 28,940，任务仍未通过验收（单任务样本，不能定阈值）。

## 三、优化空间（按性价比排序）

### P1 溢出路径的摘要前缀缓存（可量化，收益最大）

- 现象：4 次溢出压缩的摘要 input 690k–742k，cacheRead 仅 2.2k–17.4k。
- 机制推断：上游本意是让摘要调用成为主请求的真实前缀；但溢出分支的顺序是 `pruneSession` → 重新测量 → `dscodeOverflowFits` → `selectCompactableRange` → 摘要。剪枝会改写跨度内 tool result 的内容，摘要读到的消息与上一次成功请求的前缀在第一个被剪节点处断裂，缓存随之失效。
- 影响：每次压缩多付约一个全价输入（$0.10–0.20），prefill 也被拉长。
- 方向：溢出分支在剪枝**之前**捕获摘要输入（或摘要使用未剪投影），剪枝只用于 meter 判定与短路。
- 验证：构造一次 overflow，对照「剪枝前/后」摘要输入的 cacheRead。

### P2 溢出路径 `retainTokens = 0`（信息风险）

- 代码事实：溢出恢复调用 `selectCompactableRange(session, measurement, 0)`，保留尾部预算为 0 ⇒ 只留最后 1 个 surface 节点，几乎丢弃全部原文。
- 方向：给溢出路径一个有意义的原文下限（例如 `window × 0.05` 或固定 8k tokens）。现有的 `fitsInWindow` 短路可以保证剪后仍在窗口内，但需评测确认不会引发二次溢出。

### P3 预取的覆盖与失效策略

- 现状：每个会话只允许 1 个 prefetch（WeakMap）；lead 固定 10% 窗口；被手动压缩或 surface 重写打断即静默丢弃且不重试；没有命中/丢弃计数。
- 方向：
  - lead 可配置，并考虑调大到 15–20%。预取的是**最老跨度**，之后新增的内容会以原文保留在 checkpoint 之后，提前预取不丢信息，风险低。
  - prefetch 失效后做一次重规划，而不是直接退回同步摘要。
  - 把命中率、丢弃原因写进指标。

### P4 评测与生产配置对齐

- 把 **0.9（生产实际值）** 加入 continuation 的 1M 策略集，与 `shipped-80` 跑同一批任务。
- 补 **0.6 档**（无缓存折扣路由的真实档位），否则它从未被测过。

### P5 摘要输出预算固定 8192

- 实测输出 3.6–3.9k 且与跨度无关（45k 输入同样 3.7k）。9 段固定结构对短跨度是纯开销。
- 方向：按跨度伸缩 `maxTokens`（短跨度 2–3k），或对短跨度用轻量模板。先量化截断风险再做。

### P6 可观测性

- 现状：会话日志有 `compaction/start|summary|end` 与 `prune`，但没有前后 `totalTokens`、提交来源（prefetch / sync / manual）、prefetch 是否被丢弃、摘要耗时与成本的直接字段（成本要跨到 `session-metrics` 拼接）。
- 方向：在 `compaction/end` 上带 `beforeTokens` / `afterTokens` / `source`。

### P7 剪枝参数未评测

`8192 / 4096 / 1024` 是预设值，48 次剪枝事件从未与更激进或更保守的配置做过质量对照。

## 四、结构性观察（更大，但风险高）

1. **重复摘要**：每次压缩的区域从最早开始，包含上一次的 checkpoint 摘要，指令要求「合并」。因此摘要输入随会话历史单调增长（实测 690k–742k）。若改为「只摘要上次 checkpoint 之后的新增跨度 + 把旧摘要作为输入」，摘要输入与耗时能显著下降。属上游算法改动，必须配摘要质量评测。
2. **成本 vs 延迟的取舍**：DeepSeek cache read 仅 $0.003/M，把上下文长期压在约 700k 在经济上很便宜，但一次压缩要用户等 26–31 秒。0.9 阈值优化的是成本，不是等待时间。若更在意交互延迟，更早压缩（0.6–0.7）+ 更积极的预取才是方向。

## 五、建议的下一步

1. 先在补丁后产生的会话里确认真实自动压缩是否已走「压力路径 + 预取」（当前 0 样本，这是所有结论的前提）。
2. 复现 P1 的单变量实验：同一 overflow 场景，比较剪枝前/后摘要输入的 cacheRead 与成本。
3. 把 0.9 与 0.6 加入 1M continuation 策略集，与 shipped-80 同任务对照。
4. 以上有结果后，再决定是否动 retain 下限、prefetch lead 与输出预算。

## 六、不确定性与风险

- 5 个压缩样本**全部**来自补丁前，不能代表当前行为；v0.7.16 的修复效果尚无真实数据。
- `session-metrics` 的成本是 DeepSeek 峰谷价估算；`cacheRead` 来自 provider usage，可信。
- 「剪枝破坏前缀缓存」目前是**基于代码路径与命中率数字的推断**，尚未做单变量实验，属待验证假设。
- continuation 每策略 20 个任务且含 eval errors，配对比较只能支持「没有可测质量差异」，不支持「某阈值最优」。

## 七、是否替换掉 `dsh-compaction-basic`

### 结论

不建议从零重写引擎；建议把定制方式从「构建期文本补丁」迁移到「子类覆盖」。这确实是一种替换 —— 替换掉的是补丁式定制，而不是上游的事务内核。

### 依据

1. 上游把 compaction 设计成**可替换后端**：`dsh-compaction` 基类文档写明 `providers decide when to compact ... by subclassing CompactionEngine`，且「一个 context 只挂一个实现」（`ctx.compaction`）。
2. 但 `dsh-compaction-basic` 只留了**一个扩展点**。其类型注释原文：`summarize()` is the sole subclass customization hook。本仓库真正要改的 4 处（阈值定价、补全预算、预取、溢出短路）全部位于 `compactIfNeeded` 的管道里，不在这个 hook 里。
3. 决定性事实：`compactIfNeeded` 是 public，`_registerAutomaticCompaction` 以 `this.compactIfNeeded(...)` 调用，注释写明 `stays dynamically dispatched so subclass overrides are honored at event time`（已核对 lib/index.js 第 806、837 行）。⇒ **override `compactIfNeeded` 就能接管全部策略，不需要文本补丁。**
4. 上游不导出内部函数：`resolveCompactSpec`、`selectCompactableRange`、`prepareCompaction`、`summarizeCompaction`、`buildSummarizationInput`、`assertNoActiveCompaction` 都不在导出面。因此区域选择、摘要输入构造、溢出分支等策略辅助逻辑需要自实现（约 150–200 行）；但 `toolPairingBalancedBefore`、`CompactionId`、`compactCheckpointSource`、`ManualCompactionError`、`compactRegion()`、`summarize()` 都可复用。
5. 从零替换（不继承 basic）必须复刻 surface 事务：durable lock、`compaction/start|end` 配对、稳定性校验、shadow/回退、overflow 重试计数。这是最难、最容易写出隐性不变量错误、也最不该重写的部分。

### 三个方案对比

| 方案 | 改动量 | 主要风险 | 能否覆盖 P1–P3 |
|---|---|---|---|
| 现状：4 个文本补丁 | 0 | 上游升级即断（fail-fast），每再加一处就更脆 | 能，但脆弱度线性上升 |
| 子类覆盖 `compactIfNeeded` / `summarize` | ~200 行 + 测试 | 依赖 public/protected 契约（当前锁 0.1.5-rc.2，rc 版本可能变） | 能，且可读、可单测 |
| 从零实现 `CompactionEngine` | ~600–900 行 | 重建事务正确性，回归风险最高 | 能 |

### 什么时候才真的值得从零替换

当需求变成**改变 surface / 事务语义**时：

- 增量摘要（只摘要上次 checkpoint 之后的新增跨度，见第四节第 1 点）
- 多级 / 树状 checkpoint
- 跨会话摘要复用
- 与持久化策略耦合

前两项在子类里也能做近似（`compactRegion` 是 public），但一旦要改变「替换哪一段、替换成什么」的语义，就必须自己实现事务。目前没有这个需求。

### 迁移路径（若采纳）

1. 新建 `plugins/compaction/engine.mjs`：`class DscodeCompactionEngine extends BasicCompactionEngine`，override `compactIfNeeded`（含 overflow 分支）与 `summarize`（作为预取摘要的注入点：命中缓存则直接返回已完成的 `SummaryResult`，让上游事务照常提交）。
2. `presets/dscode/agent.cordis.yml` 把 `@deepseek-ai/dsh-compaction-basic` 换成自研模块；`scripts/build-packages.mjs` 移除 compaction-basic 的 vendor + 文本补丁项。
3. 删除 `scripts/patch-compaction.mjs` 与对应补丁测试，改为对 `engine.mjs` 的策略测试（阈值、溢出短路、预取提交）。
4. 保留 `plugins/compaction/threshold.mjs`（纯函数，与挂载方式无关）。

### 前提

当前真实压缩样本全部来自补丁前。先确认 v0.7.16 的补丁在真实会话中是否已解决问题；若已解决，迁移的紧迫性下降，可以等上游升级或做增量摘要这类更大改动时一并做。

## 八、迁移落地与「压缩后只剩 2.7%」的实测

### 8.1 迁移做了什么（已完成）

- 新增 `plugins/compaction/engine.mjs`：`DscodeCompactionEngine extends BasicCompactionEngine`，override `compactIfNeeded`（阈值定价、完成预算、预取、溢出先剪枝）与 `summarize`（预取摘要的注入点）。durable 事务、marker 配对与稳定性校验仍由上游 `compactRegion` 承担。
- 挂载点改为占位符 `DSCODE_COMPACTION_PLUGIN`：源码形态解析为绝对路径（`scripts/preset.mjs`），bundle 形态解析为 `@toddzheng024/dscode-bundle/compaction`（`scripts/build-packages.mjs` + exports）。
- 删除 `scripts/patch-compaction.mjs` 及其在 `patch-runtime.mjs` / `build-packages.mjs` 中的挂载；`node_modules` 的 `dsh-compaction-basic` 恢复为未打补丁的上游 0.1.5-rc.2；bundle 不再 vendor 该包。
- 验证：eslint 通过；`tests/compaction.test.mjs` 16/16；全量单测 **322/322**；`test:package`（bundle 构建 + 断言）通过。

### 8.2 压缩后实际保留量（回答「80% → 6%」）

用压缩前后相邻 `assistant/message` 的 provider prompt tokens 统计本机 63 个会话：

| 会话 | 压缩前 prompt tokens | 压缩后 prompt tokens | 保留比（÷ 有效窗口 792,576） |
|---|---:|---:|---:|
| 08ae45e4 | 792,443 | 22,767 | 2.9% |
| 723011ea | 792,655 | 22,300 | 2.8% |
| d41b2ae2 | 793,102 | 21,503 | 2.7% |
| 63cabcb7 | 695,661 | 20,041 | 2.5% |

4 次大压缩都从 ~792k（正好是有效窗口上限）掉到 ~21k，即保留 **2.5–2.9%**，而不是 `retainRatio 0.16` 应有的 ~127k（16%）。

原因已定位：这 4 次全部走**溢出恢复**路径，该路径调用 `selectCompactableRange(session, measurement, 0)`，保留预算为 0 ⇒ 只留最后 1 个 surface 节点，`retainRatio` 被完全绕过。用户观察到的「80% → 6%」是同一现象在不同显示口径下的表现（相对总窗口 1,048,576 时 21.5k ≈ 2.1%；pressure 路径 0.9 触发时是 713k → 131k）。无论口径如何，被保留的原文都远少于 `retainRatio` 的承诺。

### 8.3 可选修复（未实施，待决定）

把溢出路径的保留预算从 0 改为与压力路径一致的 `spec.retainTokens`（0.16 × 792,576 = 126,812）：

- 安全性：压缩前 792k ⇒ 压缩后约 131k（含摘要），远低于 792k 上限，不会二次溢出。
- 收益：每次压缩保留的原文从 ~21k 提到 ~131k，消除约 110k 的「只剩摘要」区间。
- 代价：压缩后上下文更大 ⇒ 后续每步多约 110k cache-read 输入，并更早再次触达阈值（压缩更频繁）。按 DeepSeek cache-read $0.003/M，每步约多 $0.0003。
- 折中：保留 5–8%（约 40–63k）。
- 任何取值都应先用 `eval/continuation` 的 1M 对照验证；目前没有 overflow-retain 的对照数据。

### 8.4 迁移后的状态

- 四个 `dscode-compaction-*-v1` 文本补丁标记已不存在。
- 溢出路径的 `retainCount = 0` **保持原样**（本次迁移行为等价），等待 8.3 的决定。

## 九、长上下文「多异步 checkpoint」评估

### 9.1 三种可能的读法

- **A 分层 checkpoint 共存**：surface 上保留多个 checkpoint，各自覆盖不同时间跨度（近期详细、远期粗略）。
- **B 多个后台摘要并行**：一个会话同时跑多个 prefetch。
- **C 滚动增量 checkpoint**：每次只压缩「上一个 checkpoint 之后」的新增跨度，旧 checkpoint 原样保留。

### 9.2 关键事实：它不省 token

压缩成本由**被压缩的原文量**决定，与 checkpoint 数量无关。当前一次压缩的摘要输入是 690k–742k tokens；改成增量后，跨度只少掉上一条 checkpoint 本身（约 4k，占 0.6%），因此摘要调用成本（$0.11–0.23）和耗时（26–31 s）几乎不变。

多 checkpoint 真正的收益只在**保真度**：

1. 避免反复重写同一份摘要 —— 每次 LLM 摘要都是有损的，反复重写会累积损失。
2. 允许不同时间粒度共存 —— 单条 ~4k tokens 的摘要承载 700k 历史，信息密度过高。

### 9.3 可行性：迁移之后成本大幅下降

上游 `selectCompactableRange` 把起点固定在 surface 的第一个非 system 节点（`dsh-compaction-basic/lib/index.js:398`、`413`），所以上一次的 checkpoint 必然落在新的 span 内、被重新摘要。

迁移后 `dscodeSelectRange` 已在本仓库的 `plugins/compaction/engine.mjs` 里，起点可以改成「最后一个 checkpoint 之后」：

- checkpoint 的识别用上游导出的 `isCompactCheckpointSource(message.source)`；
- `validateSurfaceRegion` 只要求 start/end 在 surface 上且边界平衡（`toolPairingBalancedBefore/After`），**不要求从最早节点开始**，所以这是合法 span；
- 还需要一条淘汰规则：surface 上 checkpoint 数超过 K 时把最老的并入新 span，否则 checkpoint 会无限累积。

最小改动约 20–40 行，全部在子类内，不需要再碰上游。

### 9.4 前置证据缺失

- 本机 63 个会话、5 次压缩，**没有任何一个会话出现过第二次压缩** ⇒「反复重写摘要的累积损失」在真实使用中还没有发生过。
- eval 的 controlled-25 平均 2.45 次摘要/分支（共 49 次），仍 18/20，与 full 的配对比较 Lost 0 / Gained 0，没有观察到退化；但那些任务很短（触发即结束）。
- 结论：**「多次压缩是否导致质量退化」目前没有测量数据**，而这正是多 checkpoint 的唯一论据。

### 9.5 建议顺序

1. 先做收益已被证据支持的两项：溢出路径的摘要前缀缓存、溢出 retain 下限。
2. 构造长会话（同一任务内触发 3–5 次压缩），对照 K=1（现状）与 K=2/3 分段 checkpoint 的任务完成率 —— 这是代价最低、最能决定方向的一步。
3. 只有退化被证实，再实现分段 checkpoint；实现位置就在子类，不需要动上游。
4. **B（并行多预取）不建议**：同一会话只有一个「最老可压缩跨度」，并行预取不会产生可提交的多份结果；只有分层设计才让并行有意义，而分层应建在 A/C 之上。

### 9.6 若要做的最小设计

- `dscodeSelectRange` 起点：最后一个 checkpoint 之后；保留层数 K 可配置。
- 摘要输入：把旧 checkpoint 作为「已有摘要」传入 —— 上游指令已经支持 `PRIOR checkpoint` 的合并语义。
- 淘汰：surface 上 checkpoint 数 > K 时，把最老的 checkpoint 纳入新 span 一并合并。
- 验收：同一长任务在 K=1/2/3 下的任务完成率、摘要调用次数、压缩后保留的原文量。

## 十、Compaction eval：数据集选型与成本

### 10.1 评测要回答什么

compaction eval 的核心问题是 **compress-then-continue 有没有损失**，不是「模型能不能读长文」。因此通用的长上下文 benchmark（RULER、LongBench 一类）只能当**上限参照**，不能当主评测：它们不压缩、不续做，测不出压缩的代价。

### 10.2 本仓库已有三层（优先复用，不要重造）

| harness | 形态 | 实测规模 | 测什么 | 单轮成本量级 |
|---|---|---|---|---|
| `eval/compaction` + `coding-v2.json` | 固定 transcript 重放 + 每 stage 探针（exact + 语义裁判） | 3 cases × **5 stages** × 75 probes（45 语义）≈ 40k tokens | 压缩后事实召回、修正覆盖 | 极低（小窗口几美分） |
| `eval/compaction` + `coding-broad-v1.json` | 同上 | 5 cases × **5 stages** × 125 probes（75 语义）≈ 63k tokens | 同上，样本更多 | 极低 |
| `eval/compaction` + `coding-million-v1.json` | 1M 压力重放 | 10 cases × 1 stage × 50 probes ≈ 5.6M tokens 重放 | 真实 1M 阈值下的召回 | $5–15 |
| `eval/continuation` + `cases-20.json` | 真实工具循环 + 隐藏检查 | 20 任务 × 5 策略 = 100 分支 | 压缩后的任务完成率 | $5–20 |
| `eval/deepswe` | DeepSWE 官方任务 + Pier 容器 | 2 trials | 真实仓库任务 | 高，且 1M 下压缩从未触发 |

**关键**：`coding-v2` / `coding-broad-v1` 是 **5 个 stage 顺序推进**，每个 stage 追加消息并跑探针 —— 上下文会跨阈值多次，**这就是「多次压缩退化」的场景**，不需要新造数据。把窗口调小（32k/64k）就能在几分钟内拿到 K 次压缩的对照。

### 10.3 外部数据集（按适配价值排序）

1. **LongMemEval**（ICLR 2025，[arXiv 2410.10813](https://arxiv.org/abs/2410.10813)）：长期交互记忆，覆盖信息抽取、多会话推理、**知识更新**、时间推理、弃答。压缩本质就是记忆管理，映射最直接；它的「知识更新」类问题正好对位本仓库 fixture 里的 superseded decision 探针。适配方式：把它的 chat history 作为 transcript 重放，问题当探针，需要一个 converter 脚本。
2. **[Context Rot](https://www.trychroma.com/research/context-rot)**（Chroma）：不是数据集，是方法论 —— 控制变量看「输入长度 vs 性能」曲线。用来设计压缩点前后的对照，避免把长度效应误判成压缩损失。
3. **[HELMET](https://arxiv.org/abs/2410.02694)**（Princeton）：长上下文评测的方法学分析，指出只测 needle-in-a-haystack 不够，需要 recall + reasoning + summarization 的组合。用来挑任务组合，本身不是数据源。
4. **RULER**（[leaderboard](https://llm-stats.com/benchmarks/ruler)）：合成长上下文，长度与难度可精确控制 —— 适合做「压缩后 recall 上限」的快速回归，不适合当主评测。
5. **[Terminal-Bench](https://www.tbench.ai/)** / SWE-bench Verified / DeepSWE：真实长任务，但本仓库的 DeepSWE pilot 已证明 1M 窗口下 191 步只到 158k tokens，**压缩从未触发**。要用它们测 compaction，必须缩窗口或注入长历史，否则测不到。

### 10.4 成本控制清单

1. **合成 filler 堆长度**（本仓库已用）：物理 token 精确可控，还能控制关键信息埋在哪个位置。
2. **先跑 offline scripted adapter**（`--backend offline`）：$0，先验证 fixture 与判定逻辑。
3. **exact 探针优先**，semantic 只留少数并保留裁判校准（`fixtures/judge-calibration.json` 已有）。
4. **探针合并为一次调用**：`probePrompt(stage.probes)` 已把一个 stage 的多个问题并成一次请求。
5. **利用前缀缓存**：同一 transcript 多策略对照时前缀相同，DeepSeek cache-read $0.003/M vs input $0.15/M（50×）。runner 已轮换策略顺序以减少顺序偏差。
6. **窗口缩放**：小窗口能便宜地测「压缩后损失」，但**不能定阈值**（报告里已明确）；阈值问题必须用 1M。
7. **控制分支数**：先 3 cases × 3 policies = 9 分支，而不是 100。

量级估算（DeepSeek 官方价，非峰）：摘要调用 ~700k input ≈ **$0.105/次**；探针调用按压缩后 ~131k input ≈ $0.0004（cache 命中）～$0.02（未命中）。于是：小窗口多 stage 对照 **< $1/轮**；1M 全矩阵（50 分支）**$5–15/轮**（峰时约 ×2）。

### 10.5 推荐的推进顺序

1. **Tier 0（$0）**：offline 跑 `synthetic.json` / broad fixture，确认 stage 数与压缩次数符合预期。
2. **Tier 1（<$1）**：32k 或 64k 窗口，3 cases × 3 policies（full / shipped-80 / K 层分段），测多次压缩后的探针命中率 —— 这一步直接回答「退化是否存在」。
3. **Tier 2（$5–15）**：只有 Tier 1 观察到退化，才上 1M + LongMemEval 子集确认。

数据侧几乎不用新增；需要新增的只是引擎侧「K 层 checkpoint」策略参数（约 20–40 行，见第 9.6 节）。

## 十一、LongMemEval 成本核算

### 11.1 数据规模（官方 README / 论文）

来源：[LongMemEval README](https://github.com/xiaowu0162/LongMemEval)、[arXiv 2410.10813](https://arxiv.org/abs/2410.10813)（ICLR 2025）、[HuggingFace 数据集](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned)。

| 变体 | 每题历史 | 题数 | 说明 |
|---|---|---|---|
| `longmemeval_oracle` | 仅 evidence sessions（几 k tokens） | 500 | 检索后的理想输入，天然不会触发压缩 |
| `longmemeval_s` | **~115k tokens**（~40 sessions） | 500 | 官方设计为适配 128k 上下文 |
| `longmemeval_m` | ~500 sessions（按 S 线性外推 ≈1.4M tokens） | 500 | 官方明确说「对长上下文测试太长」，只用检索系统评测 |

题目类型：single-session-user / single-session-assistant / single-session-preference / temporal-reasoning / **knowledge-update** / multi-session；另有 30 题 abstention（`question_id` 以 `_abs` 结尾）。

字段：`haystack_sessions`（多 session，每 session 是 turns 数组）、`haystack_dates`、`answer`、`answer_session_ids`，证据 turn 带 `has_answer: true`。官方评测用 LLM judge（`evaluate_qa.py gpt-4o ...`，输入 `{question_id, hypothesis}`）。

### 11.2 关键限制：S 在真实 1M 窗口下不会触发压缩

DeepSeek 官方路由的有效窗口是 1,048,576 − 256,000 = 792,576，阈值 713,318。**115k 的历史远低于它 —— `longmemeval_s` 直接用真实窗口跑，测的是长上下文阅读，不是 compaction。**

要让它触发压缩只有两条路：

- **(a) 缩小窗口**（runner 的 `--context-window`）：例如 96k 窗口 → 阈值 88,473 → 115k 历史触发一次压缩。这是模拟窗口，**不能用来定阈值**，但用于「压缩后召回」的相对对照有效。
- **(b) 放大历史**：把 115k 复刻到 ~805k（同 `coding-million-v1.json` 的 filler 做法）→ 真实 1M 窗口下触发。成本约 7 倍。

### 11.3 成本核算（DeepSeek 官方价，非峰：input $0.15/M、cache-read $0.003/M、output $0.6/M；峰时 ×2）

每次运行的成本 = 每题（1 次摘要调用 + 1 次探针调用）× 题数 × 策略数。

| 配置 | 每题摘要输入 | 每题成本 | 500 题 | 100 题 |
|---|---|---:|---:|---:|
| **(a) S + 96k 模拟窗口** | ~99k | $0.018 | **$9** | **$1.8** |
| (b) S + 真实 1M + 放大到 805k | ~678k | $0.122 | $61 | $12 |
| (c) M（≈1.4M/题，需分批喂入 + 多次压缩） | ≥1.4M 读一遍 | ≥$0.21 | ≥$105 | ≥$21 |
| oracle（不触发压缩的上界基线） | ~3k | $0.0006 | $0.3 | $0.06 |

Judge 成本：把 500 题的 `{question, answer, hypothesis}` 交给裁判，约 1.5k tokens/题 → DeepSeek judge ≈ **$0.11**；官方脚本用 GPT-4o 则约 $2–5（且需要改造调用端）。

策略对照会成倍：3 个策略 × 100 题（配置 a）≈ **$5–6**；其中 full（不压缩）每题 115k input ≈ $0.017，压缩策略 ≈ $0.018。

### 11.4 适配要点

1. **converter**：`haystack_sessions`（`{role, content}`）→ fixture 的 `stages[].messages`（`{role, text}`）。约 100 行。
2. **时间戳**：fixture 的 message 只允许 `role/text/name/repeat`，LongMemEval 的 session 时间必须内联进文本（例如 `[2023-05-12] ...`），否则 temporal-reasoning 题无解。
3. **evidence 强制校验**：`validateDataset` 要求每个 probe 的 `evidence.quote` 真实出现在某条消息里 —— 正好可以用 `has_answer: true` 的 turn 生成 quote，但需要 converter 保证逐字一致。
4. **abstention**：30 个 `_abs` 题在纯长上下文设定下需要特殊判定规则，建议先单独分组。
5. **可比性**：官方 leaderboard 用的是「索引 + 检索 + 阅读」范式，我们的是「全史 + 压缩」。两者不可比；只能做**内部对照**（同一 harness 下 full vs compacted）。官方也提供 `full-history-session` 的长上下文基线，说明「全史」用法在方法上是被认可的。

### 11.5 LongMemEval-V2 不适合当前需求

V2（[repo](https://github.com/xiaowu0162/LongMemEval-V2)）是面向 **retrieval-based memory backend** 的：451 题、haystack 最大 **115M tokens**、需要自建 reader/embedding endpoint（Qwen3.5-9B / Qwen3-Embedding-8B）并以 gpt-5.2 做 judge，接口是 `insert(trajectory)` / `query(question)`。它评的是「索引 + 检索」，而 DSCODE 的 compaction 是 single-pass 的 context 替换 —— 既用不到 retrieval 接口，也喂不进 115M tokens。**不建议。**

### 11.6 推荐配置

- **Tier 1（≈$2–3）**：`longmemeval_s` 分层抽 100 题（五类能力各 20 + abstention 单列），96k 模拟窗口，DeepSeek judge，对照 full / shipped-80 / K 层分段。
- **Tier 2（≈$10–20）**：同一配置跑满 500 题确认。
- **Tier 3（≈$60+）**：只有 Tier 1/2 出现明显信号，才用真实 1M + 放大历史的配置复验。
