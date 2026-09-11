# Session footer

右下角固定显示 `ctx 43% · session ~$0.0030 · cache 90.0%`，窄窗口自动缩短标签。

- **ctx**：当前会话的 token-meter 上下文估算 / 模型上下文窗口，压缩后重新计算。包含当前可见上下文；adapter 临时注入的额外文本不在本地估算中。
- **session**：美元估算，累计当前会话及其子 agent 已记录的模型调用，包括压缩、标题生成和 auto 审核。恢复会话保留累计值；新会话重新计数。模型之外的 MCP/API 服务费用不计入。
- **cache**：累计缓存读取 token / 累计全部输入 token，按 token 加权，不是请求命中率或各请求百分比的平均值。

`~` 表示估算；`+` 表示只有部分费用可计算；`--` 表示数据或价格未知；`…` 表示请求尚未结束。未收到 usage 前不预支本次费用。每秒刷新，无额外模型请求。

价格采用 [DeepSeek 官方价目表](https://api-docs.deepseek.com/quick_start/pricing/) 的 2026-09-11 快照，按请求开始时间区分峰谷价，仅匹配支持的官方 provider/model。价格更新需更新 `plugins/session-metrics/pricing.mjs`；显示值不是供应商账单。旧会话能从日志补回部分调用，但历史审核/标题/子 agent 用量未必完整，因此标为部分合计。

记录保存在 `$DSH_HOME/session-metrics/`，只含模型、时间、usage 和费用等元数据，不保存提示词或凭据。原始 session 日志不添加自定义事件。
