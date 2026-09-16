# Session 间通信设计

状态：本地源码版已实现主体，运行说明和验证见 [Session 间通信](session-communication.md)。下文保留设计依据；第一版采用固定限制，因果路径超限时明确拒绝并要求划分新任务，尚未实现自动拆分。取消的严格阻止边界为“领取前”，已领取输入以 alreadyClaimed 回执标识，不能保证撤回。基于现有 session bridge、描述性名片和原生 Agent inbox。

## 目标与范围

让 agent 能查看 session 名片、读取事件，并向选定的 session 投递任务、回复或通知。接收方仍由唯一的原生运行时执行；TUI、CLI、脚本和 agent 工具走同一入口。

第一版限定同一机器、同一状态目录、当前已加载的 dscode 根 session。沿用 Unix socket，不引入 ACP、后台常驻调度器或自动恢复离线 session。已经接收的留言在目标退出后继续持久化，恢复时可领取；向未加载 session 新发送消息暂时返回 `target_unavailable`。

发现和选择目标由调用者完成；接收方不自动扫描名片找任务。名片仍只有项目、工作区、最近用户请求 topic，不添加结论。外部通信不混入“用户请求 topic”。

## 消息含义与投递策略

消息含义与执行时机是两个独立字段。

| kind | 含义 | 回复约束 |
| --- | --- | --- |
| request | 请目标处理一件事 | 建立可跟踪的请求，允许一次最终 reply |
| reply | 对已有 request 的最终答复 | 必须关联原请求；不能回复另一条 reply |
| notify | 提供信息，不要求回复 | 不建立等待关系；进度更新也使用 notify |

| mode | 已加载但空闲 | 正在运行 |
| --- | --- | --- |
| queue | 唤醒，开始新 turn | 进入原生 nextTurn inbox，当前 turn 后执行 |
| steer | 唤醒，开始新 turn | 进入原生 nextStep inbox，在安全输入边界加入当前执行 |
| defer | 持久化留言，不唤醒 | 留给下一次 turn，不能进入当前 turn |

`steer` 不取消正在执行的工具，不绕过权限检查。当前原生 inbox 在 turn 首步领取一条 nextTurn 消息，同时领取全部 nextStep 消息；queue 因此逐条开启 turn，但同一 turn 还可包含 steer 和 defer 输入。

`defer` 的“下一次”严格指下一次 turn 的输入收集边界。turn 已开始后到达的留言，即使模型请求尚未发出，也不补进该 turn。defer 不安排定时唤醒、不因读取而领取、不因打开或恢复 TUI 而单独启动模型。

三种 kind 都可使用三种 mode。`request + defer` 是“下次有空再处理”；调用方不能假设目标会马上运行。`notify + steer` 则是需要尽快看到的信息。正常 reply 默认 queue；也可显式指定其他 mode。

## Agent 工具

```ts
list_sessions({ project?, workspace?, cursor?, limit? })
read_session({ session_id, after?, limit? })
send_session({
  session_id,
  kind: "request" | "notify",
  mode: "queue" | "steer" | "defer",
  text,
  in_reply_to?, // notify 回传进度时使用，不能用于 request
  idempotency_key
})
reply_session({
  request_message_id,
  text,
  mode?: "queue" | "steer" | "defer", // 默认 queue
  idempotency_key
})
```

list/read 返回现有名片、运行状态、分页事件和有限的消息收件状态。list 可以支持本地精确筛选，不在第一版增加模型选人或语义搜索。工具要求完整 session ID；CLI 可继续支持唯一前缀。read 只读，不领取 defer，不唤醒。

reply 的接收者从原请求推导；调用者必须是原请求的接收方。单独的 reply 工具减少填错关联 ID、回复错人、把回复变成新任务的机会。它底层仍是同一种消息信封。

发送是异步操作，返回持久化回执，不等待目标完成。第一版不提供阻塞式 `wait_session`：agent 可结束当前轮，由 queue/steer 回复继续唤醒。未来如增加 wait，必须挂起等待方而不是占用工具调用等待，否则 reply 可能无法进入正在等待的 turn。

CLI 保留现有默认 queue 与 `--steer`，新增 `--defer`（二者互斥）、`--kind`，并提供对应 reply 子命令。现有 `--title` 继续作为 CLI 的显式重命名能力，不默认开放给 agent 消息工具。

## 消息信封与身份

运行时生成并验证以下信封；模型只能填写工具公开参数：

