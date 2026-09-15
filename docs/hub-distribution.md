# npm + Hub 分发

## 包与职责

- `@toddzheng024/dscode`：全局命令 `dscode`；首次启动应用 Hub 的 `dscode` profile，之后直接运行已安装版本。包含私有安装工具 shim；在 npm exec 的同一环境中明确安装 DSH 与 pnpm 10.15.1，避免 PATH 被改写后误用系统版本。
- `@toddzheng024/dscode-bundle`：完整 Cordis 组合，包括基础层、Computer Use、修改后的 TUI/runtime 模块和本仓库插件。修改模块在构建阶段生成，安装时不改第三方文件。
- Hub profile `dscode`：指定 bundle 与 DSH runtime 的确切版本和完整性哈希。

完整 bundle 显式固定共享 DSH 依赖。不要将它与另一个 base/TUI bundle 叠加在同一 profile：Hub 顺序安装多个根 bundle 会让宽范围传递依赖先解析到另一条 rc 版本线。独立 profile 的 pnpm hoisted + autoInstallPeers=false 是验证过的安装方式。直接 `npm install` bundle 会碰到 Computer Use 的旧 peer 范围；终端用户通过 launcher 安装。

## 使用者

```sh
npm install -g @toddzheng024/dscode
dscode
```

首次安装联网从 Hub/npm 获取代码。需要 macOS 14+、Node 22.19+（22.x）或 24+、Git、Chrome。安装依赖使用 ignore-scripts，与已验证的预编译模块路径一致，不自动执行第三方安装脚本。正常 agent shell 不强制这个 npm 选项。

DeepSeek 与 OpenRouter 密钥通过 `/login`（`/login openrouter`）在本地保存，`/provider` 在两者之间切换；其他模型密钥在 `/model` 配置，或设置 `DEEPSEEK_API_KEY` / `OPENROUTER_API_KEY`。辅助功能/录屏权限由 macOS 授予。

```sh
dscode update 0.7.7
dscode history
dscode rollback
dscode doctor
```

省略 update 版本时使用当前 launcher 推荐的确切版本，不隐式追踪 latest。升级 launcher 用 `npm install -g @toddzheng024/dscode@<版本>`。同一数据目录可同时启动多个 launcher/根 session。启动与版本管理通过短期内核锁串行准入，每个运行中的 Host 单独持有版本保护锁；install/update/rollback 必须等这些 Host 退出。启动器意外退出时，runtime 或 Hub 子进程继承锁描述符，避免仍在运行时失去保护。旧版启动器仍存活时，新版会提示先退出旧版。session 写排他继续由 Harness 原生锁负责。

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

不能在 bundle/Hub release 可用之前发布 launcher，否则用户的首次启动会失败。新的版本必须重新生成包和 release，不能复用旧完整性哈希。`build:packages` 与 `release:hub` 生成候选产物；只有发布并确认公开 registry 后才算完成发布。v0.1.0 已通过 npm + Hub 公开分发。

发布脚本按阶段执行：`npm run publish:hub -- bundle`、`npm run publish:hub -- profile`、`npm run publish:hub -- launcher`。每阶段核对测试产物哈希；launcher 发布前检查公开 Hub release 的确切版本及完整性。 profile 阶段先调用 Hub 的 `sync` 接口（dsh-hub CLI 0.3.0 起提供）让 Hub 立即从 npm 拉取 bundle，不再等整点同步；同步后仍要求 Hub 已列出该精确版本。Hub 认领仍需发布者控制台操作，登录使用 `dsh-hub login`。

### 免登录发布（本机）

账号开启了 auth-and-writes 两步验证，`npm login` 的会话 token 会过期，每次 `npm publish` 又要一次性验证码。改用一个 **granular access token**，发布脚本会自动使用它：

