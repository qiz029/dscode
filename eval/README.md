# DSCODE evaluations

所有 eval 代码、样本、测试和输出都在这个目录。第一套是 **会话压缩后的事实召回评测**，复用当前安装的 DSH `BasicCompactionEngine`、token meter 和工具结果裁剪器。第二套是 **编码任务续做评测**，在隔离工作区实际改动源码并运行验收检查。

真实仓库任务另见 [`deepswe/README.md`](deepswe/README.md)：用 DeepSWE 官方任务与独立 verifier、Pier 容器，以及本地 DSH 80% 原生压缩策略跑初步评测。

事实召回评测支持固定会话重放、自动压缩策略对照、连续压缩、隔离探针、精确匹配与语义裁判、裁判正反例校准、DeepSeek 原生 API adapter，以及可检查的 JSONL / Markdown 报告。续做评测目前使用小型合成 JavaScript 仓库和受限工具循环，尚未复用完整的 dscode CLI 或真实仓库任务。

## 运行

```bash
npm run test:eval             # 离线测试；包括原生压缩和模拟 DeepSeek SSE
npm run eval:compaction       # 离线流程演练；不会联网、不会使用凭据

# 编码续做：默认 3 个合成任务 × 5 种策略；需要 DEEPSEEK_API_KEY
npm run eval:continuation -- --model deepseek-flash --max-calls 200

# 单 case 和策略子集的冒烟/复核
npm run eval:continuation -- --cases retry-after \
  --policies eval/continuation/fixtures/policies-smoke.json

# 同一续做任务按 1M 窗口扩展中性历史，在真实阈值处比较
npm run eval:continuation -- --context-window 1000000 \
  --timeout-ms 300000 --max-calls 200

# 20 个合成编码任务 × 5 种策略 = 100 个独立分支
node eval/continuation/fixtures/build-twenty.mjs
node eval/continuation/preflight-twenty.mjs
npm run eval:continuation -- --dataset eval/continuation/fixtures/cases-20.json \
  --context-window 1000000 --timeout-ms 300000 --max-calls 700

# 若个别分支只有 provider/摘要基础设施错误，先用 --cases/--policies 定向重跑；
# 再仅用首个有效重跑替换这些错误行，保留原始报告和所有有效的任务结果
node eval/continuation/reconcile.mjs eval/results/<main-run> \
  eval/continuation/fixtures/cases-20.json eval/results/<targeted-rerun> \
  [eval/results/<another-targeted-rerun>]

# 只核对一条跨过 80% 的任务：完整历史 vs 当前默认策略
npm run eval:continuation -- --cases page-window \
  --policies eval/continuation/fixtures/policies-80.json \
  --context-window 1000000 --timeout-ms 300000 --max-calls 25

# 真实模型：从环境读取 DEEPSEEK_API_KEY，不从用户会话库读取数据
npm run eval:compaction -- --backend deepseek --max-calls 200

# 重复实验：次数增多时显式调整调用上限
npm run eval:compaction -- --backend deepseek --repeats 3 --max-calls 600

# 扩展样本：5 组场景、2 次重复、5 种策略，共 250 个检查点
npm run eval:compaction -- --backend deepseek --model deepseek-flash \
  --dataset eval/compaction/fixtures/coding-broad-v1.json \
  --repeats 2 --max-calls 650

# 1M 窗口压力样本：10 个 case、5 种策略，共 50 个检查点
node eval/compaction/fixtures/build-million.mjs
node eval/compaction/preflight-million.mjs  # 离线核对原生计量和触发次数
npm run eval:compaction -- --backend deepseek --model deepseek-flash \
  --dataset eval/compaction/fixtures/coding-million-v1.json \
  --context-window 1000000 --max-calls 200 --timeout-ms 300000

# 对已完成的扩展样本做分场景、分题型及配对复核
node eval/analysis/report.mjs eval/results/<run> \
  eval/compaction/fixtures/coding-broad-v1.json

# 使用经过审阅的本地数据和真实窗口
npm run eval:compaction -- --backend deepseek \
  --dataset eval/private/long-session.json --context-window 1000000 \
  --max-calls 200 --out eval/results/long-session-v1
```

默认采用 **16,384 token 的缩小窗口**，方便便宜地触发压缩、检查退化；它不是对 1M 窗口最佳阈值的验证。要研究 250K / 400K / 800K，必须用 `--context-window 1000000` 和确实达到相应长度的会话，并检查压缩次数。

## 编码任务续做评测

