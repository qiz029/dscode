import { replaceOnce } from './patch-util.mjs';

// Four ordered detents are a DSCODE presentation for the DeepSeek catalog.
// Keep the upstream panel for other models and for catalogs with extra levels.
export function patchEffort(text) {
  if (text.includes('// dscode-effort-bar-v6')) return text;
  if (text.includes('// dscode-effort-bar-v5')) {
    text = replaceFunction(text, 'DscodeUltraRipple', DscodeUltraRipple.toString());
    text = replaceFunction(text, 'DscodeUltraFocus', DscodeUltraFocus.toString());
    return replaceOnce(text, '// dscode-effort-bar-v5', '// dscode-effort-bar-v6');
  }
  const upgradingV4 = text.includes('// dscode-effort-bar-v4');
  const upgradingV3 = text.includes('// dscode-effort-bar-v3');
  if (upgradingV4 || upgradingV3) {
    text = replaceFunction(text, 'DscodeUltraRipple', DscodeUltraRipple.toString());
    text = replaceFunction(text, 'DscodeUltraFocus', DscodeUltraFocus.toString());
    return replaceOnce(text, upgradingV4 ? '// dscode-effort-bar-v4' : '// dscode-effort-bar-v3', '// dscode-effort-bar-v6');
  }
  const upgradingV2 = text.includes('// dscode-effort-bar-v2');
  if (upgradingV2) {
    text = replaceFunction(text, 'dscodeRippleTone', dscodeRippleTone.toString());
    text = replaceFunction(text, 'DscodeUltraRipple', DscodeUltraRipple.toString());
    text = replaceFunction(text, 'DscodeEffortBar', DscodeEffortBar.toString());
    text = replaceOnce(text, 'function EffortPanel(props) {',
      DscodeUltraFocus.toString() + '\nfunction EffortPanel(props) {');
    return replaceOnce(text, '// dscode-effort-bar-v2', '// dscode-effort-bar-v6');
  }
  const upgrading = text.includes('// dscode-effort-bar-v1');
  if (upgrading) {
    text = replaceFunction(text, 'DscodeEffortBar', DscodeEffortBar.toString());
    text = replaceFunction(text, 'EffortPanel', EffortPanel.toString());
    text = replaceOnce(text, 'function EffortPanel(props) {',
      dscodeRippleTone.toString() + '\n' + DscodeUltraRipple.toString() + '\n' + DscodeUltraFocus.toString() + '\nfunction EffortPanel(props) {');
    text = replaceOnce(text, '// dscode-effort-bar-v1', '// dscode-effort-bar-v6');
  } else {
    const start = text.indexOf('function EffortPanel({ row, current, select, back, onExit }) {');
    const end = text.indexOf('\n}', start) + 2;
    if (start < 0 || end <= start) throw Error('Pinned TUI effort panel drift');
    text = text.slice(0, start) + text.slice(start, end).replace('function EffortPanel(', 'function NativeEffortPanel(') + '\n' +
      dscodeEffortCenter.toString() + '\n' + dscodeRippleTone.toString() + '\n' + DscodeUltraRipple.toString() + '\n' + DscodeUltraFocus.toString() + '\n' +
      DscodeEffortBar.toString() + '\n' + EffortPanel.toString() + text.slice(end);
    text = replaceOnce(text,
      '\t\t\tcurrent: effortLabel,\n\t\t\tselect: (effortId) => applyModel(effortFor, effortId),',
      '\t\t\tcurrent: effortLabel,\n\t\t\tanimations,\n\t\t\tselect: (effortId) => applyModel(effortFor, effortId),');
  }
  text = replaceOnce(text, 'function Input({ active, frozen, frozenHint, busy,', 'function Input({ effortSurface, ultraPulse, active, frozen, frozenHint, busy,');
  text = replaceOnce(text,
    '\tif (frozen) {\n\t\tif (deleteConfirm !== void 0) {',
    '\tif (effortSurface !== void 0) return effortSurface;\n\tif (ultraPulse !== 0 && animations) return (0, import_react.createElement)(DscodeUltraRipple, { key: ultraPulse, columns });\n\tif (frozen) {\n\t\tif (deleteConfirm !== void 0) {');
  text = replaceOnce(text,
    'const [animations, setAnimations] = (0, import_react.useState)(props.animations ?? true);',
    'const [animations, setAnimations] = (0, import_react.useState)(props.animations ?? true);\n\tconst [ultraPulse, setUltraPulse] = (0, import_react.useState)(0);\n\t(0, import_react.useEffect)(() => {\n\t\tif (ultraPulse === 0) return;\n\t\tconst timer = setTimeout(() => setUltraPulse(0), 1100);\n\t\treturn () => clearTimeout(timer);\n\t}, [ultraPulse]);');
  text = replaceOnce(text, '\t\t\tsetEffortLabel(effortId);',
    '\t\t\tsetEffortLabel(effortId);\n\t\t\tsetUltraPulse(effortId === "ultra" && animations ? Date.now() : 0);');
  text = replaceOnce(text, '\t\t\tback: () => setEffortFor(void 0),', '\t\t\tback: closeModelSurface,');
  text = replaceOnce(text, '}), modelSurface, helpOpen && !approvalPending && !questionPending ?',
    '}), effortFor !== void 0 ? void 0 : modelSurface, helpOpen && !approvalPending && !questionPending ?');
  text = replaceOnce(text,
    '\t}, (0, import_react.createElement)(Input, {\n\t\tactive: inputActive,',
    '\t}, (0, import_react.createElement)(Input, {\n\t\teffortSurface: modelOpen && effortFor !== void 0 ? modelSurface : void 0,\n\t\tultraPulse,\n\t\tactive: inputActive,');
  return upgrading ? text : '// dscode-effort-bar-v6\n' + text;
}

