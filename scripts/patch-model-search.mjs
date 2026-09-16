import { replaceOnce } from './patch-util.mjs';

/**
 * The /model picker's rows for one provider, recomputed on every keystroke. Only the
 * session's current provider is listed. Search is BM25 over the model name (weight 3), the
 * model id (2) and the provider (1); letters and digits split into separate tokens, so
 * "glm5" finds GLM 5.3, and the word still being typed matches the tokens it starts ("kim"
 * finds Kimi). Rows matching every word win over rows matching some. Whatever matches is
 * presented in alphabetical order of the displayed label, with digits compared naturally.
 */
export function dscodeFilterModels(rows, query, provider) {
  // One provider at a time: the picker lists the routes the session can actually select.
  const directory = provider === void 0 ? rows : rows.filter(row => row.provider === provider);
  const label = row => String(row.modelName ?? row.model ?? "");
  // Display order is the label itself, so the list reads alphabetically and digits inside a
  // name compare naturally ("GLM 5.2" before "GLM 5.3"); searching narrows rows, never re-ranks them.
  const byLabel = (left, right) => label(left).localeCompare(label(right), void 0, {
    numeric: true,
    sensitivity: "base"
  }) || String(left.model ?? "").localeCompare(String(right.model ?? "")) || String(left.provider ?? "").localeCompare(String(right.provider ?? ""));
  const tokenize = text => String(text ?? '').normalize('NFKC').toLowerCase().match(/[a-z]+|[0-9]+|[^\s\x00-\x7f]+/g) ?? [];
  const raw = String(query ?? '');
  const words = tokenize(raw);
  if (words.length === 0) return [...directory].sort(byLabel);
  const typing = /\s$/.test(raw) ? -1 : words.length - 1;
  const fields = [['modelName', 3], ['model', 2], ['providerName', 1], ['provider', 1]];
  const docs = directory.map(row => {
    const counts = new Map();
    let length = 0;
    for (const [field, weight] of fields) for (const token of tokenize(row[field])) { counts.set(token, (counts.get(token) ?? 0) + weight); length += weight; }
    return { row, counts, length };
  });
  const average = docs.reduce((sum, doc) => sum + doc.length, 0) / Math.max(1, docs.length);
  const frequency = (doc, word, prefix) => {
    if (!prefix) return doc.counts.get(word) ?? 0;
    let sum = 0;
    for (const [token, count] of doc.counts) if (token.startsWith(word)) sum += token === word ? count : count * 0.8;
    return sum;
  };
  const k1 = 1.2, b = 0.75;
  const terms = words.map((word, index) => {
    const matches = docs.map(doc => frequency(doc, word, index === typing));
    const found = matches.filter(value => value > 0).length;
    return { matches, idf: Math.log(1 + (docs.length - found + 0.5) / (found + 0.5)) };
  });
  const scored = docs.map((doc, index) => {
    let score = 0, hits = 0;
    for (const term of terms) {
      const tf = term.matches[index];
      if (tf <= 0) continue;
      hits += 1;
      score += term.idf * tf * (k1 + 1) / (tf + k1 * (1 - b + b * doc.length / average));
    }
    return { row: doc.row, score, hits };
  }).filter(entry => entry.hits > 0);
  const complete = scored.filter(entry => entry.hits === terms.length);
  return (complete.length > 0 ? complete : scored).map(entry => entry.row).sort(byLabel);
}