```ts
type SessionMessage = {
  version: 1;
  messageId: string;
  idempotencyKey: string;
  from: { kind: "session"; sessionId: string }
      | { kind: "external"; source: string };
  toSessionId: string;
  kind: "request" | "reply" | "notify";
  mode: "queue" | "steer" | "defer";
  text: string;
  chainIds: string[];
  parentMessageIds: string[];
  inReplyTo?: string;
  createdAt: number;
  expiresAt: number;
};
```

模型不能指定发送者、创建新任务链、减少深度、延长期限或重置预算。显示用的 source label 不是身份认证。跨 Host 的 agent 发送需要绑定发送方运行时的凭证；普通 CLI 不能只传 `source=agent` 就获得 session 身份。

这些约束防止正常工具链中的意外循环，不把同一 OS 用户当作安全隔离边界。拥有任意 shell、状态目录和凭证读取能力的 agent 仍可能绕过入口；要对抗主动绕过，需要额外的 sandbox 权限隔离，第一版不作这个保证。

## 防循环规则

### 任务链由运行时延续

只有可信的人类输入入口或获授权的外部任务入口能创建根任务链。接收到的消息、其后续 turn、工具重试、自动续跑、子 agent 和 resume 都继承原链。用户的一般补充不能自动给正在进行的通信补预算；显式开始新任务或继续已停止的任务才建立新的授权边界。

同一 turn 批量处理多条链时，采用保守规则：出站消息关联该 turn 已领取输入的链集合，并同时受这些链预算限制，不能让模型自行选择额度最多的一条。steer 带来的链对之后的出站调用生效；此前已经获准的调用不追溯改变。链集合超过上限时拆分后续输入批次，不能丢弃关联。

defer 被领取时仍携带旧链。不能用“先留言、以后再处理”洗掉预算；对同一目标混合人类任务和旧留言可能导致保守拒绝，这是第一版接受的取舍。用户可显式重新授权后继续。

### 有限委派与有限通信

建议的初始默认值（可配置，均由运行时执行）：

| 限制 | 默认值 | 计数方式 |
| --- | --- | --- |
| 委派深度 | 3 条跨 session 边 | A → B → C → D 达到上限 |
| 新消息预算 | 每条链 8 条 request/notify | defer 也计数；新追问也计数 |
| 最终回复 | 每个已接收 request 1 条 | 接收 request 时预留回复名额，最多再有 8 条 reply |
| 链有效期 | 1 小时 | 衍生消息不能延长；到期不再自动唤醒 |
| 正文 | 每条最多 64000 字节 | 沿用 bridge 限制 |
| 待领取邮箱 | 每 session 最多 100 条、合计 1 MiB 正文 | 满时拒绝新消息，不静默覆盖 |

新 request/notify 不允许发给自身或当前委派路径的祖先，直接阻断 A → B → A 和 A → B → C → A。reply 可以沿原请求返回；返回后 A 再追问 B 会消耗新的消息预算。路径按委派关系计算，不把合法回复返回当成一次新委派。

进度 notify 如需发给请求方，应显式关联原 request，并按回传处理：目标由原请求推导并与 session_id 核对，允许回传祖先，但仍消耗新消息预算。可选 `in_reply_to` 只允许原接收方通知原发送方，不能改变身份或新建链。

同一幂等键重试不重复计数，不重复唤醒；同键不同正文、目标、kind 或 mode 返回冲突。计数、回复名额和幂等记录持久化，跨 Host 并发准入必须原子执行。失败的传输可继续重试同一条消息，不通过“退款后创建新 ID”绕过额度。

当某条链的新消息预算用完，已经预留的最终 reply 仍可返回，避免 B 完成工作却无法回复 A。reply 不产生新的回复名额；自动“收到”不属于协议动作。

### 到期、取消和异常

request 的业务状态为 `open → replied | cancelled | expired`。只允许原发送方或用户取消。正常最终 reply 原子关闭 request；发送成功不代表回答正确或任务经用户验收。

取消/到期的 request 不再接受会唤醒的新回复；第一条迟到 reply 可以保存为可读记录，并返回 `late_reply`，但不再调度。重复晚到回复仍去重。已存在的请求关系保留，不能通过删除 UI 项重获回复名额。

取消尚未消费的消息会阻止其消费；已进入模型上下文的内容无法撤回。取消请求不等同于杀死工具或回滚副作用，也不会取消目标在处理的其他任务。

预算耗尽、链到期、路径回环只返回结构化错误并写一次可观察事件，不自动给另一 session 发送“拒绝通知”，以免错误通知自身成环。已经到期的 defer 仍可手动查看，但不自动进入下一轮。

## 持久化与运行时接入

