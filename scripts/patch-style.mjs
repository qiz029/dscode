import { replaceOnce } from './patch-util.mjs';

// The footer's second row leads with the model (`provider: model @ effort`), while the
// status line's first row leads with the session title — falling back to the model while
// the session has no title yet.
export const FOOTER_ROWS_SOURCE = `
function dscodeFooterHeader(facts, stats) {
  const raw = typeof facts?.model === "string" ? facts.model : "";
  if (raw === "") return "";
  const cut = raw.indexOf("/");
  const provider = cut > 0 ? raw.slice(0, cut) : "";
  const model = cut > 0 ? raw.slice(cut + 1) : raw;
  const effort = typeof facts?.effort === "string" && facts.effort !== "" ? facts.effort : (typeof stats?.reasoningEffort === "string" ? stats.reasoningEffort : "");
  return (provider === "" ? model : provider + ": " + model) + (effort === "" ? "" : " @ " + effort);
}
function dscodeStatusLead(facts, model, effort) {
  const source = facts?.title !== void 0 && facts.title !== "" ? facts.title : facts?.sessionId;
  const title = source === void 0 || source === "" ? "" : truncateColumns(safe(source), TITLE_BUDGET);
  if (title !== "") return title;
  return effort === "" ? model : model + " \uff5c " + effort;
}
`;
const FOOTER_ROW_ANCHORS = {
  modelGuard: '\tif (model !== "" && enabled.has("model")) {',
  modelText: [
    '\t\t\ttext: effort === "" ? model : `${model}@${effort}`,',
    '\t\t\ttext: effort === "" ? model : `${model} \uff5c ${effort}`,',
  ],
  titleRow: '\tconst label = truncateColumns(safe(facts.title !== void 0 && facts.title !== "" ? facts.title : facts.sessionId), TITLE_BUDGET);\n\tif (label !== "" && enabled.has("title")) row2.push({\n\t\tgroup: { spans: [{\n\t\t\ttext: label,\n\t\t\ttone: "meta"\n\t\t}] },\n\t\trank: RANK_TITLE,\n\t\tid: "title"\n\t});',
  permission: '\tif (permission !== "" && enabled.has("permission")) {\n\t\tright.push({\n\t\t\tspan: {\n\t\t\t\ttext: permission,\n\t\t\t\ttone: permissionTone(permission)\n\t\t\t},\n\t\t\trank: RANK_BADGE,\n\t\t\tid: "permission"\n\t\t});\n\t\tbadge = right.length - 1;\n\t}',
};
const PERMISSION_LEFT = '\tif (permission !== "" && enabled.has("permission")) {\n\t\t// dscode-footer-rows-v1: the permission rides row 1 next to the title.\n\t\tleft.push({\n\t\t\tgroup: { spans: [{\n\t\t\t\ttext: permission,\n\t\t\t\ttone: permissionTone(permission)\n\t\t\t}] },\n\t\t\trank: RANK_BADGE,\n\t\t\tid: "permission"\n\t\t});\n\t\tbadge = left.length - 1;\n\t}';
/** Row 1 carries `title | permission`; the model moves into the footer telemetry header. */
export function footerRows(text) {
  if (text.includes('// dscode-footer-rows-v1')) return text;
  const forms = FOOTER_ROW_ANCHORS.modelText.filter(candidate => text.includes(candidate));
  if (forms.length !== 1) throw new Error('Unsupported DSH-Code status line anchors; refusing an ambiguous footer row patch');
  text = replaceOnce(text, FOOTER_ROW_ANCHORS.modelGuard, '\t// dscode-footer-rows-v1: the title leads row 1, the model rides the footer header.\n\tif ((model !== "" && enabled.has("model")) || enabled.has("title")) {');
  text = replaceOnce(text, forms[0], '\t\t\ttext: dscodeStatusLead(facts, model, effort),');
  text = replaceOnce(text, FOOTER_ROW_ANCHORS.titleRow, '\t// dscode-footer-rows-v1: the title moved to the identity lead on row 1.');
  return replaceOnce(text, FOOTER_ROW_ANCHORS.permission, PERMISSION_LEFT);
}