// The /model panel, serialized over the upstream one: typing searches at once, so letters
// never act as shortcuts. The current model is focused on open; a changed search focuses
// nothing, Enter or an arrow then focuses the first match, and Enter on a focused row selects
// it. Esc clears the search, then closes; Tab opens providers and Ctrl+R retries.
/* global import_react, useStdout, useInput, panelViewport, editQuery, dscodeFilterModels, selectionWindow, Text, Box, PanelGap, inkColor, getPalette, truncateColumns, singleLineText, displayText, dim */
function ModelPanel({ directory, error, current, onSelect, onProviders, onRetry, onClose }) {
  const [cursor, setCursor] = (0, import_react.useState)(0);
  const [dscodeQuery, setDscodeQuery] = (0, import_react.useState)("");
  const [dscodeFocused, setDscodeFocused] = (0, import_react.useState)(true);
  const stdout = useStdout().stdout;
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30);
  const dscodeRows = directory?.rows ?? [];
  // `current` is "provider/model"; the provider never contains "/", so the first segment is it.
  const dscodeProvider = typeof current === "string" && current.includes("/") ? current.slice(0, current.indexOf("/")) : void 0;
  const rows = (0, import_react.useMemo)(() => dscodeFilterModels(dscodeRows, dscodeQuery, dscodeProvider), [dscodeRows, dscodeQuery, dscodeProvider]);
  const positioned = (0, import_react.useRef)(false);
  (0, import_react.useEffect)(() => {
    if (rows.length === 0) {
      if (cursor !== 0) setCursor(0);
      return;
    }
    if (cursor >= rows.length) {
      setCursor(rows.length - 1);
      return;
    }
    if (positioned.current || current === void 0 || dscodeQuery !== "") return;
    const index = rows.findIndex((row) => `${row.provider}/${row.model}` === current);
    if (index >= 0) {
      positioned.current = true;
      setCursor(index);
    }
  }, [rows, cursor, current, dscodeQuery]);
  const search = (next) => {
    setDscodeQuery(next.slice(0, 120));
    setCursor(0);
    setDscodeFocused(false);
  };
  useInput((input, key) => {
    if (key.ctrl && input === "c") { onClose(); return; }
    if (key.escape) {
      if (dscodeQuery === "") { onClose(); return; }
      positioned.current = false;
      setDscodeQuery("");
      setCursor(0);
      setDscodeFocused(true);
      return;
    }
    if (key.tab && onProviders !== void 0) { onProviders(); return; }
    if (key.ctrl && input === "r") { onRetry(); return; }
    if (key.return || key.upArrow || key.downArrow || key.pageUp || key.pageDown) {
      if (rows.length === 0) return;
      if (!dscodeFocused) {
        setCursor(0);
        setDscodeFocused(true);
        return;
      }
      const page = Math.max(1, viewport.bodyRows - 1);
      if (key.return) { if (rows[cursor] !== void 0) onSelect(rows[cursor]); }
      else if (key.upArrow) setCursor(cursor > 0 ? cursor - 1 : rows.length - 1);
      else if (key.downArrow) setCursor(cursor < rows.length - 1 ? cursor + 1 : 0);
      else if (key.pageUp) setCursor((value) => Math.max(0, value - page));
      else setCursor((value) => Math.min(rows.length - 1, value + page));
      return;
    }
    if (key.ctrl && input === "u") { if (dscodeQuery !== "") search(""); return; }
    if (key.ctrl || key.meta) return;
    const next = editQuery(dscodeQuery, input, key);
    if (next !== void 0 && next !== dscodeQuery) search(next);
  });
  const focusRow = dscodeFocused && rows.length > 0;
  const searchText = dscodeQuery === "" ? "type to search" : `search: ${dscodeQuery}`;
  const escape = dscodeQuery === "" ? "esc close" : "esc clears search";
  if (viewport.maxHeight === 0 || viewport.compact) {
    const providers = onProviders === void 0 ? "" : " · tab providers";
    const state = rows.length === 0 ? directory === void 0 && error === void 0 ? "loading…" : error !== void 0 ? "error" : dscodeQuery === "" ? "no models" : "no match"
      : focusRow ? `❯ ${rows[cursor]?.modelName ?? rows[cursor]?.model ?? ""}` : `${rows.length} ${rows.length === 1 ? "match" : "matches"}`;
    return (0, import_react.createElement)(Text, { wrap: "truncate-end" }, truncateColumns(`/model · ${searchText} · ${state}${providers} · ${escape}`, viewport.contentColumns));
  }
  const visibleStateRows = (directory === void 0 && error === void 0 ? [(0, import_react.createElement)(Text, {
    key: "loading",
    dimColor: true,
    wrap: "truncate-end"
  }, "  loading models…")] : error !== void 0 ? [(0, import_react.createElement)(Text, {
    key: "error",
    color: inkColor(getPalette().error),
    wrap: "truncate-end"
  }, truncateColumns(`  ${singleLineText(error)}`, viewport.contentColumns))] : [...directory?.failures.length === 0 ? [] : [(0, import_react.createElement)(Text, {
    key: "failures",
    color: inkColor(getPalette().warn),
    wrap: "truncate-end"
  }, truncateColumns(`  unavailable providers: ${directory?.failures.join(", ")}`, viewport.contentColumns))], ...rows.length === 0 ? [(0, import_react.createElement)(Text, {
    key: "empty",
    dimColor: true,
    wrap: "truncate-end"
  }, dscodeQuery === "" ? "  no models available" : "  no models match the search")] : []]).slice(0, viewport.bodyRows);
  const rowBudget = Math.max(0, viewport.bodyRows - visibleStateRows.length);
  const first = selectionWindow(cursor, rows.length, rowBudget);
  const visible = rowBudget === 0 ? [] : rows.slice(first, first + rowBudget);
  const count = rows.length === 0 ? "" : focusRow ? ` · ${cursor + 1}/${rows.length}` : ` · ${rows.length} ${rows.length === 1 ? "match" : "matches"}`;
  return (0, import_react.createElement)(Box, {
    flexDirection: "column",
    width: viewport.outerColumns,
    paddingX: 1,
    borderStyle: "round",
    borderColor: inkColor(getPalette().brand)
  }, (0, import_react.createElement)(Text, {
    color: inkColor(getPalette().brand),
    bold: true,
    wrap: "truncate-end"
  }, truncateColumns(`/model — select model${count} · ${searchText}`, viewport.contentColumns)), (0, import_react.createElement)(PanelGap, { visible: viewport.gapRows > 0 }), ...visibleStateRows, ...visible.map((row) => {
    const index = rows.indexOf(row);
    const focused = focusRow && index === cursor;
    const capability = row.inputModalities?.includes("image") === true ? " · image" : "";
    const label = displayText(`${row.providerName} · ${row.modelName}${capability}`);
    return (0, import_react.createElement)(Text, {
      key: `${row.provider}/${row.model}`,
      color: focused ? inkColor(getPalette().brandBright) : inkColor(getPalette().dim),
      wrap: "truncate-end"
    }, truncateColumns(`${focused ? "❯ " : "  "}${label}`, viewport.contentColumns));
  }), (0, import_react.createElement)(PanelGap, { visible: viewport.gapRows > 0 }), (0, import_react.createElement)(Text, {
    dimColor: true,
    wrap: "truncate-end"
  }, dim(truncateColumns(`type to search · ↑↓ move · enter ${focusRow ? "select" : "focus first match"}${onProviders === void 0 ? "" : " · tab providers"} · ctrl+r retry · ${escape}`, viewport.contentColumns))));
}

