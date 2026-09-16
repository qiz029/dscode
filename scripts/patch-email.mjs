import { replaceOnce } from './patch-util.mjs';
import { catalogEntry, catalogAnchor } from './patch-command-catalog.mjs';
import { DscodeEmailPanel } from './email-panel.mjs';
import { DscodeImapSetup } from './imap-panel.mjs';

export function patchEmail(text) {
  if (text.includes('// dscode-email-v4')) return text;
  if (text.includes('// dscode-email-v3')) return addSteer(text);
  if (text.includes('// dscode-email-v2')) return addSteer(addImap(text));
  if (text.includes('// dscode-email-v1')) return addSteer(addImap(addGmail(text)));
  const patch = (from, to) => { text = replaceOnce(text, from, to); };
  // The 1.2.0 DSCODE catalog already carries the /email row; older trees need it inserted.
  if (!text.includes(catalogEntry('email'))) {
    patch(catalogAnchor('login'), catalogAnchor('email') + catalogAnchor('login'));
  }
  patch('quit, openLogin,', 'quit, openEmail, emailFill, emailConsumed, openLogin,');
  patch('const text = submissionPayload(liveValue);', `const text = submissionPayload(liveValue);
            if (/^\\/email(?:\\s|$)/.test(trimmed)) {
                if (trimmed !== "/email") { notify("Use /email to open the inbox.", "warning"); return; }
                valueRef.current = ""; cursorRef.current = 0;
                setValue(""); setCursor(0); setCompletionIndex(0); setDismissedMenuValue(void 0);
                recall.current = beginRecall(recallSpace, "");
                openEmail(); return;
            }`);
  patch('\tconst killRef = (0, import_react.useRef)("");', `
    (0, import_react.useEffect)(() => {
      if (!emailFill) return;
      if (emailFill.sessionKey === sessionKey) {
        const next = valueRef.current + (valueRef.current ? "\\n\\n" : "") + sanitizeDraftText(emailFill.text);
        valueRef.current = next; cursorRef.current = next.length;
        setValue(next); setCursor(next.length); setDismissedMenuValue(void 0);
      }
      emailConsumed();
    }, [emailFill, sessionKey, emailConsumed]);
\tconst killRef = (0, import_react.useRef)("");`);
  patch('function App(props) {', `function App(props) {
    const [emailOpen, setEmailOpen] = (0, import_react.useState)(false);
    const [emailFill, setEmailFill] = (0, import_react.useState)(void 0);
    const emailConsumed = (0, import_react.useCallback)(() => setEmailFill(void 0), []);
    (0, import_react.useEffect)(() => { setEmailOpen(false); setEmailFill(void 0); }, [props.sessionKey]);`);
  patch(': !modelOpen && !helpOpen', ': !emailOpen && !modelOpen && !helpOpen');
  patch('const transcriptVisible = !modelOpen', 'const transcriptVisible = !emailOpen && !modelOpen');
  patch('const modalVisible = modelOpen', 'const modalVisible = emailOpen || modelOpen');
  patch('if (!approvalPending && !questionPending) return;', 'if (!approvalPending && !questionPending) return;\n        setEmailOpen(false);');
  patch('transcriptVisible ? (0, import_react.createElement)(Box, { flexDirection: "column" }, auditedLiveLines.length === 0', `emailOpen && !approvalPending && !questionPending ? (0, import_react.createElement)(DscodeEmailPanel, {
      columns: terminalColumns, rows: Math.max(3, terminalRows - 8 - composerGutterRows - composerRows),
      close: () => setEmailOpen(false),
      pick: mail => { setEmailFill({ text: dscodeEmailPrompt(mail), sessionKey: props.sessionKey }); setEmailOpen(false); }
    }) : void 0,
    transcriptVisible ? (0, import_react.createElement)(Box, { flexDirection: "column" }, auditedLiveLines.length === 0`);
  patch('\t\topenLogin: () => {', '\t\topenEmail: () => setEmailOpen(true),\n\t\temailFill, emailConsumed,\n\t\topenLogin: () => {');
  return addSteer(addImap(addGmail('// dscode-email-v1\nimport { createEmailInbox as dscodeCreateEmailInbox, emailKey as dscodeEmailKey, emailPrompt as dscodeEmailPrompt, emailText as dscodeEmailText } from "./dscode-email.mjs";\n' + DscodeEmailPanel.toString() + '\n' + text)));
}