// Keep the presentation changes together; patch the pinned upstream renderer
// without adding a second UI framework or touching its input/IME ownership.
export function patchStyle(text) {
  if (text.includes('// dscode-style-v1')) {
    let patched = text
    .replace('...DEFAULT_STATUSLINE_ITEMS.filter((id) => !seen.has(id))', '...STATUS_ITEMS.map(item => item.id).filter((id) => !seen.has(id))')
    .replace('const summary = "agents " + counts + " · /agents";', agentSummary)
    .replace(': " · " + runClock(elapsed);', ': " · " + dscodeT("activity.turn") + " " + runClock(elapsed);')
    .replace(': " · 本轮 " + runClock(elapsed);', ': " · " + dscodeT("activity.turn") + " " + runClock(elapsed);')
    .replace(agentSummaryV1, agentSummary)
    .replace('[running.length + " running", idle ? idle + " idle" : "", done ? done + " done" : "", total > rows.length ? total + " total" : ""]', '[running.length + " " + dscodeT("agents.running"), idle ? idle + " " + dscodeT("agents.idle") : "", done ? done + " " + dscodeT("agents.done") : "", total > rows.length ? total + " " + dscodeT("agents.total") : ""]')
    .replace('Math.floor(columns / 2) - 4', 'Math.min(columns - 8, Math.max(40, Math.floor(columns * 0.8) - 4))')
    .replace('Math.floor(columns * 0.6) - 4', 'Math.min(columns - 8, Math.max(40, Math.floor(columns * 0.8) - 4))')
    .replace('telemetry: columns >= 64 ?', 'telemetry: columns >= 48 ?')
    .replace('const STATUS_ITEM_SEPARATOR = " · ";', 'const STATUS_ITEM_SEPARATOR = " ｜ ";')
    .replace('function sep() {\n\treturn {\n\t\ttext: " · ",', 'function sep() {\n\treturn {\n\t\ttext: " ｜ ",')
    .replace('`${model} · ${effort}`', '`${model} ｜ ${effort}`')
    .replace('const groupSeparator = visibleColumns(" | ");', 'const groupSeparator = visibleColumns(" ｜ ");')
    .replace('}, " | "));', '}, " ｜ "));')
    .replace(/const row2Budget = Math\.max\(0, budget - 2 - \(facts\.telemetry \? visibleColumns\(facts\.telemetry\) \+ [234] : 0\)\);/, 'const row2Budget = Math.max(0, budget - 1 - (facts.telemetry ? visibleColumns(facts.telemetry) + 3 : 0));')
    .replace('key: key + "divider", color: inkColor(getPalette().dim) }, " ｜ "));', 'key: key + "divider", color: inkColor(getPalette().dim) }, "｜ "));')
    .replace('key: key + "divider", color: inkColor(getPalette().dim) }, "｜"));', 'key: key + "divider", color: inkColor(getPalette().dim) }, "｜ "));')
    .replace('const rightParts = [];\n\t\trow.right.forEach', 'const rightParts = [];\n        if (key === "s2" && row.left.length > 0 && row.right.length > 0) rightParts.push((0, import_react.createElement)(Text, { key: key + "divider", color: inkColor(getPalette().dim) }, "｜ "));\n\t\trow.right.forEach');
    if (!patched.includes('// dscode-tps-colors-v1')) patched = patched.replace('function dscodeActivity(entries, streaming) {', tpsColorSource + '\nfunction dscodeActivity(entries, streaming) {');
    if (!patched.includes('// dscode-footer-rows-v1')) {
      if (!patched.includes('function dscodeFooterHeader(')) patched = FOOTER_ROWS_SOURCE + '\n' + patched;
      patched = patched.replace('dscodeFooterFor(facts.fullSessionId, stats, Math.max(1, Math.min(columns - 8, Math.max(40, Math.floor(columns * 0.8) - 4))))', 'dscodeFooterFor(facts.fullSessionId, stats, Math.max(1, Math.min(columns - 8, Math.max(40, Math.floor(columns * 0.8) - 4))), dscodeFooterHeader(facts, stats))');
      patched = footerRows(patched);
    }
    // Resync the activity line with the current source (spinner, translations) whenever it drifted.
    const activityStart = patched.indexOf('function dscodeActivity(');
    const activityEnd = patched.indexOf('\n}\n', patched.indexOf('function DscodeActivityLine(')) + 3;
    if (activityStart < 0 || activityEnd <= activityStart) throw Error('Patched TUI activity line drift');
    const canonical = activitySource + '\n' + spinnerSource;
    const activityCurrent = canonical.slice(canonical.indexOf('function dscodeActivity('), canonical.indexOf('\n}\n', canonical.indexOf('function DscodeActivityLine(')) + 3);
    if (patched.slice(activityStart, activityEnd) !== activityCurrent) patched = patched.slice(0, activityStart) + activityCurrent + patched.slice(activityEnd);
    return patched.replace(telemetryTextAnchor, telemetryColorRender);
  }
  const patch = (from, to) => { text = replaceOnce(text, from, to); };
  const replaceFunction = (name, replacement) => {
    const start = text.indexOf(`function ${name}(`);
    const end = text.indexOf('\n}', start) + 2;
    if (start < 0 || end <= start) throw Error(`Missing TUI function: ${name}`);
    patch(text.slice(start, end), replacement);
  };
  replaceFunction('Header', `function Header({ resumed, cwd = "", branch = "", title = "" }) {
    const columns = useStdout().stdout?.columns ?? 80;
    const width = Math.max(1, columns - 4);
    const project = singleLineText(cwd).split(/[\\\\/]/).filter(Boolean).at(-1) || "workspace";
    const identity = "DSCODE · " + project + (branch ? " / " + singleLineText(branch) : "");
    const subtitle = title ? singleLineText(title) : resumed ? "Session resumed · /help" : "New session · /help";
    return (0, import_react.createElement)(Box, { flexDirection: "column", paddingX: 2, marginBottom: 1 },
      (0, import_react.createElement)(Text, { color: inkColor(getPalette().brandBright), bold: true, wrap: "truncate-end" }, truncateColumns(identity, width)),
      (0, import_react.createElement)(Text, { color: inkColor(getPalette().dim), wrap: "truncate-end" }, truncateColumns(subtitle, width)));
  }`);
  patch('columns = 80, rowCap = SETTLED_ROW_CAP) {', 'columns = 80, rowCap = SETTLED_ROW_CAP, headerFacts = {}) {');
  patch('key: "header",\n\t\t\tresumed', 'key: "header",\n            ...headerFacts,\n\t\t\tresumed');
  patch('props.resumed, refreshEpoch, terminalSize.columns);', 'props.resumed, refreshEpoch, terminalSize.columns, SETTLED_ROW_CAP, { cwd: props.cwd, branch: props.branch, title: view.title });');

  // One stable status row, including while answer text is streaming. Keep
  // elapsed time explicitly turn-based so it cannot be mistaken for tool time.
  patch('const deepDivingVisible = busy && !streamingActive;', 'const deepDivingVisible = busy;');
  patch('deepDivingVisible ? (0, import_react.createElement)(DeepDivingLine, {\n\t\tsince: view.busySince,\n\t\tanimated: animations\n\t}) : void 0', 'void 0');
  patch('transcriptVisible && busy ? (0, import_react.createElement)(Text, { dimColor: true, wrap: "truncate-end" }, view.entries.filter(entry => entry.kind === "tool" && entry.state === "running").map(entry => "● " + entry.name).join(" · ")) : void 0', 'transcriptVisible && busy ? (0, import_react.createElement)(DscodeActivityLine, { entries: view.entries, streaming: view.streaming !== "", since: view.busySince, animated: animations }) : void 0');

  replaceFunction('AgentsLine', `function AgentsLine({ rows, total }) {
    const columns = useStdout().stdout?.columns ?? 80;
    if (rows.length === 0) return void 0;
    const running = rows.filter(row => row.state === "running");
    const idle = rows.filter(row => row.state === "idle").length;
    const done = rows.filter(row => row.state === "done").length;
    const active = [...running].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    const counts = [running.length + " " + dscodeT("agents.running"), idle ? idle + " " + dscodeT("agents.idle") : "", done ? done + " " + dscodeT("agents.done") : "", total > rows.length ? total + " " + dscodeT("agents.total") : ""].filter(Boolean).join(" · ");
    ${agentSummary}
    const detail = active && columns >= 80 ? " — " + singleLineText(active.label) + " · " + singleLineText(active.activity) : "";
    return (0, import_react.createElement)(Box, { paddingX: 2 },
      (0, import_react.createElement)(Text, { color: inkColor(getPalette().dim), wrap: "truncate-end" },
        truncateColumns(summary + detail, Math.max(1, columns - 4))));
  }`);
  // Preserve /statusline customization, but use a quieter default catalog.
  patch('const DEFAULT_STATUSLINE_ITEMS = STATUS_ITEMS.map((item) => item.id);', 'const DEFAULT_STATUSLINE_ITEMS = ["model", "permission", "title", "plan", "goal", "sandbox"];');
  patch('...DEFAULT_STATUSLINE_ITEMS.filter((id) => !seen.has(id))', '...STATUS_ITEMS.map(item => item.id).filter((id) => !seen.has(id))');
  patch('const effort = safe(stats.reasoningEffort);', 'const effort = safe(facts.effort ?? stats.reasoningEffort);');
  patch('const model = safe(facts.model);', 'const model = safe(facts.model).split("/").at(-1);');
  patch('`${model}@${effort}`', '`${model} ｜ ${effort}`');
  patch('\t\t\tmodel: modelLabel,', '\t\t\tmodel: modelLabel,\n            effort: effortLabel,');
  patch('\t\tfacts.model,', '\t\tfacts.model,\n        facts.effort,');
  patch('facts = { ...facts, telemetry: dscodeFooterFor(facts.fullSessionId, stats, Math.max(1, columns - 6)) };', 'facts = { ...facts, telemetry: columns >= 48 ? dscodeFooterFor(facts.fullSessionId, stats, Math.max(1, Math.min(columns - 8, Math.max(40, Math.floor(columns * 0.8) - 4))), dscodeFooterHeader(facts, stats)) : "" };');
  patch('right: facts.telemetry ? [{ text: facts.telemetry, tone: "value" }] : [],', 'right: facts.telemetry ? [{ text: facts.telemetry, tone: "meta" }] : [],');
  patch('const STATUS_ITEM_SEPARATOR = " · ";', 'const STATUS_ITEM_SEPARATOR = " ｜ ";');
  patch('function sep() {\n\treturn {\n\t\ttext: " · ",', 'function sep() {\n\treturn {\n\t\ttext: " ｜ ",');
  patch('const groupSeparator = visibleColumns(" | ");', 'const groupSeparator = visibleColumns(" ｜ ");');
  patch('}, " | "));', '}, " ｜ "));');
  patch('const row2Budget = Math.max(0, budget - 2 - (facts.telemetry ? visibleColumns(facts.telemetry) + 3 : 0));', 'const row2Budget = Math.max(0, budget - 1 - (facts.telemetry ? visibleColumns(facts.telemetry) + 3 : 0));');
  patch('const rightParts = [];\n\t\trow.right.forEach', 'const rightParts = [];\n        if (key === "s2" && row.left.length > 0 && row.right.length > 0) rightParts.push((0, import_react.createElement)(Text, { key: key + "divider", color: inkColor(getPalette().dim) }, "｜ "));\n\t\trow.right.forEach');
  patch(telemetryTextAnchor, telemetryColorRender);
  patch('case "model": return {\n\t\t\tcolor: inkColor(getPalette().code),\n\t\t\tbold: true,', 'case "model": return {\n\t\t\tcolor: void 0,\n\t\t\tbold: void 0,');
  // One animation owns the running state; the editor remains a stable target.
  patch('busy ? (0, import_react.createElement)(BusyChase, { animated: animations })', 'busy ? (0, import_react.createElement)(Text, { color: inkColor(getPalette().brandBright) }, "› ")');
  patch('active: waveTier !== null && waveStyle !== null && !busy && !preparingImages && animations && waveArmed,', 'active: false, // DSCODE keeps the input band stable');
  text = footerRows(text);
  return '// dscode-style-v1\n' + FOOTER_ROWS_SOURCE + '\n' + tpsColorSource + '\n' + activitySource + '\n' + spinnerSource + '\n' + text;
}