`continuation/fixtures/cases.json` 有重试头解析、分页窗口、配额预留三个合成任务。每个 case 包含早期任务说明、最新纠正、初始源码与可见测试，以及期望占用的窗口比例。运行时按 `--context-window` 生成相同的中性检查记录，让策略在其真实配置阈值触发；case 的源码和任务说明不会因策略不同而改变。当前三项压力目标约为 53%、84%、86%，因此 1M 运行可触及 25%、40%、80% 三档。

`continuation/fixtures/cases-20.json` 在这三项之外增加 17 个不同的小型 JavaScript 任务，涵盖解析、集合、排序、区间和配置处理。`build-twenty.mjs` 从明文任务规格生成工作区初始文件、可见检查和模型不可见的验收检查；`preflight-twenty.mjs` 离线验证每个初始源码都不过关、1M 原生压力不溢出且触发次数符合各策略。新增 17 项还有独立参考实现测试，确保隐藏检查可被正确实现通过。目标压力分布约为 28%、45%、53%、84%–86%，让 25%、40%、80% 策略都面对实际触发点。

每个 case / 策略 / repeat 都在新的 `eval/results/<run>/workspaces/` 下独立建工作区。模型只有 `read_file`、`write_file` 和 `run_tests` 三个工具：可读初始项目文件，只能替换指定源码，`run_tests` 运行不可修改的可见测试。隐藏检查保存在 `continuation/fixtures/checks/`，模型结束后才由隔离的 Node 子进程执行，不加入提示词或工具反馈；子进程不继承 API key。成功要求模型在 `--max-steps` 内完成、源码有改动、隐藏检查通过。可见测试通过本身不算任务成功。

`report.md` 按策略列成功任务数、原生摘要次数、模型调用数，并逐 case 与 `full` 配对统计丢分/得分。提供商或摘要调用错误单列并排除出任务质量配对，`step-limit` 则是实际续做失败。`scores.jsonl`、`traces.jsonl`、`calls.jsonl`、`contexts.jsonl` 和每个独立工作区保留可复核证据。只有基础设施错误的分支可以定向重跑并用 `reconcile.mjs` 合并；它核对模型、配置、数据、检查和源码 hash，生成独立的 `reconciled-*` 文件，不覆盖原始结果，也不重试有效的失败任务。它是有上限的最小工具循环，不包括完整 dscode 的 bash、插件、MCP、审批或跨文件仓库工作流；不能把这些合成任务的成功率直接推广到真实工程任务。

其他参数：`--policies <json>`、`--model deepseek-flash`、`--thinking disabled|enabled`、`--timeout-ms 60000`、`--base-url <endpoint>`。摘要输出上限 8,192，探针输出上限 2,048。默认关闭思考来隔离第一轮实验；开启思考后的结果应单独比较，不能混成同一组。

`--max-calls` 是整个实验的 adapter 调用上限，包括摘要、探针、裁判和校准，不是金额上限。传输层关闭自动重试；原生压缩引擎仍可进行一次摘要收敛重试，裁判格式不合规时最多重试一次，均计入上限。有效的不通过判定不会重试。每次调用有硬超时，即使 provider 的流不响应取消信号也会结束等待；Ctrl-C 会留下部分报告。已有输出目录会被拒绝，防止覆盖旧证据。

退出码：所有已计划探针通过为 0；有错误答案、无效 JSON、上下文溢出、调用失败或中断为非零。错误不会从分母中删除；中断会明确标记 `aborted` 和已完成/计划检查点数。

## 样本和策略

`compaction/fixtures/synthetic.json` 是离线流程样本：3 个场景 × 5 个检查点 × 5 个探针。它故意包含机器可读的状态更新，供脚本 adapter 测试数据流。其满分没有模型质量含义。

`compaction/fixtures/coding-v2.json` 是真实模型默认使用的人工编写微型样本，覆盖登录纠正、锁与失败恢复、发布验收边界，使用自然语言描述状态。v2 明确撤销旧约束、指定问题所询问的最新状态，并为每题固定评分方式及原文证据。当前数据 ID 为 `coding-recall-micro-v2.1`：每题只引用对应事实的原句，避免其他题的整段旧记录夹带过时待办。`coding.json` 保留首轮 v1 数据，不回写旧结果。

`compaction/fixtures/coding-broad-v1.json` 在原有三组会话之外增加长工具输出裁剪和中文配额纠正两组案例，共 5 组 × 5 检查点 × 5 探针。其生成器 `build-broad.mjs` 只读取公开的合成 fixture，不读取本地会话、仓库源码或凭据。长工具输出的目标文件名位于裁剪器保留的头尾之外；这组用于观测裁剪与摘要的共同影响。中文案例使用英文例行检查记录制造压力，业务事实和问题仍为中文。

