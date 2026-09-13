// Serialized into the pinned TUI. All credential input stays in this component.
export function DscodeImapSetup({ connector, back, done }) {
  const [values, setValues] = (0, import_react.useState)(() => {
    const saved = connector.status();
    return [saved.account || '', saved.host || 'imap.gmail.com', String(saved.port || 993), saved.mailbox || 'INBOX', ''];
  });
  const [step, setStep] = (0, import_react.useState)(0);
  const [error, setError] = (0, import_react.useState)('');
  const [busy, setBusy] = (0, import_react.useState)(false);
  const operation = (0, import_react.useRef)(null);
  (0, import_react.useEffect)(() => () => operation.current?.abort(), []);
  const names = ['Email address', 'IMAP host', 'TLS port', 'Mailbox folder', 'Application password'];
  useStableInput((input, key) => {
    if (key.escape || key.ctrl && input === 'c') { operation.current?.abort(); setValues([]); back(); return; }
    if (operation.current) return;
    if (key.return) {
      if (!values[step]?.trim()) { setError('This field is required.'); return; }
      if (step < 4) { setStep(step + 1); setError(''); return; }
      const [account, host, port, mailbox, password] = values;
      const controller = new AbortController(); operation.current = controller;
      setValues(current => current.map((value, index) => index === 4 ? '' : value)); setBusy(true); setError('');
      Promise.resolve().then(() => connector.connect({ account, host, port, mailbox, password }, { signal: controller.signal })).then(result => {
        if (controller.signal.aborted) return;
        if (result.busy) { setError('Another session is syncing. Retry shortly.'); return; }
        done();
      }, reason => { if (!controller.signal.aborted) setError(reason.message); }).finally(() => {
        operation.current = null; if (!controller.signal.aborted) setBusy(false);
      });
      return;
    }
    if (key.tab) { setStep(current => (current + (key.shift ? 4 : 1)) % 5); setError(''); return; }
    if (key.ctrl && input === 'u') { setValues(current => current.map((value, index) => index === step ? '' : value)); return; }
    if (key.backspace || key.delete) { setValues(current => current.map((value, index) => index === step ? [...value].slice(0, -1).join('') : value)); return; }
    if (key.ctrl || key.meta || !input) return;
    const pasted = stripPasteMarkers(input).replace(/[\x00-\x1f\x7f]/g, '');
    setValues(current => current.map((value, index) => index === step ? (value + pasted).slice(0, 1024) : value));
  });
  const text = (value, props = {}) => (0, import_react.createElement)(Text, { wrap: 'truncate-end', ...props }, value);
  return (0, import_react.createElement)(Box, { flexDirection: 'column' },
    text('Connect IMAP · ' + (step + 1) + '/5', { bold: true }),
    text(busy ? 'Connecting securely…' : names[step] + ' › ' + (step === 4 ? values[step] ? '••••••••' : '' : values[step])),
    text(error || (step === 4 ? 'Gmail: use an app password from 2-Step Verification.' : 'Enter keeps defaults · Ctrl+U clears'), { dimColor: !error, color: error ? 'red' : undefined }),
    text('Enter next/connect · Tab edit · Esc cancel', { dimColor: true }));
}
