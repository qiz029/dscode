# 🐋 DSCODE

**在终端里，用 DeepSeek 完成从读代码到验证修改的整个过程。**

![macOS 14+](https://img.shields.io/badge/macOS-14%2B-111827?logo=apple)
![Node.js](https://img.shields.io/badge/Node.js-22.19%2B%20%7C%2024%2B-43853D?logo=node.js&logoColor=white)
![DSH](https://img.shields.io/badge/DSH-0.1.5--rc.1-2563EB)
![License](https://img.shields.io/badge/license-MIT-green)
[![npm](https://img.shields.io/npm/v/@toddzheng024/dscode)](https://www.npmjs.com/package/@toddzheng024/dscode)

DSCODE 是基于 DeepSeek Harness 的 coding agent preset：以极简模式的持久 Shell 为核心，配上 TUI、自动权限审核、子 agent、Chrome MCP、Computer Use、skills 和上下文压缩。

[安装](#-安装) · [常用命令](#-常用命令) · [权限与配置](#-权限与配置) · [开发与发布](#-开发与发布)

## ✨ 能做什么

| 能力 | 说明 |
|---|---|
| 🛠️ 编码 | 持久 Bash 保留 cwd 和环境；通过 Shell 读写文件、搜索、应用补丁与运行测试 |
| 🧠 Ultra | DeepSeek `max` 推理 + 有明确收益的子 agent 协作；支持父子消息与任务控制 |
| 🛡️ Auto 权限 | 普通操作按本地策略执行；需要升级权限的适用请求交给独立模型审核 |
| 🌐 浏览器与桌面 | Chrome DevTools MCP 与 macOS 原生 Computer Use，按需使用 |
| 📚 长任务 | 项目指令、skills、plan、goal、hooks、自动压缩和会话恢复 |
| 📊 会话统计 | 右下角显示上下文占用、session 美元估算、输入 token 缓存命中率 |

```text
                              ctx 43% · session ~$0.0030 · cache 90.0%
```

费用包含已记录的子 agent、压缩和 auto 审核调用；统计本身不额外请求模型。[统计口径 →](docs/session-metrics.md)

## 🚀 安装

需要 **macOS 14+、Node 22.19+（22.x）或 24+、npm、Git 和 Google Chrome**。

### npm + Plugin Hub

> **v0.1.0 已发布。** [npm 启动器](https://www.npmjs.com/package/@toddzheng024/dscode) · [Hub preset](https://dshpluginhub.ai/profiles/dscode) · [GitHub Releases](https://github.com/qiz029/dscode/releases)

```sh
npm install -g @toddzheng024/dscode
cd /path/to/project
dscode
```

如果 npm 包名查询暂时返回 404，可直接安装同一版本的官方 registry tarball（此路径已完成安装和 TUI 启动验证）：

```sh
npm install -g https://registry.npmjs.org/@toddzheng024/dscode/-/dscode-0.1.0.tgz
dscode
```

首次启动会从 [DSH Plugin Hub](https://dshpluginhub.ai) 安装固定版本的完整 preset；之后直接打开 TUI。无需手动拼装插件，也不需要全局安装 pnpm。

第一次进入后，用 `/model` 配置模型和凭据，也可在启动前设置 `DEEPSEEK_API_KEY`。默认路由是 `deepseek-official/deepseek-flash`。Computer Use 的辅助功能和录屏权限需在 macOS 中单独授予。

```sh
dscode --continue                     # 继续上次会话
dscode --resume SESSION_ID            # 恢复指定会话
dscode --cwd /another/project         # 在指定目录工作

dscode update 0.2.0                   # 示例：升级到已发布的确切版本
dscode history                        # 查看保留的版本记录
dscode rollback                       # 回到上个 preset 版本
dscode doctor                         # 检查 Hub 安装状态
```

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

首次使用同样通过 `/model` 配置。也可复制 `.env.example` 为 `.env`，仅在本机填写密钥。

### tar 包安装（现在可用）

从 [GitHub Releases](https://github.com/qiz029/dscode/releases/latest) 下载 `dscode-0.1.0.tar.gz`，然后执行：

```sh
mkdir dscode-install
tar -xzf dscode-0.1.0.tar.gz -C dscode-install
sh dscode-install/install.sh
cd /path/to/project
dscode
```

默认命令位于 `~/.local/bin/dscode`，请确保该目录在 PATH 中。tar 安装器不会覆盖已有命令或安装。它与 npm/Hub 安装的管理命令不同，详情见 [tar 分发说明](docs/distribution.md)。

## ⌨️ 常用命令

| 命令 | 作用 |
|---|---|
| `/model`、`/effort` | 选择模型、配置凭据、调整推理强度；Ultra 在 effort 菜单中 |
| `/mode` | 选择 Agent Preset；新会话默认 `dscode` |
| `/status`、`/doctor` | 会话状态与运行时诊断 |
| `/permission auto`、`/permission ask` | 切换自动审核或人工审批 |
| `/review-usage` | 查看自动审核的额外 token 与耗时 |
| `/shell`、`/shell reset` | 检查或重置持久终端 |
| `/mcp`、`/skills`、`/hooks` | 管理 MCP、检查 skill 来源、查看或重载 hooks |
| `/plan`、`/goal` | 计划与持续任务 |
| `/agents` | 查看子 agent |
| `/compact` | 压缩历史上下文 |
| `/diff`、`/review` | 查看和审查代码修改 |
| `/clear` | 开始新的空上下文会话，旧会话仍可恢复 |
| `/resume`、`/fork` | 恢复或分叉会话 |

`Ctrl+L` 只清屏，`Esc` 中断当前操作。完整命令以 TUI `/help` 为准。[命令与 hooks 说明 →](docs/tui-commands.md)

## 🔧 权限与配置

默认使用 `workspace-write` sandbox 和 **Auto** 权限审核。Ultra 不增加权限；独立审核只处理适用的审批请求，Computer Use 保留人工授权。[Auto 的范围、成本与限制 →](docs/auto-review.md)

| 安装方式 | 会话、凭据与统计 | 本地配置 |
|---|---|---|
| npm / Hub | `~/.local/share/dscode-hub`，可用 `DSCODE_HOME` 覆盖 | 数据目录的 `.env` 和 `config/` |
| 源码 | 仓库 `.runtime/` | 仓库 `.env` 和 `config/` |
| tar | 安装目录 `.runtime/` | 安装目录 `.env` 和 `config/` |

支持 `config/hooks.local.json`、`config/mcp.local.yml`、`config/harness.local.yml`。这些本地配置、密钥与会话不会打入发布包。Hub 升级/回退替换 profile，保留独立状态目录；不自动迁入旧源码或 tar 安装的凭据。

Skills 会发现目标项目的 `.agents/skills`、`.dsh/skills`，以及隔离的用户 skill 目录。使用 `/skills conflicts` 排查同名覆盖。

Chrome 默认使用独立临时 profile，不接管日常浏览器登录态。桌面工具通过 skill 渐进加载；截图理解需要支持图片的模型。当前 MCP bridge 提供 tools，不提供 resources/prompts。[持久 Shell 与 Ultra →](docs/dscode-ultra.md)

## 🧩 开发与发布

```sh
npm test                              # 单元与契约测试
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

完整流程见 **[npm + Hub 分发指南](docs/hub-distribution.md)**。先发布 bundle，再上线 Hub release，最后发布 launcher。`artifacts/npm/` 是完整分发产物；旧 `npm run release` 只保留基础配置导出，不能替代完整 bundle。

本地集成验证使用确定性模型；公开 npm/Hub 安装与真实 TUI 启动另行验证。真实远程模型、浏览器操作或桌面操作不属于这轮发布测试的验收范围。[验证说明 →](docs/verification.md)

---

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)、[DSH-Code](https://github.com/unlinearity/dsh-code)、[Chrome DevTools MCP](https://github.com/ChromeDevTools/chrome-devtools-mcp) 与 [DSH Plugin Hub](https://dshpluginhub.ai)。独立社区项目，非 DeepSeek 官方产品。
