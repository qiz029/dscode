import { replaceOnce } from './patch-util.mjs';

// dsh-code 1.2.0 moved the local command catalog to i18n: an entry is
// { label, descriptionKey } and both the /help overlay and the completion menu
// resolve it through t(command.descriptionKey). DSCODE's own rows therefore need
// real message keys. Rather than editing upstream's message tables — their key
// union grows every release, so a key missing from a future source merge would
// fail typecheck — the keys are carried here and injected as one extra fallback
// arm of the upstream lookup. That way they resolve for every upstream language
// and survive an upstream rename of an unrelated key.
export const CATALOG_ENTRIES = [
  ['status', 'session, model, permissions and usage', '会话、模型、权限与用量'],
  ['doctor', 'read-only runtime diagnostics', '只读运行时诊断'],
  ['mcp', 'list and manage MCP servers', '列出并管理 MCP 服务器'],
  ['skills', 'skill sources and conflicts', '技能来源与冲突'],
  ['hooks', 'hook configuration and reload', '钩子配置与重载'],
  ['update', 'upgrade DSCODE after this session exits', '本会话退出后升级 DSCODE'],
  ['verbose', 'toggle thinking and tool call details in the chat', '切换对话中的思考与工具调用详情'],
  ['language', 'show or set the interface language: en, zh-CN, zh-TW, ja, ko, es', '查看或设置界面语言：en、zh-CN、zh-TW、ja、ko、es'],
  ['email', 'browse email and steer into this session', '浏览邮件并转入当前会话'],
  ['login', 'save a provider API key locally (/login [deepseek|openrouter])', '在本机保存提供商 API key（/login [deepseek|openrouter]）'],
  ['provider', 'switch between DeepSeek and OpenRouter', '在 DeepSeek 与 OpenRouter 之间切换'],
  ['openrouter', 'OpenRouter account: balance, key usage and 30-day spend', 'OpenRouter 账户：余额、密钥用量与 30 天消费'],
];

const DESCRIPTION_KEY = 'cmd.dscode.';

/**
 * One catalog row in the shape the 1.2.0 renderer reads, tab-indented exactly
 * like the upstream rows. No trailing newline: callers that append the row add
 * their own separator, and a row used as an anchor must match only itself.
 */
export function catalogEntry(name) {
  return `\t{\n\t\tlabel: "/${name}",\n\t\tdescriptionKey: "${DESCRIPTION_KEY}${name}"\n\t},`;
}

/** The row followed by the newline an appended entry leaves after it. */
export function catalogAnchor(name) {
  return catalogEntry(name) + '\n';
}

/**
 * The keys the DSCODE entries resolve through. Upstream ships en and zh, so the
 * lookup switches on the active language name directly.
 */
function messageArm() {
  const arm = (index) => CATALOG_ENTRIES.map(([name, ...texts]) => `\t\t"${DESCRIPTION_KEY}${name}": ${JSON.stringify(texts[index])},`).join('\n');
  return `function dscodeCommandMessages() {
\treturn activeName === "zh" ? {
${arm(1)}
\t} : {
${arm(0)}
\t};
}
`;
}

/**
 * Teach the upstream message lookup the DSCODE command descriptions. The anchor
 * is the 1.2.0 lookup shape, so this refuses to guess on any other release.
 */
export function patchCommandCatalogMessages(text) {
  if (text.includes('function dscodeCommandMessages()')) return text;
  const from = '\treturn (CATALOGS[activeName][key] ?? en[key]).replace(';
  const to = '\treturn (dscodeCommandMessages()[key] ?? CATALOGS[activeName][key] ?? en[key]).replace(';
  text = replaceOnce(text, from, to);
  return replaceOnce(text, 'function t(key, params = {}) {', messageArm() + 'function t(key, params = {}) {');
}
