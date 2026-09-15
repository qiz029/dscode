import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { replaceOnce } from './patch-util.mjs';

// Auto-compaction prices its threshold from the routed model's cache discount
// (plugins/compaction/threshold.mjs) unless the deployment configured one.
export function patchCompactionBasic(text) {
  const marker = '// dscode-compaction-threshold-v1';
  if (text.includes(marker)) return text;
  text = replaceOnce(text, 'import z from "@deepseek-ai/schemastery";', 'import { pricedCompactionPolicy as dscodePricedCompactionPolicy } from "../../../../plugins/compaction/threshold.mjs";\nimport z from "@deepseek-ai/schemastery";');
  text = replaceOnce(text, '\treturn deepFreeze({\n\t\tthresholdRatio,\n', '\treturn deepFreeze({\n\t\tthresholdRatio,\n\t\tdscodePricedThreshold: config.thresholdRatio === void 0,\n');
  text = replaceOnce(text, 'const spec = resolveCompactSpec(policy, context.contextWindow);', 'const spec = resolveCompactSpec(await dscodePricedCompactionPolicy(this.config, policy), context.contextWindow);');
  return marker + '\n' + text;
}

const UI_START = '// dscode-compaction-ui-start';
const UI_END = '// dscode-compaction-ui-end';
// A running compaction replaces the activity line with the Tetris bot (one
// board row when the terminal is short), and a /model pick whose route would
// compact the current context asks first.
const UI_SOURCE = `${UI_START}
function dscodeTetrisCells(row, palette, key) {
  return [...row].map((cell, index) => (0, import_react.createElement)(Text, { key: key + "-" + index, color: inkColor(cell === "@" ? palette.brandBright : cell === "#" ? palette.brandMid : cell === "=" ? palette.warn : palette.dim) }, cell === "." ? " ." : cell === "=" ? "==" : "[]"));
}
function DscodeCompactionLine({ since, rows, animated = true }) {
  const columns = useStdout().stdout?.columns ?? 80;
  const tick = useFrames(animated ? DSCODE_TETRIS_TICK_MS : 1000);
  const palette = getPalette();
  const board = dscodeTetrisFrame(animated ? tick : 0);
  const clock = runClock(since > 0 ? Math.max(0, Date.now() - since) : 0);
  const room = Math.max(1, columns - 8 - DSCODE_TETRIS_WIDTH * 2);
  const wall = (key) => (0, import_react.createElement)(Text, { key, color: inkColor(palette.dim) }, "|");
  const label = (text, color) => (0, import_react.createElement)(Text, { key: "label", color: inkColor(color), wrap: "truncate-end" }, "  " + truncateColumns(text, room));
  if (columns < DSCODE_TETRIS_WIDTH * 2 + 12) return (0, import_react.createElement)(Box, { paddingX: 2 }, (0, import_react.createElement)(Text, { color: inkColor(palette.brandBright), wrap: "truncate-end" }, truncateColumns(dscodeT("compaction.running") + " · " + clock, Math.max(1, columns - 4))));
  if (rows < 5) return (0, import_react.createElement)(Box, { paddingX: 2 }, wall("left"), ...dscodeTetrisCells(board[board.length - 1], palette, "cell"), wall("right"), label(dscodeT("compaction.running") + " · " + clock, palette.brandBright));
  return (0, import_react.createElement)(Box, { flexDirection: "column", paddingX: 2 },
    ...board.map((row, y) => (0, import_react.createElement)(Box, { key: y }, wall("left"), ...dscodeTetrisCells(row, palette, "cell"), wall("right"),
      y === 1 ? label(dscodeT("compaction.running"), palette.brandBright) : y === 2 ? label(clock, palette.dim) : void 0)),
    (0, import_react.createElement)(Text, { color: inkColor(palette.dim) }, "+" + "-".repeat(DSCODE_TETRIS_WIDTH * 2) + "+"));
}
function DscodeCompactionConfirmPanel({ preview, confirm, back }) {
  const stdout = useStdout().stdout;
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30);
  useStableInput((input, key) => {
    if (key.escape || input === "n") { back(); return; }
    if (input === "y") confirm();
  }, true);
  const palette = getPalette();
  const values = { model: singleLineText(preview.label), used: formatTokens(preview.used), threshold: formatTokens(preview.threshold), window: formatTokens(preview.contextWindow), ratio: Math.round(preview.thresholdRatio * 100) + "%" };
  const title = dscodeT("compaction.confirm.title", values);
  const hint = dscodeT("compaction.confirm.hint");
  if (viewport.maxHeight === 0 || viewport.compact) return (0, import_react.createElement)(Text, { wrap: "truncate-end" }, truncateColumns(title + " · " + hint, viewport.contentColumns));
  const body = [dscodeT("compaction.confirm.usage", values), dscodeT(preview.overflows ? "compaction.confirm.overflow" : "compaction.confirm.next", values)]
    .map((text, index) => (0, import_react.createElement)(Text, { key: "body" + index, color: index === 0 ? void 0 : inkColor(palette.dim), wrap: "truncate-end" }, truncateColumns("  " + text, viewport.contentColumns)))
    .slice(0, viewport.bodyRows);
  return (0, import_react.createElement)(Box, { flexDirection: "column", width: viewport.outerColumns, paddingX: 1, borderStyle: "round", borderColor: inkColor(palette.warn) },
    (0, import_react.createElement)(Text, { color: inkColor(palette.warn), bold: true, wrap: "truncate-end" }, truncateColumns(title, viewport.contentColumns)),
    (0, import_react.createElement)(PanelGap, { visible: viewport.gapRows > 0 }), ...body, (0, import_react.createElement)(PanelGap, { visible: viewport.gapRows > 0 }),
    (0, import_react.createElement)(Text, { color: inkColor(palette.dim), wrap: "truncate-end" }, truncateColumns(hint, viewport.contentColumns)));
}
${UI_END}`;

