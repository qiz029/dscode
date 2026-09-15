import { replaceOnce } from './patch-runtime.mjs';

// `/openrouter` shows the OpenRouter account: balance, this key's usage, every key and
// the last 30 days of spend. A management key (optional, offered after the OpenRouter
// API key is saved, or with `m` in the panel) unlocks the account-wide parts. Runs after
// the provider and compaction patches, whose output it extends.
const MARKER = '// dscode-openrouter-account-v1';
const UI_START = '// dscode-openrouter-ui-start';
const UI_END = '// dscode-openrouter-ui-end';
const IMPORT = 'import { MANAGEMENT_REF as DSCODE_OPENROUTER_MANAGEMENT_REF, loadOpenRouterAccount as dscodeLoadOpenRouterAccount, openRouterAccountLines as dscodeOpenRouterAccountLines, verifyManagementKey as dscodeVerifyManagementKey } from "./dscode-providers/openrouter-account.mjs";';

// Serialized into the TUI bundle, where React, Ink, the input helpers and the imports above are module globals.
/* global import_react, Box, Text, useStdout, useStableInput, getPalette, inkColor, truncateColumns, ENV_ASSIGNMENT, hasWrappingQuotes, stripPasteMarkers,
   DSCODE_OPENROUTER_MANAGEMENT_REF, dscodeLoadOpenRouterAccount, dscodeOpenRouterAccountLines, dscodeVerifyManagementKey */
async function dscodeOpenRouterSecret(ctx, ref) {
  const hit = await ctx.get("credentials")?.resolve(ref);
  return typeof hit?.value === "string" && hit.value.length > 0 ? hit.value : void 0;
}
async function dscodeManagementKeyStatus(ctx) {
  const credentials = ctx.get("credentials");
  if (credentials === void 0) return { state: "unavailable" };
  try {
    const facts = await credentials.describe(DSCODE_OPENROUTER_MANAGEMENT_REF);
    if (facts?.configured) return { state: facts.source === "env" ? "env" : "saved" };
    return { state: facts?.writable === false ? "readonly" : "missing" };
  } catch {
    return { state: "error" };
  }
}
async function dscodeSaveManagementKey(ctx, key) {
  const credentials = ctx.get("credentials");
  if (typeof credentials?.set !== "function") throw new Error("Credential storage is unavailable.");
  await dscodeVerifyManagementKey(key);
  await credentials.set(DSCODE_OPENROUTER_MANAGEMENT_REF, key);
}
async function dscodeLoadOpenRouterAccountFor(ctx) {
  const [apiKey, managementKey] = await Promise.all(["OPENROUTER_API_KEY", DSCODE_OPENROUTER_MANAGEMENT_REF].map(ref => dscodeOpenRouterSecret(ctx, ref)));
  return dscodeLoadOpenRouterAccount({ apiKey, managementKey });
}
function DscodeManagementKeyPanel({ optional, status, save, done, back }) {
  const [draft, setDraft] = (0, import_react.useState)("");
  const [error, setError] = (0, import_react.useState)("");
  const [busy, setBusy] = (0, import_react.useState)(false);
  const [state, setState] = (0, import_react.useState)(void 0);
  const saving = (0, import_react.useRef)(false);
  (0, import_react.useEffect)(() => {
    let active = true;
    Promise.resolve().then(() => status?.()).then(result => { if (active) setState(result?.state ?? "missing"); }, () => { if (active) setState("error"); });
    return () => { active = false; };
  }, []);
  const locked = state === "env" || state === "readonly" || state === "unavailable";
  useStableInput((input, key) => {
    if (saving.current) return;
    if (key.escape || key.ctrl && input === "c") { setDraft(""); back(); return; }
    if (state === void 0) return;
    if (key.return) {
      const raw = draft.trim();
      if (!raw) { done(false); return; }
      if (locked) return;
      if (/[\s\x00-\x1f\x7f-￿]/.test(raw) || ENV_ASSIGNMENT.test(raw) || hasWrappingQuotes(raw)) {
        setError("Paste only the management key, without quotes, spaces or an environment-variable name."); return;
      }
      saving.current = true; setBusy(true); setError(""); setDraft("");
      Promise.resolve().then(() => save(raw)).then(() => done(true), reason => {
        saving.current = false; setBusy(false);
        setError(reason instanceof Error ? reason.message : String(reason));
      });
      return;
    }
    if (locked) return;
    if (key.ctrl && input === "u") { setDraft(""); setError(""); return; }
    if (key.backspace || key.delete) { setDraft(current => [...current].slice(0, -1).join("")); return; }
    if (key.ctrl || key.meta || !input) return;
    setDraft(current => (current + stripPasteMarkers(input)).slice(0, 4096));
    setError("");
  });
  const stateLine = state === "saved" ? "A management key is saved; paste a new one to replace it."
    : state === "env" ? "OPENROUTER_MANAGEMENT_KEY is set by your environment."
      : state === "readonly" ? "OPENROUTER_MANAGEMENT_KEY is read-only here."
        : state === "unavailable" ? "Credential storage is unavailable."
          : state === "error" ? "Could not read the management key status." : "";
  return (0, import_react.createElement)(Box, { flexDirection: "column", paddingX: 2 },
    (0, import_react.createElement)(Text, { bold: true }, "OpenRouter management key" + (optional ? " (optional)" : "")),
    (0, import_react.createElement)(Text, { dimColor: true }, "Adds every API key's usage and your 30-day spend by model to /openrouter."),
    (0, import_react.createElement)(Text, { dimColor: true }, "It cannot call models; DSCODE only reads."),
    (0, import_react.createElement)(Text, { dimColor: true }, "Saved on this Mac in ~/.dscode/credentials.yaml"),
    stateLine ? (0, import_react.createElement)(Text, { dimColor: true }, stateLine) : void 0,
    (0, import_react.createElement)(Text, null, busy ? "Checking with OpenRouter…" : state === void 0 ? "Loading…" : locked ? "" : "Management key › " + (draft ? "••••••••" : "paste your key")),
    error ? (0, import_react.createElement)(Text, { color: "red" }, error) : void 0,
    (0, import_react.createElement)(Text, { dimColor: true }, locked ? "Enter continue · Esc close" : optional ? "Enter save · Enter on empty skips · Esc skip · Ctrl+U clear" : "Enter save · Esc back · Ctrl+U clear"));
}
function DscodeOpenRouterPanel({ load, setManagement, back }) {
  const [account, setAccount] = (0, import_react.useState)(void 0);
  const [error, setError] = (0, import_react.useState)("");
  const [epoch, setEpoch] = (0, import_react.useState)(0);
  const stdout = useStdout().stdout;
  const columns = stdout?.columns ?? 80, rows = stdout?.rows ?? 30;
  (0, import_react.useEffect)(() => {
    let active = true;
    setAccount(void 0); setError("");
    Promise.resolve().then(() => load()).then(value => { if (active) setAccount(value); }, reason => { if (active) setError(reason instanceof Error ? reason.message : String(reason)); });
    return () => { active = false; };
  }, [epoch]);
  useStableInput((input, key) => {
    if (key.escape || input === "q" || key.ctrl && input === "c") { back(); return; }
    if (input === "r") { setEpoch(value => value + 1); return; }
    if (input === "m") setManagement();
  });
  const palette = getPalette();
  const width = Math.max(1, columns - 4);
  const lines = account === void 0
    ? [{ text: error ? "Could not load the OpenRouter account: " + error : "Loading OpenRouter account…", tone: error ? "error" : "dim" }]
    : dscodeOpenRouterAccountLines(account);
  const colorOf = tone => tone === "error" ? palette.error : tone === "dim" ? palette.dim : tone === "title" ? palette.brandBright : palette.text;
  return (0, import_react.createElement)(Box, { flexDirection: "column", paddingX: 2 },
    (0, import_react.createElement)(Text, { bold: true }, "/openrouter — account"),
    ...lines.slice(0, Math.max(1, rows - 6)).map((line, index) => (0, import_react.createElement)(Text, { key: index, color: inkColor(colorOf(line.tone)), bold: line.tone === "title" || void 0, wrap: "truncate-end" }, truncateColumns(line.text, width))),
    (0, import_react.createElement)(Text, { dimColor: true }, "r refresh · m management key · esc close"));
}

