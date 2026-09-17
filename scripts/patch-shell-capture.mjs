import { replaceOnce } from "./patch-util.mjs";

/**
 * dscode: keep one command output where the bytes flow, instead of re-reading the shared
 * scrollback on every poll.
 *
 * Upstream reads the shared terminal ring from the newest page back to the oldest retained
 * line and prefers it over the output of the send that is running. That ring is shared with
 * every other writer on the terminal — a background job, another session, a release
 * publisher — so a reader that falls behind reports a dropped beginning, and the command
 * own output can be evicted before it is read. The per-send buffer is not enough on its own:
 * it collects chunks only while that send is active, and the tool leaves a poll gap between
 * sends.
 *
 * The window below is fed by appendOutput, so it sees every sanitized chunk the scrollback
 * sees, keeps its own bound and survives that gap. It travels through the existing terminal
 * API instead of new service methods: the tool asks for it with `capture: true`, which the
 * installed dsh-terminal service forwards untouched to the session it owns.
 */
const MARKER = "// dscode-shell-capture-v1";
export const CAPTURE_MAX_BYTES = 4 * 1024 * 1024;

const SESSION_CONST = "const CAPTURE_MAX_BYTES = " + CAPTURE_MAX_BYTES + ";\n";
const SESSION_APPEND_FROM = "\tappendOutput(text) {\n\t\tif (text.length === 0) return;\n\t\tthis.lastOutputAt = Date.now();\n\t\tthis.scrollback.append(text);\n\t\tthis.active?.append(text);\n\t}";
const SESSION_APPEND_TO = "\tappendOutput(text) {\n\t\tif (text.length === 0) return;\n\t\tthis.lastOutputAt = Date.now();\n\t\tthis.scrollback.append(text);\n\t\tthis.capture?.append(text);\n\t\tthis.active?.append(text);\n\t}";
const SESSION_OPERATION_FROM = "\t\tconst operation = new LocalSendOperation(this.config.maxReadBytes, Date.now(), () => {";
const SESSION_OPERATION_TO = "\t\tif (request.capture === true) this.capture = new BoundedTextBuffer(CAPTURE_MAX_BYTES);\n\t\tconst operation = new LocalSendOperation(this.config.maxReadBytes, Date.now(), () => {";
const SESSION_READ_FROM = "\tread(request) {\n\t\tconst snapshot = this.scrollback.snapshot();";
const SESSION_READ_TO = "\tread(request) {\n\t\tif (request.capture === true) return this.capture?.snapshot() ?? { text: \"\", truncated: false };\n\t\tconst snapshot = this.scrollback.snapshot();";

const SEND_FROM = "\t\t\t\t\ttext: first ? wrapped : \"\",";
const SEND_TO = "\t\t\t\t\ttext: first ? wrapped : \"\",\n\t\t\t\t\tcapture: first,";
const RING_FROM = "\t\t\tconst latest = ctx.terminals.read(owner, id, {\n\t\t\t\toffset: 0,\n\t\t\t\tcount: SCROLLBACK_PAGE_LINES\n\t\t\t});";
const RING_TO = "\t\t\tconst captured = ctx.terminals.read(owner, id, { capture: true });\n\t\t\tfallbackTruncated ||= captured.truncated;";
const EXIT_FROM = "\tconst snapshot = retainedScrollback(ctx, owner, id);";
const EXIT_TO = "\tconst window = ctx.terminals.read(owner, id, { capture: true });\n\tconst snapshot = window.text.length > 0 ? window : retainedScrollback(ctx, owner, id);";
const NEEDLE = "retainedScrollback(ctx, owner, id, latest)";

export function patchTerminalCapture(text) {
  if (text.includes(MARKER)) return text;
  text = replaceOnce(text, "var BoundedTextBuffer = class {", SESSION_CONST + "var BoundedTextBuffer = class {");
  text = replaceOnce(text, SESSION_APPEND_FROM, SESSION_APPEND_TO);
  text = replaceOnce(text, SESSION_OPERATION_FROM, SESSION_OPERATION_TO);
  text = replaceOnce(text, SESSION_READ_FROM, SESSION_READ_TO);
  return MARKER + "\n" + text;
}

export function patchShellCapture(text) {
  if (text.includes(MARKER)) return text;
  text = replaceOnce(text, SEND_FROM, SEND_TO);
  text = replaceOnce(text, RING_FROM, RING_TO);
  text = replaceOnce(text, "if (latest.text.includes(marker.end)) {", "if (captured.text.includes(marker.end)) {");
  text = replaceOnce(text, EXIT_FROM, EXIT_TO);
  const sites = text.split(NEEDLE).length - 1;
  if (sites !== 3) throw new Error("Pinned runtime patch drift: persistent bash capture sites (" + sites + ")");
  return MARKER + "\n" + text.split(NEEDLE).join("captured");
}
