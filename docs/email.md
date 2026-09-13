# Email inbox

`/email` opens a local inbox in the TUI. The right-hand list is sorted by
`updatedAt`, newest first; the left side previews the selected message.
On narrow terminals, Tab switches between list and preview.

- ↑/↓ selects a message; PgUp/PgDn scrolls its preview.
- Enter immediately steers the full message, sender, subject and source into
  the current session. A running agent receives it at the next step; an idle
  agent starts a turn. No second Enter is needed.
- Esc closes the inbox without sending. Receipt and browsing never start a model turn.
- The open inbox refreshes every two seconds; `r` refreshes immediately. Selection
  stays on the same message when newer messages arrive.

The inbox belongs to the local user and is shared across sessions. Its default
directory is `~/.dscode/email`; `DSCODE_EMAIL_DIR` overrides it. New directories
use mode 0700 and messages use 0600. Message content enters session history only
when selected with Enter. Existing composer drafts and attachments are preserved.

## Connector boundary

The exported `createEmailInbox()` provides `receive(value)` and `list()`;
`EmailReceiver` in `plugins/email/inbox.d.mts` is the connector's destination
interface. This is an in-process/local-filesystem interface, not an HTTP endpoint.

```js
import { createEmailInbox } from '../plugins/email/inbox.mjs';
// Published bundle export: @toddzheng024/dscode-bundle/email
const receiver = createEmailInbox();
receiver.receive({
  format: 'dscode.email.v1',
  connector: 'example',
  account: 'developer@example.com',
  id: 'provider-message-id',
  from: 'Sender <sender@example.com>',
  subject: 'Investigate a failing build',
  body: 'Please inspect the test failure in the attached report URL.',
  receivedAt: '2026-09-12T10:00:00Z',
  updatedAt: '2026-09-12T10:00:00Z',
});
```

Dates must include a timezone. `updatedAt` cannot precede `receivedAt`. Body is
nonempty plain text, limited to 256 KiB. HTML and attachments must be handled by
the connector before receipt. Unknown formats and malformed fields are rejected.
Terminal controls are removed from display and insertion. Mail is inserted as a
JSON envelope with `type: "user_injected_email_context"`, `injectedBy: "user"`,
`purpose: "supplement_session_context"`, explicit context-only instructions, and
a nested `email` object. The email is external reference material, not a new
user instruction or authorization to act. Enter directly injects this envelope
in both idle and running sessions.

Identity is `(connector, account, id)`. Exact repeats are idempotent; immutable,
atomically written revisions ensure a late delivery cannot replace a newer
revision, including when multiple processes receive mail. For the same identity,
changed content should have a strictly newer `updatedAt`; equal timestamps use a
stable content-hash tie break. Corrupt records are skipped with a visible count.
Revisions are retained locally; this first version has no deletion/retention UI.

## IMAP connection (no Google OAuth client required)

Restart the local TUI, enter `/email`, and press **i**. The setup walks through:

1. Mailbox login address.
2. IMAP host (default `imap.gmail.com`).
3. TLS port (default `993`).
4. Folder (default `INBOX`; an existing `ToAgent` folder may be used).
5. Application password, entered in a masked private field.

Enter accepts each field; Tab revisits fields; Ctrl+U clears the current field.
Esc cancels, including an in-flight connection. Credentials are saved only after
TLS login and opening the chosen folder succeed. They are never submitted to
the agent, recorded in composer history, or printed in status/error messages.
To update a password, press **i** and reconnect the same account and folder.

