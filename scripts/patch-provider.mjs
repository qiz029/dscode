import { replaceOnce } from './patch-util.mjs';
import { catalogEntry, catalogAnchor } from './patch-command-catalog.mjs';

// `/provider` switches the session between DeepSeek's official API and OpenRouter,
// and `/login [provider]` stores either key. The provider catalog ships beside the
// TUI (lib/dscode-providers), so the source checkout and the vendored bundle
// import it the same way.
export function patchProvider(text) {
  const marker = '// dscode-provider-v1';
  if (text.includes(marker)) return text;
  const patch = (from, to) => { text = replaceOnce(text, from, to); };
  // The 1.2.0 catalog already carries the provider row; an older tree needs it appended.
  if (!text.includes(catalogEntry('provider'))) {
    patch(catalogAnchor('login'), catalogAnchor('login') + catalogAnchor('provider'));
  }
  patch('openLogin, openModel, openEffort,', 'openLogin, openProvider, openModel, openEffort,');
  // Arguments are provider names only; anything else may be a pasted key and is never echoed.
  patch('if (trimmed !== "/login") { notify("Use /login alone, then paste the key in the private input.", "warning"); return; }',
    'const dscodeLoginTarget = dscodeProviderArgument(trimmed.slice(6));\n                if (dscodeLoginTarget === null) { notify("Use /login, /login deepseek or /login openrouter, then paste the key in the private input.", "warning"); return; }');
  patch('                openLogin(); return;\n            }', `                openLogin(dscodeLoginTarget); return;
            }
            if (trimmed === "/provider" || /^\\/provider\\s/.test(trimmed)) {
                valueRef.current = ""; cursorRef.current = 0;
                setValue(""); setCursor(0); setCompletionIndex(0); setDismissedMenuValue(void 0);
                recall.current = beginRecall(recallSpace, "");
                const dscodeProviderTarget = dscodeProviderArgument(trimmed.slice(9));
                if (dscodeProviderTarget === null) { notify("Usage: /provider [deepseek|openrouter]", "warning"); return; }
                if (busy) { notify("Stop the running turn before /provider.", "warning"); return; }
                openProvider(dscodeProviderTarget); return;
            }`);
  // OpenRouter model ids carry their own vendor segment: split the label at the first slash only.
  patch('const [provider, model] = modelLabel.split("/");', 'const { provider, model } = dscodeSplitModelLabel(modelLabel);');
  patch(' · open /model to add an API key', ' · run /login to add an API key');
  patch(`\t\topenLogin: () => {
            setProviderOpen(false); setEffortFor(void 0);
            setProviderAction({ kind: "dscode-key" }); setModelOpen(true);
        },`, `\t\topenLogin: (provider) => {
            setProviderOpen(false); setEffortFor(void 0);
            setProviderAction({ kind: "dscode-key", provider: provider ?? dscodeProviderOfLabel(modelLabel) }); setModelOpen(true);
        },
        openProvider: (provider) => {
            if (provider !== void 0) { dscodeSwitchProvider(provider); return; }
            setProviderOpen(false); setEffortFor(void 0);
            setProviderAction({ kind: "dscode-provider" }); setModelOpen(true);
        },`);
  patch(`if (providerAction?.kind === "dscode-key") modelSurface = (0, import_react.createElement)(DscodeLoginPanel, {
            load: props.loadModelProviders,
            save: props.saveModelProviderCredential,
            done: () => { closeModelSurface(); reloadModelSurfaces(); notify("DeepSeek API key saved locally; ready to use."); },
            back: closeModelSurface
        });`, `if (providerAction?.kind === "dscode-provider") modelSurface = (0, import_react.createElement)(DscodeProviderPanel, {
            current: dscodeProviderOfLabel(modelLabel),
            load: props.loadModelProviders,
            choose: dscodeSwitchProvider,
            back: closeModelSurface
        });
        else if (providerAction?.kind === "dscode-key") modelSurface = (0, import_react.createElement)(DscodeLoginPanel, {
            provider: providerAction.provider,
            load: async () => { await props.dscodeEnsureProviderRoute?.(providerAction.provider); return props.loadModelProviders(); },
            save: props.saveModelProviderCredential,
            done: () => {
                const then = providerAction.then;
                closeModelSurface(); reloadModelSurfaces();
                if (then !== void 0) then(); else notify(dscodeProviderSpec(providerAction.provider).name + " API key saved locally; ready to use.");
            },
            back: closeModelSurface
        });`);
  patch('\tconst reloadModelSurfaces = () => {', switchProvider + '\tconst reloadModelSurfaces = () => {');
  patch('\t\t\tloadModels: () => loadModelDirectory(ctx),', '\t\t\tloadModels: () => loadModelDirectory(ctx),\n\t\t\tdscodeEnsureProviderRoute: (provider) => dscodeEnsureProviderRoute(ctx.get("settings"), provider),');
  const start = text.indexOf('function DscodeLoginPanel(');
  const end = text.indexOf('\nfunction ProviderSetupPanel(');
  if (start < 0 || end < start) throw new Error('Pinned runtime patch drift: DscodeLoginPanel');
  // Never discard anything between the two panels silently: assert the slice we remove is
  // the install's own login panel before replacing it.
  const removed = text.slice(start, end);
  // Refuse to swallow anything upstream may have added between the two panels: the removed
  // slice must be exactly the bracketed login panel we are replacing.
  if (!removed.trimEnd().endsWith('}') || /^function [A-Za-z]/m.test(removed.slice(1)) || removed.length > 20000) throw new Error('Pinned runtime patch drift: provider panel splice');
  text = text.slice(0, start) + DscodeLoginPanel.toString() + '\n' + DscodeProviderPanel.toString() + '\n' + text.slice(end);
  return marker + '\n' + IMPORT + '\n' + text;
}