`compaction/fixtures/coding-million-v1.json` 是独立的 1M 窗口压力样本：10 个合成编码 case，各有 5 个事实探针。原生计量的完整上下文分布在约 270K–870K，分别跨过 25%、40%、80% 触发线；每个 case 的最后一条用户消息纠正决策和待办。`build-million.mjs` 生成样本，`preflight-million.mjs` 不联网而直接复用原生计量和压缩逻辑核对触发次数。它只检验长而重复的合成历史，不能代表真实 1M token 开发会话。这里的 K 是原生估算 token，实际 API token usage 另见 `calls.jsonl`。

重复的检查记录用于制造压力，仍是合成数据，不能当作真实开发任务基准。检查点编号表示会话阶段，不是压缩次数；每一行报告实际发生的摘要次数。v1 与 v2 的题面、评分协议不同，分数不可直接相减作为压缩改善幅度。

| 策略 | 触发比例 | 近期原文保留比例 | 用途 |
|---|---:|---:|---|
| full | 不压缩 | 全部 | 同一模型的召回对照；溢出会报错 |
| shipped-80 | 80% | 16% | 当前产品默认比例 |
| controlled-80 | 80% | 6.4% | 固定保留量的阈值对照 |
| controlled-40 | 40% | 6.4% | 固定保留量的阈值对照 |
| controlled-25 | 25% | 6.4% | 固定保留量的阈值对照 |

1M 窗口下 6.4% 为 64K；近期消息边界及工具配对可能使实际保留量更大。所有开启压缩的组使用产品里的工具裁剪设置。`full` 也关闭工具裁剪，因此与压缩组比较的是整套上下文管理策略。`shipped-80` 与其他组同时改变保留量，只比较 `controlled-*` 才能隔离触发阈值。

## 数据格式

```json
{
  "version": 1,
  "id": "auth-session-v1",
  "cases": [{
    "id": "auth-fix",
    "system": "You are a coding assistant. Preserve user corrections.",
    "stages": [{
      "id": "after-debugging",
      "messages": [
        {"role": "user", "text": "Fix the 401 error at /api/auth/login."},
        {"role": "tool", "name": "read_file", "text": "The session-store configuration is in src/auth/session.ts."},
        {"role": "assistant", "text": "The remaining action is to add a regression test."}
      ],
      "probes": [{
        "id": "original-endpoint",
        "category": "recall",
        "question": "What exact endpoint originally failed? Answer with the path only.",
        "accept": ["/api/auth/login"]
      }]
    }]
  }]
}
```

五种分类为 `recall`、`artifact`、`decision`、`continuation`、`constraint`。每个阶段只放**新增**消息；后续阶段继承此前压缩后的上下文，不能重新注入已丢弃的原始历史。探针不会加入之后的会话，因此不向后续阶段泄漏答案。

支持文本 user / assistant，以及有名称的工具结果。工具消息会重建为配对的调用/结果；不执行工具。它没有恢复原始工具参数、schema、provider usage 或 reasoning，因此这个导入格式不能声称是完整生产请求重放。暂不接受图片、任意 DSH JSONL 或其他未支持字段；应先转换为上述格式并审阅。`repeat` 仅供合成压力样本，不能用于冒充真实轨迹。

标准答案在重放前固定：从未压缩原文确定并核查，之后不要按某个策略的输出修改答案。送给压缩器的只有历史；探针模型只看到压缩后的历史和问题，`accept`、评分标准和原文证据均不发送给它。

v1 维持旧的精确匹配行为。v2 每题声明以下字段：

```json
{
  "grading": {
    "kind": "semantic",
    "required": ["Use kernel-backed locks for ownership; kernel locks is a sufficient concise answer."],
    "forbidden": ["Use PID-only ownership checks."]
  },
  "evidence": [{
    "stage": "checkpoint-1",
    "message": 0,
    "quote": "We decided to use kernel locks instead of PID-only ownership."
  }]
}
```

这段应附加在 probe 上，数据集 `version` 设为 2；quote 必须是该阶段或更早消息中的真实子串，校验器会拒绝未来证据及不存在的引文。精确题只需 `"grading":{"kind":"exact"}`，同样要求 evidence。