function replaceFunction(text, name, replacement) {
  const start = text.indexOf(`function ${name}(`);
  const end = text.indexOf('\n}', start) + 2;
  if (start < 0 || end <= start) throw Error(`Pinned TUI ${name} drift`);
  return text.slice(0, start) + replacement + text.slice(end);
}

function dscodeEffortCenter(label, width) {
  const left = Math.floor((width - label.length) / 2);
  return ' '.repeat(left) + label + ' '.repeat(width - left - label.length);
}

function dscodeRippleTone(position, center, frame, palette) {
  const distance = Math.abs(position - center);
  const radius = frame * 3;
  return Math.abs(distance - radius) < 3 ? palette.brandBright : distance < radius ? palette.brandMid : palette.brandDeep;
}

function DscodeUltraRipple({ columns }) {
  const palette = getPalette();
  const width = Math.max(1, columns - 5);
  const tick = useFrames(55, true);
  const center = (width - 1) / 2;
  const settled = tick > Math.ceil(width / 6) + 2;
  const label = dscodeEffortCenter(truncateColumns('✦  ULTRA  ·  max reasoning + focused collaboration', width), width);
  const rippleLine = (lag) => {
    const frame = Math.max(0, tick - lag);
    return (0, import_react.createElement)(Text, { wrap: 'truncate-end' },
      ...Array.from({ length: width }, (_, index) => (0, import_react.createElement)(Text, {
        key: index,
        color: inkColor(settled ? palette.brandDeep : dscodeRippleTone(index, center, frame, palette))
      }, !settled && (index === Math.floor(center - frame * 3) || index === Math.ceil(center + frame * 3)) ? '✦' : '─')));
  };
  return (0, import_react.createElement)(Box, {
    width: Math.max(1, columns - 1), paddingX: 2, flexDirection: 'column'
  }, rippleLine(0), (0, import_react.createElement)(Text, { wrap: 'truncate-end' },
    ...Array.from(label, (letter, index) => (0, import_react.createElement)(Text, {
      key: index,
      color: inkColor(settled ? palette.brandBright : dscodeRippleTone(index, center, Math.max(0, tick - 1), palette)),
      bold: settled || Math.abs(Math.abs(index - center) - Math.max(0, tick - 1) * 3) < 3
    }, letter))), rippleLine(2));
}

function DscodeUltraFocus({ width, animations }) {
  const palette = getPalette();
  const [frame, setFrame] = (0, import_react.useState)(0);
  const lastFrame = Math.ceil(width / 6) + 2;
  (0, import_react.useEffect)(() => {
    if (!animations) return;
    let step = 0;
    const timer = setInterval(() => {
      step++;
      setFrame(step);
      if (step >= lastFrame) clearInterval(timer);
    }, 55);
    return () => clearInterval(timer);
  }, [animations, lastFrame]);
  const label = dscodeEffortCenter(truncateColumns('✦  ULTRA  ✦', width), width);
  const center = (width - 1) / 2;
  const settled = !animations || frame >= lastFrame;
  const first = label.length - label.trimStart().length;
  const last = label.trimEnd().length - 1;
  return (0, import_react.createElement)(Text, { wrap: 'truncate-end' },
    ...Array.from(label, (letter, index) => {
      const outer = index < first || index > last;
      const burst = animations && !settled && outer &&
        (index === Math.floor(center - frame * 3) || index === Math.ceil(center + frame * 3));
      return (0, import_react.createElement)(Text, {
        key: index,
        color: inkColor(settled ? outer ? palette.brandDeep : palette.brandBright : dscodeRippleTone(index, center, frame, palette)),
        bold: burst || letter !== ' ' && (settled || Math.abs(Math.abs(index - center) - frame * 3) < 3)
      }, burst ? '✦' : outer ? '─' : letter);
    }));
}

