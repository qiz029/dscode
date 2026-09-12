# Session 间通信

DSCODE 0.2.0 支持。agent 可以读取 session 名片并通过内置工具向同一状态目录下、已加载的 dscode 根 session 发送消息。接收方继续使用原生唯一运行时；TUI、CLI 与 agent 工具共用 session bridge。不会自动打开离线 session。

## 投递方式

| mode | 目标空闲 | 目标正在运行 |
| --- | --- | --- |
| queue | 唤醒新一轮 | 排到后续 turn |
| steer | 唤醒新一轮 | 在下一安全 step 加入当前执行，不取消工具 |
| defer | 留言，不唤醒 | 等下一次 turn 开始时领取，不进入当前轮 |

defer 是一次性留言。读取邮箱或恢复 session 不会单独唤醒它。超过本轮批次大小的留言继续等待以后自然发生的 turn，不会自动启动额外轮次。

消息含义独立于投递方式：`request` 请求处理，`notify` 提供信息但不要求回复，`reply` 是关联原 request 的一次最终答复。notify 可以使用 queue 或 steer 唤醒目标，也可以 defer；协议不会自动回复“收到”。

## CLI 与 TUI

```sh
dscode sessions
dscode send SESSION_ID --kind request "请检查 parser 的边界条件"
dscode send SESSION_ID --steer --kind notify "补充：只检查 UTF-8 输入"
dscode send SESSION_ID --defer --kind notify "下次处理时注意这个兼容性问题"
dscode send SESSION_ID --defer --title "Parser 兼容性" "稍后检查 UTF-8"
dscode mailbox SESSION_ID
dscode mailbox SESSION_ID --after 12 --limit 50
dscode watch-mailbox SESSION_ID --after 0
dscode cancel SESSION_ID MESSAGE_ID
dscode new-task SESSION_ID
```

`--steer` 与 `--defer` 互斥，默认 queue。显式 `--title` 立即设置标题，不因 defer 等待领取；重复发送不会覆盖后来修改的标题。发送前 stderr 会打印 requestId，丢失回执时使用相同 `--request-id`、目标、kind、mode、正文和 title 重试。

TUI `/session` 显示邮箱计数；`/mailbox` 查看消息，`/mailbox cancel MESSAGE_ID` 取消请求或未领取消息。原生停止操作也会取消待处理的原生 inbox 消息；独立 defer 留言需要在邮箱里显式取消。接收并进入上下文的消息仍作为带来源的 relay 显示。

`/session-new-task` 或 `dscode new-task SESSION_ID` 在 session 空闲时显式开始新的通信任务预算。普通补充、自动续跑和 resume 不重置预算。旧请求后续返回或旧留言被领取时仍带原链，因此可能再次受到旧链的限制。

CLI 可代当前 session 回复一个确实发给它的跨 session 请求：

```sh
dscode reply RECEIVING_SESSION_ID --reply-to REQUEST_MESSAGE_ID "最终答复"
```

外部脚本发来的 request 没有另一个 agent session 回复地址，其进展和输出通过 read/watch 读取。

## 内置 agent 工具

- `list_sessions`：读取名片和运行状态，支持精确 project/workspace 筛选及分页。
- `read_session`：读取指定 session 的原生事件页和邮箱首页，不唤醒、不领取。
- `send_session`：发送 request/notify；必须指定完整 session ID、mode、正文与稳定的 `idempotency_key`。
- `reply_session`：按原 request ID 回复，目标由运行时确定；默认 queue。

进度 notify 可以携带 `in_reply_to` 返回原请求方；目标 ID 必须与原发送方一致。每个 request 最多一条最终 reply。工具只返回接收回执，模型应结束当前轮等回复，不要循环 read 轮询。

发送者 session 身份由运行时凭证绑定；模型不能传入自己的 chainId、预算、发送者或新任务授权。子 agent 继承父任务链，但第一版跨 session 发送/回复只由根 session 执行，子 agent 应通过原生协作入口交回父 agent；也不开放把子 agent 作为独立收件目标。会话名片仍只描述原始用户请求，relay 不进入名片 topic。

