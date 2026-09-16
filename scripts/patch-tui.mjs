import { replaceOnce } from './patch-util.mjs';
import { CATALOG_ENTRIES, catalogEntry, patchCommandCatalogMessages } from './patch-command-catalog.mjs';
import { readFileSync, writeFileSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { patchIme } from './patch-ime.mjs';
import { patchInteraction } from './patch-interaction.mjs';
import { patchFooter } from './patch-footer.mjs';
import { patchSessionBridge } from './patch-session-bridge.mjs';
import { patchStyle } from './patch-style.mjs';
import { patchLogin } from './patch-login.mjs';
import { patchWelcome } from './patch-welcome.mjs';
import { patchEffort } from './patch-effort.mjs';
import { patchEmail } from './patch-email.mjs';
import { patchFrame } from './patch-frame.mjs';
import { patchInterrupt } from './patch-interrupt.mjs';
import { patchTurnDivider } from './patch-turn-divider.mjs';
import { patchLanguage } from './patch-language.mjs';
import { patchUserBackground } from './patch-user-background.mjs';
import { patchLargePaste } from './patch-large-paste.mjs';
import { patchImageMarker } from './patch-image-marker.mjs';
import { patchClipboardImage } from './patch-clipboard-image.mjs';
import { patchReview } from './patch-review.mjs';
import { patchProvider } from './patch-provider.mjs';
import { patchModelSearch } from './patch-model-search.mjs';
import { patchCompactionTui } from './patch-compaction.mjs';
import { patchOpenRouterTui, patchPickerCommands } from './patch-openrouter.mjs';
import { patchUpdateCheck } from './patch-update-tui.mjs';
import { patchErrors } from './patch-errors.mjs';
import { patchShellMode } from './patch-shell-mode.mjs';

export function patchText(text) {
  const before = '\t\t\tif (text === "/clear") {\n\t\t\t\trefresh();\n\t\t\t\tclearView();\n\t\t\t\tdismissNotice();\n\t\t\t\treturn;\n\t\t\t}';
  const after = '\t\t\tif (text === "/clear") {\n\t\t\t\t// dscode: new context, existing session stays resumable.\n\t\t\t\tif (busy) { notify("stop the running turn before /clear", "warning"); return; }\n\t\t\t\tcreateSession();\n\t\t\t\treturn;\n\t\t\t}';
  if (text.includes(after)) return text;
  if (text.split(before).length !== 2) throw new Error('Unsupported DSH-Code /clear implementation; refusing an ambiguous patch');
  return text.replace(before, after).replace('description: "clear the screen"', 'description: "clear screen and start a new session (Ctrl+L: screen only)"');
}
export function patchTui(root) {
  const dir = join(root, 'node_modules/dsh-code');
  if (JSON.parse(readFileSync(join(dir, 'package.json'))).version !== '1.2.0') throw new Error('Revalidate TUI patch before upgrading dsh-code');
  const path = join(dir, 'lib/index.mjs');
  const before = readFileSync(path, 'utf8');
  let after = patchText(before);
  // The 0.7.x generation patched the TUI into a full-screen in-place viewport and
  // deleted the upstream Static rows; that text cannot be repaired in place.
  if (after.includes('// dscode-viewport-v1')) throw new Error('This installation carries the DSCODE in-place viewport generation; refresh the dependencies (npm ci) before starting the native-scrollback build.');
  const anchor = 'const LOCAL_COMMANDS = [';
  const catalogMarker = '// dscode: startup command discovery';
  // 1.2.0 resolves every catalog row through t(descriptionKey) and its message lookup gains
  // the DSCODE keys; the older generation reads a literal description per row.
  const keyedCatalog = after.includes('(CATALOGS[activeName][key] ?? en[key])');
  if (keyedCatalog) {
    if (!after.includes(catalogMarker)) {
      if (after.split(anchor).length !== 2) throw new Error('Unsupported TUI command catalog');
      after = after.replace(anchor, anchor + '\n' + catalogMarker + '\n' + CATALOG_ENTRIES.map(([name]) => catalogEntry(name)).join('\n') + '\n');
    } else {
      // A tree provisioned by an earlier release keeps its patched catalog, so entries added
      // since then are appended one by one instead of being skipped with the marker.
      for (const [name] of CATALOG_ENTRIES) {
        const entry = catalogEntry(name);
        if (after.includes(entry)) continue;
        after = replaceOnce(after, catalogMarker + '\n', catalogMarker + '\n' + entry + '\n');
      }
    }
    after = patchCommandCatalogMessages(after);
  } else if (!after.includes(catalogMarker)) {
    if (after.split(anchor).length !== 2) throw new Error('Unsupported TUI command catalog');
    after = after.replace(anchor, anchor + '\n' + catalogMarker + '\n' + CATALOG_ENTRIES.map(([name]) => JSON.stringify({ label: '/' + name, description: CATALOG_ENTRIES.find(([entry]) => entry[0] === name)[1] })).join('\n') + '\n');
  }
  after = patchInteraction(after);
  after = patchSessionBridge(after);
  after = patchIme(after);
  after = patchFooter(after, root);
  after = patchStyle(after);
  after = patchLogin(after);
  after = patchWelcome(after, JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
  after = patchEffort(after);
  after = patchEmail(after);
  after = patchFrame(after);
  after = patchInterrupt(after);
  after = patchTurnDivider(after);
  after = patchUserBackground(after);
  after = patchLargePaste(after);
  after = patchImageMarker(after);
  after = patchClipboardImage(after, root);
  after = patchReview(after);
  after = patchProvider(after);
  after = patchModelSearch(after);
  after = patchCompactionTui(after, root);
  after = patchOpenRouterTui(after);
  after = patchPickerCommands(after);
  after = patchLanguage(after);
  after = patchErrors(after);
  after = patchShellMode(after);
  after = patchUpdateCheck(after, JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version);
  cpSync(new URL('../plugins/email/', import.meta.url), join(dir, 'lib/dscode-email'), { recursive: true });
  cpSync(new URL('../plugins/providers/', import.meta.url), join(dir, 'lib/dscode-providers'), { recursive: true });
  if (before !== after) writeFileSync(path, after);
}