复用当前 Host/socket 和原生 `Agent.followup()` / `Agent.steer()`。新增 CommunicationService 负责消息准入、持久化、因果链、回复关联与 defer 领取，不执行模型，也不另造 agent 调度器。

同一状态目录使用一份 SQLite 通信账本，记录 chains、messages、request 状态、delivery 回执和 runtime owner 信息。它是有上限的通信邮箱及去重账本；执行队列仍是原生 inbox。写事务只涵盖元数据准入和计数，不跨模型请求、工具调用、socket 等待或 session flush。

各 Host 通过现有 socket 将消息交给目标 owner；成功投递按目标准入顺序排列，不保证不同源的发送墙钟顺序。账本不轮询唤醒 session；未完成的准入只在同键重试、owner 恢复或已有运行时恢复处理时补投。

读取使用 WAL 快照，不获取 session 写锁；不宣称 SQLite 或整个系统在算法意义上 lock-free。保留现有事件分页语义。

消息投递状态为：

```text
accepted → admitted → consumed
    └──────────────→ cancelled / expired（未消费时）
```

- accepted：信封和预算预留已经持久化。defer 可长期停留在此。
- admitted：目标原生 inbox 或指定 turn 的输入中已有持久化记录。
- consumed：有持久化的 turn 输入记录证明消息进入上下文；不表示模型读懂、任务完成或工具副作用只执行一次。

queue/steer 的成功 ACK 继续等待原生 inbox 的 flush，兼容已有 accepted 回执的保证。defer 的 ACK 只要求通信账本持久化，明确返回 `delivery: deferred`、`wake: false`。如果准入后 Host 崩溃导致 ACK 丢失，重试同键查询原记录并完成未完成的投递。

SQLite 与原生 session 日志之间没有共同事务，因此使用稳定 messageId 和可重放的投递记录：先持久化意图，再写入原生 inbox 并 flush，最后确认 admitted。恢复时先检查原生日志是否已有该 messageId，再决定是否补投。保留 receipt 墓碑直至链终结且超过重试保留期，不能因删除消息而丢失去重证据。

defer 在 turn 输入收集前按收件序号冻结一个批次，稳定记录 batchId/turnId/messageIds，再注入带来源的 plugin 消息。冻结后到达的消息留给下一轮。只有确认原生 turn 输入持久化后才标 consumed；恢复时通过 turnId/messageId 核对，避免“先删除后崩溃丢留言”或正常恢复重复注入。超出单轮输入预算的留言按序保留，不截断正文；剩余 defer 不会单独触发下一轮。

当前安装版本已验证可用现有插件接口实现时机语义：在同步 `session/event` 的 `turn/start` 通知中冻结留言收件序号；在首步 `agent/pre-step` waterfall 中等待批次持久化，再将留言追加到返回的 `decision.messages`。后者发生在原生 inbox claim 之后，因此不能修改已经领取的原生输入；只追加独立邮箱冻结的留言。session observer 不可异步阻塞，也不可重入 append；它只记录 cutoff 或错误，缺少有效 cutoff 时由可等待的 pre-step 拒绝本次领取。

`agent.inject()` 等价于不主动 wake 的 nextStep 入队，正在运行的 driver 仍会在当前 turn 消费，不符合 defer。不能把留言预先放进原生任一 inbox：`hasPending` 会让现有 driver 继续运行。

每个 `(stateHome, sessionId)` 的 owner 必须唯一。当前安装的原生 JSONL persistence 已持有整个 write handle 生命周期的 OS 排他锁；本机 macOS 的两个真实 Host 争用测试已确认，因此本方案复用原锁，不新增第二套 owner 锁。通信投递记录仍需要 owner generation 来拒绝旧连接或旧投递工作的提交。不能仅凭心跳过期抢占仍存活的 owner。只有已成功取得原生写句柄的 Host 可以把通信账本消息投进该 session。

## 可观察性

发送回执包含 messageId、去重标记、delivery、实际是否请求唤醒及关联 request 状态。list/read 提供 pending queue/steer/defer 数量与分页消息状态；不把通信内容写进描述性名片。

TUI 显示来源 session、kind、mode 和正文，defer 显示“已留言，等待下一轮”。工具调用仍遵守现有隐藏历史 tool call 的展示策略；接收的消息作为可辨认的 relay 展示。用户可以查看留言、取消未消费请求，并看到链预算耗尽原因。

通信事件通过单独的 mailbox watch 游标订阅，不复用或修改现有 session event.seq；原生 inbox/消费事件继续通过现有 `watch` 展示。这样 deferred 在尚未进入 turn 时也可观察，而不会破坏现有事件分页及重连语义。

