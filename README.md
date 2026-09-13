# ❄ DSCODE

**在终端里写代码，让脚本接入当前会话，让 agent 之间交接任务。**

![macOS 14+](https://img.shields.io/badge/macOS-14%2B-111827?logo=apple)
![Node.js](https://img.shields.io/badge/Node.js-22.19%2B%20%7C%2024%2B-43853D?logo=node.js&logoColor=white)
![DSH](https://img.shields.io/badge/DSH-0.1.5--rc.1-2563EB)
![License](https://img.shields.io/badge/license-MIT-green)
[![npm](https://img.shields.io/npm/v/@toddzheng024/dscode)](https://www.npmjs.com/package/@toddzheng024/dscode)

DSCODE 是基于 DeepSeek Harness 的终端编码 agent。持久 Shell 负责读写代码和执行测试；TUI、CLI 与脚本共用同一个会话运行时。0.3.0 加入本地密钥登录、横向 effort 选择条和固定底部输入区，并完善启动、会话并发与补丁工具。

[0.3.0 亮点](#-030-亮点) · [安装](#-安装) · [常用命令](#-常用命令) · [权限与配置](#-权限与配置) · [开发与发布](#-开发与发布)

## ✨ 0.3.0 亮点

新增 `/login` 本地密钥保存；effort 选择条支持 Ultra 光效。欢迎界面和屏内对话视口让输入区保持在底部，Chrome MCP 延后到创建 agent 会话时连接。修复子目录中的 `apply_patch`，并加强并发启动、版本切换锁和消息处理。以下协作与记忆能力继续保留。

### 一个 session，接入终端、脚本和外部工具

在 TUI 中开始任务后，可以从另一个终端补充要求、读取输出或订阅进展。不同来源的输入进入同一个运行时，共用上下文；读取和订阅不需要取得 session 写锁。

```sh
# TUI 保持打开，在另一个终端执行
# 先找到当前 session，再用实际 ID 替换下面的 SESSION_ID
dscode sessions
dscode send SESSION_ID --steer "补充：保持现有 API 兼容"
dscode watch SESSION_ID
```

外部消息进入会话后，TUI 会显示内容和来源。`watch` 订阅会话事件，不是逐 token 文本流。[多来源接入 →](docs/session-bridge.md)

### 把任务交给另一个 session，也可以只留一条便签

Agent 内置 `list_sessions`、`read_session`、`send_session` 和 `reply_session`，能查找目标会话、读取上下文、请求协作并返回结果。发送方式由任务决定：

| 投递方式 | 适合什么场景 | 行为 |
|---|---|---|
| `queue` | 交给对方下一轮处理 | 空闲时唤醒；忙碌时排队 |
| `steer` | 给当前任务补充信息 | 空闲时唤醒；忙碌时在下一个安全步骤加入 |
| `defer` | 留一条下次再看的便签 | 不唤醒，等下一轮自然开始时领取 |

持久化邮箱、重试去重、关联回复和有限通信预算，约束消息丢失、重复处理及互相唤醒的循环。当前通信面向同一状态目录中已加载的根 session；离线会话需要先恢复。[Session 通信 →](docs/session-communication.md)

### 看名片，就知道该找哪个会话

每个 session 提供**项目、工作区、最近 5 个用户请求 topic**。查找协作对象时，可以先按仓库、worktree 和近期话题定位。名片描述用户让它做过什么，不放任务结论或 agent 推测的完成状态。

项目从本地 Git 信息识别，topic 在达到输入阈值后后台更新，并保留原始用户消息引用。[会话名片 →](docs/session-cards.md)

### 换一个会话，仍能找到过去的经验

全局 memory 在后台从历史会话提取、整理可复用经验。新会话获得精简记忆，需要细节时再检索对应条目、工作区和来源消息；项目约定、用户修正和操作经验都有可追溯的出处。

同一状态目录默认共享记忆，支持按 session 或全局关闭。Memory 和 topic 提取会产生额外模型用量，分别提供用量记录；它们不会占用前台 agent 的执行轮次。[记忆与开关 →](docs/memory.md)

### 推理强度按任务分配，执行过程看得清

Ultra 使用 DeepSeek 原生 `max` 推理，并引导 agent 按任务需要决定调查、委派和验证的范围。父 agent 可以给每个子 agent 单独选择 effort：例如让边界清楚的测试任务用 `low`，复杂排查用 `high`，同时保留自己的 Ultra 设置。[持久 Shell 与 Ultra →](docs/dscode-ultra.md)

TUI 启动时清屏，顶部欢迎框显示 DSCODE、模型、effort、版本和项目路径，输入区固定在终端底部；长对话在屏内显示最近内容，完整会话可用 Ctrl+O 查看或 `/export` 导出。默认聚焦用户与 agent 的输出，隐藏 thinking 和工具调用历史；输入区上方显示当前工具、描述和本轮耗时。子 agent 概览区分 running / idle / done，`/agents` 可查看任务与当前活动。支持 `!` Shell、Shift+Enter 换行、中文输入光标定位，以及 `dscode resume` 接续会话。

界面示意：

```text
  DSCODE · my-project / main
  会话消息投递

  已完成队列投递，正在验证中断后的恢复行为。

  ⠋ 正在执行 · shell · 验证会话恢复 · 本轮 24s
  agents 1 running · 1 idle · /agents

  › 接下来把取消行为也检查一下

  deepseek-flash · ultra                         auto
                              ctx 43% · ~$0.0030
```

底栏展示上下文占用、session 费用估算与缓存命中率，窄窗口自动精简。费用包含已记录的子 agent、压缩和 auto 审核调用；后台 memory 与 topic 提取另行统计。[统计口径 →](docs/session-metrics.md)

### 编码所需的基础能力也已配好

| 能力 | 说明 |
|---|---|
| 持久 Shell | 同一 agent 的 Bash 保留 cwd、环境和后台任务，支持读写文件、搜索、应用补丁与测试 |
| Auto 权限 | 普通操作按本地策略执行；适用的审批请求交给独立模型审核，支持切换人工审批 |
| 浏览器与桌面 | Chrome DevTools MCP 与 macOS 原生 Computer Use，按需使用 |
| 长任务 | 项目指令、skills、plan、goal、hooks、上下文压缩与会话恢复 |
| 安装与升级 | npm 一条命令安装；固定推荐 Harness 组合，版本偏离只提示 warning；支持 profile 升级与回退 |

## 🚀 安装

需要 **macOS 14+、Node 22.19+（22.x）或 24+、npm、Git 和 Google Chrome**。

### npm + Plugin Hub

> **v0.3.0 已发布。** [npm 启动器](https://www.npmjs.com/package/@toddzheng024/dscode) · [Hub preset](https://dshpluginhub.ai/profiles/dscode) · [GitHub Releases](https://github.com/qiz029/dscode/releases)

```sh
npm install -g @toddzheng024/dscode
cd /path/to/project
dscode
```

如果 npm 包名查询暂时返回 404，可直接安装同一版本的官方 registry tarball：

```sh
npm install -g https://registry.npmjs.org/@toddzheng024/dscode/-/dscode-0.3.0.tgz
dscode
```

首次启动会从 [DSH Plugin Hub](https://dshpluginhub.ai) 安装固定版本的完整 preset；之后直接打开 TUI。无需手动拼装插件，也不需要全局安装 pnpm。

npm 启动器会检查已安装 bundle 和 Harness 依赖的推荐版本组合。版本不匹配或无法核实时，只在启动时集中显示一次 warning，并继续运行，不要求确认，也不会自动降级或修改依赖。源码构建时的补丁匹配检查仍会在补丁无法安全应用时停止构建。

第一次进入后，输入 `/login`，在隐藏输入框中粘贴 DeepSeek API key，按 Enter 保存。密钥保存在本机 `~/.dscode/credentials.yaml`，当前会话立即可用，以后启动自动加载，不同项目和安装版本共用。输入不会进入聊天记录，也不会发送给 agent。按 Esc 取消。

密钥文件以明文保存在本地，文件权限为 `0600`，新建目录权限为 `0700`。已设置的 `DEEPSEEK_API_KEY` 环境变量优先；若要改用 `/login`，先移除 shell 或启动器 `.env` 中的该变量并重启。旧版 profile 中保存的凭据仍可读取，直到你通过 `/login` 保存新的 key。

用 `/model` 选择模型或配置其他提供方，用 `/effort` 调整推理强度。effort 选择器会替代底部输入框；支持四档的模型显示 `low → high → max → ultra` 横向 bar，方向键移动、Enter 应用、Esc 取消，`o` 可切到 off。光标移到 ultra 时，蓝色光效会从中央向两侧展开；按 Enter 后，输入框也会播放短暂的中央扩散涟漪。默认路由是 `deepseek-official/deepseek-flash`。Computer Use 的辅助功能和录屏权限需在 macOS 中单独授予。

```sh
dscode --continue                     # 继续上次会话
dscode --resume SESSION_ID            # 恢复指定会话
dscode --cwd /another/project         # 在指定目录工作

dscode update 0.3.0                   # 升级到 0.3.0
dscode history                        # 查看保留的版本记录
dscode rollback                       # 回到上个 preset 版本
dscode doctor                         # 检查 Hub 安装状态
```

从旧版本升级时，先更新启动器，再更新已安装的 profile：

```sh
npm install -g @toddzheng024/dscode@0.3.0
dscode update 0.3.0
```

源码/tar 安装与 npm/Hub 使用不同的数据目录。升级不会自动迁移它们之间的会话和凭据。[0.3.0 更新说明](docs/releases/0.3.0.md)

### 从源码运行（现在可用）

克隆本仓库并安装锁定依赖：

```sh
git clone https://github.com/qiz029/dscode.git
cd dscode
npm ci --ignore-scripts
npm run setup
npm start

# 操作另一个项目
npm start -- --cwd /path/to/project
```

首次使用同样通过 `/login` 保存 DeepSeek API key。也可复制 `.env.example` 为 `.env`，仅在本机填写密钥；此方式会优先于 `/login` 保存的凭据。

### tar 包安装（现在可用）

从 [GitHub Releases](https://github.com/qiz029/dscode/releases/latest) 下载 `dscode-0.3.0.tar.gz`，然后执行：

```sh
mkdir dscode-install
tar -xzf dscode-0.3.0.tar.gz -C dscode-install
sh dscode-install/install.sh
cd /path/to/project
dscode
```

默认命令位于 `~/.local/bin/dscode`，请确保该目录在 PATH 中。tar 安装器不会覆盖已有命令或安装。它与 npm/Hub 安装的管理命令不同，详情见 [tar 分发说明](docs/distribution.md)。

## ⌨️ 常用命令

| 命令 | 作用 |
|---|---|
| `/login` | 在隐藏输入框粘贴 DeepSeek API key，保存到 `~/.dscode/`，启动自动加载 |
| `/model`、`/effort` | 选择模型、配置其他凭据；支持四档的模型用横向 bar 调整 effort |
| `/mode` | 选择 Agent Preset；新会话默认 `dscode` |
| `/status`、`/doctor` | 会话状态与运行时诊断 |
| `/memories` | 全局记忆状态、后台用量、开关与清理 |
| `/session` | 当前 session ID、名片与外部接入入口 |
| `/permission auto`、`/permission ask` | 切换自动审核或人工审批 |
| `/review-usage` | 查看自动审核的额外 token 与耗时 |
| `/shell`、`/shell reset` | 检查或重置持久终端 |
| `/mcp`、`/skills`、`/hooks` | 管理 MCP、检查 skill 来源、查看或重载 hooks |
| `/plan`、`/goal` | 计划与持续任务 |
| `/agents` | 查看子 agent 的任务、状态与当前活动 |
| `/mailbox` | 查看 session 消息和 deferred 便签 |
| `/compact` | 压缩历史上下文 |
| `/diff`、`/review` | 查看和审查代码修改 |
| `/clear` | 开始新的空上下文会话，旧会话仍可恢复 |
| `/resume`、`/fork` | 恢复或分叉会话 |

`Shift+Enter` 换行，`!命令` 运行本地 Shell 命令，`Ctrl+L` 只清屏，`Esc` 中断当前操作。退出后用 `dscode resume [SESSION_ID]` 恢复会话。完整命令以 TUI `/help` 为准。[命令与 hooks 说明 →](docs/tui-commands.md)

## 🔧 权限与配置

默认使用 `workspace-write` sandbox 和 **Auto** 权限审核。Ultra 不增加权限；独立审核只处理适用的审批请求，Computer Use 保留人工授权。[Auto 的范围、成本与限制 →](docs/auto-review.md)

| 安装方式 | 会话、凭据与统计 | 本地配置 |
|---|---|---|
| npm / Hub | `~/.local/share/dscode-hub`，可用 `DSCODE_HOME` 覆盖 | 数据目录的 `.env` 和 `config/` |
| 源码 | 仓库 `.runtime/` | 仓库 `.env` 和 `config/` |
| tar | 安装目录 `.runtime/` | 安装目录 `.env` 和 `config/` |

支持 `config/hooks.local.json`、`config/mcp.local.yml`、`config/harness.local.yml`。这些本地配置、密钥与会话不会打入发布包。Hub 升级/回退替换 profile，保留独立状态目录；不自动迁入旧源码或 tar 安装的凭据。

Skills 会发现目标项目的 `.agents/skills`、`.dsh/skills`，以及隔离的用户 skill 目录。使用 `/skills conflicts` 排查同名覆盖。

Chrome 随 `dscode` agent preset 初始化：空白启动先显示输入框，首次创建会话时连接 MCP 并等待工具注册；带初始消息或恢复会话的启动仍需完成这一步。Chrome 使用独立临时 profile，不接管日常浏览器登录态。桌面工具通过 skill 渐进加载；截图理解需要支持图片的模型。当前 MCP bridge 提供 tools，不提供 resources/prompts。[持久 Shell 与 Ultra →](docs/dscode-ultra.md)

## 🧩 开发与发布

```sh
npm test                              # 单元与契约测试（隔离上游依赖）
npm run check                         # 覆盖率、集成、TUI 与打包检查
npm run doctor                        # 本地确定性 agent 集成检查
npm run config                        # 查看组合后的配置（请勿分享含密钥的输出）

npm run build:packages                # 构建 launcher 与完整 bundle 的 npm tgz
npm run release:hub                   # 构建 Hub release 和 .dshprofile
npm run verify:hub                    # 临时安装、agent 检查、失败升级与回退
npm run dist                          # 构建备用 tar 安装包
```

| 分发组件 | 内容 |
|---|---|
| `@toddzheng024/dscode` | `dscode` 命令、首次安装引导、Hub 版本管理 |
| `@toddzheng024/dscode-bundle` | 基础层、Computer Use、自定义插件与修改后的 TUI/runtime |
| Hub profile `dscode` | 固定 bundle/runtime 版本与完整性哈希 |

Bundle 在构建阶段生成修改后的模块，不在使用者机器上改第三方源码。DSH 依赖统一固定到 `0.1.5-rc.1`；TUI 基于 `dsh-code@1.0.6`，Chrome MCP 为 `1.9.0`，Computer Use 为 `0.3.2`。

日常检查使用 `npm run check`；单独运行可用 `test:unit`、`test:integration`、`test:ui`、`test:package`、`test:coverage`、`test:eval`。覆盖率把未加载的项目源码计为零，并设置 75% 行覆盖率门槛。测试不会修改开发环境的 `node_modules`，集成和 UI 验证使用临时 checkout。首次准备原始上游测试包时，优先读取 npm 缓存，缓存缺失才下载锁文件指定的 tarball。

上下文压缩评测入口是 `npm run eval:compaction`，默认离线运行；样本、策略、评分器、测试和报告均放在 [`eval/`](eval/README.md)。真实模型评测显式使用 `--backend deepseek`。

完整流程见 **[npm + Hub 分发指南](docs/hub-distribution.md)**。先发布 bundle，再上线 Hub release，最后发布 launcher。`artifacts/npm/` 是完整分发产物；旧 `npm run release` 只保留基础配置导出，不能替代完整 bundle。

本地集成验证使用确定性模型；公开 npm/Hub 安装与真实 TUI 启动另行验证。真实远程模型、浏览器操作或桌面操作不属于这轮发布测试的验收范围。[验证说明 →](docs/verification.md)

---

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)、[DSH-Code](https://github.com/unlinearity/dsh-code)、[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) 与 [DSH Plugin Hub](https://dshpluginhub.ai)。独立社区项目，非 DeepSeek 官方产品。
