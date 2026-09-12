import { replaceOnce } from './patch-runtime.mjs';
export function patchSessionBridge(text) {
  if (text.includes('// dscode-session-relay-v1')) return text;
  return '// dscode-session-relay-v1\nfunction dscodeVisibleRelay(message) {\n  return message.source.kind === "plugin" && message.source.plugin === "dscode-session-bridge" && message.source.form === "relay";\n}\n' + replaceOnce(text,
    'if (message.source.kind === "user") {\n\t\t\t\tappendReplayEntry(acc, {',
    'if (message.source.kind === "user" || dscodeVisibleRelay(message)) {\n\t\t\t\tappendReplayEntry(acc, {');
}
