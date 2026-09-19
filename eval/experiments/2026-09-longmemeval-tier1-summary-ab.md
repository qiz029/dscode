# LongMemEval Tier 1 压缩评测：证据保真度与摘要 A/B（2026-09）

## 速览

| 项目 | 值 |
|---|---|
| 数据集 | `longmemeval-s-tier1`（100 case，来自 LongMemEval_S；每题一个探针） |
| 窗口 | 131072（缩小窗口 micro-eval，不是 1M 结论） |
| 运行 A（诊断） | 2026-09-18，OpenRouter `deepseek/deepseek-v4-flash`，100 case × 3 策略 × 1 repeat |
| 运行 B（A/B） | 2026-09-19，官方 `deepseek-flash`，47 case × 3 策略 × 3 repeats = 423 checkpoint |
| 新增工具 | 确定性证据保真度、`--baseline` 预筛、探针协议重试、`summaryInstruction` 摘要 A/B |

## 为什么做这两轮

第一次运行（`eval/results/2026-09-18T15-24-51.850Z-681d25b4/`）报出 full 47/100、compact-80 17/100、compact-90 14/100，但这份数字无法指导决策：131072 micro 窗口与真实 1M 会话的保留预算相差约 8 倍；80/90 之间只差 3 个百分点而有效区分样本只有约 30 个；constraint 类三种策略一致 0/6；另有 24 个 eval error。要让评测有用，先补三件事：**一个不依赖模型的保真度指标**、**有区分度样本的预筛**、**把格式失败与模型失败分开**。

## 方法

1. **证据保真度（确定性）**：v2 探针的 `evidence.quote` 是历史消息里的逐字原文。`measureRetention`（`eval/compaction/retention.mjs`）在模型实际看到的上下文上按 token 边界统计原句（quotes）与 ≥4 字符词（terms）是否仍在，不调用模型与裁判，无采样方差。写入 `scores.jsonl` 的 `retention`，报告里是 `Evidence kept` 列。
2. **有区分度样本预筛**：`--baseline <run> [--baseline-policy full]`（`selectBaselineCases`）只保留基线 run 中该策略每个 repeat 都全对、且无基础设施错误的 case，筛选后的数据集写入新 run 的 `dataset.json`，`manifest.json` 记录 `selection`。
3. **协议重试**：答复不是单个合法 JSON、或流在 JSON 收全前截断时，带纠正提示重试一次（`answerRetries` 记录，计入调用上限）；被拒绝的答复不进入会话。
4. **摘要 A/B**：上游引擎只暴露一个 `summarize()` 钩子。策略里的 `summaryInstruction` 由 `EvalCompactionEngine` 在压缩请求里、上游总结指令之前插入一条指示，产品行为不变。

## 运行 A：保真度指标解释第一次结果（100 case × 3 策略，重算后）

| 策略 | 通过 | 原句保留 | 词保留 | 原句保留时通过 | 原句丢失时通过 |
|---|---:|---:|---:|---:|---:|
| full | 47/100 | 100/100 | 100% | 47/100 (47%) | – |
| compact-80 | 17/100 | 31/100 | 92% | 13/31 (42%) | 4/69 (6%) |
| compact-90 | 14/100 | 26/100 | 89% | 11/26 (42%) | 3/74 (4%) |

结论：**损失几乎全部来自「证据原句被摘要吞掉」**。原句仍在时通过率接近 full，原句丢失时只剩 4–6%。词级保留仍有 89–92%，说明摘要把词汇留住了、却没留住可复述的事实结构。阈值 80→90 只是把原句保留从 31 降到 26。

## 运行 B：提示词级「保事实」摘要无效（否定结果）

`--baseline` 从运行 A 的 full 结果筛出 47 个 case，`repeats 3`，策略 `full` / `compact-80` / `compact-80-keepfacts`（同一 `thresholdRatio`/`retainRatio`，只多了保事实摘要指令）。

| 策略 | 通过 | 弃答 | 原句保留 | vs full 丢失/追回 | 调用 | uncached input |
|---|---:|---:|---:|---:|---:|---:|
| full | 89/141 (63%) | 24 | 141/141 | – | 202 | 4.61M |
| compact-80 | 67/141 (48%) | 63 | 36/141 | 32 / 10 | 316 | 6.61M |
| compact-80-keepfacts | 66/141 (47%) | 57 | 36/141 | 34 / 11 | 319 | 6.63M |

- 两压缩策略直接配对：keepfacts 更好 10 次、更差 11 次，其余 56 次同对、64 次同错——**完全对称**。
- 保真度没有变化：原句保留同为 36/141，词保留 1889 vs 1887；输出 token 反而更多（193k vs 164k）。
- 结论：一句「保留可引用的事实原句」不会改变摘要器行为，提示词层面的修补可以排除。要改善必须做结构性改动（保留原文片段/引用式压缩、可检索的外置记忆、对证据句选择性保留）。
- 复现的机制关系：保住原句的 checkpoint 通过率 86–92%（33/36、31/36），丢掉原句的 32–33%（34/105、35/105）。注意前者高于 full 均值是选择效应（原句仍在的题多半更好答），能确定的是丢掉原句的 105 个 checkpoint 贡献了几乎全部损失。
- 成本：这个配置下压缩不仅更差也更贵——调用 316 vs 202，uncached input 6.61M vs 4.61M，同时通过率低 15 个百分点。
- 协议重试未被触发：423 个 checkpoint、0 个 eval error、0 次重试。运行 A 里 15 个 `invalid-answer-json` 没有复现，说明那是当时后端/模型快照的输出问题。

## 限制

- 131072 缩小窗口；真实 1M 会话的保留预算约 160k，损失应低于上表。结论方向（保住原句最关键、提示词无效）可外推，具体数字不可。
- 运行 A 与运行 B 是不同后端与模型快照，分数不可直接相减；A/B 结论只取自运行 B 的 run 内配对。
- 47 个 case 来自运行 A 的筛选，偏向「full 能答对」的题。
- 同模型判分；校准 14/14 只证明判分器自洽，不是判分正确性的证明。
- constraint（`single-session-preference`）类 0/6 是数据集缺陷（题面要求推荐、rubric 要求复述偏好），已知且未修。

## 复现

```bash
# 运行 B：同一 run 内配对的摘要 A/B
npm run eval:compaction -- --backend deepseek --model deepseek-flash \
  --dataset eval/private/longmemeval/tier1-wordboundary.json \
  --policies eval/compaction/fixtures/policies-summary-ab.json \
  --context-window 131072 --repeats 3 \
  --baseline eval/results/2026-09-18T15-24-51.850Z-681d25b4 --baseline-policy full \
  --max-calls 2400 --out eval/results/tier1-ab-keepfacts

# 配对与成本拆解
node eval/analysis/report.mjs eval/results/tier1-ab-keepfacts eval/results/tier1-ab-keepfacts/dataset.json
```

完整归因报告在 `eval/results/2026-09-18T15-24-51.850Z-681d25b4/attribution.md`（`eval/results/` 不入库）。数据集重建：`node eval/compaction/fixtures/build-longmemeval.mjs`。

## 下一步

1. 结构性改动实验：压缩时把证据句以引用形式钉在摘要里（而不是提示词里加要求），用同一套 `--baseline` + `repeats 3` + run 内配对验证。
2. constraint 类需要先修数据集（改探针问法或判分口径）再参与策略对比。
3. 真实窗口（`--context-window 1000000`）重跑，才能给出可外推的阈值结论。
