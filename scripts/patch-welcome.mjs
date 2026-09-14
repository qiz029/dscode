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

/** Pixel rows of the welcome snowflake for terminals of 26+ rows: "." is transparent, "1"-"3" are dark-to-bright brand tones. */
export const WELCOME_ART = [
  "...........1.1..........",
  "............1...........",
  "............1...........",
  ".........1..1..1........",
  ".......1..22222..1......",
  "...1...1....2....1...1..",
  "..11...2....2....2...11.",
  "....11.2...222...2.11...",
  "......22.22.3.22.22.....",
  ".....22.22.333.22.22....",
  "....1...2.33332.2...1...",
  "........2.33322.2.......",
  "....1...2.33222.2...1...",
  ".....22.22.222.22.22....",
  "......22.22.3.22.22.....",
  "....11.2...222...2.11...",
  "..11...2....2....2...11.",
  "...1...1....2....1...1..",
  ".......1..22222..1......",
  ".........1..1..1........",
  "............1...........",
  "............1...........",
  "...........1.1..........",
  "........................"
];

/** Smaller snowflake for 24-25 row terminals, where the welcome box may use at most 13 rows. */
export const WELCOME_ART_SMALL = [
  "..........1.1.........",
  "...........1..........",
  "........1..1..1.......",
  ".........1.2.1........",
  "...1..1...222...1..1..",
  "...1..1....2....1..1..",
  "..1.1.2...222...2.1.1.",
  ".....22.22.3.22.22....",
  "....12.22.333.22.21...",
  "...1...2.33332.2...1..",
  ".......2.33322.2......",
  "...1...2.33222.2...1..",
  "....12.22.222.22.21...",
  ".....22.22.3.22.22....",
  "..1.1.2...222...2.1.1.",
  "...1..1....2....1..1..",
  "...1..1...222...1..1..",
  ".........1.2.1........",
  "........1..1..1.......",
  "...........1..........",
  "..........1.1.........",
  "......................"
];

/** Pack two pixel rows per terminal row into half-block runs with foreground/background tones. */
export function welcomeArtRows(grid, tones) {
  const rows = [];
  for (let y = 0; y < grid.length; y += 2) {
    const top = grid[y] || '';
    const bottom = grid[y + 1] || '';
    const segments = [];
    for (let x = 0; x < Math.max(top.length, bottom.length); x++) {
      const upper = tones[top[x]] || '';
      const lower = tones[bottom[x]] || '';
      const glyph = upper && lower ? upper === lower ? '\u2588' : '\u2580' : upper ? '\u2580' : lower ? '\u2584' : ' ';
      const color = upper || lower;
      const background = upper && lower && upper !== lower ? lower : '';
      const last = segments[segments.length - 1];
      if (last && last.glyph === glyph && last.color === color && last.background === background) last.text += glyph;
      else segments.push({ glyph, text: glyph, color, background });
    }
    rows.push(segments);
  }
  return rows;
}

const LIVE_BUDGET_V1 = 'const liveBudget = dynamicRows === 0 ? 0 : busy || streamingActive ? Math.max(1, Math.floor(dynamicRows / 3)) : Math.max(0, dynamicRows - (deepDivingVisible ? 1 : 0));';
// Within the live rows the streaming answer comes first; unsettled entries get the remainder.
const LIVE_BUDGET_V2 = 'const liveBudget = dynamicRows === 0 ? 0 : streamingActive ? Math.max(0, dynamicRows - Math.min(streamingDemand, dynamicRows)) : dynamicRows;';

