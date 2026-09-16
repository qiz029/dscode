import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { patchText } from './patch-tui.mjs';
import { patchInteraction } from './patch-interaction.mjs';
import { patchSessionBridge } from './patch-session-bridge.mjs';
import { patchIme } from './patch-ime.mjs';
import { patchFooter } from './patch-footer.mjs';
import { patchStyle } from './patch-style.mjs';
import { patchLogin } from './patch-login.mjs';
import { patchWelcome } from './patch-welcome.mjs';
import { patchEffort } from './patch-effort.mjs';
import { patchEmail } from './patch-email.mjs';
import { patchInterrupt } from './patch-interrupt.mjs';
import { patchTurnDivider } from './patch-turn-divider.mjs';
import { patchUserBackground } from './patch-user-background.mjs';
import { patchLargePaste } from './patch-large-paste.mjs';
import { patchImageMarker } from './patch-image-marker.mjs';
import { patchClipboardImage } from './patch-clipboard-image.mjs';
import { patchReview } from './patch-review.mjs';
import { patchProvider } from './patch-provider.mjs';
import { patchModelSearch } from './patch-model-search.mjs';
import { patchCompactionTui } from './patch-compaction.mjs';
import { patchOpenRouterTui } from './patch-openrouter.mjs';
import { patchPickerCommands } from './patch-openrouter.mjs';
import { patchLanguage } from './patch-language.mjs';
import { patchErrors } from './patch-errors.mjs';
import { patchUpdateCheck } from './patch-update-tui.mjs';

// Which TUI patches still apply to the installed dsh-code bundle. Upgrading that package
// rewrites the text our patches anchor on, so this quantifies the breakage in seconds:
//   node scripts/probe-tui-patches.mjs [path/to/dsh-code]
// A patch that throws is drift; its message names the anchor that moved.
const root = join(fileURLToPath(import.meta.url), '..', '..');
// An optional directory lets a candidate bundle be analysed without touching the pinned
// install, so a migration can be prepared in a scratch copy while the repo stays green.
const dir = process.argv[2] === undefined ? join(root, 'node_modules/dsh-code') : process.argv[2];
const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
let text = readFileSync(join(dir, 'lib/index.mjs'), 'utf8');
const steps = [
  ['patchText', () => patchText(text)],
  ['interaction', () => patchInteraction(text)],
  ['sessionBridge', () => patchSessionBridge(text)],
  ['ime', () => patchIme(text)],
  ['footer', () => patchFooter(text, root)],
  ['style', () => patchStyle(text)],
  ['login', () => patchLogin(text)],
  ['welcome', () => patchWelcome(text, version)],
  ['effort', () => patchEffort(text)],
  ['email', () => patchEmail(text)],
  ['interrupt', () => patchInterrupt(text)],
  ['turnDivider', () => patchTurnDivider(text)],
  ['userBackground', () => patchUserBackground(text)],
  ['largePaste', () => patchLargePaste(text)],
  ['imageMarker', () => patchImageMarker(text)],
  ['clipboardImage', () => patchClipboardImage(text, root)],
  ['review', () => patchReview(text)],
  ['provider', () => patchProvider(text)],
  ['modelSearch', () => patchModelSearch(text)],
  ['compaction', () => patchCompactionTui(text, root)],
  ['openRouter', () => patchOpenRouterTui(text)],
  ['pickerCommands', () => patchPickerCommands(text)],
  ['language', () => patchLanguage(text)],
  ['errors', () => patchErrors(text)],
  ['updateCheck', () => patchUpdateCheck(text, version)],
];
const failed = [];
for (const [name, run] of steps) {
  try { text = run(); }
  catch (error) { failed.push(name); console.log(`FAIL ${name}: ${String(error.message).split('\n')[0].slice(0, 90)}`); }
}
console.log(`dsh-code ${manifest.version}: ${steps.length - failed.length}/${steps.length} patches apply`);
if (failed.length > 0) process.exitCode = 1;
