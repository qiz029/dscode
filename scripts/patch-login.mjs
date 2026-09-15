import { replaceOnce } from './patch-util.mjs';

export function patchLogin(text) {
  if (text.includes('// dscode-login-v1')) return text;
  const patch = (from, to) => { text = replaceOnce(text, from, to); };
  patch('const LOCAL_COMMANDS = [', 'const LOCAL_COMMANDS = [\n{ label: "/login", description: "save a DeepSeek API key locally" },');
  patch('quit, openModel, openEffort,', 'quit, openLogin, openModel, openEffort,');
  // Intercept before attachment handling, history, queueing and model dispatch.
  patch('const text = submissionPayload(liveValue);', `const text = submissionPayload(liveValue);
            if (/^\\/login(?:\\s|$)/.test(trimmed)) {
                valueRef.current = ""; cursorRef.current = 0;
                setValue(""); setCursor(0); setCompletionIndex(0); setDismissedMenuValue(void 0);
                recall.current = beginRecall(recallSpace, "");
                if (trimmed !== "/login") { notify("Use /login alone, then paste the key in the private input.", "warning"); return; }
                if (busy) { notify("Stop the running turn before /login.", "warning"); return; }
                openLogin(); return;
            }`);
  patch('function ProviderSetupPanel(', loginPanel + '\nfunction ProviderSetupPanel(');
  patch('if (providerAction?.kind === "login" &&', `if (providerAction?.kind === "dscode-key") modelSurface = (0, import_react.createElement)(DscodeLoginPanel, {
            load: props.loadModelProviders,
            save: props.saveModelProviderCredential,
            done: () => { closeModelSurface(); reloadModelSurfaces(); notify("DeepSeek API key saved locally; ready to use."); },
            back: closeModelSurface
        });
        else if (providerAction?.kind === "login" &&`);
  patch('openModel: () => {', `openLogin: () => {
            setProviderOpen(false); setEffortFor(void 0);
            setProviderAction({ kind: "dscode-key" }); setModelOpen(true);
        },
        openModel: () => {`);
  return text;
}

const loginPanel = `// dscode-login-v1
function DscodeLoginPanel({ load, save, done, back }) {
    const [draft, setDraft] = (0, import_react.useState)("");
    const [target, setTarget] = (0, import_react.useState)(void 0);
    const [error, setError] = (0, import_react.useState)("");
    const [busy, setBusy] = (0, import_react.useState)(false);
    const saving = (0, import_react.useRef)(false);
    (0, import_react.useEffect)(() => {
        let active = true;
        Promise.resolve().then(() => load()).then(directory => {
            if (!active) return;
            const row = directory.rows.find(row => row.provider === "deepseek-official");
            if (!row || !save) { setError("DeepSeek credential storage is unavailable."); return; }
            if (row.credential?.kind !== "facts") { setError("Could not read credential status. Check local file permissions."); return; }
            if (!row.credential.writable) { setError("DEEPSEEK_API_KEY is set by your environment. Remove it and restart to use /login."); return; }
            setTarget(row);
        }, () => { if (active) setError("Could not load DeepSeek credential settings."); });
        return () => { active = false; };
    }, [load, save]);
    useStableInput((input, key) => {
        if (saving.current) return;
        if (key.escape || key.ctrl && input === "c") { setDraft(""); back(); return; }
        if (!target) return;
        if (key.return) {
            const raw = draft.trim();
            if (!raw || /[\\s\\x00-\\x1f\\x7f-\\uffff]/.test(raw) || ENV_ASSIGNMENT.test(raw) || hasWrappingQuotes(raw)) {
                setError("Paste only the API key, without quotes, spaces or an environment-variable name."); return;
            }
            saving.current = true; setBusy(true); setError(""); setDraft("");
            Promise.resolve().then(() => save(target, raw)).then(done, () => {
                saving.current = false; setBusy(false);
                setError("Could not save the API key. Check file permissions and available disk space, then paste again.");
            });
            return;
        }
        if (key.ctrl && input === "u") { setDraft(""); setError(""); return; }
        if (key.backspace || key.delete) { setDraft(current => [...current].slice(0, -1).join("")); return; }
        if (key.ctrl || key.meta || !input) return;
        const pasted = stripPasteMarkers(input);
        setDraft(current => (current + pasted).slice(0, 4096));
        setError("");
    });
    return (0, import_react.createElement)(Box, { flexDirection: "column", paddingX: 2 },
        (0, import_react.createElement)(Text, { bold: true }, "DeepSeek login"),
        (0, import_react.createElement)(Text, { dimColor: true }, "Saved on this Mac in ~/.dscode/credentials.yaml"),
        (0, import_react.createElement)(Text, null, busy ? "Saving…" : target ? "API key › " + (draft ? "••••••••" : "paste your key") : error ? "" : "Loading…"),
        error ? (0, import_react.createElement)(Text, { color: "red" }, error) : void 0,
        (0, import_react.createElement)(Text, { dimColor: true }, "Enter save · Esc cancel · Ctrl+U clear"));
}
`;
