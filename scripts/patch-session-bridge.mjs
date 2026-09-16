import { replaceOnce } from './patch-util.mjs';

export function patchSessionBridge(text) {
  if (text.includes('// dscode-session-relay-v1')) return text;
  const relay = 'dscodeVisibleRelay(message)';
  const entry = '\n\t\t\t\tappendReplayEntry(acc, {';
  // 1.2.0 admits reminder-plugin messages through the same replay branch, and the relay
  // plugin is not one of them, so each generation's condition is extended in place.
  const reminder = 'message.source.kind === "plugin" && REMINDER_PLUGINS.has(message.source.plugin)';
  const keyed = 'if (message.source.kind === "user" || ' + reminder + ') {' + entry;
  const bare = 'if (message.source.kind === "user") {' + entry;
  if (text.includes(keyed)) text = replaceOnce(text, keyed, 'if (message.source.kind === "user" || ' + relay + ' || ' + reminder + ') {' + entry);
  else text = replaceOnce(text, bare, 'if (message.source.kind === "user" || ' + relay + ') {' + entry);
  return '// dscode-session-relay-v1\nfunction dscodeVisibleRelay(message) {\n  return message.source.kind === "plugin" && message.source.plugin === "dscode-session-bridge" && message.source.form === "relay";\n}\n' + text;
}
