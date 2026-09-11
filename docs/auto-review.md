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

`npm run dist` 的完整安装包包含此插件。Hub `.dshprofile` 仍只导出可解析的基础 bundle composition，不含尚未发布为 npm bundle 的本地 reviewer，不能声称独立 Hub 导入具有 auto 能力。

## 验证

`npm test` 覆盖审核规则入口、参数绑定、取消、超时、无效响应、凭据拦截、模型预算、模式切换、重复拒绝和停止。

`npm run doctor` 使用真实 DSH agent 和工具管线、确定性本地 LLM adapter，验证允许执行、拒绝不执行、无效响应转测试人工审批器、usage 记录及会话恢复。没有调用付费远程模型；实际模型的审核质量、延迟和费用尚待真实使用验证。模拟人工审批器只存在 doctor 的测试 overlay 中。
