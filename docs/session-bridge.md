# One session, many sources

Supported since DSCODE 0.2.0. A running dscode Host holds the single Agent/session; other terminals and scripts attach to it over a Unix socket. A client never starts another Harness, resumes a session, or opens a session write handle.

Built-in agent communication tools, `defer` notes, a persisted mailbox and anti-loop budgets are covered in [Agent-to-agent tasks](session-communication.md). The read/watch cursors below still belong to the native session log; the mailbox uses its own cursor.

## Usage

Start or resume the TUI first. Inside the TUI, `/session` shows the full session ID and the socket address. From another terminal:

```sh
dscode sessions
dscode send SESSION_ID --source script "check why the tests fail first"
dscode send SESSION_ID --source ci --title "fix the build failure" "look at this build log"
dscode send SESSION_ID --source editor --steer "also: change only the parser module"
dscode read SESSION_ID
dscode watch SESSION_ID
```

`send` delivers into the next turn by default; `--steer` delivers into the next step without interrupting the running model request or tool. A source name may contain letters (Latin or CJK), digits and `_.:@/-`, up to 64 characters. A message body is at most 64000 bytes. Put a body that starts with `-` after `--`.

`--title` explicitly sets the current session's title, persisted through the native title service and announced to the TUI; later automatic naming will not overwrite it. A title is stripped of control characters, whitespace-collapsed and truncated to the native limit (80 UTF-8 bytes by default). An empty title is refused; omitting the option changes nothing and calls no model. `sessions`, `read` and the send response all carry the current `title`, which is `null` while unnamed.

In the TUI an external message shows its full body with an `[External source: ...]` label and also enters the native pending-message queue. The log still marks it as a plugin relay: it never impersonates local user input or a permission approval. The source label is for recognition, not authentication; under one OS user, any process able to reach the socket has session access.

`sessions` lists only running root sessions in the current state directory. Either the full ID or a unique prefix works; when several Hosts carry the same ID, the send is refused. An exited session must be resumed in the TUI first. Child agents expose no direct write entry point.

`sessions` and `read` also return the descriptive `card` (project, workspace, recent user-request topics) and the separate `cardState` update status. The TUI `/session` shows them too. A card carries no conclusions; see [Session cards](session-cards.md).

The source entry point looks in the project `.runtime` by default; the npm launcher uses `$DSCODE_HOME` or `~/.local/share/dscode-hub`. Every client command accepts `--home /absolute/state/directory` to reach another installation or a temporary profile.

## Writing and retrying

A message enters the inbox through the native `Agent.followup()` / `Agent.steer()`, and the model and its tools are still scheduled by the single native driver. There is no asynchronous gap between validation, de-duplication and inbox submission; a slow model request holds no write lock. TUI input and external input share one inbox.

```sh
dscode send SESSION_ID --source ci --request-id build-123 "the build failed, please look"
```

An `accepted: true` response means the message passed the native session's persistence flush barrier; it does not mean the task is done. The client prints the request ID to stderr before submitting, so a lost response is retried with the same ID, source, mode and body. A repeated request returns `duplicate: true` and is not delivered again; the same ID with different content is an error.

With `--title`, the title is part of the request identity and must stay the same on a retry. A repeated request will not pull a later title change back to the old value.

De-duplication evidence comes from persisted inbox events, so it survives a normal exit and a resume. Cancelling or deleting a queued message does not erase the fact that it was received; use a new ID to genuinely send it again.

This is message-reception de-duplication, not an exactly-once guarantee for tool side effects. When sources send at the same time, the order is whatever order the Host actually completes inbox submission in; the wall-clock send order of different processes is not preserved.

## Reading without contending for the write lock

`read` returns JSON: an immutable event page, the current status, the inbox, a page-tail `cursor` and the log tail `head` at snapshot time. Keep paging while `cursor < head`:

```sh
dscode read SESSION_ID --after 123 --limit 100
```

`--after` is the last event sequence already received and defaults to `-1`; `--limit` defaults to 100 and caps at 500. Take the next page from the previous `cursor`; do not use `head` to skip events you have not read.

`watch` emits NDJSON: `ready` first, then the history after `after`, then `caught-up`, then every new event as it happens. Subscribing and taking the snapshot happen in the same synchronous boundary, and overlapping events are de-duplicated by sequence. Leaving the session emits `closed`; an unexpected disconnect is an error, and the client can reconnect manually with the last `event.seq` it received:

```sh
dscode watch SESSION_ID --after 123
```

What is subscribed here is the persisted model's event stream: messages, inbox, tool and status events. It does not carry uncommitted per-token assistant chunks. An event can be observed live before it reaches the disk persistence barrier; a cursor that jumps past the recovery log across a crash is reported as an explicit error and needs a fresh baseline read. Reading acquires no session write lock, but it still pays serialisation and disk-flush cost, so no strict lock-free algorithm is claimed.

A slow subscriber that exceeds the 8 MiB send buffer is disconnected rather than blocking the agent's writes; the client should catch up from the last sequence it received. A single oversized response or event also disconnects, so this interface is not a way to move large files: reference files by path instead.

## Local protocol and implementation

A Host creates its own socket under `/tmp/dscode-UID-HASH/`, isolated by a hash of the state directory. The directory is mode 0700, the socket mode 0600, and nothing listens on TCP. The socket path stays short enough for macOS. Each connection accepts one newline-terminated JSON request:

```json
{"method":"send","sessionId":"...","source":"editor","requestId":"edit-123","mode":"queue","text":"check the change"}
```

The methods are `list`, `send`, `read` and `watch`. A normal response is `{"result":...}`, a failure `{"error":"..."}`. `watch` emits the event frames above. A Host releases its socket on shutdown; a stale socket left by a crash is ignored by discovering clients when it refuses the connection.

The implementation reuses the native Agent inbox, session snapshots, event notifications and persistence flush. It adds no second task queue and mounts neither the Web Session Controller's media upload nor its web gateway and other dependencies. A future ACP layer can adapt the same entry point.

Verification: `node --test tests/session-bridge.test.mjs`; `node scripts/verify-session-bridge.mjs` uses a real Harness and a local deterministic model to check two client processes, queue/steer while busy, reads, persisted de-duplication and recovery. The tests need permission to listen on a local Unix socket.
