# 同一个 session，多来源接入

DSCODE 0.2.0 支持。运行中的 dscode Host 持有唯一的 Agent/session；其他终端和脚本通过 Unix socket 接入它。客户端不会启动新的 Harness、恢复会话或者打开 session 写句柄。

已增加内置 agent 通信工具、`defer` 留言、持久化邮箱和防循环预算，详见[Session 间通信](session-communication.md)。下文的 read/watch 游标仍属于原生 session 日志；邮箱使用独立游标。

## 使用

先启动或恢复 TUI。在 TUI 内用 `/session` 查看完整 session ID 和 socket 地址。其他终端：

```sh
dscode sessions
dscode send SESSION_ID --source script "先检查测试失败原因"
dscode send SESSION_ID --source ci --title "修复构建失败" "检查这次构建日志"
dscode send SESSION_ID --source editor --steer "补充：只修改 parser 模块"
dscode read SESSION_ID
dscode watch SESSION_ID
```

`send` 默认投递下一轮；`--steer` 投递下一步，不强行打断正在运行的模型请求或工具。来源名称允许中英文、数字及 `_.:@/-`，最长 64 字符。消息正文最多 64000 字节。以 `-` 开头的正文放在 `--` 后面。

`--title` 显式设置当前 session 的标题，使用原生标题服务持久化并通知 TUI；后续自动命名不会覆盖它。标题会清理控制字符、合并空白，并按原生配置截短（默认最多 80 UTF-8 字节）。空白标题拒绝发送；省略此选项不改标题，也不额外调用模型。`sessions`、`read` 和发送响应都包含当前 `title`，未命名时为 `null`。

外部消息在 TUI 中显示完整正文和 `[External source: ...]` 标签，也会进入原生待处理消息队列。日志仍将其标记为 plugin relay，不冒充本地用户输入或权限批准。来源标签用于辨认，不是身份认证；同一 OS 用户下能访问 socket 的进程具有会话接入权限。

`sessions` 只列当前状态目录下正在运行的根会话。完整 ID 或唯一前缀都可使用；多 Host 命中相同 ID 时拒绝发送。已退出的会话必须先在 TUI 中恢复。子 agent 不开放直接写入口。

`sessions` 和 `read` 还返回描述性的 `card`（项目、工作区、最近用户请求 topic）与独立的 `cardState` 更新状态。TUI `/session` 也可查看。名片不包含结论；详见[会话名片](session-cards.md)。

源码入口默认查找项目 `.runtime`；npm 启动器默认使用 `$DSCODE_HOME` 或 `~/.local/share/dscode-hub`。所有客户端命令都支持 `--home /absolute/state/directory`，用于连接其他安装或临时 profile。

## 写入与重试

消息通过原生 `Agent.followup()` / `Agent.steer()` 进入 inbox，模型和工具仍由原生单个 driver 调度。校验、去重和 inbox 提交之间没有异步间隙；耗时模型请求不持有写锁。TUI 输入和外部输入共享同一个 inbox。

```sh
dscode send SESSION_ID --source ci --request-id build-123 "构建失败，请检查"
```

响应 `accepted: true` 表示消息通过了原生 session 的持久化 flush 屏障，不表示任务已经完成。客户端在提交前将 request ID 打到 stderr；丢失响应时，用相同 ID、source、mode 和正文重试。重复请求返回 `duplicate: true`，不会再投递；同一个 ID 换了内容则报错。

指定 `--title` 后，标题也属于请求身份，重试时必须保持一致。重复请求不会把后来修改的标题改回旧值。

去重凭证来自持久化 inbox 事件，因此正常退出、恢复后仍有效。取消或删除队列消息不会抹除“已接收”的事实；确实要重新发送时使用新 ID。

这是消息接收去重，不是工具副作用的 exactly-once 保证。来源同时发送时，以 Host 实际完成 inbox 提交的顺序为准，不保证不同进程的墙钟发送顺序。

## 不争用写锁的读取

`read` 返回 JSON：不可变事件页、当前状态、inbox、页尾 `cursor` 和快照时的日志尾 `head`。`cursor < head` 时继续分页：

```sh
dscode read SESSION_ID --after 123 --limit 100
```

`--after` 表示已经收到的最后一个事件序号，默认 `-1`；`--limit` 默认 100、最大 500。下一页使用上一页的 `cursor`，不要用 `head` 跳过尚未读取的事件。

`watch` 输出 NDJSON：先 `ready`，再补发 `after` 之后的历史事件，发送 `caught-up`，随后持续发送新事件。注册订阅和获取快照在同一个同步边界完成，重叠事件按序号去重。退出会话会发出 `closed`；意外断线会报错，可手动用最后一个收到的 `event.seq` 重连：

```sh
dscode watch SESSION_ID --after 123
```

这里订阅的是持久化模型中的事件流：消息、inbox、工具和状态事件。它不传输尚未提交的逐 token assistant chunk。一个事件可先被实时观察到，再达到磁盘持久化屏障；跨崩溃的游标超出恢复日志时会明确报错，需重新读取基线。读取不获取 session 写锁，但仍有序列化和磁盘 flush 成本，不宣称严格的 lock-free 算法。

慢订阅者超过 8 MiB 发送缓冲会断开，不会阻塞 agent 写入；客户端应按最后收到的序号补读。单个响应/事件过大也会断开，因此这条接口不适合传输大文件，文件应通过路径引用。

## 本地协议与实现

Host 在按状态目录哈希隔离的 `/tmp/dscode-UID-HASH/` 下建立自己的 socket。目录权限 0700，socket 权限 0600，不监听 TCP。socket 路径足够短以兼容 macOS。每条连接接受一条以换行结尾的 JSON 请求：

```json
{"method":"send","sessionId":"...","source":"editor","requestId":"edit-123","mode":"queue","text":"检查修改"}
```

方法为 `list`、`send`、`read`、`watch`。普通响应为 `{"result":...}`，失败为 `{"error":"..."}`。`watch` 返回上述事件帧。Host 关闭时释放 socket；崩溃残留的拒绝连接 socket 会被发现客户端忽略。

实现复用原生 Agent inbox、Session 快照、事件通知和 persistence flush。没有引入第二套任务队列，也没有挂载 Web Session Controller 的媒体上传、网页 Gateway 和其他依赖。后续 ACP 可以适配同一个入口。

验证：`node --test tests/session-bridge.test.mjs`；`node scripts/verify-session-bridge.mjs` 使用真实 Harness 和本地确定性模型，验证两个客户端进程、忙时 queue/steer、读取、持久化去重和恢复。测试需要允许本地 Unix socket listen。
