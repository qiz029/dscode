# 分发与单命令启动

新增 npm + Hub 发布路径见 [Hub 分发](hub-distribution.md)。以下保留 tar 安装方式。

交付物是可安装的 `dscode-0.7.8.tar.gz`，不是只有配置的 `.dshprofile`。安装后用户直接运行 `dscode`。npm + Hub 安装已提供，tar 包通过 GitHub Releases 分发；尚无 Homebrew formula。

## 发布者

```sh
npm run dist
```

分发 `artifacts/dscode-0.7.8.tar.gz`。包里包含启动器、preset、依赖 manifest 和完整 lockfile，不含模型密钥、本地覆盖配置、会话、node_modules 或研究文件。安装时从 npm 下载锁定依赖，需要联网。

## 使用者

需要 macOS 14+、Node 22.19+（22.x）或 24+、npm、Git（供 `apply_patch` 使用）、Google Chrome。

同一个脚本也能自己取包：从管道执行时它进入远程模式，解析最新 release、校验发布方 sha256 摘要、解包，然后把工作交给包内自带的 `install.sh`，所以下载到的版本和安装脚本对布局的理解不会分叉。

```sh
curl -fsSL https://raw.githubusercontent.com/qiz029/dscode/main/install.sh | sh
# 固定版本
curl -fsSL https://raw.githubusercontent.com/qiz029/dscode/main/install.sh | sh -s -- 0.7.8
```

或者手动解包同一个 tar 包：

```sh
mkdir dscode-install
tar -xzf dscode-0.7.8.tar.gz -C dscode-install
sh dscode-install/install.sh
cd /path/to/project
dscode
```

默认安装到 `~/.local/share/dscode`，命令链接为 `~/.local/bin/dscode`。如果该 bin 目录不在 PATH，将 `export PATH="$HOME/.local/bin:$PATH"` 加入 shell 配置并重新打开终端。

首次进入 `/model` 配置供应商和模型。macOS Computer Use 仍需用户授予辅助功能/录屏权限；这些权限和凭据不能随包分发。

支持 `dscode --continue`、`dscode --resume SESSION_ID` 和 `dscode --cwd /path/to/project`。默认操作当前终端目录；状态保存在安装目录 `.runtime`。自定义位置可在安装时设置绝对路径的 `DSCODE_INSTALL_DIR`、`DSCODE_BIN_DIR`。

安装器不会覆盖已有安装或命令。自包含 `dscode update` 的版本起，tar 安装支持自升级：`dscode update [精确版本号]` 从 GitHub Releases 下载 tar 包并按发布方 sha256 摘要校验，迁移 `.runtime`、`.env` 与本地 config，原位换目录（`dscode` 命令路径不变，无需重新链接），旧安装保留为同级备份目录，可手动换回或丢弃。更新要求没有正在运行的会话；npm ci 下载锁定依赖，需要联网。更早版本的 tar 安装没有升级器，请把新 tar 包装到新目录并手动迁移一次状态。

## 为什么当前不直接 npm install -g

依赖里的 npm `overrides` 在作为第三方依赖安装时不会成为根项目的解析规则。本组合需要统一固定 DSH 的 rc 版本线，因此使用安装包内的根 manifest 和 `npm ci` 保留已经验证的锁定依赖图。`package.json` 已声明 `dscode` bin，但不能把单纯的 bin 声明当作 npm 全局安装兼容性验证。

一行 `curl | sh` 安装已提供，复用 GitHub Releases 的 tarball 与发布方 sha256 摘要；缺少摘要的 release 会被拒绝，而不是未经校验地安装。Homebrew formula 仍是后续可能项，需要先确定正式下载地址和版本发布渠道。

完整 tar 包包含 `presets/dscode`、`bin/apply_patch` 和版本锁定的 runtime patch 脚本。setup 默认启用 dscode 并安装 Ultra effort 支持；不会将本机 node_modules 打入包中。旧会话继续按原 preset 恢复，使用 `dscode --mode dscode` 显式创建新会话。
