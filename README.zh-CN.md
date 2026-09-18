<div align="center">

<img src="assets/banner.svg" alt="DSCODE" width="880">

# ❄ DSCODE

**在终端里写代码，让脚本接入当前会话，让 agent 之间交接任务。**

![macOS 14+](https://img.shields.io/badge/macOS-14%2B-111827?logo=apple&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-22.19%2B%20%7C%2024%2B-43853D?logo=node.js&logoColor=white)
![DSH](https://img.shields.io/badge/DSH-0.1.5--rc.1-2563EB)
![License](https://img.shields.io/badge/license-MIT-green)
[![npm](https://img.shields.io/npm/v/@toddzheng024/dscode)](https://www.npmjs.com/package/@toddzheng024/dscode)
[![Release](https://img.shields.io/github/v/release/qiz029/dscode?color=111827&label=release)](https://github.com/qiz029/dscode/releases)
[![Stars](https://img.shields.io/github/stars/qiz029/dscode?color=111827)](https://github.com/qiz029/dscode/stargazers)

[English](README.md) · [简体中文](README.zh-CN.md)

[核心能力](#-核心能力) · [最新变化](#-最新变化) · [快速开始](#-快速开始) · [常用命令](#-常用命令) · [更新日志](docs/CHANGELOG.md) · [文档](#-文档)

</div>

DSCODE 是基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 macOS 终端编码 agent。持久 Shell 负责读写代码和执行测试；TUI、CLI 与脚本共用同一个会话运行时，而不是各自启动一套。它以固定版本的可复现 harness 安装——DSH 依赖、TUI 与插件一起打包、一起校验。

## 🧭 核心能力

| 能力 | 说明 |
|---|---|
| **[编码循环](docs/dscode-ultra.md)** | 持久 Shell 保留 cwd、环境和后台任务，可读写文件、搜索、应用补丁并运行测试。项目指令、skills、plan、goal 与 hooks 已接入。 |
| **[会话接入](docs/session-bridge.md)** | 在 TUI 开始任务后，可从另一个终端补充要求、读取输出或订阅进展（`dscode sessions`、`send`、`read`、`watch`）。所有来源进入同一个运行时和上下文，读取和订阅不需要取得 session 写锁。 |
| **[Agent 间任务](docs/session-communication.md)** | Agent 通过 `list_sessions`、`read_session`、`send_session` 与 `reply_session` 查找、读取并联系其他会话，投递方式可选 `queue`、`steer` 或 `defer`。持久化邮箱、重试去重和有限预算约束消息丢失、重复处理和互相唤醒。 |
| **[会话名片](docs/session-cards.md)** | 每个 session 展示项目、工作区与最近 5 条用户请求 topic，选协作对象时不必先读它的记录。名片描述用户让它做过什么，不放任务结论。 |
| **[跨会话记忆](docs/memory.md)** | 后台提取可复用经验，检索时一并给出工作区和来源消息。支持按 session 或全局关闭，后台模型用量单独统计。 |
| **[推理强度与子 agent](docs/dscode-ultra.md)** | Ultra 使用模型的 `max` 推理，自行决定调查、委派和验证的范围；低于 Ultra 时也能委派，但只在任务确实需要时才用。父 agent 可为每个子 agent 单独选择 effort，需要编辑的子 agent 可从干净的 `HEAD` 建立隔离 Git worktree。 |
| **[独立审查](docs/tui-commands.md)** | 代码改动通过相关检查后，agent 会把 Git diff（非 Git 工作区则是相对任务开始时快照的改动）交给独立的只读模型审查，先修复具体发现再结束本轮。`/review` 可手动触发，范围可选暂存区、基准分支、单次提交或路径。 |
| **[非交互执行](docs/exec.md)** | `dscode exec "prompt"`，或 `git diff \| dscode exec "review this"`，在脚本和 CI 中跑完整一轮：回复流式输出到 stdout，工具活动和 session id 到 stderr，退出码反映轮次结果，支持 `--json` 与 `--resume`。 |
| **[终端体验](docs/session-metrics.md)** | 六种界面语言、可选中复制、向上滚动历史、verbose 思考与工具调用视图、固定在底部的输入区、子 agent 概览，以及底栏 TPS / context / 费用 / 缓存指标。 |
| **[权限护栏](docs/auto-review.md)** | 默认 `workspace-write` sandbox 与独立模型 Auto 审核，可切回人工审批。Ultra 不增加权限，Computer Use 保留人工授权。 |
| **[Agent 邮件](docs/email.md)** | 所有 session 共用的本地 `[ToAgent]` 收件箱：Enter 把邮件作为用户选择的上下文 steer 进当前会话；配置 Gmail 后 agent 可走同一审批流程发信。 |

## 🆕 最新变化

**0.7.11** — 内置 TUI 升级到 `dsh-code` 1.2.0，25 个 DSCODE 补丁全部重新对齐，运行时固定 DSH `0.1.5-rc.2`。`dscode update` 一条命令升级整个安装，更新提示支持七种语言，`/model` 只列当前 provider 并按字母序，代码审查预算更宽裕且默认使用最低推理档。

每次发布的完整记录见 **[更新日志](docs/CHANGELOG.md)**，更详细的说明见 [0.7.11 更新说明](docs/releases/0.7.11.md)。

## 🚀 快速开始

需要 **macOS 14+、Node 22.19+（22.x）或 24+、npm、Git 和 Google Chrome**。

```sh
npm install -g @toddzheng024/dscode
cd /path/to/project
dscode
```

其余安装方式安装的是同一套固定版本：

| 方式 | 做法 |
|---|---|
| npm / Hub | 上面的命令；launcher 会从 [DSH Plugin Hub](https://dshpluginhub.ai) 安装固定版本的 profile |
| GitHub release，一行命令 | `curl -fsSL https://raw.githubusercontent.com/qiz029/dscode/main/install.sh \| sh` |
| release tar 包 | 从 [Releases](https://github.com/qiz029/dscode/releases) 下载 `dscode-<version>.tar.gz`，解包后执行 `sh dscode-install/install.sh` |
| 源码 checkout | `git clone https://github.com/qiz029/dscode.git && cd dscode && npm ci --ignore-scripts && npm run setup` |

一行安装器会解析最新 release、校验 GitHub 为其 tarball 公布的 sha256 摘要，然后执行该 tar 包自带的安装流程；`sh -s -- <版本号>` 可固定精确版本而不跟随最新版。所有方式都需要 Node、npm 和 Git——tar 包用 `npm ci` 安装自己的 lockfile，npm 方式则从 Hub 安装固定版本的 profile。

首次启动会从 [DSH Plugin Hub](https://dshpluginhub.ai) 安装固定版本的完整 preset——无需手动拼装插件，也不需要全局安装 pnpm。之后输入 `/login`，在隐藏输入框中粘贴 DeepSeek API key：密钥以 `0600` 权限保存在本机 `~/.dscode/credentials.yaml`，不同项目和安装版本共用，不会发送给 agent。已设置的 `DEEPSEEK_API_KEY` 环境变量优先。想使用 OpenRouter，输入 `/provider openrouter`：DSCODE 会提示输入 OpenRouter key（同样保存在本机，或读取 `OPENROUTER_API_KEY`），并把当前会话切到对应的 DeepSeek 模型；OpenRouter 实时模型列表里支持工具调用的模型随后都会出现在 `/model` 中，直接输入即可搜索。DeepSeek、GLM、Kimi 和 Qwen 经过适配和测试，其他模型尽力可用。`/provider deepseek` 切回，`/login openrouter` 可更换 key。用 `/model` 选择模型或配置其他提供方，用 `/effort` 调整推理强度；默认路由是 `deepseek-official/deepseek-flash`。 TUI 启动时会检查 npm 上的新版本，`/update` 可在退出后自动完成整个安装的升级。

**默认英文，界面支持 6 种语言。** `/language` 打开选择器，`/language ja` 可直接切换；也可以直接写「中文」「日本語」「한국어」。支持 English、简体中文、繁體中文、日本語、한국어、Español。选择按机器保存在 `~/.dsh/dsh-code/language.json`，`DSCODE_LANGUAGE=es` 可覆盖单次运行。

```sh
dscode --continue                 # 继续上次会话
dscode --resume SESSION_ID        # 恢复指定会话
dscode --cwd /another/project     # 在指定目录工作
dscode doctor                     # 分析近期运行日志和 session trace
dscode --version                  # 输出 DSCODE 版本
```

npm 启动器会核对已安装 bundle 与 Harness 依赖的推荐版本组合；版本不一致时集中显示一次 warning 并继续运行，不会修改依赖，也不会自动降级。浏览器与桌面工具按需授权：Chrome 使用独立临时 profile，不接管日常浏览器登录态；桌面工具通过 skill 渐进加载，截图理解需要支持图片的模型；当前 MCP bridge 提供 tools，不提供 resources/prompts；Computer Use 的辅助功能和录屏权限需在 macOS 中单独授予。

<details>
<summary><b>其他安装方式、升级与回退</b></summary>

**从源码运行**

```sh
git clone https://github.com/qiz029/dscode.git
cd dscode
npm ci --ignore-scripts
npm run setup
npm start

# 操作另一个项目
npm start -- --cwd /path/to/project
```

也可复制 `.env.example` 为 `.env`，仅在本机填写密钥；此方式会优先于 `/login` 保存的凭据。

**一行安装** —— 安装器直接来自仓库并自行获取 release；在 `--` 之后给出精确版本号即可固定版本，而不是跟随最新版：

```sh
curl -fsSL https://raw.githubusercontent.com/qiz029/dscode/main/install.sh | sh
curl -fsSL https://raw.githubusercontent.com/qiz029/dscode/main/install.sh | sh -s -- 0.7.14
```

**tar 包安装** —— 从 [GitHub Releases](https://github.com/qiz029/dscode/releases/latest) 下载 `dscode-0.7.11.tar.gz`，然后执行：

```sh
mkdir dscode-install
tar -xzf dscode-0.7.11.tar.gz -C dscode-install
sh dscode-install/install.sh
```

默认命令位于 `~/.local/bin/dscode`，请确保该目录在 PATH 中。安装器不会覆盖已有命令或安装。

**若 npm 包名查询暂时返回 404**，可直接安装同一版本的官方 registry tarball：

```sh
npm install -g https://registry.npmjs.org/@toddzheng024/dscode/-/dscode-0.7.11.tgz
```

**升级** —— `dscode update [精确版本号]` 一步完成整个安装的更新，且要求没有正在运行的 DSCODE 会话。npm/Hub 安装会先用 npm 替换 launcher 本体，再把已安装的 profile 升到同一版本；tar 安装会下载 release tar 包、按发布方 sha256 校验、原位换目录并迁移 `.runtime`、`.env` 和本地 `config/`，旧安装保留为同级备份目录。源码检出同样一条命令更新：先对它跟踪的分支执行 `git pull --ff-only`，再跑 `npm ci --ignore-scripts` 和 `npm run setup`；工作区中有未提交的改动时会先拒绝，避免更新只做一半。

```sh
dscode update                  # 最新版本
dscode update 0.7.11           # 指定版本
```

`dscode history` 查看保留的版本记录，`dscode rollback` 回到上个 preset 版本（npm/Hub 安装）。带 `dscode update` 之前的旧 tar 安装，请把新 tar 包装到新目录并手动迁移一次状态。源码、tar 与 npm/Hub 使用不同的数据目录，会话和凭据不会互相迁移。详见 [tar 分发说明](docs/distribution.md) 与 [npm + Hub 分发指南](docs/hub-distribution.md)。

</details>

## ⌨️ 常用命令

| 命令 | 作用 |
|---|---|
| `/login` | 在隐藏输入框粘贴 DeepSeek API key，保存到 `~/.dscode/`，启动自动加载 |
| `/model`、`/effort` | 选择模型（直接输入即可搜索）、配置其他凭据；支持四档的模型用横向 bar 调整 effort |
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
| `/email` | `i` 配置 IMAP 邮箱与应用密码；浏览 `[ToAgent]` 邮件，Enter 直接 steer 进当前 session |
| `/compact` | 压缩历史上下文 |
| `/diff`、`/review` | 查看代码修改；`/review` 用独立、只读模型请求审查 Git diff |
| `/clear` | 开始新的空上下文会话，旧会话仍可恢复 |
| `/resume`、`/fork` | 恢复或分叉会话 |

`Shift+Enter` 换行，`!命令` 运行本地 Shell 命令，`Ctrl+L` 只清屏，`Esc` 中断当前操作。完整命令以 TUI `/help` 为准，[命令与 hooks 说明](docs/tui-commands.md) 覆盖其余部分。

## 🔧 权限与配置

默认使用 `workspace-write` sandbox 和 **Auto** 权限审核，适用的审批请求交给独立模型；`/permission ask` 切回人工审批。Ultra 不增加权限。[Auto 的范围、成本与限制 →](docs/auto-review.md)

| 安装方式 | 会话、凭据与统计 | 本地配置 |
|---|---|---|
| npm / Hub | `~/.local/share/dscode-hub`，可用 `DSCODE_HOME` 覆盖 | 数据目录的 `.env` 和 `config/` |
| 源码 | 仓库 `.runtime/` | 仓库 `.env` 和 `config/` |
| tar | 安装目录 `.runtime/` | 安装目录 `.env` 和 `config/` |

支持 `config/hooks.local.json`、`config/mcp.local.yml` 和 `config/harness.local.yml`；这些本地配置、密钥与会话不会打入发布包。Skills 会发现目标项目的 `.agents/skills`、`.dsh/skills`，以及隔离的用户 skill 目录；用 `/skills conflicts` 排查同名覆盖。

## 🧩 开发与发布

```sh
npm test                    # 单元与契约测试（隔离上游依赖）
npm run check               # 覆盖率、集成、TUI 与打包检查
npm run doctor              # 本地确定性 agent 集成检查
npm run build:packages      # 构建 launcher 与完整 bundle 的 npm tgz
npm run release:hub         # 构建 Hub release 和 .dshprofile
npm run verify:hub          # 临时安装、agent 检查、失败升级与回退
npm run dist                # 构建备用 tar 安装包
```

`make release` 按同样顺序执行整个 build job——版本校验、`npm run check`、三个构建步骤、`verify:hub`，最后打包 `release-candidates.tar.gz`；`make publish` 按顺序执行 publish job 的各阶段。`make help` 列出全部 target；workflow 本身不调用 make。

| 分发组件 | 内容 |
|---|---|
| `@toddzheng024/dscode` | `dscode` 命令、首次安装引导与 Hub 版本管理 |
| `@toddzheng024/dscode-bundle` | 基础层、Computer Use、自定义插件与修改后的 TUI/runtime |
| Hub profile `dscode` | 固定 bundle/runtime 版本与完整性哈希 |

Bundle 在构建阶段生成修改后的模块，不在使用者机器上改第三方源码。DSH 依赖统一固定到 `0.1.5-rc.1`；TUI 基于 `dsh-code@1.0.6`，Chrome MCP 为 `1.9.0`，Computer Use 为 `0.3.2`。完整流程——先发布 bundle，再上线 Hub release，最后发布 launcher——见 [分发指南](docs/hub-distribution.md)。上下文压缩评测位于 [`eval/`](eval/README.md)，用 `npm run eval:compaction` 运行。

## 📚 文档

| 文档 | 内容 |
|---|---|
| [更新日志](docs/CHANGELOG.md) | 每次发布，最新在前 |
| [非交互执行](docs/exec.md) | `dscode exec`、JSON 输出、resume 与 effort/model/permission 参数 |
| [会话接入](docs/session-bridge.md) | 用 `dscode sessions`、`send`、`read`、`watch` 接入运行中的会话 |
| [Session 通信](docs/session-communication.md) | Agent 侧消息、投递方式、预算与去重 |
| [会话名片](docs/session-cards.md) | 项目、工作区与 topic 字段及其来源 |
| [记忆](docs/memory.md) | 全局跨 session 记忆、后台用量与开关 |
| [持久 Shell 与 Ultra](docs/dscode-ultra.md) | preset、推理强度、子 agent effort 与 worktree 隔离 |
| [Auto 审核](docs/auto-review.md) | 独立权限审核的范围、成本与限制 |
| [邮件](docs/email.md) | IMAP 配置、收件箱面板、`send_email` 与联系人别名 |
| [TUI 命令](docs/tui-commands.md) | 命令参考与 hooks |
| [Session 指标](docs/session-metrics.md) | 底栏 TPS、context、费用与缓存的统计口径 |
| [npm + Hub 分发](docs/hub-distribution.md) | bundle、Hub release 与 launcher 流程 |
| [tar 分发](docs/distribution.md) | 独立 tar 安装器 |
| [验证说明](docs/verification.md) | 维护中的检查覆盖范围 |

## 🤝 参与

欢迎提 issue 和 pull request。改动请先跑 `npm run check`，并保持发布流程不变：先 bundle，再 Hub release，最后 launcher。

## 📄 许可

[MIT](LICENSE) © 2026 Todd Zheng

---

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)、[DSH-Code](https://github.com/unlinearity/dsh-code)、[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) 与 [DSH Plugin Hub](https://dshpluginhub.ai)。独立社区项目，非 DeepSeek 官方产品。