1. 在 npm 网站 Access Tokens 页面生成 granular token：勾选 *Bypass two-factor authentication*，Packages and scopes 只给 `@toddzheng024/dscode` 与 `@toddzheng024/dscode-bundle` 的 Read and write，过期时间按需要选（到期后重复这一步）。granular token 目前只能在网站生成。
2. `npm run publish:token store`，在 `security` 的密码提示处粘贴 token。它存进登录钥匙串（service `dscode-npm-publish`），不会写进 `~/.npmrc`、命令行或 shell 历史。
3. `npm run publish:token check` 确认 token 以 `toddzheng024` 身份通过认证。

之后 `npm run publish:hub -- bundle|launcher` 会从钥匙串取 token，通过一次性的临时 `--userconfig` 传给 npm，不需要登录也不需要验证码。临时环境可用 `NPM_PUBLISH_TOKEN` 覆盖；两者都没有时退回原来的交互式流程。`npm run publish:token remove` 删除钥匙串里的 token。

npm 已宣布带 bypass 2FA 的 token 直接发布将在 2027 年 1 月停用；届时本机发布需要改为在 CI 上使用 trusted publishing（OIDC）。

### GitHub Actions

两个 workflow：

- `.github/workflows/checks.yml`：每次 push/PR 在 `macos-14` 上跑 `npm run check`（Node 22.19.0 与 24 两个矩阵），上传覆盖率产物；同一 ref 的新推送会取消上一轮。
- `.github/workflows/release.yml`：推送 `v*` tag（或手动 `workflow_dispatch`）时先跑 `build` job —— `npm run check` → `npm run build:packages` → `npm run release:hub` → `npm run verify:hub`，把 `artifacts/npm` 与 `artifacts/local/hub-verification.json` 作为 `release-candidates` 产物上传。`publish` job 依赖它，并挂在 `release` environment 上（可在仓库 Settings → Environments 里加 required reviewers 做人工放行）。

发布凭据放在仓库 Secrets（Settings → Secrets and variables → Actions）：

| Secret | 用途 |
| --- | --- |
| `DSH_HUB_TOKEN` | Hub CI 凭据。`@dsh-plugin-hub/cli` 的 `getAccessToken()` 优先读它，因此流水线不跑设备登录、也不依赖 5 分钟有效的 WorkOS access token。 |
| `NPM_PUBLISH_TOKEN` | npm granular token（勾选 *Bypass two-factor authentication*，只授权 `@toddzheng024/dscode` 与 `@toddzheng024/dscode-bundle` 的 Read and write）。`npm run publish:hub` 会把它写进一次性的 `--userconfig`，不落盘、不进 shell 历史。 |

发布按文档顺序分三段执行，每段都重新核对上面验过的哈希：`publish:hub -- bundle` → `publish:hub -- profile`（先让 Hub 从 npm 同步，再要求该精确版本可解析）→ `publish:hub -- launcher`。**launcher 永远在 bundle 与 public Hub release 之后**，否则用户首次启动会失败。新包在 Hub 控制台的认领（claim）仍需人工完成；tag 与 `package.json` 版本不一致时 `build` job 直接失败，不会发布。

手动 dry run：Actions → Release → Run workflow，两个开关都保持 `false`，只构建并验证候选产物、不发布。

只验凭据：Actions → Release → Run workflow，勾选 `verify_credentials`。它跑完整 `build` job 后进入 `publish` job，用 `node scripts/check-publish-credentials.mjs` 做**只读**检查——npm token 是否以 `toddzheng024` 身份通过认证、Hub token 能否读到 `dscode` profile、以及当前版本号在 npm 上是否还空着——然后停止，不发布任何东西。版本已在 npm 上时这个检查会失败，正好拦住「忘记 bump 版本就推 tag」。



Hub 阶段（`profile`）用的是 `dsh-hub login` 写入 `~/.dsh/.hub/auth.json` 的 WorkOS 会话，access token 5 分钟有效、脚本会用 refresh token 自动续期；只有 refresh token 失效时才需要重新 `dsh-hub login`。