const UI_SOURCE = [UI_START, dscodeOpenRouterSecret, dscodeManagementKeyStatus, dscodeSaveManagementKey, dscodeLoadOpenRouterAccountFor, DscodeManagementKeyPanel, DscodeOpenRouterPanel, UI_END]
  .map(part => typeof part === 'function' ? part.toString() : part).join('\n');

const PICKER_MARKER = '// dscode-picker-commands-v1';
const PICKER_COMMANDS = ['/provider', '/login', '/openrouter'];

/** Enter on a slash command that opens a picker runs it, instead of completing it into the input and waiting for another Enter. */
export function patchPickerCommands(text) {
  if (text.includes(PICKER_MARKER)) return text;
  return replaceOnce(text,
    '\t\t\tif (menuActive) {\n\t\t\t\tif (!(!mentionActive && candidates.some((candidate) => candidate.label === liveValue))) {\n\t\t\t\t\tacceptMenuCandidate();\n\t\t\t\t\treturn;\n\t\t\t\t}\n\t\t\t}\n\t\t\tconst expandedValue = expandLargePastes(liveValue, pendingPastesRef.current);',
    `\t\t\t${PICKER_MARKER}: these commands open a picker, so Enter on the menu runs them.
\t\t\tlet dscodeRunValue;
\t\t\tif (menuActive) {
\t\t\t\tconst dscodePicked = mentionActive || candidates.length === 0 ? void 0 : candidates[completionIndex % candidates.length];
\t\t\t\tif (dscodePicked !== void 0 && ${JSON.stringify(PICKER_COMMANDS)}.includes(dscodePicked.label)) dscodeRunValue = dscodePicked.label;
\t\t\t\telse if (!(!mentionActive && candidates.some((candidate) => candidate.label === liveValue))) {
\t\t\t\t\tacceptMenuCandidate();
\t\t\t\t\treturn;
\t\t\t\t}
\t\t\t}
\t\t\tconst expandedValue = expandLargePastes(dscodeRunValue ?? liveValue, pendingPastesRef.current);`);
}

