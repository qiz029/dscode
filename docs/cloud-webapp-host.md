# 云端 Web App Host：设计与信任模型

面向「从任何地方用浏览器访问自己的 DSCODE」这一形态的架构设计。执行、文件与密钥始终留在用户自己的机器上；Hub（dshpluginhub.ai）在**架构上**无法读取用户内容。

状态：设计基线，尚未实现。P0 验证未开始。

## 1. 目标与约束

**目标**：用户在任何设备、任何网络的浏览器里使用自己的 DSCODE host，体验对齐 `dsh-web-app` 已有的 Web 面（chat、模型与设置、会话历史、审批）。

**约束（已确定）**：

1. **强制端到端加密**：Hub 永不接触明文，包括会话内容、文件内容与凭据。
2. **多租户**：每个用户拥有独立的 host；用户的凭证不能触达其他用户的 host。
3. **Web 面不复刻终端专属能力**：压缩 Tetris 指示器、键盘交互面板等不进入 Web。
4. **不依赖 Tailscale 或任何第三方隧道**：隧道与中继由 Hub 侧自建（cloudflared 只可用于 P0 验证）。
5. **本地执行**：agent 的 shell、文件系统、密钥、审批全部在本机 host 完成，Hub 无法放宽本地策略。

## 2. 架构

```
[浏览器 · 任何地方]
     │  HTTPS（Hub 登录态 / passkey）
     ▼
[dshpluginhub.ai]          ← 身份 · host 目录 · 盲中继 · 连接级审计 · 配额
     ▲  WSS 出站长连接（本机主动拨出；不开放任何入站端口）
     │
[用户机器 · dscode host]    ← 唯一的执行处
     └ dsh --profile web（只 bind 127.0.0.1）+ DSCODE 服务层插件
```

**数据流**：

1. 用户在 Hub 登录，并用 passkey 完成设备绑定（见第 5 节）。
2. 本机 `dscode host up` 使用短期 host 凭证拨出 WSS 隧道，向 Hub 注册 `host-id` 与公钥。
3. 浏览器打开 `dshpluginhub.ai/h/<host-id>`：Hub 认证用户 → 查目录 → 建立到该 host 的中继。
4. 浏览器与该 host 协商 E2E 会话密钥；此后所有 API 调用与事件都在该通道内。
5. 敏感操作（写文件、执行命令、安装依赖）仍由本机 DSCODE 的 approval / auto-review 决策，通过 E2E 通道在 Web 上征询用户确认。

**信任边界**：Hub 只在第 2–3 步参与身份与路由；第 4 步之后它转发的是密文。

## 3. 关键决策记录

| 决策 | 选择 | 后果 |
|---|---|---|
| 加密 | **强制 E2E** | Hub 不能提供内容索引/搜索、AI 内容审核、跨租户内容共享。换取"架构上看不到" |
| 租户 | **多租户** | 隔离落在授权与路由层（执行天然分离）。需要配额、滥用防护、每租户的 host 目录与审计 |
| Web 能力 | **不复刻终端功能** | Web 只保留服务层插件；TUI 专属组件（tui-tools、Tetris、键盘面板）不迁移 |
| 隧道 | **自建出站隧道** | 不引入第三方可见性；与 Hub 认证/审计/配额一体 |
| 密钥/身份 | **passkey（WebAuthn PRF）** | 新设备免配对；依赖浏览器 PRF 支持，并放大 SPA 可信性要求（第 6 节） |

## 4. 信任设计

| 机制 | 说明 |
|---|---|
| **只出不进** | host 只主动拨出隧道，不监听公网端口。`dscode host down` 即刻断开——"没有进入你电脑的通道"是结构性的 |
| **Hub 盲中继** | 只按认证过的帧转发，不解析内容。会话、凭据、审核、费用记录留在本机（现状即 `~/.local/share/dscode-hub`） |
| **E2E 数据面** | 浏览器与 host 之间协商会话密钥，Hub 只有公钥 |
| **host 侧授权** | host 验证 Hub 签发的**短期** token（绑定 host-id、audience、过期），不采信"Hub 说这是谁" |
| **最小暴露面** | 隧道只转发白名单路径（Web UI + `dsh-api-gateway`），不做文件系统或 shell 直通 |
| **本地策略不可绕过** | approval、auto-review、platform sandbox 全在本机执行；Hub 无法放宽 |
| **可审计可撤销** | `dscode host status` 列出在线设备、来源、令牌到期；`dscode host revoke <device>` 断开并轮换 |
| **隐私工程沿用现有标准** | `dsh-hub` 遥测已做到事件不含账号、机器 ID、IP 字段、路径、配置与密钥，并支持 `DSH_HUB_TELEMETRY_DEBUG=1` 预览。隧道与 host 组件沿用同一标准并开源 |

## 5. E2E 密钥模型（passkey）

**信任根是本机 host，不是 Hub，也不是 passkey。** passkey 只是让新设备取回 host 密钥的便捷凭据。

