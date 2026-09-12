# 描述性的 session 名片

DSCODE 0.2.0 在 `dscode sessions`、`dscode read SESSION_ID` 和 TUI `/session` 中提供名片。名片只含三个字段：

```json
{
  "project": { "name": "dscode", "id": "github.com/qiz029/dscode" },
  "workspace": "/work/dscode-feature",
  "topics": [
    { "text": "为会话增加项目、工作区和最近请求 topic", "sourceSeqs": [125, 129] },
    { "text": "取消鲸鱼动画方案", "sourceSeqs": [98, 112] }
  ]
}
```

项目由本地 Git 信息确定：优先使用去除凭证的 origin 仓库标识，没有可识别的远端时使用 Git common directory 对应的路径。同一仓库的 worktree 因此可以归到同一项目；工作区保留 session 的原始 cwd。非 Git 目录的项目为 `null`，不让模型猜项目。读取 Git 信息不访问网络。

Topic 描述用户提出了什么请求，默认最多 5 个，按最近提及顺序排列，并引用原始用户消息的事件序号。提取提示词要求合并连续补充、描述明确的取消和替换、忽略单纯的确认；禁止生成结论、结果、完成状态或 agent 推测的计划。结构校验拒绝额外字段和不存在的消息引用，文本语义仍取决于模型遵循提示词的质量。

## 后台更新

项目和工作区立即可用（Git 检测异步完成）。默认累计 3 条非空用户文字输入后启动 topic 提取；新输入等待 1.5 秒合并，同一 session 两次提取至少间隔 60 秒。只扫描原始 `user/message` 中的用户文字，不读取 assistant 输出、工具结果或外部 plugin relay。因此 `dscode send` 不会成为“用户让做的 topic”。

每次最多读取最近 32 条用户文字、合计 16000 字符，单条最多 4000 字符；更早的话题可能不再保留。这是近期请求索引，不是完整会话摘要。常见密钥模式会脱敏，但不能保证识别任意敏感文字。

模型使用会话的 provider/model，独立固定 `low` effort，不继承主 agent 的 ultra；可单独指定 provider/model。每个 Host 最多同时运行一个提取调用，30 秒超时，不创建第二个 Agent，不使用工具，不写入会话上下文。新用户输入会作废正在生成的旧版本；失败保留上一版并退避重试。该后台调用会产生额外模型用量，调用计数和 token 用量记在名片缓存中，目前不计入 TUI 的 session 费用统计。

`cardState` 放在 `card` 外，提供 `status`、`updatedAt`、`coveredUserSeq`、`latestUserSeq`。状态可能是 `empty`、`insufficient`、`pending`、`updating`、`ready`、`error` 或 `disabled`；消费者可以据此辨认过期名片。后台名片更新不属于持久化会话事件，因此 `watch` 不推送它；需要时重新调用 `sessions` 或 `read`。

派生缓存原子写入状态目录的 `session-cards/`，只存名片和生成元数据，不另存用户原文。恢复会话可复用未变化的名片；损坏缓存可以重建。`sessions` 仍只列运行中的根会话，没有增加离线会话目录或自动跨会话发送。

## 配置

在 Harness profile overlay 中配置已有插件：

```yaml
- id: dscode-session-cards
  config:
    enabled: true
    topicCount: 5
    minMessages: 3
    debounceMs: 1500
    cooldownMs: 60000
    timeoutMs: 30000
    maxMessages: 32
    maxInputChars: 16000
    # provider: your-provider
    # model: your-model
```

`enabled: false` 停止模型提取，仍可读取本地项目、工作区和已有 topic 缓存。provider/model 必须成对配置。`minMessages` 不能超过 `maxMessages`。

验证：`node --test tests/session-cards.test.mjs` 和 `node scripts/verify-session-cards.mjs`。后者使用真实 Harness、原生会话、Unix socket 与确定性本地模型，覆盖独立 effort、输入隔离、读取和恢复；不代表真实远端模型的 topic 文本质量已经验收。
