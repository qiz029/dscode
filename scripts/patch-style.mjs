import { replaceOnce } from './patch-runtime.mjs';

// Keep the presentation changes together; patch the pinned upstream renderer
// without adding a second UI framework or touching its input/IME ownership.
export function patchStyle(text) {
  if (text.includes('// dscode-style-v1')) return text
    .replace('...DEFAULT_STATUSLINE_ITEMS.filter((id) => !seen.has(id))', '...STATUS_ITEMS.map(item => item.id).filter((id) => !seen.has(id))')
    .replace('const summary = "agents " + counts + " · /agents";', agentSummary)
    .replace(': " · " + runClock(elapsed);', ': " · 本轮 " + runClock(elapsed);');
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
    const counts = [running.length + " running", idle ? idle + " idle" : "", done ? done + " done" : "", total > rows.length ? total + " total" : ""].filter(Boolean).join(" · ");
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
  patch('`${model}@${effort}`', '`${model} · ${effort}`');
  patch('\t\t\tmodel: modelLabel,', '\t\t\tmodel: modelLabel,\n            effort: effortLabel,');
  patch('\t\tfacts.model,', '\t\tfacts.model,\n        facts.effort,');
  patch('facts = { ...facts, telemetry: dscodeFooterFor(facts.fullSessionId, stats, Math.max(1, columns - 6)) };', 'facts = { ...facts, telemetry: columns >= 64 ? dscodeFooterFor(facts.fullSessionId, stats, Math.max(1, Math.floor(columns / 2) - 4)) : "" };');
  patch('right: facts.telemetry ? [{ text: facts.telemetry, tone: "value" }] : [],', 'right: facts.telemetry ? [{ text: facts.telemetry, tone: "meta" }] : [],');
  patch('case "model": return {\n\t\t\tcolor: inkColor(getPalette().code),\n\t\t\tbold: true,', 'case "model": return {\n\t\t\tcolor: void 0,\n\t\t\tbold: void 0,');
  // One animation owns the running state; the editor remains a stable target.
  patch('busy ? (0, import_react.createElement)(BusyChase, { animated: animations })', 'busy ? (0, import_react.createElement)(Text, { color: inkColor(getPalette().brandBright) }, "› ")');
  patch('active: waveTier !== null && waveStyle !== null && !busy && !preparingImages && animations && waveArmed,', 'active: false, // DSCODE keeps the input band stable');
  return '// dscode-style-v1\n' + activitySource + '\n' + text;
}

const activitySource = `
function dscodeActivity(entries, streaming) {
  const running = entries.filter(entry => entry.kind === "tool" && entry.state === "running");
  const tool = running.at(-1);
  if (!tool) return streaming ? "正在回复" : "正在思考";
  let description = "";
  try {
    if (typeof tool.arguments === "string" && tool.arguments.length <= 4096) {
      const args = JSON.parse(tool.arguments);
      if (typeof args?.description === "string") description = args.description;
    }
  } catch {}
  // No raw argument/command dump in the chat chrome. A supplied description
  // is a task label, not a claim that the command succeeded.
  return "正在执行 · " + singleLineText(tool.name) + (running.length > 1 ? " +" + (running.length - 1) : "") +
    (description ? " · " + truncateColumns(singleLineText(description), 56) : "");
}
function DscodeActivityLine({ entries, streaming, since, animated = true }) {
  const columns = useStdout().stdout?.columns ?? 80;
  const tick = useFrames(animated ? 160 : 1000);
  const elapsed = since > 0 ? Math.max(0, Date.now() - since) : 0;
  const suffix = columns >= 48 ? " · 本轮 " + runClock(elapsed) + " · Esc 中断" : " · 本轮 " + runClock(elapsed);
  const glyph = animated ? ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"][tick % 10] : "●";
  const label = truncateColumns(dscodeActivity(entries, streaming), Math.max(1, columns - 6 - visibleColumns(suffix)));
  return (0, import_react.createElement)(Box, { paddingX: 2 },
    (0, import_react.createElement)(Text, { wrap: "truncate-end" },
      (0, import_react.createElement)(Text, { color: inkColor(getPalette().brandBright) }, glyph + " " + label),
      (0, import_react.createElement)(Text, { color: inkColor(getPalette().dim) }, suffix)));
}
`;

const agentSummary = 'const summary = "agents " + (columns < 60 ? running.length + " running" : counts) + " · /agents";';