function addImap(text) {
  const start = text.indexOf('function DscodeEmailPanel('), end = text.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw Error('Pinned email panel drift');
  text = text.slice(0, start) + DscodeImapSetup.toString() + '\n' + DscodeEmailPanel.toString() + text.slice(end + 2);
  text = replaceOnce(text, '// dscode-email-v2', '// dscode-email-v3\nimport { createImapConnector as dscodeCreateImapConnector } from "./dscode-email/imap.mjs";');
  text = replaceOnce(text, 'const gmail = (0, import_react.useMemo)(() => dscodeCreateGmailConnector(), []);', 'const gmail = (0, import_react.useMemo)(() => dscodeCreateGmailConnector(), []);\n    const imap = (0, import_react.useMemo)(() => dscodeCreateImapConnector(), []);');
  text = replaceOnce(text, 'const sync = () => gmail.sync({ signal: controller.signal }).catch(() => {});', 'const sync = () => (imap.status().connected ? imap : gmail).sync({ signal: controller.signal }).catch(() => {});');
  text = replaceOnce(text, '}, [gmail]);', '}, [gmail, imap]);');
  return replaceOnce(text, 'gmail, columns: terminalColumns,', 'gmail, imap, columns: terminalColumns,');
}

function addGmail(text) {
  const start = text.indexOf('function DscodeEmailPanel(');
  const end = text.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw Error('Pinned email panel drift');
  text = text.slice(0, start) + DscodeEmailPanel.toString() + text.slice(end + 2);
  text = replaceOnce(text, '// dscode-email-v1', '// dscode-email-v2\nimport { createGmailConnector as dscodeCreateGmailConnector } from "./dscode-email/gmail.mjs";');
  text = replaceOnce(text, 'from "./dscode-email.mjs";', 'from "./dscode-email/inbox.mjs";');
  text = replaceOnce(text, 'function App(props) {', `function App(props) {
    const gmail = (0, import_react.useMemo)(() => dscodeCreateGmailConnector(), []);
    (0, import_react.useEffect)(() => {
      const controller = new AbortController();
      const sync = () => gmail.sync({ signal: controller.signal }).catch(() => {});
      sync(); const timer = setInterval(sync, 30000);
      return () => { clearInterval(timer); controller.abort(); };
    }, [gmail]);`);
  return replaceOnce(text, 'columns: terminalColumns, rows: Math.max(3, terminalRows - 8 - composerGutterRows - composerRows),',
    'gmail, columns: terminalColumns, rows: Math.max(3, terminalRows - 8 - composerGutterRows - composerRows),');
}

function addSteer(text) {
  text = replaceOnce(text, '// dscode-email-v3', '// dscode-email-v4');
  text = replaceOnce(text, 'pick: mail => { setEmailFill({ text: dscodeEmailPrompt(mail), sessionKey: props.sessionKey }); setEmailOpen(false); }', 'pick: mail => { props.steer(dscodeEmailPrompt(mail), [], props.sessionKey); setEmailOpen(false); }');
  // The catalog row now renders through cmd.dscode.email, so the steer wording rides the key's text.
  // Refresh panel help on existing locally patched runtimes as well.
  const start = text.indexOf('function DscodeEmailPanel('), end = text.indexOf('\n}\n', start);
  if (start < 0 || end < 0) throw Error('Pinned email panel drift');
  return text.slice(0, start) + DscodeEmailPanel.toString() + text.slice(end + 2);
}
