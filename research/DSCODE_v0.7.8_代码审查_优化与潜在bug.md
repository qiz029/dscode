# DSCODE v0.7.8 代码审查：可优化点与潜在 Bug

- 日期：2025-09-15（会话内审查，HEAD = ec558f6，工作树干净）
- 基线验证：`node scripts/checks.mjs unit` → 226 pass / 0 fail（8.0s）
- 覆盖范围：逐行细读 openrouter（wire/adapter/models/account）、session-bridge 全部（mailbox/communication/server/client/paths）、auto-review（index/policy/audit）、code-review（index/git/baseline）、email（smtp/gmail）、memory、session-metrics（index/attribution/rate）、ultra、providers/effort、exec、scripts（composition/harness/release）；其余插件与 patch/verify 脚本做模式扫描（exec 注入、eval、浮动 Promise、setInterval 泄漏等），未逐行读。

## 一句话结论

整体工程质量高于同类外壳项目：安全边界、幂等、预算、原子写都有明确设计；本次确认 4 个值得修的问题（1 个安全加固 + 3 个健壮性 bug），另有若干小加固点，无阻断性缺陷。

## 确认的问题（建议修复）

### 1.（安全）sysctl 提权逃生舱允许写操作 — plugins/auto-review/policy.mjs
`escalationDiagnosticGrant` 的意图是「只读诊断才允许免人提权」，但 `sysctl` 在白名单里，且 `SHELL_META` 不含 `=`、不限制参数。`shell_retry` 带 `sandbox_permissions` 且 `command` 为 `sysctl -w kern.xxx=0`（无任何 shell 元字符）会被自动授予 `allowed-once`。同类还有 `hostname <name>`（改主机名）、`date -s`。在普通用户下这些命令会因无 root 失败，但白名单声明的不可变量（"cannot change state"）已被打破，任何提权/守护进程场景都会放大。
建议：对 sysctl 只允许 `-n <key>` / `<key>` 形式（拒绝 `-w`、`=`），hostname/date 仅允许无参数，或干脆移出白名单。

### 2.（健壮性）code-review untracked() 的 TOCTOU — plugins/code-review/git.mjs
`ls-files` 枚举与 `lstat(full)` 之间文件被删除（构建产物很常见）时，`lstat` 抛 ENOENT 且无捕获，整个 review 直接报 error，而不是把该文件记入 omitted。建议给 `lstat`/`readFile` 包 try/catch，失败计入 omitted。

### 3.（健壮性）auto-review 审计文件坏行会打断审批链 — plugins/auto-review/audit.mjs
`auditStore.read` 逐行 `JSON.parse` 无 try/catch；进程崩溃留下的半行 JSON 会让之后每次 `audit.read` 抛错。而 `review()` 中 `contextFor(..., audit.read(...))` 位于 try 块之外，异常会穿透 approval/request 处理器，auto-review 整体失效直到手工修文件。建议逐行 try/catch 跳过坏行；顺带：审计 JSONL 无上限、每次 review 全量重读，长会话为 O(n)，可加截断/游标。

### 4.（健壮性）session-bridge recover 失败后无恢复路径 — plugins/session-bridge/communication.mjs
`state.ready = background(recover(state))`，`preStep` 中 `await state.ready` 会重抛 recover 的异常。recover 无内部容错：一次存储层错误（磁盘满、DB 锁等）会让该 agent 之后所有 preStep 永远失败（fail closed 本身合理，但缺恢复手段，等于永久 brick 该会话）。建议：recover 内部 catch 记日志，或将 ready 改成「失败后允许重跑一次恢复」。

## 小加固点（低优先级）

