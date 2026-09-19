# 分发与单命令启动

新增 npm + Hub 发布路径见 [Hub 分发](hub-distribution.md)。以下保留 tar 安装方式。

交付物是可安装的 `dscode-0.7.8.tar.gz`，不是只有配置的 `.dshprofile`。安装后用户直接运行 `dscode`。npm + Hub 安装已提供，tar 包通过 GitHub Releases 分发；尚无 Homebrew formula。

## 发布者

```sh
npm run dist
```

产出三个 tar 包，全部挂到 GitHub release：

| 文件 | 内容 | 安装时需要 |
|---|---|---|
| `dscode-<version>-darwin-arm64.tar.gz`、`dscode-<version>-darwin-x64.tar.gz` | 预构建包：源码树 + 按该平台装好的锁定 `node_modules` + `.dscode-prebuilt` 标记（约 70 MB） | Node、Git；**不需要 npm，不访问 npm registry** |
| `dscode-<version>.tar.gz` | 源码包：启动器、preset、依赖 manifest 和完整 lockfile，不含 node_modules（约 1 MB） | Node、npm、Git；安装时从 npm 下载锁定依赖 |

三者都不含模型密钥、本地覆盖配置、会话或研究文件。预构建包在暂存目录里用 `npm ci --ignore-scripts --os=darwin --cpu=<arch>` 生成——和安装器自己执行的命令一致，原生模块都是按 `os`/`cpu` 选择的预编译可选依赖，所以一台 runner 就能构建两个架构。`DSCODE_PREBUILT_ARCHS=arm64` 只构建一个架构，设为空串则只打源码包。

## 使用者

需要 macOS 14+、Node 22.19+（22.x）或 24+、Git（供 `apply_patch` 使用）、Google Chrome。只有从源码包安装时才需要 npm。

同一个脚本也能自己取包：从管道执行时它进入远程模式，解析最新 release、校验发布方 sha256 摘要、解包，然后把工作交给包内自带的 `install.sh`，所以下载到的版本和安装脚本对布局的理解不会分叉。它优先取当前平台的预构建包，整个安装只访问 GitHub——公司内 npm registry 代理拦截安装时不受影响；release 没有该平台的预构建包时回退到源码包并提示，`DSCODE_INSTALL_SOURCE=1` 可显式要求源码包。包内 `install.sh` 看到 `.dscode-prebuilt` 与 `node_modules` 时跳过 `npm ci`，直接用 `node scripts/harness.mjs setup` 完成 provision；标记的平台与本机不符则拒绝安装。

```sh
curl -fsSL https://raw.githubusercontent.com/qiz029/dscode/main/install.sh | sh
# 固定版本
curl -fsSL https://raw.githubusercontent.com/qiz029/dscode/main/install.sh | sh -s -- 0.7.8
```

或者手动解包同一个 tar 包：

```sh
mkdir dscode-install
tar -xzf dscode-0.7.8-darwin-arm64.tar.gz -C dscode-install
sh dscode-install/install.sh
cd /path/to/project
dscode
```

默认安装到 `~/.local/share/dscode`，命令链接为 `~/.local/bin/dscode`。如果该 bin 目录不在 PATH，将 `export PATH="$HOME/.local/bin:$PATH"` 加入 shell 配置并重新打开终端。

首次进入 `/model` 配置供应商和模型。macOS Computer Use 仍需用户授予辅助功能/录屏权限；这些权限和凭据不能随包分发。

支持 `dscode --continue`、`dscode --resume SESSION_ID` 和 `dscode --cwd /path/to/project`。默认操作当前终端目录；状态保存在安装目录 `.runtime`。自定义位置可在安装时设置绝对路径的 `DSCODE_INSTALL_DIR`、`DSCODE_BIN_DIR`。

安装器不会覆盖已有安装或命令。自包含 `dscode update` 的版本起，tar 安装支持自升级：`dscode update [精确版本号]` 从 GitHub Releases 下载 tar 包并按发布方 sha256 摘要校验，迁移 `.runtime`、`.env` 与本地 config，原位换目录（`dscode` 命令路径不变，无需重新链接），旧安装保留为同级备份目录，可手动换回或丢弃。更新要求没有正在运行的会话；release 带有当前平台的预构建包时取它，升级同样不需要 npm，否则取源码包并用 npm ci 下载锁定依赖。更早版本的 tar 安装没有升级器，请把新 tar 包装到新目录并手动迁移一次状态。

## 为什么当前不直接 npm install -g

依赖里的 npm `overrides` 在作为第三方依赖安装时不会成为根项目的解析规则。本组合需要统一固定 DSH 的 rc 版本线，因此使用安装包内的根 manifest 和 `npm ci` 保留已经验证的锁定依赖图。`package.json` 已声明 `dscode` bin，但不能把单纯的 bin 声明当作 npm 全局安装兼容性验证。

一行 `curl | sh` 安装已提供，复用 GitHub Releases 的 tarball 与发布方 sha256 摘要，并优先使用免 npm 的预构建包；缺少摘要的 release 会被拒绝，而不是未经校验地安装。Homebrew formula 仍是后续可能项，需要先确定正式下载地址和版本发布渠道。

完整 tar 包包含 `presets/dscode`、`bin/apply_patch` 和版本锁定的 runtime patch 脚本。setup 默认启用 dscode 并安装 Ultra effort 支持；预构建包里的 node_modules 来自暂存目录中对 lockfile 的全新安装，不会将本机 node_modules 打入包中。旧会话继续按原 preset 恢复，使用 `dscode --mode dscode` 显式创建新会话。
