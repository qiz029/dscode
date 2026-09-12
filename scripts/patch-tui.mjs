import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { patchIme } from './patch-ime.mjs';
import { patchInteraction } from './patch-interaction.mjs';
import { patchFooter } from './patch-footer.mjs';
import { patchSessionBridge } from './patch-session-bridge.mjs';
import { patchStyle } from './patch-style.mjs';

export function patchText(text) {
  const before = '\t\t\tif (text === "/clear") {\n\t\t\t\trefresh();\n\t\t\t\tclearView();\n\t\t\t\tdismissNotice();\n\t\t\t\treturn;\n\t\t\t}';
  const after = '\t\t\tif (text === "/clear") {\n\t\t\t\t// dscode: new context, existing session stays resumable.\n\t\t\t\tif (busy) { notify("stop the running turn before /clear", "warning"); return; }\n\t\t\t\tcreateSession();\n\t\t\t\treturn;\n\t\t\t}';
  if (text.includes(after)) return text;
  if (text.split(before).length !== 2) throw new Error('Unsupported DSH-Code /clear implementation; refusing an ambiguous patch');
  return text.replace(before, after).replace('description: "clear the screen"', 'description: "clear screen and start a new session (Ctrl+L: screen only)"');
}
export function patchTui(root) {
  const dir = join(root, 'node_modules/dsh-code');
  if (JSON.parse(readFileSync(join(dir, 'package.json'))).version !== '1.0.6') throw new Error('Revalidate TUI patch before upgrading dsh-code');
  const path = join(dir, 'lib/index.mjs');
  const before = readFileSync(path, 'utf8');
  let after = patchText(before);
  const anchor = 'const LOCAL_COMMANDS = [';
  if (!after.includes('// dscode: startup command discovery')) {
    if (after.split(anchor).length !== 2) throw new Error('Unsupported TUI command catalog');
    const commands = [['status', 'session, model, permissions and usage'], ['doctor', 'read-only runtime diagnostics'], ['mcp', 'list and manage MCP servers'], ['skills', 'skill sources and conflicts'], ['hooks', 'hook configuration and reload']];
    after = after.replace(anchor, anchor + '\n// dscode: startup command discovery\n' + commands.map(([name, description]) => JSON.stringify({ label: '/' + name, description }) + ',').join('\n'));
  }
  after = patchInteraction(after);
  after = patchSessionBridge(after);
  after = patchIme(after);
  after = patchFooter(after, root);
  after = patchStyle(after);
  if (before !== after) writeFileSync(path, after);
}