const IMPORTS = /import \{ TETRIS_TICK_MS as DSCODE_TETRIS_TICK_MS[^\n]*\nimport \{ compactionPreview as dscodeCompactionPreview[^\n]*/;

/** TUI half: projection state, the Tetris indicator and the model-switch confirmation. Runs after the style and provider patches. */
export function patchCompactionTui(text, root) {
  const marker = '// dscode-compaction-v1';
  const url = name => JSON.stringify(pathToFileURL(join(root, 'plugins/compaction', name)).href);
  const imports = `import { TETRIS_TICK_MS as DSCODE_TETRIS_TICK_MS, TETRIS_WIDTH as DSCODE_TETRIS_WIDTH, tetrisFrame as dscodeTetrisFrame } from ${url('tetris.mjs')};\nimport { compactionPreview as dscodeCompactionPreview, pricedThresholdRatio as dscodePricedThresholdRatio } from ${url('threshold.mjs')};`;
  if (text.includes(marker)) {
    const start = text.indexOf(UI_START), end = text.indexOf(UI_END);
    if (!IMPORTS.test(text) || start < 0 || end < start) throw Error('Patched TUI compaction drift');
    return text.slice(0, start).replace(IMPORTS, imports) + UI_SOURCE + text.slice(end + UI_END.length);
  }
  const patch = (from, to) => { text = replaceOnce(text, from, to); };
  // Projection: a compaction runs from its start marker to its end marker; a turn boundary also ends a stale one.
  patch('\t\tbusySince: 0,\n', '\t\tbusySince: 0,\n\t\tdscodeCompactingSince: 0,\n');
  patch('\t\t\tacc.busySince = wasBusy ? acc.busySince : event.time;\n', '\t\t\tacc.busySince = wasBusy ? acc.busySince : event.time;\n\t\t\tacc.dscodeCompactingSince = 0;\n');
  patch('\t\t\tacc.busy = false;\n\t\t\tacc.busySince = 0;\n', '\t\t\tacc.busy = false;\n\t\t\tacc.busySince = 0;\n\t\t\tacc.dscodeCompactingSince = 0;\n');
  patch('\t\tcase "compaction/prune":\n', '\t\tcase "compaction/start":\n\t\t\tacc.dscodeCompactingSince = event.time;\n\t\t\treturn true;\n\t\tcase "compaction/prune":\n');
  patch('\t\t\tacc.compactionTokens.delete(event.data.compactionId);\n\t\t\tappendReplayEntry(acc, {', '\t\t\tacc.compactionTokens.delete(event.data.compactionId);\n\t\t\tacc.dscodeCompactingSince = 0;\n\t\t\tappendReplayEntry(acc, {');
  patch('\t\tbusySince: acc.busySince,\n', '\t\tbusySince: acc.busySince,\n\t\tdscodeCompactingSince: acc.dscodeCompactingSince,\n');
  // Live area: the board takes five rows when there is room, otherwise one.
  patch('\tconst deepDivingVisible = busy;\n', '\tconst dscodeCompacting = view.dscodeCompactingSince > 0;\n\tconst dscodeCompactionRows = !dscodeCompacting ? 0 : dynamicRows >= 12 ? 5 : 1;\n\tconst deepDivingVisible = busy || dscodeCompacting;\n');
  patch('const liveBudget = busy || streamingActive ? Math.max(1, Math.floor(dynamicRows / 3)) : Math.max(0, dynamicRows - (deepDivingVisible ? 1 : 0));',
    'const liveBudget = busy || streamingActive ? Math.max(1, Math.floor((dynamicRows - dscodeCompactionRows) / 3)) : Math.max(0, dynamicRows - (deepDivingVisible ? Math.max(1, dscodeCompactionRows) : 0));');
  patch('transcriptVisible && busy ? (0, import_react.createElement)(DscodeActivityLine, {', 'transcriptVisible && dscodeCompacting ? (0, import_react.createElement)(DscodeCompactionLine, { since: view.dscodeCompactingSince, rows: dscodeCompactionRows, animated: animations }) : transcriptVisible && busy ? (0, import_react.createElement)(DscodeActivityLine, {');
  // Model picks: a route that would compact the current context confirms first.
  patch('\t/** Apply one /model pick: record the selection, close the panel, report via notice. */\n\tconst applyModel = (row, effortId) => {', `\tconst dscodeRequestModel = (row, effortId) => {
\t\tif (props.dscodeCompactionPreview === void 0 || modelLabel === row.provider + "/" + row.model) { applyModel(row, effortId); return; }
\t\tPromise.resolve().then(() => props.dscodeCompactionPreview(row)).then((preview) => {
\t\t\tif (!preview?.compacts) { applyModel(row, effortId); return; }
\t\t\tsetEffortFor(void 0); setProviderOpen(false);
\t\t\tsetProviderAction({ kind: "dscode-compaction", row, effortId, preview }); setModelOpen(true);
\t\t}, () => applyModel(row, effortId));
\t};
\t/** Apply one /model pick: record the selection, close the panel, report via notice. */\n\tconst applyModel = (row, effortId) => {`);
  patch('select: (effortId) => applyModel(effortFor, effortId),', 'select: (effortId) => dscodeRequestModel(effortFor, effortId),');
  patch('const effortId = row.reasoning?.efforts.length === 1 ? row.reasoning.efforts[0].id : void 0;\n\t\t\t\tapplyModel(row, effortId);', 'const effortId = row.reasoning?.efforts.length === 1 ? row.reasoning.efforts[0].id : void 0;\n\t\t\t\tdscodeRequestModel(row, effortId);');
  patch('applyModel(pick.row, pick.effort);', 'dscodeRequestModel(pick.row, pick.effort);');
  patch('\tif (modelOpen && !approvalPending && !questionPending) {\n\t\tif (providerAction?.kind === "dscode-provider")', `\tif (modelOpen && !approvalPending && !questionPending) {
\t\tif (providerAction?.kind === "dscode-compaction") modelSurface = (0, import_react.createElement)(DscodeCompactionConfirmPanel, {
\t\t\tpreview: providerAction.preview,
\t\t\tconfirm: () => applyModel(providerAction.row, providerAction.effortId),
\t\t\tback: () => setProviderAction(void 0)
\t\t});
\t\telse if (providerAction?.kind === "dscode-provider")`);
  patch('function ProviderConfirmPanel({ target, kind, confirm, done, back }) {', UI_SOURCE + '\nfunction ProviderConfirmPanel({ target, kind, confirm, done, back }) {');
  // Host side: the preview measures the live session against the picked route.
  patch("\t/** The /subagent override label, '' when delegated agents follow the current model. */\n\tconst subagentModelLabel = ", `\tconst dscodeCompactionPreviewFor = async (row) => {
\t\tconst meter = ctx.get("tokenMeter");
\t\tconst llm = ctx.get("llm");
\t\tif (active === void 0 || typeof meter?.measure !== "function" || typeof llm?.resolveModelInfo !== "function") return void 0;
\t\tconst used = meter.measure(active.session).totalTokens;
\t\tconst info = await llm.resolveModelInfo(row.provider, row.model);
\t\treturn dscodeCompactionPreview({ used, contextWindow: info?.context?.contextWindow, thresholdRatio: await dscodePricedThresholdRatio(row.provider, row.model), label: row.provider + "/" + row.model });
\t};
\t/** The /subagent override label, '' when delegated agents follow the current model. */\n\tconst subagentModelLabel = `);
  patch('\t\t\tselectModel,\n\t\t\tsubagentModel: subagentModelLabel(),', '\t\t\tselectModel,\n\t\t\tdscodeCompactionPreview: dscodeCompactionPreviewFor,\n\t\t\tsubagentModel: subagentModelLabel(),');
  return `${marker}\n${imports}\n${text}`;
}