路径、标识符、错误码、版本号用 `exact`：忽略首尾/重复空白，做 Unicode NFKC 规范化，保留大小写。决策、待办、约束用 `semantic`：回答与事先审定的参考答案完全一致（忽略大小写及重复空白）时直接通过；其他表达单独调用 `deepseek-flash`，只提供候选回答、问题、事先固定的参考答案、必需事实、禁止结论和原文证据，不提供策略名称、压缩后的上下文或先前评分。

v2 探针接受单个完整的 Markdown `json` 代码块并单独统计格式偏差，避免把五项事实正确的答案全部误记为召回失败。代码块外有额外说明、JSON 对象结构错误或未知字段仍然报错。v1 保持严格 JSON 解析行为。

裁判使用 `semantic-checklist-v3` 协议，每题独立判断，禁止跨题引用证据；逐条返回事实是否满足、是否包含禁止结论及候选回答中的引文。代码验证 JSON、ID、清单长度和引文真实性；引文与回答经 Unicode 规范化、大小写折叠后仍必须匹配，其他编造引文会被拒绝。只有全部必需事实满足且没有禁止结论时通过。语义正确的简短名词短语可通过；缺失事实、相反约束、已过时待办不能通过。`UNKNOWN`、空答案及缺失答案直接失败。裁判服务错误、无效 JSON 或编造引文标记为 `ungraded` 和 eval 错误，不把它们伪装成模型答错。

每次包含语义题的运行先用 `judge-calibration.json` 的 14 个固定正反例校准裁判，按最多四题的小批次独立判断，包含近义表达、时间状态、否定、矛盾、中文纠正和回答内的评分指令注入。必须全部正确才能开始候选会话；校准结果和 hash 留在报告。校准标签不会传给裁判。模型与裁判使用同一个模型 ID、不同请求，仍可能共享偏差；这不是独立模型复核，也不能用 14 题证明裁判永远正确。离线脚本 adapter 不支持语义裁判，离线演练继续使用 synthetic 样本。

## 报告与证据

每次运行写入新的 `eval/results/<run>/`：

- `manifest.json`：时间、模型 ID、参数、数据 hash、评测源码和关键 DSH 依赖 hash、状态及调用数。
- `scores.jsonl`：每个 case / repeat / policy / stage 的答案、判分、错误、实际摘要和裁剪次数。
- `contexts.jsonl`：每个检查点的模型可见上下文、摘要/裁剪事件及回答，便于查明丢失发生在哪里。
- `calls.jsonl`：摘要、探针、裁判及校准的耗时、完成状态及原始 provider token usage。没有 usage 时记为 null，不算零；当前不推算费用。
- `judgments.jsonl`：每次语义评分的输入、原始响应及错误，包括格式重试前后的证据，允许逐题复核；不写回被测会话。
- `judge-calibration.json`：运行前的正反例校准结果。manifest 记录评分协议、裁判模型和校准数据 hash。
- `summary.json` / `report.md`：聚合得分、分类结果和运行范围。
- 扩展样本可额外运行 `analysis/report.mjs` 生成 `analysis.md`：按场景、题型拆分，配对统计相对 full 的丢分与得分，并保留失败探针清单；必须提供与 manifest hash 相符的数据集。

报告中的 token 数来自原生 DSH 估算器，不是精确分词结果。短窗口的同一比例不能外推到长窗口；没有触发摘要的组会标记未执行压缩。模型 alias 可能变动，所以记录请求模型 ID、运行日期和源码 hash 仍不能保证远端模型版本被冻结。

每次 repeat 轮换策略顺序，以减少固定顺序带来的时间/缓存偏差，但不保证冷缓存或隔离服务端负载。同一会话的多个探针互相关联，不能把 375 个探针当作 375 个独立任务，也不将单轮分数差当作显著差异。

结果和 `eval/private/` 已忽略提交。报告会包含输入会话和摘要，使用真实会话时应先审阅数据；harness 不会自动读取或上传用户的历史会话。

## 下一层评测

事实召回套件衡量**召回与约束保留**；续做套件已在同一合成仓库快照处分叉，执行代码修改并用隐藏检查衡量任务通过率。后续还需加入真实仓库、跨文件修改和更长的工具流程，并记录需求遗漏、重复探索、总费用和耗时。

方法参考：[Hermes Compaction Eval](https://github.com/NousResearch/hermes-agent/tree/main/evals/compaction)、[Factory 的探针方法](https://factory.com/news/evaluating-compression)、[TRACE 的成对续做评测](https://arxiv.org/abs/2608.06503)。这里只借鉴设计，未复制其数据或宣称复现其成绩。
