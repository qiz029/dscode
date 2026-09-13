import { replaceOnce } from './patch-runtime.mjs';

// A cancelled agent may remain "busy" until its aborting tool settles. Keep the
// two Ctrl+C presses independent of that asynchronous view update.
export function ctrlCAction(armed, { interrupt, busy, preparingImages, active, hasDraft }) {
  if (armed) return 'quit';
  if (interrupt() || busy) return 'interrupt';
  if (preparingImages) return 'cancel-prepare';
  if (!active) return 'wait';
  return hasDraft ? 'clear-draft' : 'quit';
}

export function patchInterrupt(text) {
  if (text.includes('// dscode-interrupt-v1')) return text;
  const patch = (from, to) => { text = replaceOnce(text, from, to); };
  patch('const cursorRef = (0, import_react.useRef)(cursor);\n\tvalueRef.current = value;', 'const cursorRef = (0, import_react.useRef)(cursor);\n\tconst ctrlCArmedRef = (0, import_react.useRef)(false);\n\tvalueRef.current = value;');
  patch('useStableInput((input, key) => {\n\t\tif (!active) return;\n\t\tconst liveValue = valueRef.current;\n\t\tconst liveCursor = cursorRef.current;\n\t\tif (preparingImages)', `useStableInput((input, key) => {
        if (!active && !(key.ctrl && input === "c")) { ctrlCArmedRef.current = false; return; }
        const liveValue = valueRef.current;
        const liveCursor = cursorRef.current;
        if (key.ctrl && input === "c") {
          const repeated = ctrlCArmedRef.current;
          const action = ctrlCAction(ctrlCArmedRef.current, { interrupt, busy, preparingImages, active: active && deleteConfirm === void 0, hasDraft: liveValue !== "" });
          ctrlCArmedRef.current = action !== "quit";
          if (action === "quit") quit(repeated);
          else if (action === "cancel-prepare") cancelImageSubmission();
          else if (action === "wait" && deleteConfirm !== void 0) cancelDelete();
          else if (action === "clear-draft") {
            valueRef.current = ""; cursorRef.current = 0;
            setValue(""); setCursor(0); resetCursorBlink();
            draftImagesRef.current = []; setDraftImages([]);
            draftFilesRef.current = []; setDraftFiles([]);
            setCompletionIndex(0); setDismissedMenuValue(void 0);
          }
          return;
        }
        ctrlCArmedRef.current = false;
        if (preparingImages)`);
  patch('\t\tif (key.ctrl && input === "c") {\n\t\t\tif (busy) interrupt();\n\t\t\telse if (liveValue !== "") {\n\t\t\t\tvalueRef.current = "";\n\t\t\t\tcursorRef.current = 0;\n\t\t\t\tsetValue("");\n\t\t\t\tsetCursor(0);\n\t\t\t\tresetCursorBlink();\n\t\t\t\tdraftImagesRef.current = [];\n\t\t\t\tsetDraftImages([]);\n\t\t\t\tdraftFilesRef.current = [];\n\t\t\t\tsetDraftFiles([]);\n\t\t\t\tsetCompletionIndex(0);\n\t\t\t\tsetDismissedMenuValue(void 0);\n\t\t\t} else quit();\n\t\t\treturn;\n\t\t}\n', '');
  patch('\t}, active);\n\tconst waveKey = waveTier', '\t}, true);\n\tconst waveKey = waveTier');
  patch('const quit = () => {\n\t\tif (quitting) return;', 'const quit = (fast = false) => {\n\t\tif (quitting) return;');
  patch('\t\trunQuitSequence([\n\t\t\t...currentSession', '\t\tif (fast) setTimeout(() => process.exit(0), 250);\n\t\trunQuitSequence([\n\t\t\t...currentSession');
  patch('"  esc interrupt the running turn · ctrl+c cancel / clear / quit · ctrl+d exit"', '"  ctrl+c stop running turn · ctrl+c again exit · ctrl+d exit"');
  return '// dscode-interrupt-v1\n' + ctrlCAction.toString() + '\n' + text;
}