## 防循环与持久化

当前第一版固定以下上限：每条任务链 3 层委派、8 条 request/notify、每个 request 预留 1 条最终回复；有效期 1 小时。外部 send 创建根请求时本身也计入 8 条。队列、steer 和 defer 均计数；达到新消息上限后，预留的最终 reply 仍可返回。

禁止把新任务发给自己或当前委派路径中的祖先；关联原请求的合法回复、进度回传允许返回。多条链合并后受所有相关链约束，不能选择一条剩余额度更多的链。普通续跑、回复和通知保留当前因果关系；新的一轮完全由通信 request 发起时，采用这些请求已有的链，避免混入早已结束的无关工作。这不会创建新预算。最多保留 32 条不同因果路径，超过时明确拒绝，而不静默丢弃关系；需要用户明确划分新任务。

每 session 的待领取邮箱最多 100 条、正文合计 1 MiB；单条正文最多 64000 字节，包含元数据的完整信封及余量最多 96000 字节。单次 defer 批次同样受完整大小限制。到期留言保留可读记录，但不再自动领取。

所有 Host 共享状态目录 `session-communication/mailbox.sqlite`。准入、幂等、预算和回复名额在 SQLite 短事务中提交。账本只负责通信，模型执行继续使用原生 inbox；session 的写排他仍由原生 JSONL 内核锁保证。owner generation 拒绝旧运行时凭证，无心跳超时夺锁。

回执与记录区分：

| delivery | 含义 |
| --- | --- |
| accepted | 邮箱已持久化；defer 可停留在此 |
| admitted | 已进入原生 inbox 或领取流程 |
| consumed | 已核对原生 user/message 并完成 flush；不代表任务完成 |
| cancelled / expired | 不再自动投递 |
| late | 迟到最终回复，仅保留记录、不唤醒 |

queue/steer 的成功回执等待原生 inbox flush；defer 等待邮箱提交。账本先提交、inbox 后写入的间隙由稳定 messageId 补投恢复；已进入原生日志的消息不重复加入。原生退出时清理 inbox 与用户主动取消分开处理，前者允许从账本恢复尚未消费的通信，后者不会复活已取消消息。

**取消的边界是领取。** `alreadyClaimed: false` 的未领取消息可阻止后续领取；已领取输入不能保证撤回，回执会标为 true。取消请求会关闭回复关系，迟到回复不唤醒；不会杀死目标的其他工作或回滚工具副作用。defer 的 batch 记录和原生消费确认分开保存，中断后可以重新核对。

`watch-mailbox` 使用独立的单调事件游标，250ms 读取一次共享账本；只订阅的连接执行轮询，不驱动任何 agent。它覆盖接收、准入、消费、取消与拒绝。`watch` 继续使用原生 session seq，二者游标不能混用。read/list 不领取消息，WAL 快照不取得 session 写锁。

同一 OS 用户下能读取状态和凭证的程序仍可调用外部入口；这些限制防止正常工具使用中的意外循环，不构成对拥有任意 shell 权限的程序的安全隔离。单个 agent 内部的工具循环和模型用量仍需其执行预算控制。

## 验证

`node --test tests/*.test.mjs` 覆盖协议校验、幂等、循环/深度、预算、并发进程准入、过期、取消与编码后大小限制。

`node scripts/verify-session-messaging.mjs` 使用两个真实 Harness Host 和本地确定性模型，验证已注册工具发送、模型调用 reply、defer 截止边界与不唤醒、强制退出恢复、已有原生 inbox 的恢复、去重、取消和邮箱订阅。`node scripts/verify-runtime-foundations.mjs` 验证内核锁及原生输入钩子。没有声称远端模型协作质量、UI 人工验收或副作用 exactly-once 已通过验证。
