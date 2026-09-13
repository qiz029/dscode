import { replaceOnce } from './patch-runtime.mjs';

export function welcomePath(path, width) {
  const full = singleLineText(path || '');
  if (visibleColumns(full) <= width) return full;
  const segments = full.split(/[\\/]/).filter(Boolean);
  let suffix = '';
  for (let index = segments.length - 1; index >= 0; index--) {
    const candidate = '/' + segments[index] + suffix;
    if (visibleColumns('…' + candidate) > width) break;
    suffix = candidate;
  }
  return suffix ? '…' + suffix : '…' + truncateColumns(segments.at(-1) || full, Math.max(1, width - 1));
}

export function welcomeVisibleRows(capacity, maximum, demand, canScroll = true) {
  if (!canScroll || capacity < maximum) return maximum;
  return Math.max(0, Math.min(maximum, capacity - demand));
}

function patchWelcomeScroll(text) {
  if (text.includes('// dscode-welcome-scroll-v1')) return text;
  const start = text.indexOf('const welcomeFull = terminalRows >= 24 && terminalColumns >= 64;');
  const end = text.indexOf('\n\tconst liveBudget =', start);
  if (start < 0 || end < 0) throw Error('Pinned TUI welcome viewport drift');
  const previous = text.slice(start, end);
  for (const anchor of ['const settledBudget =', 'const renderedSettled =', 'const allLiveLines =', 'const streamingActive =']) {
    if (!previous.includes(anchor)) throw Error(`Pinned TUI welcome viewport missing ${anchor}`);
  }
  const layout = `const welcomeFull = terminalRows >= 24 && terminalColumns >= 64;
  const welcomeMaxRows = welcomeFull ? 13 : terminalRows >= 10 ? 4 : 1;
  // The nine fixed rows belong to the composer, footer and their gutters.
  const transcriptCapacity = transcriptVisible ? Math.max(0, terminalRows - 9 - composerGutterRows - (composerRows - 1) - menuRows) : 0;
  const streamingActive = view.streaming !== "";
  const deepDivingVisible = busy;
  const allLiveLines = (0, import_react.useMemo)(() => view.entries.slice(settled).flatMap((entry) => dscodeChatLines(entry, Math.max(1, terminalColumns - 2))), [
    view.entries,
    settled,
    terminalColumns,
    showReasoning
  ]);
  const settledTail = (0, import_react.useMemo)(() => visibleSettledLines(view.entries, settled, transcriptCapacity, terminalColumns, showReasoning, settledEntryLines), [settled, view.entries[settled - 1], transcriptCapacity, terminalColumns, showReasoning]);
  const streamingDemand = streamingActive ? textLines(view.streaming.slice(-Math.max(1, terminalColumns * transcriptCapacity)), Math.max(10, terminalColumns - 2)).length : 0;
  const demand = settledTail.length + allLiveLines.length + streamingDemand + (busy ? 1 : 0) + (agentRows.length > 0 ? 1 : 0);
  const welcomeRows = welcomeVisibleRows(transcriptCapacity, welcomeMaxRows, demand, transcriptVisible);
  const settledBudget = transcriptVisible ? Math.max(0, transcriptCapacity - welcomeRows) : 0;
  const settledViewportRows = busy || streamingActive ? Math.floor(settledBudget / 3) : settledBudget;
  const renderedSettled = settledViewportRows > 0 ? settledTail.slice(-settledViewportRows) : [];
  const dynamicRows = Math.max(0, settledBudget - settledViewportRows);`;
  text = text.slice(0, start) + layout + text.slice(end);
  const headerLine = text.split('\n').find(line => line.includes('(Header, { cwd: props.workspaceRoot ?? props.cwd, model: modelLabel, effort: effortLabel })'));
  if (!headerLine || !headerLine.trim().endsWith('"DSCODE"),')) throw Error('Pinned TUI welcome render drift');
  const headerExpression = headerLine.trim().slice(0, -1);
  text = replaceOnce(text, headerLine, `    welcomeRows > 0 ? (0, import_react.createElement)(Box, { height: welcomeRows, overflowY: "hidden", flexDirection: "column", justifyContent: "flex-end", flexShrink: 0 },
      (0, import_react.createElement)(Box, { flexShrink: 0 }, ${headerExpression})) : void 0,`);
  return '// dscode-welcome-scroll-v1\n' + welcomeVisibleRows.toString() + '\n' + text;
}