const telemetryTextAnchor = '}, span.text));\n\t\t});\n\t\tif (row.hint)';
const telemetryColorRender = '}, key === "s2" && index === 0 ? dscodeTelemetryNodes(span.text, key + "r" + index) : span.text));\n\t\t});\n\t\tif (row.hint)';

const tpsColorSource = `
// dscode-tps-colors-v1
function dscodeTpsTone(rate) {
  if (!Number.isFinite(rate) || rate < 0) return null;
  if (rate < 75) return "yellow";
  if (rate < 150) return "green";
  if (rate <= 250) return "blue";
  return "purple";
}
// Cache hit rate: red under 90, yellow to 95, green to 98, blue above.
const dscodeCacheLabels = ["cache hit", "\u7f13\u5b58\u547d\u4e2d", "\u5feb\u53d6\u547d\u4e2d", "\u30ad\u30e3\u30c3\u30b7\u30e5\u30d2\u30c3\u30c8", "\uce90\uc2dc \uc801\uc911", "\u00e9xitos de cach\u00e9"];
function dscodeCacheTone(rate) {
  if (!Number.isFinite(rate) || rate < 0) return null;
  if (rate < 90) return "red";
  if (rate < 95) return "yellow";
  if (rate < 98) return "green";
  return "blue";
}
function dscodeTpsInkColor(tone) {
  const palette = getPalette();
  if (tone === "red") return inkColor(getTheme() === "light" ? [185, 28, 28] : [248, 113, 113]);
  if (tone === "yellow") return inkColor(palette.warn);
  if (tone === "green") return inkColor(palette.success);
  if (tone === "blue") return inkColor(palette.brandBright);
  if (tone === "purple") return inkColor(getTheme() === "light" ? [126, 34, 206] : [192, 132, 252]);
  return void 0;
}
function dscodeTelemetryParts(value) {
  const result = [];
  const parts = String(value).split(" | ");
  for (const [index, part] of parts.entries()) {
    if (index > 0) result.push({ text: " | ", tone: null });
    const match = /^(.+?: )(~?(?:\\d+(?:\\.\\d+)?|--)) tps$/.exec(part);
    if (match) {
      const display = match[2];
      const rate = Number(display.startsWith("~") ? display.slice(1) : display);
      result.push({ text: match[1], tone: null }, { text: display + " tps", tone: display && dscodeTpsTone(rate) });
      continue;
    }
    // The cache hit rate is the last segment of the telemetry line.
    // The cache hit rate closes the telemetry line; only a recognised cache label is tinted.
    const labelled = index === parts.length - 1 ? /^(.*?)(\\d+(?:\\.\\d+)?)%$/.exec(part) : null;
    const cache = labelled && dscodeCacheLabels.includes(labelled[1].replace(/:\\s*$/, "").trim().toLowerCase()) ? labelled : null;
    if (cache) {
      result.push({ text: cache[1], tone: null }, { text: cache[2] + "%", tone: dscodeCacheTone(Number(cache[2])) });
      continue;
    }
    result.push({ text: part, tone: null });
  }
  return result;
}
function dscodeTelemetryNodes(value, key) {
  return dscodeTelemetryParts(value).map((part, index) => (0, import_react.createElement)(Text,
    { key: key + "p" + index, color: dscodeTpsInkColor(part.tone) }, part.text));
}
`;