export function patchOpenRouterTui(text) {
  if (text.includes(MARKER)) {
    const start = text.indexOf(UI_START), end = text.indexOf(UI_END);
    if (start < 0 || end < start) throw Error('Patched TUI OpenRouter account drift');
    return text.slice(0, start) + UI_SOURCE + text.slice(end + UI_END.length);
  }
  const patch = (from, to) => { text = replaceOnce(text, from, to); };
  patch('{ label: "/provider", description: "switch between DeepSeek and OpenRouter" },',
    '{ label: "/provider", description: "switch between DeepSeek and OpenRouter" },\n{ label: "/openrouter", description: "OpenRouter account: balance, key usage and 30-day spend" },');
  patch('openLogin, openProvider, openModel, openEffort,', 'openLogin, openProvider, openOpenRouter, openModel, openEffort,');
  patch('if (trimmed === "/provider" || /^\\/provider\\s/.test(trimmed)) {', `if (trimmed === "/openrouter") {
                valueRef.current = ""; cursorRef.current = 0;
                setValue(""); setCursor(0); setCompletionIndex(0); setDismissedMenuValue(void 0);
                recall.current = beginRecall(recallSpace, "");
                if (busy) { notify("Stop the running turn before /openrouter.", "warning"); return; }
                openOpenRouter(); return;
            }
            if (trimmed === "/provider" || /^\\/provider\\s/.test(trimmed)) {`);
  patch('        openProvider: (provider) => {', `        openOpenRouter: () => {
            setProviderOpen(false); setEffortFor(void 0);
            setProviderAction({ kind: "dscode-openrouter" }); setModelOpen(true);
        },
        openProvider: (provider) => {`);
  // Saving the OpenRouter API key offers the optional management key before the switch resumes.
  patch(`                const then = providerAction.then;
                closeModelSurface(); reloadModelSurfaces();
                if (then !== void 0) then(); else notify(dscodeProviderSpec(providerAction.provider).name + " API key saved locally; ready to use.");`,
  `                const then = providerAction.then, provider = providerAction.provider;
                reloadModelSurfaces();
                const finish = () => { closeModelSurface(); if (then !== void 0) then(); else notify(dscodeProviderSpec(provider).name + " API key saved locally; ready to use."); };
                if (provider === "openrouter" && props.dscodeSaveManagementKey !== void 0) { setProviderAction({ kind: "dscode-management-key", optional: true, then: finish }); return; }
                finish();`);
  patch('else if (providerAction?.kind === "dscode-provider") modelSurface = (0, import_react.createElement)(DscodeProviderPanel, {', `else if (providerAction?.kind === "dscode-openrouter") modelSurface = (0, import_react.createElement)(DscodeOpenRouterPanel, {
			load: () => props.dscodeLoadOpenRouterAccount === void 0 ? Promise.reject(new Error("account data is unavailable in this profile")) : props.dscodeLoadOpenRouterAccount(),
			setManagement: () => setProviderAction({ kind: "dscode-management-key", then: () => setProviderAction({ kind: "dscode-openrouter" }) }),
			back: closeModelSurface
		});
		else if (providerAction?.kind === "dscode-management-key") modelSurface = (0, import_react.createElement)(DscodeManagementKeyPanel, {
			optional: providerAction.optional === true,
			status: props.dscodeManagementKeyStatus,
			save: (key) => props.dscodeSaveManagementKey === void 0 ? Promise.reject(new Error("credential storage is unavailable")) : props.dscodeSaveManagementKey(key),
			done: (saved) => {
				if (saved) notify("OpenRouter management key saved locally; /openrouter now shows every API key and your 30-day spend.");
				const then = providerAction.then;
				if (then !== void 0) then(); else closeModelSurface();
			},
			back: () => { const then = providerAction.then; if (then !== void 0) then(); else closeModelSurface(); }
		});
		else if (providerAction?.kind === "dscode-provider") modelSurface = (0, import_react.createElement)(DscodeProviderPanel, {`);
  patch('\t\t\tdscodeEnsureProviderRoute: (provider) => dscodeEnsureProviderRoute(ctx.get("settings"), provider),', `\t\t\tdscodeEnsureProviderRoute: (provider) => dscodeEnsureProviderRoute(ctx.get("settings"), provider),
\t\t\tdscodeManagementKeyStatus: () => dscodeManagementKeyStatus(ctx),
\t\t\tdscodeSaveManagementKey: (key) => dscodeSaveManagementKey(ctx, key),
\t\t\tdscodeLoadOpenRouterAccount: () => dscodeLoadOpenRouterAccountFor(ctx),`);
  patch('function ProviderConfirmPanel({ target, kind, confirm, done, back }) {', UI_SOURCE + '\nfunction ProviderConfirmPanel({ target, kind, confirm, done, back }) {');
  return `${MARKER}\n${IMPORT}\n${text}`;
}
