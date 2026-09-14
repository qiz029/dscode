import { replaceOnce } from './patch-runtime.mjs';

/**
 * Models matching a /model search: every whitespace-separated word must appear in the
 * provider name, model name or `provider/model` id, ignoring case.
 */
export function dscodeFilterModels(rows, query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return rows;
  return rows.filter((row) => {
    const haystack = [row.providerName, row.modelName, row.provider + '/' + row.model].filter(Boolean).join(' ').toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}

// OpenRouter serves its whole catalog, so /model gains a search: `/` or Ctrl+F starts
// it, typed text filters the list, Esc leaves it and clears the filter, and ↑↓ and
// Enter keep working while typing. Opening /model also replaces the narrow OpenRouter
// profile that 0.7.3 to 0.7.5 wrote, so existing routes list every model too.
export function patchModelSearch(text) {
  const marker = '// dscode-model-search-v1';
  if (text.includes(marker)) return text;
  const patch = (from, to) => { text = replaceOnce(text, from, to); };
  patch('function ModelPanel({ directory, error, current, onSelect, onProviders, onRetry, onClose }) {\n\tconst [cursor, setCursor] = (0, import_react.useState)(0);\n\tconst stdout = useStdout().stdout;\n\tconst viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30);\n\tconst rows = directory?.rows ?? [];',
    dscodeFilterModels.toString() + '\nfunction ModelPanel({ directory, error, current, onSelect, onProviders, onRetry, onClose }) {\n\tconst [cursor, setCursor] = (0, import_react.useState)(0);\n\tconst [dscodeQuery, setDscodeQuery] = (0, import_react.useState)("");\n\tconst [dscodeSearching, setDscodeSearching] = (0, import_react.useState)(false);\n\tconst stdout = useStdout().stdout;\n\tconst viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30);\n\tconst dscodeRows = directory?.rows ?? [];\n\tconst rows = (0, import_react.useMemo)(() => dscodeFilterModels(dscodeRows, dscodeQuery), [dscodeRows, dscodeQuery]);');
  patch('if (key.escape || input === "q") {\n\t\t\tonClose();\n\t\t\treturn;\n\t\t}\n\t\tif (input === "r") {\n\t\t\tonRetry();', `if (dscodeSearching) {
\t\t\tif (key.escape) {
\t\t\t\tsetDscodeSearching(false);
\t\t\t\tsetDscodeQuery("");
\t\t\t\tsetCursor(0);
\t\t\t\treturn;
\t\t\t}
\t\t\tif (key.return) {
\t\t\t\tsetDscodeSearching(false);
\t\t\t\tif (rows[cursor] !== void 0) onSelect(rows[cursor]);
\t\t\t\treturn;
\t\t\t}
\t\t\tif (!(key.upArrow || key.downArrow || key.pageUp || key.pageDown || key.ctrl && input === "c")) {
\t\t\t\tconst next = editQuery(dscodeQuery, input, key);
\t\t\t\tif (next !== void 0) {
\t\t\t\t\tsetDscodeQuery(next.slice(0, 120));
\t\t\t\t\tsetCursor(0);
\t\t\t\t}
\t\t\t\treturn;
\t\t\t}
\t\t} else if (input === "/" || isSearchToggle(input, key)) {
\t\t\tsetDscodeSearching(true);
\t\t\treturn;
\t\t}
\t\tif (key.escape || input === "q") {\n\t\t\tonClose();\n\t\t\treturn;\n\t\t}\n\t\tif (input === "r") {\n\t\t\tonRetry();`);
  patch('/model — select model${rows.length === 0 ? "" : ` · ${cursor + 1}/${rows.length}`}', '/model — select model${rows.length === 0 ? "" : ` · ${cursor + 1}/${rows.length}`}${dscodeSearching || dscodeQuery !== "" ? ` · ${searchLine(dscodeSearching, dscodeQuery)}` : ""}');
  patch('"  no models available")] : []]).slice(0, viewport.bodyRows);', 'dscodeQuery === "" ? "  no models available" : "  no models match the search")] : []]).slice(0, viewport.bodyRows);');
  patch('↑↓ move · pgup/pgdn page · enter select${onProviders === void 0 ? "" : " · tab providers"} · r retry · esc/q close', '↑↓ move · pgup/pgdn page · ${dscodeSearching ? "esc clears search" : "/ search"} · enter select${onProviders === void 0 ? "" : " · tab providers"} · r retry · esc/q close');
  patch('\t\t\tloadModels: () => loadModelDirectory(ctx),', '\t\t\tloadModels: () => dscodeMigrateOpenRouter(ctx.get("settings")).then(() => loadModelDirectory(ctx)),');
  return `${marker}\nimport { migrateOpenRouterProfile as dscodeMigrateOpenRouter } from "./dscode-providers/catalog.mjs";\n${text}`;
}