const spinnerSource = `
// A comet orbiting the snowflake clockwise. Each side cell uses only its inner braille
// dot column (bit masks), so every position is one column from the flake and the orbit
// stays centred: down the right side, then up the left side. The comet is two dots long;
// when it crosses under or over the flake the previous dot lingers dimly in the old cell.
const DSCODE_ORBIT = [["right", 1], ["right", 2], ["right", 4], ["right", 64], ["left", 128], ["left", 32], ["left", 16], ["left", 8]];
function dscodeMixTone(from, to, amount) { return from.map((value, index) => Math.round(value + (to[index] - value) * amount)); }
function dscodeSpinnerCells(tick, palette) {
  const index = ((tick % DSCODE_ORBIT.length) + DSCODE_ORBIT.length) % DSCODE_ORBIT.length;
  const [side, bit] = DSCODE_ORBIT[index];
  const [previousSide, previousBit] = DSCODE_ORBIT[(index + DSCODE_ORBIT.length - 1) % DSCODE_ORBIT.length];
  const cells = { left: { text: " ", color: palette.brandMid }, right: { text: " ", color: palette.brandMid } };
  if (previousSide === side) cells[side] = { text: String.fromCharCode(0x2800 | bit | previousBit), color: palette.brandMid };
  else { cells[side] = { text: String.fromCharCode(0x2800 | bit), color: palette.brandMid }; cells[previousSide] = { text: String.fromCharCode(0x2800 | previousBit), color: palette.dim }; }
  // The flake breathes with the orbit: brightest as the comet passes the top, deepest at the bottom.
  const flake = dscodeMixTone(palette.brandDeep, palette.brandBright, (Math.cos(2 * Math.PI * index / DSCODE_ORBIT.length) + 1) / 2);
  return { left: cells.left, flake, right: cells.right };
}
function DscodeActivityLine({ entries, streaming, since, animated = true }) {
  const columns = useStdout().stdout?.columns ?? 80;
  const tick = useFrames(animated ? 100 : 1000);
  const elapsed = since > 0 ? Math.max(0, Date.now() - since) : 0;
  const suffix = columns >= 64 ? " · " + dscodeT("activity.turn") + " " + runClock(elapsed) + " · " + dscodeT("activity.interrupt") : " · " + dscodeT("activity.turn") + " " + runClock(elapsed);
  const palette = getPalette();
  const spinner = animated ? dscodeSpinnerCells(tick, palette) : { left: { text: " ", color: palette.brandMid }, flake: palette.brandBright, right: { text: " ", color: palette.brandMid } };
  const label = truncateColumns(dscodeActivity(entries, streaming), Math.max(1, columns - 9 - visibleColumns(suffix)));
  return (0, import_react.createElement)(Box, { paddingX: 2 },
    (0, import_react.createElement)(Text, { wrap: "truncate-end" },
      (0, import_react.createElement)(Text, { color: inkColor(spinner.left.color) }, spinner.left.text),
      (0, import_react.createElement)(Text, { color: inkColor(spinner.flake) }, "\u2744"),
      (0, import_react.createElement)(Text, { color: inkColor(spinner.right.color) }, spinner.right.text),
      (0, import_react.createElement)(Text, { color: inkColor(getPalette().brandBright) }, " " + label),
      (0, import_react.createElement)(Text, { color: inkColor(getPalette().dim) }, suffix)));
}
`;

const activitySource = `
function dscodeActivity(entries, streaming) {
  const running = entries.filter(entry => entry.kind === "tool" && entry.state === "running");
  const tool = running.at(-1);
  if (!tool) return streaming ? dscodeT("activity.replying") : dscodeT("activity.thinking");
  let description = "";
  try {
    if (typeof tool.arguments === "string" && tool.arguments.length <= 4096) {
      const args = JSON.parse(tool.arguments);
      if (typeof args?.description === "string") description = args.description;
    }
  } catch {}
  // No raw argument/command dump in the chat chrome. A supplied description
  // is a task label, not a claim that the command succeeded.
  return dscodeT("activity.running") + " · " + singleLineText(tool.name) + (running.length > 1 ? " +" + (running.length - 1) : "") +
    (description ? " · " + truncateColumns(singleLineText(description), 56) : "");
}
`;

const agentSummary = 'const summary = "agents " + (columns < 60 ? running.length + " " + dscodeT("agents.running") : counts) + " · /agents";';
const agentSummaryV1 = 'const summary = "agents " + (columns < 60 ? running.length + " running" : counts) + " · /agents";';
