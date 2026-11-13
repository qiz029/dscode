import { replaceOnce } from './patch-util.mjs';

// Session headers are immutable; the latest durable title lives in the event log.
// A failed optional metadata read must not hide an otherwise resumable session.
export async function readAcpSessionTitle(persistence, sessionId, signal, logger) {
  try {
    const handle = await persistence.open(sessionId, 'read', { signal });
    try {
      const { events } = await handle.read(0, undefined, { signal });
      return events.findLast(event => event.type === 'session/title')?.data.title;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    logger.warn(`acp: session title read failed: ${String(error)}`);
    return undefined;
  }
}

export function patchAcpTitles(text) {
  const marker = '// dscode-acp-titles-v1';
  if (text.includes(marker)) return text;
  text = replaceOnce(text, '\t\ttry {\n\t\t\tif (event.type === "assistant/message") {', `\t\ttry {
\t\t\tif (event.type === "session/title") {
\t\t\t\tthis.titleChanged(event.data.title);
\t\t\t} else if (event.type === "assistant/message") {`);
  text = replaceOnce(text, '\t/** Await every update queued before this call. */', `
\t/** Publish titles in the same ordered queue as committed assistant and tool updates. */
\ttitleChanged(title) {
\t\tif (title === undefined || this.closing !== undefined) return;
\t\tthis.outputTail = this.outputTail.then(() => this.notify({
\t\t\tsessionId: this.agent.session.id,
\t\t\tupdate: { sessionUpdate: "session_info_update", title }
\t\t})).catch((error) => {
\t\t\tthis.ctx.logger.warn("acp: session title update failed: " + String(error));
\t\t});
\t}
\t/** Await every update queued before this call. */`);
  text = replaceOnce(text, '\t\t\t\t\treturn { configOptions: await record.configOptions(signal) };', `
\t\t\t\t\tconst configOptions = await record.configOptions(signal);
\t\t\t\t\trecord.titleChanged(record.agent.session.snapshotEvents().findLast((event) => event.type === "session/title")?.data.title);
\t\t\t\t\tawait record.drainUpdates();
\t\t\t\t\treturn { configOptions };`);
  text = replaceOnce(text, '\t\t\t\tsessions: page.map(({ sessionId, cwd }) => ({\n\t\t\t\t\tsessionId,\n\t\t\t\t\tcwd\n\t\t\t\t})),', `
\t\t\t\tsessions: await Promise.all(page.map(async ({ sessionId, cwd }) => {
\t\t\t\t\tconst title = await readAcpSessionTitle(persistence, sessionId, signal, logger);
\t\t\t\t\treturn { sessionId, cwd, ...(title === undefined ? {} : { title }) };
\t\t\t\t})),`);
  return marker + '\n' + readAcpSessionTitle.toString() + '\n' + text;
}
