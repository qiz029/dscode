import { replaceOnce } from './patch-util.mjs';

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
function patchWelcomeScroll(text) {
  // Live chat lines follow the verbose toggle.
  return text.split('dscodeChatLines(entry, Math.max(1, terminalColumns - 2))').join('dscodeChatLines(entry, Math.max(1, terminalColumns - 2), showReasoning)');
}

export function patchWelcome(text, version) {
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) throw Error('Invalid DSCODE version for welcome box');
  const patched = text.includes('// dscode-welcome-v1');
  if (patched) {
    // Both header generations start alike; the newer one also takes `animated`.
    const start = text.indexOf('function Header({ cwd = "", model = "", effort = ""');
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
  // Mode A: the header is the first Static row, so patch-style already threads
  // headerFacts through; give it the snowflake header's own fields.
  text = replaceOnce(text,
    'SETTLED_ROW_CAP, { cwd: props.cwd, branch: props.branch, title: view.title });',
    'SETTLED_ROW_CAP, { cwd: props.workspaceRoot ?? props.cwd, model: modelLabel, effort: effortLabel, animated: animations });');
  return patchWelcomeScroll('// dscode-welcome-v1\n// dscode-welcome-v2\n' + welcomePath.toString() + '\nconst WELCOME_ART = ' + JSON.stringify(WELCOME_ART) + ';\nconst WELCOME_ART_SMALL = ' + JSON.stringify(WELCOME_ART_SMALL) + ';\n' + welcomeArtRows.toString() + '\n' + text);
}

/** Source of the patched welcome header: pixel snowflake on the left, session facts on the right. */
function welcomeHeaderSource(version) {
  return `function Header({ cwd = "", model = "", effort = "", animated = false }) {
    const stdout = useStdout().stdout;
    const rippleTick = useFrames(animated ? 450 : 3600000);
    const ripplePhase = animated ? rippleTick % 4 : 3;
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
    // Ripple: the bright band moves core → ring → tips, then one resting frame in the base tones.
    const rippleBand = { 1: 2, 2: 1, 3: 0 };
    const tone = level => ripplePhase < 3 ? (rippleBand[level] === ripplePhase ? tones[2] : level === 3 ? tones[1] : tones[0]) : tones[level - 1];
    if (!full) return (0, import_react.createElement)(Box, { flexDirection: "column", paddingX: 2, marginBottom: 1 },
      (0, import_react.createElement)(Text, { wrap: "truncate-end" },
        (0, import_react.createElement)(Text, { color: inkColor(getPalette().brandBright), bold: true }, "❄ DSCODE"),
        (0, import_react.createElement)(Text, { color: inkColor(getPalette().dim) }, "  v${version}")),
      (0, import_react.createElement)(Text, { wrap: "truncate-end" }, truncateColumns(modelName + " · " + effortName, width)),
      (0, import_react.createElement)(Text, { color: inkColor(getPalette().dim), wrap: "truncate-end" }, welcomePath(cwd, width)));
    return (0, import_react.createElement)(Box, { flexDirection: "column", width, borderStyle: "round", borderColor: inkColor(getPalette().brand), paddingX: 1 },
      (0, import_react.createElement)(Box, { flexDirection: "row" },
        (0, import_react.createElement)(Box, { flexDirection: "column", width: 28 },
          ...welcomeArtRows(art, { "1": inkColor(tone(1)), "2": inkColor(tone(2)), "3": inkColor(tone(3)) }).map((segments, row) => (0, import_react.createElement)(Text, { key: row }, "  ",
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