const IMPORT = 'import { PROVIDERS as DSCODE_PROVIDERS, providerSpec as dscodeProviderSpec, providerArgument as dscodeProviderArgument, providerOfLabel as dscodeProviderOfLabel, splitModelLabel as dscodeSplitModelLabel, pickModel as dscodePickModel, credentialState as dscodeCredentialState, ensureProviderRoute as dscodeEnsureProviderRoute, waitForModels as dscodeWaitForModels } from "./dscode-providers/catalog.mjs";';

// Declared once in App, after applyModel: a switch declares the route, asks for a
// missing key (then resumes), and lands on the counterpart model.
const switchProvider = `\t// dscode-provider-switch
\tconst dscodeSwitchProvider = (provider) => {
\t\tconst spec = dscodeProviderSpec(provider);
\t\tif (props.loadModelProviders === void 0) { notify("provider switching is unavailable in this profile", "warning"); return; }
\t\tPromise.resolve().then(async () => {
\t\t\tif (props.dscodeEnsureProviderRoute !== void 0 && await props.dscodeEnsureProviderRoute(provider)) reloadModelSurfaces();
\t\t\tconst providers = await props.loadModelProviders();
\t\t\tconst state = dscodeCredentialState(providers.rows.find((row) => row.provider === provider));
\t\t\tif (state === "unavailable") { notify(spec.name + " is unavailable in this profile", "error"); return; }
\t\t\tif (state === "missing") {
\t\t\t\tsetProviderOpen(false); setEffortFor(void 0);
\t\t\t\tsetProviderAction({ kind: "dscode-key", provider, then: () => dscodeSwitchProvider(provider) }); setModelOpen(true);
\t\t\t\treturn;
\t\t\t}
\t\t\tif (state === "error" || state === "readonly") notify("could not confirm the " + spec.name + " API key; requests may fail until /login " + provider + " succeeds", "warning");
\t\t\tconst models = await dscodeWaitForModels(props.loadModels, provider);
\t\t\tconst pick = dscodePickModel(models.rows, provider, modelLabel, effortLabel);
\t\t\tif (pick === void 0) { notify(spec.name + " serves no models yet — check /model", "error"); return; }
\t\t\tapplyModel(pick.row, pick.effort);
\t\t}).catch((error) => notify("provider switch failed: " + (error instanceof Error ? error.message : String(error)), "error"));
\t};
`;