const MARKER = '// dscode-model-search-v3';
const PREVIOUS = /\/\/ dscode-model-search-v[12]\b/;

// OpenRouter serves its whole catalog, so /model searches as you type. Opening /model
// also clears the inert pi-ai OpenRouter profile earlier builds wrote. v1 and v2 edited the
// upstream panel in place; v3 replaces it whole, so a patched or pristine bundle ends identical.
export function patchModelSearch(text) {
  if (!text.includes(MARKER) && !PREVIOUS.test(text)) {
    text = replaceOnce(text, '\t\t\tloadModels: () => loadModelDirectory(ctx),', '\t\t\tloadModels: () => dscodeMigrateOpenRouter(ctx.get("settings")).then(() => loadModelDirectory(ctx)),');
    text = `${MARKER}\nimport { migrateOpenRouterProfile as dscodeMigrateOpenRouter } from "./dscode-providers/catalog.mjs";\n${text}`;
  } else text = text.replace(PREVIOUS, MARKER);
  const panel = text.indexOf('\nfunction ModelPanel(');
  if (panel < 0) throw new Error('Pinned runtime patch drift: ModelPanel');
  const search = text.indexOf('function dscodeFilterModels(');
  const start = search >= 0 && search < panel ? search : panel + 1;
  const end = text.indexOf('\n}\n', panel + 1);
  if (end < 0) throw new Error('Pinned runtime patch drift: ModelPanel end');
  return text.slice(0, start) + dscodeFilterModels.toString() + '\n' + ModelPanel.toString() + text.slice(end + 2);
}