export function patchWelcome(text, version) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw Error('Invalid DSCODE version for welcome box');
  if (text.includes('// dscode-welcome-v1')) {
    const start = text.indexOf('function Header({ cwd = "", model = "", effort = "" }) {');
    const end = text.indexOf('\n}', start) + 2;
    if (start < 0 || end <= start) throw Error('Patched TUI welcome header drift');
    const header = text.slice(start, end).replace(/"(  )?v\d+\.\d+\.\d+(?:-[\w.-]+)?"/g, (_, pad = '') => `"${pad}v${version}"`);
    return patchWelcomeScroll(text.slice(0, start) + header + text.slice(end));
  }
  const start = text.indexOf('function Header({ resumed, cwd = "", branch = "", title = "" }) {');
  const end = text.indexOf('\n}', start) + 2;
  if (start < 0 || end <= start) throw Error('Pinned TUI welcome header drift');
  const header = `function Header({ cwd = "", model = "", effort = "" }) {
    const stdout = useStdout().stdout;
    const columns = stdout?.columns ?? 80;
    const full = (stdout?.rows ?? 30) >= 24 && columns >= 64;
    const width = Math.max(1, full ? Math.min(columns - 2, 84) : columns - 4);
    const contentWidth = Math.max(1, width - (full ? 4 : 0));
    const detailsWidth = Math.max(1, contentWidth - (full ? 28 : 0));
    const modelName = singleLineText(model).split("/").at(-1) || "unknown";
    const effortName = singleLineText(effort) || "default";
    const project = welcomePath(cwd, detailsWidth);
    if (!full) return (0, import_react.createElement)(Box, { flexDirection: "column", paddingX: 2, marginBottom: 1 },
      (0, import_react.createElement)(Text, { wrap: "truncate-end" },
        (0, import_react.createElement)(Text, { color: inkColor(getPalette().brandBright), bold: true }, "❄ DSCODE"),
        (0, import_react.createElement)(Text, { color: inkColor(getPalette().dim) }, "  v${version}")),
      (0, import_react.createElement)(Text, { wrap: "truncate-end" }, truncateColumns(modelName + " · " + effortName, width)),
      (0, import_react.createElement)(Text, { color: inkColor(getPalette().dim), wrap: "truncate-end" }, welcomePath(cwd, width)));
    return (0, import_react.createElement)(Box, { flexDirection: "column", width, borderStyle: "round", borderColor: inkColor(getPalette().brand), paddingX: 1, marginBottom: 1 },
      (0, import_react.createElement)(Box, { flexDirection: "row" },
        (0, import_react.createElement)(Box, { flexDirection: "column", width: 28 },
          (0, import_react.createElement)(Text, { color: inkColor(getPalette().brandBright) }, "            ▄"),
          (0, import_react.createElement)(Text, { color: inkColor(getPalette().brandBright) }, "    █▄▄█  █▄█▄█  █▄▄█"),
          (0, import_react.createElement)(Text, { color: inkColor(getPalette().brandBright) }, "    ▄███▄  ▀█▀  ▄███▄"),
          (0, import_react.createElement)(Text, { color: inkColor(getPalette().brandBright) }, "       ▀██▄ █ ▄██▀"),
          (0, import_react.createElement)(Text, { color: inkColor(getPalette().brandBright) }, "          ▄███▄"),
          (0, import_react.createElement)(Text, { color: inkColor(getPalette().brandBright) }, "          ▀███▀"),
          (0, import_react.createElement)(Text, { color: inkColor(getPalette().brandBright) }, "       ▄██▀ █ ▀██▄"),
          (0, import_react.createElement)(Text, { color: inkColor(getPalette().brandBright) }, "    ▀███▀  ▄█▄  ▀███▀"),
          (0, import_react.createElement)(Text, { color: inkColor(getPalette().brandBright) }, "    █▀▀█  █▀█▀█  █▀▀█"),
          (0, import_react.createElement)(Text, { color: inkColor(getPalette().brandBright) }, "            ▀")),
        (0, import_react.createElement)(Box, { flexDirection: "column", width: detailsWidth, marginTop: 2 },
          (0, import_react.createElement)(Text, { color: inkColor(getPalette().text), bold: true }, "DSCODE"),
          (0, import_react.createElement)(Text, { color: inkColor(getPalette().brandDeep) }, "────────────"),
          (0, import_react.createElement)(Text, { color: inkColor(getPalette().dim) }, "v${version}"),
          (0, import_react.createElement)(Text, { wrap: "truncate-end" }, truncateColumns("model    " + modelName, detailsWidth)),
          (0, import_react.createElement)(Text, { wrap: "truncate-end" }, truncateColumns("effort   " + effortName, detailsWidth)),
          (0, import_react.createElement)(Text, null, " "),
          (0, import_react.createElement)(Text, { color: inkColor(getPalette().dim) }, "project"),
          (0, import_react.createElement)(Text, { wrap: "truncate-end" }, project))));
  }`;
  text = text.slice(0, start) + header + text.slice(end);
  text = replaceOnce(text,
    'const settledBudget = transcriptVisible ? Math.max(0, terminalRows - 12 - composerGutterRows - (composerRows - 1) - menuRows) : 0;',
    'const welcomeFull = terminalRows >= 24 && terminalColumns >= 64;\n  const welcomeChromeRows = welcomeFull ? 22 : terminalRows >= 10 ? 13 : 10;\n  const settledBudget = transcriptVisible ? Math.max(0, terminalRows - welcomeChromeRows - composerGutterRows - (composerRows - 1) - menuRows) : 0;');
  text = replaceOnce(text,
    'terminalRows >= 10 ? (0, import_react.createElement)(Header, { resumed: props.resumed, cwd: props.cwd, branch: props.branch, title: view.title })',
    'terminalRows >= 10 ? (0, import_react.createElement)(Header, { cwd: props.workspaceRoot ?? props.cwd, model: modelLabel, effort: effortLabel })');
  return patchWelcomeScroll('// dscode-welcome-v1\n' + welcomePath.toString() + '\n' + text);
}