## 交付顺序与验收

1. 复用已确认的原生 owner 排他与 turn/pre-step 接入点；完成持久化邮箱、稳定消息身份及 crash 恢复协议。
2. 接入 queue/steer/defer，保留现有 CLI 回执、重试和标题行为。
3. 加入 request/reply/notify、链预算、祖先检查和跨 Host 原子准入，再开放 agent 工具；不得先开放无预算的自动通信。
4. 接入 TUI/读取接口与通信事件订阅，更新 CLI 和使用文档。

必须通过的行为测试：

- 空闲/运行 × 三种 mode；queue 批处理；steer 不取消工具；defer 在 turn 边界前后到达。
- defer 在 read、resume、长时间空闲时均不唤醒；下一次自然 turn 只领取一次；批次溢出保持有序。
- 多 Host 并发发送下无超预算；相同 session 双重加载只允许一个 owner。
- ACK 丢失、ledger 写后崩溃、inbox flush 后崩溃、消费确认前崩溃的去重与补投。
- A/B 相互 request、notify 回传、循环追问、defer 延迟回环、跨 resume 与子 agent 的链继承。
- 每个 request 仅一次最终 reply；达到发送上限后仍可返回预留回复；重复和晚到回复不反复唤醒。
- 多链合并、steer 新链加入、伪造来源/链 ID、模型通过改幂等键不能重置额度。
- 到期、取消、邮箱满、目标退出、慢订阅者不阻塞其他会话；消息来源不变成用户授权。

以确定性本地模型验证协议和调度，再用真实模型观察协作质量。协议能保证消息数和自动激活次数有界；单个 session 内部的过度思考、工具循环和总 token 消耗仍由其执行预算治理。

## 底层调查结果（当时安装的 0.1.5-rc.1，现已升到 0.1.5-rc.2）

核对的是 dscode 实际使用的 `node_modules` 产物，不以旁边 Harness 源码 checkout 代替运行版本。可重现命令：`node scripts/verify-runtime-foundations.mjs`。脚本只使用临时状态目录、真实 Harness/JSONL 后端和确定性本地模型，不调用网络模型。

**唯一写 owner：已具备。** `dsh-session-persistence-jsonl/lib/index.js` 的 `SessionWriteLease.acquire`（约 661 行）在 POSIX 使用 native `tryLockExclusive` 对 `session.lock` 取得非阻塞 flock；竞争映射成 `SessionAlreadyOwnedError`。`open(id, "write")`（约 2345 行）在返回句柄前取得锁；`dsh-agent-loop/lib/index.js` 的 `resumeWith`（约 1887 行）先取得此句柄，再准备和发布 Agent。新建 session 在首次物化写时取得锁，正常 Agent 发布路径会先持久化 seed。锁跟随写句柄关闭或进程死亡释放，不使用心跳过期接管；read 句柄不取该锁。

实测覆盖：新建但空闲的 Host A 已阻止 Host B resume；B 被拒绝后未发布 Agent，仍能 open/read；A 被 SIGKILL 后新 Host 成功 resume；正常 dispose 后再次 resume 成功。仅本机 macOS 已运行该测试，未验证其他平台或不启用 JSONL persistence 的组合。

**turn 输入时机：现有接口足够，需组合两个事件。** 当前顺序是 `turn/start → inbox.claim → systemPrompt.assemble → await agent/pre-step → step/start → prepareRequest → append user/message → model stream`。`turn/start` 是同步观察通知，`agent/pre-step` 是可等待且可改写 messages 的 waterfall。step 在每个 turn 从 1 开始，因此只在 step=1 追加被冻结的留言。

实测覆盖：pre-step Promise 未放行时模型调用数为零；turn/start 之前的留言进入该 turn，冻结后到达的留言即使在模型开始前到达也不进入该 turn；后续自然 turn 收到该留言；独立留言不唤醒空闲 Agent；负例 `inject` 在忙时进入同一 turn 的下一步；追加的留言最终通过原生 user/message 持久化。

**持久化仍有独立工作。** inbox.claim 先记录移除事件，user/message 在后续请求准备后才追加，中间有 await；观察到任一事件不等于磁盘 flush 已完成。不能在 pre-step 返回时就从邮箱删除留言，必须保留批次记录，等待原生 user/message 的稳定 messageId 和 flush 回执后确认消费。调查 fixture 的邮箱是内存样例，只验证调度接入点，没有宣称验证完整 defer 的 crash 恢复或模型副作用 exactly-once。实现时仍需完成前述持久化与故障注入测试。