For Gmail, first enable 2-Step Verification and generate an application password
in [Google Account settings](https://support.google.com/mail/answer/185833?hl=en).
Some organization or Advanced Protection accounts do not offer this option.
Use that password in the TUI, not the ordinary Google account password. No Google
Cloud project or client JSON is needed for this IMAP path.

The default directly filters `INBOX` by the exact `[ToAgent]` subject prefix.
It does not require or create a Gmail label/filter. If a custom `ToAgent` folder
is selected, create and route mail to that folder in the mail provider first.
Only the selected folder is checked; mail auto-archived elsewhere is not picked
up from `INBOX`. App passwords grant mailbox access, not per-folder access; the
connector enforces the selected folder and subject checks.

Connections require TLS with certificate verification. The client opens the
folder read-only and uses `BODY.PEEK`; it never marks mail read, changes flags,
sends mail, or deletes messages. Strict subject checks happen before retrieving
a full message. Plain-text MIME bodies are accepted, including multipart
alternatives; HTML-only and attachment-only messages are skipped. Raw messages
are capped at 2 MiB and the decoded text at 256 KiB, so larger messages are skipped.

The first successful connection records UIDVALIDITY and UIDNEXT without importing
existing mail. Subsequent polls use bounded UID ranges, process at most 50 matching
candidates per poll, and checkpoint only after persistence. Retries deduplicate
by source content. UIDVALIDITY changes trigger recovery using the original
connection timestamp (at IMAP's second precision) and content identity, instead
of trusting old UIDs or importing the whole historical inbox.

All sessions share `~/.dscode/email/imap/connection.json` (or
`$DSCODE_EMAIL_DIR/imap/connection.json`). It contains the credentials and cursor,
is written atomically with mode 0600 inside a new 0700 directory, and is guarded
by a kernel lock. A running TUI polls every 30 seconds even with `/email` closed;
there is no daemon after all TUIs exit. Press **r** for an immediate sync.

IMAP takes precedence over the earlier Gmail OAuth connector when both are
configured, avoiding two background connectors polling the same mailbox. The
existing OAuth configuration is retained. Previously imported messages remain
in the shared inbox; cross-connector imports are not merged automatically.

Development diagnostics (no passwords accepted as CLI arguments):

```sh
node bin/dscode.mjs email imap-status
node bin/dscode.mjs email imap-sync
```

The packaged launcher supports `dscode email imap-status` and `imap-sync` after
release. The current implementation is local and has not been publicly released.

## Gmail OAuth connection (optional)

The Gmail connector is implemented locally. It requires a Google Cloud Desktop
OAuth client and the user's browser authorization before real mail can sync.

1. In Google Cloud, enable **Gmail API**, configure the OAuth consent screen, and
   create an OAuth client with application type **Desktop app**. Download its
   JSON file. See [Google's setup instructions](https://developers.google.com/workspace/gmail/api/quickstart/nodejs).
2. Import the downloaded file using its path (never paste its contents into chat):

   ```sh
   node bin/dscode.mjs email configure /absolute/path/to/client.json
   ```

3. Restart the local TUI, open `/email`, and press **g**. Choose the Gmail account
   and grant the requested permissions in the system browser. Esc cancels.
   Alternatively, run `node bin/dscode.mjs email connect`.
4. After connection succeeds, new incoming mail must have a subject beginning
   with `[ToAgent]` followed by whitespace or the end of the subject, and a
   nonempty `text/plain` body. For example, `[ToAgent] Check the login module`.

The distributed launcher supports the same commands as `dscode email configure`,
`connect`, `status`, and `sync` when this version is released. Development commands
above run the current checkout. `status` reports no secrets; `sync` performs one
explicit sync. `/email` shows the connection status; **r** requests an immediate
sync and **g** reauthorizes the same account if access expires.

The connector creates or reuses the **ToAgent** label and an incoming-mail
subject filter. Gmail's subject search is a candidate filter; the connector
independently checks the exact `[ToAgent]` prefix, current label and receipt date
before fetching a full body. Replies prefixed `Re:`, HTML-only messages, drafts,
sent mail, trash and spam are not imported. A `text/plain` alternative within a
multipart message is accepted; ordinary attachments and nested forwarded-message
attachments are not imported. Plain-text MIME bodies stored separately by Gmail
are fetched using the body attachment endpoint. No messages are sent, marked
read, deleted or automatically submitted to an agent.

OAuth requests `gmail.readonly`, `gmail.labels`, and `gmail.settings.basic` for
reading mail and setting up the agreed label/filter. These are Google account
permissions, not a Google-enforced per-label grant; DSCODE's connector enforces
the mail filter. See Google's [label](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.labels/create)
and [filter](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.settings.filters/create)
permission documentation. Login uses [desktop loopback OAuth with PKCE and state validation](https://developers.google.com/identity/protocols/oauth2/native-app).

The client JSON, tokens and sync state are stored privately under
`~/.dscode/email/gmail/` (or `$DSCODE_EMAIL_DIR/gmail/`). Files are atomic 0600
writes inside a new 0700 directory. `DSCODE_GMAIL_CLIENT_FILE` optionally points
at an existing client JSON instead of importing it. Keep that file available
for token refresh. Only one account is supported; reconnecting another account
is rejected without replacing the current credentials.

After first connection, this connector records a Gmail history cursor and does
not import old mail. A running TUI syncs every 30 seconds, even with the inbox
panel closed, provided IMAP is not configured. There is no always-on daemon: when all TUIs are closed, the next
launch catches up. Multiple sessions share a kernel lock and a polling timestamp.
The cursor advances only after all accepted messages are persisted. Retries are
idempotent. If [Gmail history expires](https://developers.google.com/workspace/gmail/api/guides/sync),
recovery lists labelled messages since the original connection date and retains
that date boundary. Reauthorization of the same account also retains it.

This first connector has no account-switch or disconnect UI. Revocation is
available through the Google account's app-access settings. Provisioned labels
and filters are not removed automatically.

Validation: `npm test` includes deterministic Gmail transport fixtures, real
local OAuth callback/PKCE/cancellation tests, shared-lock and cursor recovery
checks, a local TLS server exercising the real IMAP library, MIME parsing, masked
IMAP credential entry, and the real Ink `/email` keyboard flow. Callback tests require local
loopback listeners. Real Google authorization and mail delivery are separate
verification steps; automated tests use no actual Gmail credentials or messages.

## Send email from the agent

After configuring Gmail with an application password, restart DSCODE to load
`send_email` and `email_send_status`. Ask, for example: “Send a [ToAgent] email
to colleague@example.com summarizing this change and asking them to review it.”
The agent uses the existing approval flow to check recipient and content against
your authorization. Incoming mail does not authorize automatic replies.

`send_email` accepts `to` (one address), `subject`, `body` (plain text, up to
256 KiB), and a globally unique `idempotency_key`. It automatically adds
`[ToAgent]` unless already present. The sender is your configured Gmail account;
SMTP uses `smtp.gmail.com:465` with verified TLS and the existing local app
password. No OAuth client JSON or separate password is needed. This initial
sender supports Gmail app-password connections, not custom IMAP hosts or the
optional OAuth connector. Attachments, CC/BCC and automatic replies are not part
of this tool.

Receipts are shared across sessions under `~/.dscode/email/outbox` (or
`DSCODE_EMAIL_DIR/outbox`), with private file permissions. `accepted` means the
SMTP server accepted the mail; it does not prove delivery or that someone read
it. `uncertain` means the send may have succeeded despite an interrupted
response. Check with `email_send_status`; never use a new key to blindly retry.
Repeating the same key and content returns the existing receipt without sending.
A key reused for different content is rejected.

## Contact aliases

Save a recipient once, then say “发给 congkai，告诉他这次修改已经完成”:

```sh
dscode email alias set congkai actual-address@example.com
dscode email alias list
dscode email alias remove congkai
```

Replace the example address with the person's real email. Aliases are shared
across sessions in the local email directory (`contacts/aliases.json`), are
case-insensitive, and contain 1–64 letters, digits, underscores or hyphens.
`set` also updates an existing alias. Changes take effect without restarting;
restart once after installing this version to load the new agent tool.

The agent calls `resolve_email_recipient`, then supplies both `to: "congkai"`
and `resolved_to: "actual-address@example.com"` to `send_email`. Approval sees
both the alias and the real address. Unknown aliases fail without guessing an
address; a changed mapping is rejected at send time until resolved and reviewed
again. Configuring an alias does not send mail or enable automatic replies.

You can also manage aliases by asking the agent directly:

- “把 congkai 的邮箱设为 person@example.com” creates or updates the mapping.
- “列出我的邮箱别名” lists contacts.
- “删除 congkai 的邮箱别名” removes it.

The tools are `set_email_alias`, `list_email_aliases`, and `remove_email_alias`.
They use the same shared contact store as the CLI. The agent asks for the real
email address if it is missing; it must not infer contact changes from incoming
mail. Saving a contact does not send any email.