function patchWelcomeScroll(text) {
  // Live chat lines follow the verbose toggle; a plain string swap keeps every marker generation idempotent.
  text = text.split('dscodeChatLines(entry, Math.max(1, terminalColumns - 2))').join('dscodeChatLines(entry, Math.max(1, terminalColumns - 2), showReasoning)');
  if (text.includes('// dscode-welcome-scroll-v2')) return text;
  if (text.includes('// dscode-welcome-scroll-v1')) {
    text = text.replace('const welcomeMaxRows = welcomeFull ? 13 :', 'const welcomeMaxRows = welcomeFull ? terminalRows >= 26 ? 14 : 13 :');
    text = replaceOnce(text, '  const settledViewportRows = busy || streamingActive ? Math.floor(settledBudget / 3) : settledBudget;', `  const liveDemand = allLiveLines.length + streamingDemand;
  const liveCap = busy || streamingActive ? Math.max(1, Math.floor(settledBudget * 2 / 3)) : 0;
  const liveRows = Math.min(liveDemand, liveCap);
  const settledViewportRows = Math.max(0, settledBudget - liveRows);`);
    return '// dscode-welcome-scroll-v2\n' + replaceOnce(text, LIVE_BUDGET_V1, LIVE_BUDGET_V2);
  }
  const start = text.indexOf('const welcomeFull = terminalRows >= 24 && terminalColumns >= 64;');
  const end = text.indexOf('\n\tconst liveBudget =', start);
  if (start < 0 || end < 0) throw Error('Pinned TUI welcome viewport drift');
  const previous = text.slice(start, end);
  for (const anchor of ['const settledBudget =', 'const renderedSettled =', 'const allLiveLines =', 'const streamingActive =']) {
    if (!previous.includes(anchor)) throw Error(`Pinned TUI welcome viewport missing ${anchor}`);
  }
  const layout = `const welcomeFull = terminalRows >= 24 && terminalColumns >= 64;
  const welcomeMaxRows = welcomeFull ? terminalRows >= 26 ? 14 : 13 : terminalRows >= 10 ? 4 : 1;
  // The nine fixed rows belong to the composer, footer and their gutters.
  const transcriptCapacity = transcriptVisible ? Math.max(0, terminalRows - 9 - composerGutterRows - (composerRows - 1) - menuRows) : 0;
  const streamingActive = view.streaming !== "";
  const deepDivingVisible = busy;
  const allLiveLines = (0, import_react.useMemo)(() => view.entries.slice(settled).flatMap((entry) => dscodeChatLines(entry, Math.max(1, terminalColumns - 2), showReasoning)), [
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
  // Live rows (unsettled entries plus the streaming answer) take only what they need, capped at two
  // thirds of the budget; settled history fills the rest instead of a fixed third.
  const liveDemand = allLiveLines.length + streamingDemand;
  const liveCap = busy || streamingActive ? Math.max(1, Math.floor(settledBudget * 2 / 3)) : 0;
  const liveRows = Math.min(liveDemand, liveCap);
  const settledViewportRows = Math.max(0, settledBudget - liveRows);
  const renderedSettled = settledViewportRows > 0 ? settledTail.slice(-settledViewportRows) : [];
  const dynamicRows = Math.max(0, settledBudget - settledViewportRows);`;
  text = text.slice(0, start) + layout + text.slice(end);
  const headerLine = text.split('\n').find(line => line.includes('(Header, { cwd: props.workspaceRoot ?? props.cwd, model: modelLabel, effort: effortLabel })'));
  if (!headerLine || !headerLine.trim().endsWith('"DSCODE"),')) throw Error('Pinned TUI welcome render drift');
  const headerExpression = headerLine.trim().slice(0, -1);
  text = replaceOnce(text, headerLine, `    welcomeRows > 0 ? (0, import_react.createElement)(Box, { height: welcomeRows, overflowY: "hidden", flexDirection: "column", justifyContent: "flex-end", flexShrink: 0 },
      (0, import_react.createElement)(Box, { flexShrink: 0 }, ${headerExpression})) : void 0,`);
  text = replaceOnce(text, LIVE_BUDGET_V1, LIVE_BUDGET_V2);
  return '// dscode-welcome-scroll-v1\n// dscode-welcome-scroll-v2\n' + welcomeVisibleRows.toString() + '\n' + text;
}

export function patchWelcome(text, version) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw Error('Invalid DSCODE version for welcome box');
  const patched = text.includes('// dscode-welcome-v1');
  if (patched) {
    const start = text.indexOf('function Header({ cwd = "", model = "", effort = "" }) {');
    const tail = '}, project))));\n  }';
    const end = text.indexOf(tail, start) + tail.length;
    if (start < 0 || end <= start + tail.length) throw Error('Patched TUI welcome header drift');
    text = text.slice(0, start) + welcomeHeaderSource(version) + text.slice(end);
    if (!text.includes('// dscode-welcome-v2')) text = '// dscode-welcome-v2\n' + 'const WELCOME_ART = ' + JSON.stringify(WELCOME_ART) + ';\nconst WELCOME_ART_SMALL = ' + JSON.stringify(WELCOME_ART_SMALL) + ';\n' + welcomeArtRows.toString() + '\n' + text;
    return patchWelcomeScroll(text);
  }
  const start = text.indexOf('function Header({ resumed, cwd = "", branch = "", title = "" }) {');
  const end = text.indexOf('\n}', start) + 2;
  if (start < 0 || end <= start) throw Error('Pinned TUI welcome header drift');
  text = text.slice(0, start) + welcomeHeaderSource(version) + text.slice(end);
  text = replaceOnce(text,
    'const settledBudget = transcriptVisible ? Math.max(0, terminalRows - 12 - composerGutterRows - (composerRows - 1) - menuRows) : 0;',
    'const welcomeFull = terminalRows >= 24 && terminalColumns >= 64;\n  const welcomeChromeRows = welcomeFull ? 22 : terminalRows >= 10 ? 13 : 10;\n  const settledBudget = transcriptVisible ? Math.max(0, terminalRows - welcomeChromeRows - composerGutterRows - (composerRows - 1) - menuRows) : 0;');
  text = replaceOnce(text,
    'terminalRows >= 10 ? (0, import_react.createElement)(Header, { resumed: props.resumed, cwd: props.cwd, branch: props.branch, title: view.title })',
    'terminalRows >= 10 ? (0, import_react.createElement)(Header, { cwd: props.workspaceRoot ?? props.cwd, model: modelLabel, effort: effortLabel })');
  return patchWelcomeScroll('// dscode-welcome-v1\n// dscode-welcome-v2\n' + welcomePath.toString() + '\nconst WELCOME_ART = ' + JSON.stringify(WELCOME_ART) + ';\nconst WELCOME_ART_SMALL = ' + JSON.stringify(WELCOME_ART_SMALL) + ';\n' + welcomeArtRows.toString() + '\n' + text);
}