function DscodeEffortBar({ row, current, select, back, onExit, animations = true }) {
  const ids = ['low', 'high', 'max', 'ultra'];
  const advertised = row.reasoning.efforts;
  const defaultEffort = row.reasoning.defaultEffort;
  const initial = current || defaultEffort;
  const [cursor, setCursor] = (0, import_react.useState)(Math.max(0, ids.indexOf(initial)));
  useStableInput((input, key) => {
    if (key.ctrl && input === 'c') return onExit();
    if (key.escape || input === 'q') return back();
    if (key.leftArrow || key.upArrow) return setCursor(value => Math.max(0, value - 1));
    if (key.rightArrow || key.downArrow) return setCursor(value => Math.min(3, value + 1));
    if (input === 'g') return setCursor(0);
    if (input === 'G') return setCursor(3);
    if (input === 'o' && advertised.some(effort => effort.id === 'off')) return select('off');
    if (key.return) return select(ids[cursor]);
  }, true);
  const stdout = useStdout().stdout;
  const columns = stdout?.columns ?? 80;
  const rows = stdout?.rows ?? 30;
  const contentWidth = Math.max(1, columns - 5);
  const palette = getPalette();
  const selected = ids[cursor];
  const slot = Math.max(5, Math.min(14, Math.floor(contentWidth / 4)));
  const width = slot * 4;
  const barIndent = Math.max(0, Math.floor((contentWidth - width) / 2));
  const compact = rows < 16 || contentWidth < 24;
  const hasOff = advertised.some(effort => effort.id === 'off');
  if (compact) return (0, import_react.createElement)(Box, { flexDirection: 'column', paddingX: 2 },
    (0, import_react.createElement)(Text, { color: inkColor(palette.brandBright), wrap: 'truncate-end' },
      truncateColumns(ids.map(id => id === selected ? '[' + id + ']' : id).join('  '), contentWidth)),
    (0, import_react.createElement)(Text, { color: inkColor(palette.dim), wrap: 'truncate-end' },
      truncateColumns('←→ adjust · enter confirm · esc cancel', contentWidth)));
  const description = advertised.find(effort => effort.id === selected)?.description ?? '';
  const currentLabel = current || defaultEffort || 'default';
  const footer = '←/→ adjust · Enter confirm · Esc cancel' + (hasOff ? ' · o off' : '');
  const trackNode = Math.floor((slot - 1) / 2);
  const pointerColumn = barIndent + cursor * slot + trackNode;
  return (0, import_react.createElement)(Box, {
    width: Math.max(1, columns - 1),
    flexDirection: 'column',
    paddingX: 2
  },
  (0, import_react.createElement)(Text, { color: inkColor(palette.brandDeep) }, '─'.repeat(contentWidth)),
  (0, import_react.createElement)(Text, { color: inkColor(palette.dim) },
    'Faster' + ' '.repeat(Math.max(1, contentWidth - 6 - 7)) + 'Smarter'),
  (0, import_react.createElement)(Box, { flexDirection: 'row', width, marginLeft: barIndent }, ...ids.map((id, index) => {
    const node = index === cursor ? id === 'ultra' ? '✦' : '◆' : '●';
    const track = '━'.repeat(trackNode) + node + '━'.repeat(slot - trackNode - 1);
    const tone = index === cursor ? palette.brandBright : index < cursor ? palette.brandMid : palette.dim;
    return (0, import_react.createElement)(Text, { key: id, color: inkColor(tone) }, track);
  })),
  (0, import_react.createElement)(Text, { color: inkColor(palette.brandBright) }, ' '.repeat(pointerColumn) + '▲'),
  (0, import_react.createElement)(Box, { flexDirection: 'row', width, marginLeft: barIndent }, ...ids.map((id, index) =>
    (0, import_react.createElement)(Text, {
      key: id,
      color: inkColor(index === cursor ? palette.brandBright : palette.dim),
      bold: index === cursor
    }, dscodeEffortCenter(id, slot)))),
  selected === 'ultra' ? (0, import_react.createElement)(DscodeUltraFocus, { width: contentWidth, animations }) :
    (0, import_react.createElement)(Text, { color: inkColor(palette.text), wrap: 'truncate-end' },
      truncateColumns('current ' + currentLabel + ' · ' + description, contentWidth)),
  (0, import_react.createElement)(Text, { color: inkColor(palette.dim), wrap: 'truncate-end' },
    truncateColumns(footer, contentWidth)));
}

function EffortPanel(props) {
  const reasoning = props.row.reasoning;
  const ids = reasoning?.efforts.map(effort => effort.id) ?? [];
  const barIds = ['low', 'high', 'max', 'ultra'];
  const barCatalog = reasoning?.defaultEffort !== undefined &&
    barIds.every(id => ids.includes(id)) && ids.every(id => id === 'off' || barIds.includes(id));
  return (0, import_react.createElement)(barCatalog ? DscodeEffortBar : NativeEffortPanel, props);
}
