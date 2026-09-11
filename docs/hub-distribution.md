# npm + Hub 分发

## 包与职责

- `@toddzheng024/dscode`：全局命令 `dscode`；首次启动应用 Hub 的 `dscode` profile，之后直接运行已安装版本。包含私有安装工具 shim；在 npm exec 的同一环境中明确安装 DSH 与 pnpm 10.15.1，避免 PATH 被改写后误用系统版本。
- `@toddzheng024/dscode-bundle`：完整 Cordis 组合，包括基础层、Computer Use、修改后的 TUI/runtime 模块和本仓库插件。修改模块在构建阶段生成，安装时不改第三方文件。
- Hub profile `dscode`：指定 bundle 与 DSH runtime 的确切版本和完整性哈希。

完整 bundle 显式固定共享 DSH 依赖。不要将它与另一个 base/TUI bundle 叠加在同一 profile：Hub 顺序安装多个根 bundle 会让宽范围传递依赖先解析到另一条 rc 版本线。独立 profile 的 pnpm hoisted + autoInstallPeers=false 是验证过的安装方式。直接 `npm install` bundle 会碰到 Computer Use 的旧 peer 范围；终端用户通过 launcher 安装。

## 使用者（正式发布后）

```sh
npm install -g @toddzheng024/dscode
dscode
```

首次安装联网从 Hub/npm 获取代码。需要 macOS 14+、Node 22.19+（22.x）或 24+、Git、Chrome。安装依赖使用 ignore-scripts，与已验证的预编译模块路径一致，不自动执行第三方安装脚本。正常 agent shell 不强制这个 npm 选项。

模型密钥在 `/model` 配置，或设置 `DEEPSEEK_API_KEY`。辅助功能/录屏权限由 macOS 授予。

```sh
dscode update 0.2.0
dscode history
dscode rollback
dscode doctor
```

省略 update 版本时使用当前 launcher 推荐的确切版本，不隐式追踪 latest。升级 launcher 用 `npm install -g @toddzheng024/dscode@<版本>`。同时只允许一个 launcher 使用同一数据目录，以防运行中替换依赖。

默认状态目录是 `~/.local/share/dscode-hub`，可用 `DSCODE_HOME` 覆盖；它与现有 tar 安装及本仓库 `.runtime` 分开。会话、凭据、审核和费用记录位于数据目录，不在 npm 包内。配置位于该目录 `.env` 与 `config/`，支持 `hooks.local.json`、`mcp.local.yml`、`harness.local.yml`。Profile 位于 `profiles/dscode`。Hub 管理升级和回退目录；会话不会随 profile 回退，但跨未来不兼容的会话格式版本仍需迁移。

已安装 dsh-hub 的用户也可直接 apply，但需使用 pnpm 10.15.1，设置独立 `DSH_HOME` 和 `DSH_AGENTS_HOME`，并在安装命令上设置 `npm_config_ignore_scripts=true`。推荐 launcher，以统一这些条件。

## 发布者

```sh
# 将实际 GitHub 仓库写入发布元数据；不填写虚构 URL。
DSCODE_REPOSITORY=https://github.com/OWNER/REPO npm run build:packages
npm run release:hub
npm test
npm run verify:hub
```

产物位于 `artifacts/npm/`：两个 npm tgz、Hub draft/release JSON 和 `.dshprofile`。构建只复制白名单文件，不复制用户配置、凭据或会话；发布携带原始 MIT 许可和修改说明。

`verify:hub` 在临时目录安装真实 launcher，以 loopback npm registry 供应尚未发布的 bundle，使用真实 dsh-cli 与 Hub lifecycle 验证组合、agent loop、替换及回退。它不等同于公开 Hub 发现或 npm 正式发布。测试不请求远程模型。

正式发布顺序：

1. 通过 `dsh-hub validate artifacts/npm/bundle` 验证包元数据与真实公开源码仓库。
2. `npm whoami` 确认是 `toddzheng024`，然后发布 bundle tgz（`npm publish ... --access public`）。
3. 在 Hub 发布者控制台登记/认领 `@toddzheng024/dscode-bundle`，确认确切版本可解析。
4. 保存生成的 profile draft，再发布 `dscode` 的同版本 release。
5. 在全新 DSH_HOME 通过公开 Hub apply/doctor 验证后，发布 launcher tgz。
6. 在另一干净目录用公开 npm 的 launcher 完成首次启动验证。

不能在 bundle/Hub release 可用之前发布 launcher，否则用户的首次启动会失败。新的版本必须重新生成包和 release，不能复用旧完整性哈希。目前本仓库生成的是发布候选产物，不代表已在线发布。

发布脚本按阶段执行：`npm run publish:hub -- bundle`、`npm run publish:hub -- profile`、`npm run publish:hub -- launcher`。每阶段核对测试产物哈希；launcher 发布前检查公开 Hub release 的确切版本及完整性。Hub 认领仍需发布者控制台操作，登录使用 `dsh-hub login`。