- `client.mjs discover()`：单个陈旧 socket 的非 ECONNREFUSED/ENOENT 错误（如 EACCES）会让 `dscode sessions` 整体失败；建议单端点失败降级为 []。
- `providers/effort.mjs chooseEffort()`：wanted 不在 EFFORT_LEVELS（如将来传 'ultra'）时返回 undefined 而不是就近映射或报错。当前调用点都传 'low' 或已校验值，属于埋雷。
- `mailbox.mjs admit()`：超过 7 天（链已被 prune）的超晚 reply 报 `invalid_chain` 而非干净的 late 语义，错误信息误导排查。
- `harness.mjs main()`：重复调用会重复注册 SIGTERM/SIGHUP 监听（测试场景）。
- `release.mjs` 入口判断未像 harness 那样 `resolve(process.argv[1])`，相对路径执行时会被当成库导入；目前 npm script 全是绝对路径调用，无实际影响。
- 项目没有 lint 脚本；代码风格一致性目前靠人工，可考虑加轻量 lint。

## 值得肯定的设计（保持现状即可）

- openrouter 适配层：idle 计时只测 provider 不测慢消费者、错误码三级路由（metadata.error_type → 状态码 → 文案）、qwen 显式缓存断点、SSE 解析含 keep-alive 与跨 chunk 缓冲。
- session-bridge mailbox：`BEGIN IMMEDIATE` 事务、幂等指纹防重放、链预算/深度/环检测、逐 recipient 的事件修剪、WAL+busy_timeout、先 expire 再统计。
- 邮件：先落盘 receipt 再 SMTP（崩溃不盲重发）、uncertain 语义、catch 吞掉可能含密钥的 SMTP 错误。
- auto-review：审计→上下文→模型→绑定 pending invocation 的完整闭环，无授权缓存，redact 在输入输出两侧生效。
- 基线快照：影子 bare 仓库 + throwaway index，从不触碰工作区；敏感文件与超大文件排除；ref 按 session 前缀隔离且只留最新任务。

## 建议跟踪指标

- 修复 #1 后跑 `npm run test:unit`（含 auto-review 用例）+ `npm run test:ui`（若涉及 footer/审批 UI）。
- #2/#3 建议各补一个单测：untracked 中途消失、audit 文件含坏行。

## 后续可选方向

- compaction、i18n、tui-tools、clipboard-image、worktree-subagent、session-cards、email-tools、credentials 及 60+ patch/verify 脚本尚未逐行审读，可按模块继续。
- 可为 review diff 收集加「文件级进度/缓存」，减少 resume 后重复全量扫描。

## 修复记录（2025-09-15 同日落地）

四个确认问题全部修复，并新增 lint 脚本；基线验证：`npm run lint` 0 错误（ESLint 10.10.0），`node scripts/checks.mjs unit` 229 pass / 0 fail。

1. sysctl 逃生舱：`escalationDiagnosticGrant` 现拒绝 `sysctl -w`、赋值形 key、以及带参数的 `hostname`/`date`；测试扩充 4 个变体（tests/auto-review.test.mjs）。
2. untracked TOCTOU：`lstat`/`readFile` 包 try/catch，消失或不可读文件计入 omitted 并导出 `untracked` 供测试；新增不可读文件用例（tests/code-review.test.mjs）。
3. audit 坏行：逐行 try/catch 跳过；新增崩溃残留半行用例（tests/auto-review.test.mjs）。
4. recover 卡死：`CommunicationService.ensureReady` 失败后允许下一步重试；新增重试用例（tests/communication.test.mjs）。

Lint 接入：

- `npm run lint`（`eslint .`，flat config `eslint.config.mjs`），并纳入 `npm run check` 链首。
- devDependencies：eslint ^10.10.0、@eslint/js ^10.0.1、globals ^17.12.0。
- 忽略面：5 个序列化进 TUI 的模板文件（email-panel/imap-panel/patch-effort/patch-model-search/patch-welcome，`import_react` 等由 patcher 绑定）；测试目录放宽 no-unused-vars/require-yield/no-empty（测试桩形态）；`no-control-regex` 关闭（控制字符正则是有意为之）；`no-empty` 允许空 catch（代码库惯用法）。
- 顺带修复 lint 暴露的真实问题：email store/inbox 与两个 verify 脚本 finally 中 throw 会吞掉原始结果/错误（改为 best-effort 清理）；checks.mjs 完整性检查重构为不吞套件错误；6 处 catch 补 `{ cause }`；git.mjs 两处无用赋值；多个无用导入/未用变量与转义修正。
