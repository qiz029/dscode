// Serialized into the pinned TUI, using its React, Ink and keyboard runtime.
export function DscodeEmailPanel({ columns, rows, pick, close, gmail, imap }) {
  const [snapshot, setSnapshot] = (0, import_react.useState)({ emails: [], rejected: 0 });
  const [error, setError] = (0, import_react.useState)('');
  const [selected, setSelected] = (0, import_react.useState)(null);
  const [offset, setOffset] = (0, import_react.useState)(0);
  const [preview, setPreview] = (0, import_react.useState)(false);
  const [gmailStatus, setGmailStatus] = (0, import_react.useState)(() => gmail.status());
  const [imapStatus, setImapStatus] = (0, import_react.useState)(() => imap.status());
  const [setup, setSetup] = (0, import_react.useState)(false);
  const [connecting, setConnecting] = (0, import_react.useState)(false);
  const operation = (0, import_react.useRef)(null);
  (0, import_react.useEffect)(() => () => operation.current?.abort(), []);
  const inbox = (0, import_react.useMemo)(() => dscodeCreateEmailInbox(), []);
  const refresh = () => {
    try { setSnapshot(inbox.list()); setGmailStatus(gmail.status()); setImapStatus(imap.status()); }
    catch { setError('Could not read inbox. Press r to retry.'); }
  };
  (0, import_react.useEffect)(() => {
    refresh();
    const timer = setInterval(refresh, 2000);
    return () => clearInterval(timer);
  }, [inbox]);
  const emails = snapshot.emails;
  const index = Math.max(0, emails.findIndex(mail => dscodeEmailKey(mail) === selected));
  const mail = emails[index];
  (0, import_react.useEffect)(() => {
    if (mail) setSelected(dscodeEmailKey(mail));
  }, [mail && dscodeEmailKey(mail)]);
  const height = Math.max(3, rows);
  const contentRows = Math.max(1, height - 4);
  const wide = columns >= 64;
  const listWidth = wide ? Math.max(26, Math.floor(columns * 0.4)) : columns;
  const previewWidth = wide ? Math.max(1, columns - listWidth - 1) : columns;
  const clean = value => dscodeEmailText(value).replace(/\n/g, ' ');
  const bodyLines = mail ? wrapText(dscodeEmailText(mail.body), Math.max(1, previewWidth - 2), 'wrap').split('\n') : [];
  useStableInput((input, key) => {
    if (setup) return;
    if (key.escape || key.ctrl && input === 'c') { close(); return; }
    if (input === 'i' && !operation.current) { setSetup(true); setError(''); return; }
    if (input === 'g' || input === 'r') {
      if (operation.current) return;
      const controller = new AbortController(); operation.current = controller;
      setError(''); setConnecting(input === 'g');
      const action = input === 'g' ? gmail.connect({ signal: controller.signal }) : (imapStatus.connected ? imap : gmail).sync({ force: true, signal: controller.signal });
      Promise.resolve(action).then(result => {
        if (!controller.signal.aborted) { if (result.busy) setError('Gmail is busy in another session. Retry shortly.'); refresh(); }
      }, reason => { if (!controller.signal.aborted) setError(reason.message); }).finally(() => {
        operation.current = null;
        if (!controller.signal.aborted) setConnecting(false);
      });
      return;
    }
    if (key.tab) { setPreview(current => !current); return; }
    if (!mail) return;
    if (key.upArrow || key.downArrow) {
      const next = Math.max(0, Math.min(emails.length - 1, index + (key.upArrow ? -1 : 1)));
      setSelected(dscodeEmailKey(emails[next])); setOffset(0); return;
    }
    if (key.pageDown || key.pageUp) {
      setOffset(current => Math.max(0, Math.min(Math.max(0, bodyLines.length - contentRows + 2), current + (key.pageUp ? -1 : 1) * Math.max(1, contentRows - 2)))); return;
    }
    if (key.return) pick(mail);
  });
  if (setup) return (0, import_react.createElement)(Box, { height, overflow: 'hidden', flexDirection: 'column' },
    (0, import_react.createElement)(DscodeImapSetup, { connector: imap, back: () => setSetup(false), done: () => { setSetup(false); refresh(); } }));
  const text = (value, extra = {}) => (0, import_react.createElement)(Text, { wrap: 'truncate-end', ...extra }, value);
  const start = Math.max(0, index - contentRows + 1);
  const list = (0, import_react.createElement)(Box, { width: listWidth, flexDirection: 'column', overflow: 'hidden' },
    text('Email · newest updates first', { bold: true }),
    ...emails.slice(start, start + contentRows).map((entry, i) => text(
      (start + i === index ? '› ' : '  ') + entry.updatedAt.slice(5, 16).replace('T', ' ') + ' ' + clean(entry.subject),
      { key: dscodeEmailKey(entry), color: start + i === index ? 'cyan' : undefined })),
    !mail ? text(error || 'No emails received.') : null);
  return (0, import_react.createElement)(Box, { flexDirection: 'column', height, overflow: 'hidden' },
    text(imapStatus.connected ? imapStatus.error || 'IMAP · ' + clean(imapStatus.account) + ' · ' + clean(imapStatus.mailbox) : connecting ? 'Gmail · Complete Google login in your browser · Esc cancels' : gmailStatus.error || (gmailStatus.connected ? 'Gmail · ' + clean(gmailStatus.account) + (gmailStatus.lastSyncAt ? ' · synced ' + new Date(gmailStatus.lastSyncAt).toLocaleTimeString() : ' · waiting for new mail') : 'Email not connected · i IMAP · g Google OAuth'), { dimColor: true }),
    (0, import_react.createElement)(Box, { flexDirection: 'row', height: Math.max(1, height - 2) },
      wide || preview ? (0, import_react.createElement)(Box, { width: previewWidth, marginRight: wide ? 1 : 0, flexDirection: 'column', overflow: 'hidden' },
        text(mail ? clean(mail.subject) : 'Email preview', { bold: true }),
        text(mail ? 'From: ' + clean(mail.from) : 'Waiting for a connector', { dimColor: true }),
        ...bodyLines.slice(offset, offset + Math.max(1, contentRows - 1)).map((line, i) => text(line, { key: i }))) : null,
      wide || !preview ? list : null),
    text(error || (snapshot.rejected ? snapshot.rejected + ' invalid records skipped · ' : '') + (wide ? '↑↓ select · Enter steer · Esc · PgUp/Dn · i IMAP · g OAuth · r sync' : '↑↓ Enter · Tab · i IMAP · r sync'), { dimColor: true }));
}