// Both panels are serialized into the TUI bundle, where React, Ink and the input
// helpers are module globals.
/* global import_react, Box, Text, useStableInput, ENV_ASSIGNMENT, hasWrappingQuotes, stripPasteMarkers, DSCODE_PROVIDERS, dscodeProviderSpec, dscodeCredentialState */
function DscodeLoginPanel({ provider, load, save, done, back }) {
  const spec = dscodeProviderSpec(provider) ?? DSCODE_PROVIDERS[0];
  const [draft, setDraft] = (0, import_react.useState)("");
  const [target, setTarget] = (0, import_react.useState)(void 0);
  const [error, setError] = (0, import_react.useState)("");
  const [busy, setBusy] = (0, import_react.useState)(false);
  const saving = (0, import_react.useRef)(false);
  (0, import_react.useEffect)(() => {
    let active = true;
    Promise.resolve().then(() => load()).then(directory => {
      if (!active) return;
      const row = directory.rows.find(row => row.provider === spec.id);
      if (!row || !save) { setError(spec.name + " credential storage is unavailable."); return; }
      if (row.credential?.kind === "error") { setError("Could not read credential status. Check local file permissions."); return; }
      if (row.credential?.kind === "facts" && !row.credential.writable) { setError(spec.credentialRef + " is set by your environment. Remove it and restart to use /login."); return; }
      setTarget(row);
    }, () => { if (active) setError("Could not load " + spec.name + " credential settings."); });
    return () => { active = false; };
  }, [spec.id]);
  useStableInput((input, key) => {
    if (saving.current) return;
    if (key.escape || key.ctrl && input === "c") { setDraft(""); back(); return; }
    if (!target) return;
    if (key.return) {
      const raw = draft.trim();
      if (!raw || /[\s\x00-\x1f\x7f-￿]/.test(raw) || ENV_ASSIGNMENT.test(raw) || hasWrappingQuotes(raw)) {
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
    (0, import_react.createElement)(Text, { bold: true }, spec.name + " login"),
    (0, import_react.createElement)(Text, { dimColor: true }, "Saved on this Mac in ~/.dscode/credentials.yaml"),
    (0, import_react.createElement)(Text, null, busy ? "Saving…" : target ? "API key › " + (draft ? "••••••••" : "paste your key") : error ? "" : "Loading…"),
    error ? (0, import_react.createElement)(Text, { color: "red" }, error) : void 0,
    (0, import_react.createElement)(Text, { dimColor: true }, "Enter save · Esc cancel · Ctrl+U clear"));
}

function DscodeProviderPanel({ current, load, choose, back }) {
  const [directory, setDirectory] = (0, import_react.useState)(void 0);
  const [failed, setFailed] = (0, import_react.useState)(false);
  const [cursor, setCursor] = (0, import_react.useState)(() => Math.max(0, DSCODE_PROVIDERS.findIndex(provider => provider.id === current)));
  (0, import_react.useEffect)(() => {
    let active = true;
    Promise.resolve().then(() => load()).then(loaded => { if (active) setDirectory(loaded); }, () => { if (active) setFailed(true); });
    return () => { active = false; };
  }, []);
  useStableInput((input, key) => {
    const count = DSCODE_PROVIDERS.length;
    if (key.escape || key.ctrl && input === "c" || input === "q") { back(); return; }
    if (key.upArrow || input === "k") { setCursor(index => (index + count - 1) % count); return; }
    if (key.downArrow || input === "j") { setCursor(index => (index + 1) % count); return; }
    if (key.return) { back(); choose(DSCODE_PROVIDERS[cursor].id); }
  });
  const status = provider => {
    if (failed) return "status unavailable";
    if (directory === void 0) return "…";
    const row = directory.rows.find(row => row.provider === provider.id);
    const state = dscodeCredentialState(row);
    if (state === "saved") return "key saved";
    if (state === "env") return "key from " + provider.credentialRef;
    if (state === "readonly") return provider.credentialRef + " is empty";
    if (state === "error") return "credential status unavailable";
    if (state === "unavailable") return "unavailable in this profile";
    return row?.configured === true || provider.id === "deepseek-official" ? "needs an API key" : "not set up · Enter sets it up";
  };
  return (0, import_react.createElement)(Box, { flexDirection: "column", paddingX: 2 },
    (0, import_react.createElement)(Text, { bold: true }, "Provider"),
    (0, import_react.createElement)(Text, { dimColor: true, wrap: "truncate-end" }, "The next step uses the chosen provider; /model picks among its models."),
    ...DSCODE_PROVIDERS.map((provider, index) => (0, import_react.createElement)(Text, { key: provider.id, bold: index === cursor, wrap: "truncate-end" },
      (index === cursor ? "› " : "  ") + (provider.id === current ? "● " : "○ ") + provider.name.padEnd(11) + provider.id + " · " + status(provider))),
    (0, import_react.createElement)(Text, { dimColor: true }, "↑↓ choose · Enter switch · Esc cancel"));
}
