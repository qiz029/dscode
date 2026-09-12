# DSCODE 全局记忆

DSCODE 0.2.0 新增全局跨 session memory。

记忆跨项目、跨会话保存，同一个 DSCODE 状态目录下共享。工作区路径和来源会话会保留；项目经验不能自动推广到其他项目。它与 resume（恢复完整会话）、compaction（压缩当前上下文）和项目指令文件分别工作。

## 使用

默认开启读取和后台生成。新根会话第一次产生模型请求配置时调度历史整理，此后每 30 分钟尝试一次；不会等待整理完成再回复用户。退出进程会取消后台任务，下次运行继续处理。初次使用没有历史记忆属于正常情况。

| 命令 | 行为 |
|---|---|
| `/memories` 或 `/memories status` | 路径、开关、后台状态、条目数、记忆模型调用与 token 用量 |
| `/memories off` / `on` | 禁用 / 启用当前会话读取和后续贡献；会话恢复后仍然有效 |
| `/memories global-off` / `global-on` | 持久化关闭 / 开启全局读取与生成；配置文件中的禁用仍然优先 |
| `/memories run` | 立即调度一次后台整理，仍遵守闲置、数量和年龄限制 |
| `/memories note 使用中文回答` | 添加明确的偏好或修正，交给下一次整理；仅添加文本，不执行内容 |
| `/memories clear` | 清空全局生成结果和输入记忆；清空之前创建的会话不再用于重新生成 |

`off` 不会抹除以前已经整合的经验；需要删除所有旧记忆时使用 `clear`。切换开关也不会删除当前对话中已经出现的内容，完全隔离需要新会话。`/clear` 仍是清理对话，不等于清理全局记忆。

模型只会自动获得不超过 6000 字符的摘要。需要历史经验时，使用 `memory_search` 查找条目、流程及源会话摘要；返回会话 ID、工作区和原始消息序号。简单任务跳过检索。记忆不是当前代码状态的证明。

## 两阶段实现

1. 从已有 `sessionPersistence` 服务读取历史 JSONL。跳过子 agent、非 dscode 会话、活跃会话、已关闭贡献的会话以及过大日志。只提取用户原始消息和 assistant 可见文本，不读取 thinking、工具载荷和注入的系统信息。
2. 独立模型请求提取 `raw_memory`、`rollout_summary` 和证据消息序号。校验 JSON、字段长度和来源范围，对输入输出中的常见秘密格式脱敏。没有有效经验可以返回空结果。失败记录指数退避；成功记录对应的源版本。
3. 按使用次数与新近程度筛选保留经验，加入用户显式 notes，交给第二次独立模型请求合并条目和可复用流程。没有输入变化就跳过模型调用。
4. 校验输出引用的来源 ID 后发布 SQLite 快照，并生成可阅读的 Markdown 文件。检索和摘要以数据库快照为准；文件生成中断可在下次整理修复。

SQLite 租约协调多进程，后台持有心跳；恢复中的源会话、失效租约和清空操作会阻止旧结果提交。模型整理没有 shell、MCP、文件写入或委派工具，文件路径由插件确定。

目录解析优先级：插件 `root` → `DSCODE_MEMORY_HOME` → `$DSCODE_HOME/memories` → `$DSH_HOME/memories` → `~/.local/share/dscode-hub/memories`。源码启动通常使用项目 `.runtime/memories`，npm 启动使用启动器状态目录。不同安装要共享时，可显式设置同一个 `DSCODE_MEMORY_HOME`。

```text
memories/
  state.sqlite             # 作业版本、租约、开关、notes、权威快照和用量
  memory_summary.md        # 精简摘要
  MEMORY.md                # 经验手册及来源
  raw_memories.md           # 当前保留的逐会话提取结果
  rollout_summaries/*.md    # 会话摘要，含消息序号
  skills/*/SKILL.md         # 整理出的可复用流程，按需检索
```

这些 Markdown 文件是生成产物，手动改动会被覆盖；修正通过 `/memories note` 提交。生成流程会以文本返回给 agent，不会自动安装成具有执行权限的 skill。

## 配置和成本

源码安装在 `config/harness.local.yml` 覆盖已有插件配置；发布包可通过 DSH profile overlay 覆盖同一 entry ID：

```yaml
- id: dscode-memory
  config:
    generate: true
    use: true
    minIdleHours: 6
    maxAgeDays: 30
    maxPerRun: 16
    maxCandidates: 32
    maxUnusedDays: 30
    extractEffort: low
    consolidationEffort: high
    timeoutMs: 90000
    # 可选，必须同时填写；否则使用触发会话的 provider/model。
    # provider: deepseek-official
    # model: deepseek-flash
```

提取和整理的 effort 独立设置，均不继承 ultra。每次最多 16 个逐会话请求和 1 个整理请求，顺序执行；输入输出均受长度约束，单次模型请求默认限时 90 秒。后台模型会产生额外 API 用量，在 `/memories` 单独统计，不计入某一个前台 session 的费用。没有可用的 provider、未支持所配 effort 或网络失败时，不影响前台；后台会保留失败状态并重试。

这是借鉴 Codex 两阶段架构的 DSCODE 实现，并非逐行移植：使用输入指纹替代 Git diff，以无工具结构化模型请求替代可编辑目录的整理 agent。目前没有 Codex 的 provider 剩余额度门槛，脱敏也仅覆盖常见秘密格式；传给模型的是经过筛选的历史会话内容。可以全局关闭生成，保留读取已有记忆。

## 验证

```sh
node --test tests/memory.test.mjs
node scripts/verify-memory.mjs
```

第一条覆盖来源过滤、证据校验、租约、退避、清空竞争和读取开关。第二条在临时 profile 中加载真实 Harness，使用真实 JSONL 存储与本地确定性 LLM adapter，验证完整两阶段流程及提示词注入。它不访问远程模型，不是对真实模型提取质量或账单的验收。
