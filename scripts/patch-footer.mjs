import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { replaceOnce } from './patch-util.mjs';
export function patchFooter(text, root) {
  // Both footer rows now lead with their own left content, so upstream's space-between
  // (a lone child stays at the start) is exactly the alignment the two rows want.
  if (text.includes('// dscode-footer-align')) text = replaceOnce(text,
    'justifyContent: rightParts.length > 0 ? (leftParts.length > 0 ? "space-between" : "flex-end") : void 0 // dscode-footer-align',
    'justifyContent: rightParts.length > 0 ? "space-between" : void 0');
  if (!text.includes('// dscode-footer-width')) text = replaceOnce(text,
    'paddingLeft: 2 + indent,',
    'paddingLeft: 2 + indent,\n        width: columns, // dscode-footer-width');
  const module = JSON.stringify(pathToFileURL(join(root, 'plugins/session-metrics/view.mjs')).href);
  const statement = `import { footerFor as dscodeFooterFor } from ${module};`;
  if (text.includes('// dscode-footer-v1')) return text.replace(/import \{ footerFor as dscodeFooterFor \} from [^\n]+;/, statement);
  text = replaceOnce(text, 'function StatusLine({ facts, stats, busy, columns, items }) {', `function StatusLine({ facts, stats, busy, columns, items }) {
    const [, refreshMetrics] = (0, import_react.useState)(0);
    (0, import_react.useEffect)(() => { const timer = setInterval(() => refreshMetrics(n => n + 1), 1000); return () => clearInterval(timer); }, []);
    facts = { ...facts, telemetry: dscodeFooterFor(facts.fullSessionId, stats, Math.max(1, columns - 6)) };`);
  text = replaceOnce(text, '\t\tfacts.model,', '\t\tfacts.telemetry,\n\t\tfacts.model,');
  text = replaceOnce(text, '\t\t\tmodel: modelLabel,', '\t\t\tfullSessionId: props.sessionKey,\n\t\t\tmodel: modelLabel,');
  text = replaceOnce(text, 'const row2Budget = Math.max(1, budget - 2);', 'const row2Budget = Math.max(0, budget - 2 - (facts.telemetry ? visibleColumns(facts.telemetry) + 3 : 0));');
  text = replaceOnce(text, 'left: row2Kept.map((entry) => entry.group),\n\t\t\tright: [],', 'left: row2Kept.map((entry) => entry.group),\n\t\t\tright: facts.telemetry ? [{ text: facts.telemetry, tone: "value" }] : [],');
  text = replaceOnce(text, 'const row2Present = layout.row2.left.length > 0;', 'const row2Present = layout.row2.left.length > 0 || layout.row2.right.length > 0;');
  return '// dscode-footer-v1\n' + statement + '\n' + text;
}
