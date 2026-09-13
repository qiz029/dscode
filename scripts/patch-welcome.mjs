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

export function patchWelcome(text, version) {
  if (text.includes('// dscode-welcome-v1')) return text;
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw Error('Invalid DSCODE version for welcome box');
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
  return '// dscode-welcome-v1\n' + welcomePath.toString() + '\n' + text;
}