1. **host 密钥对**：启用远程时本机生成 `(sk_host, pk_host)`；`pk_host` 与 `host-id` 注册到 Hub。
2. **passkey 绑定**：浏览器用 WebAuthn PRF 输出经 HKDF 派生出 `K_wrap`。PRF 输出只在浏览器本地计算，断言里不包含它，Hub 无法获得。
3. **封装**：用户在浏览器完成一次绑定后，`sk_host` 被 `K_wrap` 封装上传 Hub（仅密文）。Hub 保存 `pk_host` 与密文。
4. **新设备**：新浏览器 → passkey 验证 → 派生 `K_wrap` → 从 Hub 取回密文 → 解封得到 `sk_host` → 与 host 建立 E2E。
5. **恢复**：passkey 丢失时，只要还能本地访问 host（终端或局域网），即可重新封装绑定新 passkey。**本地 host 始终是恢复锚点**。
6. **撤销**：`dscode host revoke` 轮换 `sk_host`，使所有已发布密文失效。

**待验证**：浏览器/平台对 WebAuthn PRF 扩展的支持矩阵；不支持时的降级路径是设备配对（在一台已授权设备上确认新设备），该路径不引入 Hub 可见性。

## 6. SPA 可验证性（E2E 的前提）

PRF 输出由**页面脚本**取得，因此"SPA 可信"是 E2E 成立的先决条件——服务端若投毒前端，就能窃取密钥。

要求：

1. Web 前端**开源**，可复现构建；
2. 每次发布公开构建哈希，浏览器加载后校验（SRI + 运行时自检），校验失败拒绝建立 E2E 通道；
3. 校验逻辑尽量早于任何密钥操作执行。

不采用「SPA 由 host 经隧道提供」作为主要方案：首屏仍要过 Hub，收益有限且增加复杂度。

## 7. 租户与授权模型

- **每用户独立 host**：执行分离是天然的，Hub 不需要共享执行沙箱。
- **host 目录**：`host-id` 属于某一用户，只有该用户（及其显式授权的会话）能连接。
- **凭证链**：Hub 登录 → 短期 host token（签名、绑定 host-id/audience/过期）→ host 校验 → 建立 E2E。
- **配额与滥用防护**：Hub 侧按连接数、带宽、并发限制（E2E 下无法按内容计量）。
- **审计**：连接时间、来源、持续时间、断开原因等元数据；不含内容。

## 8. 复用与新建

**已有可复用**：

- Hub 身份与 profile 生命周期，其中 `--profile web` 已是 `dsh-hub` 各命令的一等参数（`install` / `profile apply|share|upgrade|diff|doctor|rollback`）；
- 本地 Web 三件套：`dsh-host-webserver`（HTTP/SPA 座位）、`dsh-web-app`（浏览器 GUI）、`dsh-api-gateway`（双端 RPC）+ `dsh-api-*-controller`；
- `plugins/session-bridge` 的「Unix socket + auth + request/receipt」本地 RPC 模式；
- Hub 现有隐私与遥测工程实践。

**需要新建**：

- Hub 侧 host 注册目录与中继服务、出站隧道协议；
- host 侧 `dscode host up/down/status/revoke` 与隧道客户端；
- passkey 绑定/封装/解封流程与恢复路径；
- Web 下的审批呈现与人机交互；
- **DSCODE 的 web profile**：把服务层插件在 `dsh-web-app` 宿主下跑通，跳过终端专属部分。

## 9. 路线

**P0 · 兼容性摸底（本地，零外部依赖）**
以 `--profile web` 起本地 Web host，逐个挂载 DSCODE 自研插件，记录可用 / 报错，产出一份「web profile 必须改的清单」与最小可用 web profile 雏形。不解锁任何远程访问。

**P1 · 打通可用链路**
Hub 侧 host 目录与中继、host 侧隧道客户端、Hub 登录 + 短期 token 授权、设备列表与撤销、Web 审批交互。此阶段可以**先不做 E2E**（仅在受控环境验证链路），但必须假设 Hub 可见。

**P2 · 达到可承诺的信任水平**
E2E（passkey + 封装/解封）、SPA 可验证构建与哈希校验、审计面板、隐私声明与开源、配额与滥用防护。

## 10. 威胁模型

**防御**：Hub 运营方读取内容（E2E）、未授权访问、凭证重放、中间人、跨租户访问、前端投毒（依赖第 6 节措施）。

**不防御**：用户本机已被入侵、浏览器或扩展被控、用户主动把访问链接交给他人、Hub 拒绝服务。

## 11. 未决问题

1. WebAuthn PRF 的浏览器/平台支持矩阵，以及降级体验的设计细节；
2. 中继服务的实现选型（自建 WSS 转发 vs 引入成熟隧道内核）与自托管方案；
3. E2E 下 Hub 的计费口径（连接/带宽）与配额策略；
4. Web 端审批的用户体验（超时、离线、批量授权）；
5. DSCODE 服务层插件中哪些依赖 macOS（sandbox、keychain、computer-use），在非 macOS host 上的替代方案。