/** Source of the patched welcome header: pixel snowflake on the left, session facts on the right. */
function welcomeHeaderSource(version) {
  return `function Header({ cwd = "", model = "", effort = "" }) {
    const stdout = useStdout().stdout;
    const columns = stdout?.columns ?? 80;
    const full = (stdout?.rows ?? 30) >= 24 && columns >= 64;
    const width = Math.max(1, full ? Math.min(columns - 2, 84) : columns - 4);
    const contentWidth = Math.max(1, width - (full ? 4 : 0));
    const detailsWidth = Math.max(1, contentWidth - (full ? 28 : 0));
    const modelName = singleLineText(model).split("/").at(-1) || "unknown";
    const effortName = singleLineText(effort) || "default";
    const project = welcomePath(cwd, detailsWidth);
    const palette = getPalette();
    const art = (stdout?.rows ?? 30) >= 26 ? WELCOME_ART : WELCOME_ART_SMALL;
    const luminance = ([red, green, blue]) => red * 299 + green * 587 + blue * 114;
    const tones = [palette.brandDeep, palette.brand, palette.brandBright].sort((left, right) => luminance(left) - luminance(right));
    if (!full) return (0, import_react.createElement)(Box, { flexDirection: "column", paddingX: 2, marginBottom: 1 },
      (0, import_react.createElement)(Text, { wrap: "truncate-end" },
        (0, import_react.createElement)(Text, { color: inkColor(getPalette().brandBright), bold: true }, "❄ DSCODE"),
        (0, import_react.createElement)(Text, { color: inkColor(getPalette().dim) }, "  v${version}")),
      (0, import_react.createElement)(Text, { wrap: "truncate-end" }, truncateColumns(modelName + " · " + effortName, width)),
      (0, import_react.createElement)(Text, { color: inkColor(getPalette().dim), wrap: "truncate-end" }, welcomePath(cwd, width)));
    return (0, import_react.createElement)(Box, { flexDirection: "column", width, borderStyle: "round", borderColor: inkColor(getPalette().brand), paddingX: 1 },
      (0, import_react.createElement)(Box, { flexDirection: "row" },
        (0, import_react.createElement)(Box, { flexDirection: "column", width: 28 },
          ...welcomeArtRows(art, { "1": inkColor(tones[0]), "2": inkColor(tones[1]), "3": inkColor(tones[2]) }).map((segments, row) => (0, import_react.createElement)(Text, { key: row }, "  ",
            ...segments.map((segment, index) => (0, import_react.createElement)(Text, { key: index, color: segment.color || void 0, backgroundColor: segment.background || void 0 }, segment.text))))),
        (0, import_react.createElement)(Box, { flexDirection: "column", width: detailsWidth, marginTop: 2 },
          (0, import_react.createElement)(Text, { color: inkColor(getPalette().text), bold: true }, "DSCODE"),
          (0, import_react.createElement)(Text, { color: inkColor(getPalette().brandDeep) }, "────────────"),
          (0, import_react.createElement)(Text, { color: inkColor(getPalette().dim) }, "v${version}"),
          (0, import_react.createElement)(Text, { wrap: "truncate-end" }, truncateColumns(dscodePadEnd(dscodeT("welcome.model"), 9) + modelName, detailsWidth)),
          (0, import_react.createElement)(Text, { wrap: "truncate-end" }, truncateColumns(dscodePadEnd(dscodeT("welcome.effort"), 9) + effortName, detailsWidth)),
          (0, import_react.createElement)(Text, null, " "),
          (0, import_react.createElement)(Text, { color: inkColor(getPalette().dim) }, dscodeT("welcome.project")),
          (0, import_react.createElement)(Text, { wrap: "truncate-end" }, project))));
  }`;
}
