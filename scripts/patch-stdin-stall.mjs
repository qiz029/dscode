import { replaceOnce } from './patch-util.mjs';

// A command that holds the shell's terminal and produces nothing settles as a
// stdin wait. Upstream returns the empty partial output and leaves that command
// running behind the shell, where the next send is swallowed as its input.
// Remember the verdict, give the command the age gate to finish on its own, then
// interrupt it so the marker reports the exit status with a note saying why.
export const STDIN_STALL_MS = 5e3;
export const STDIN_STALL_NOTE = '\n[Interrupted after ' + STDIN_STALL_MS / 1e3 + 's with no output: the command held the terminal without producing anything, and this tool cannot supply terminal input. Give it stdin (a heredoc, `< file` or `< /dev/null`) or use a non-interactive form.]';

const STALL_BLOCK = [
  '\t\t\tconst partial = renderCaptured(partialOutput(retainedScrollback(ctx, owner, id, latest), marker, fallback, fallbackTruncated), config.maxOutputChars);',
  '\t\t\tif (result.waitReason === "stdin_read") stdinWaited = true;',
  '\t\t\tif (result.waitReason === "stdin_read" && partial.length > 0) return partial;',
  '\t\t\tif (stdinWaited && partial.length === 0 && !stdinStalled && Date.now() - startedAt >= STDIN_STALL_MS) {',
  '\t\t\t\tstdinStalled = true;',
  '\t\t\t\ttry {',
  '\t\t\t\t\tawait ctx.terminals.signal(owner, id, "SIGINT");',
  '\t\t\t\t} catch (_unsignallableForeground) {',
  '\t\t\t\t\tstdinStalled = false;',
  '\t\t\t\t\treturn partial;',
  '\t\t\t\t}',
  '\t\t\t}',
  '\t\t\tawait pause();',
].join('\n');

const PREVIOUS_TAIL = '\t\t\tif (result.waitReason === "stdin_read") return renderCaptured(partialOutput(retainedScrollback(ctx, owner, id, latest), marker, fallback, fallbackTruncated), config.maxOutputChars);\n\t\t\tawait pause();';

export function patchStdinStall(text) {
  if (text.includes('// dscode-stdin-stall-v2')) return text;
  // v1 shipped the marker without the constants the injected code reads.
  if (!text.includes('// dscode-stdin-stall-v1')) text = applyStdinStall(text);
  return '// dscode-stdin-stall-v2\nconst STDIN_STALL_MS = ' + STDIN_STALL_MS + ';\nconst STDIN_STALL_NOTE = ' + JSON.stringify(STDIN_STALL_NOTE) + ';\n' + text.replace('// dscode-stdin-stall-v1\n', '');
}

function applyStdinStall(text) {
  text = replaceOnce(text, '\t\tconst wrapped = wrapCommand(command, marker);\n\t\tlet first = true;', '\t\tconst wrapped = wrapCommand(command, marker);\n\t\tconst startedAt = Date.now();\n\t\tlet stdinWaited = false;\n\t\tlet stdinStalled = false;\n\t\tlet first = true;');
  text = replaceOnce(text, '\t\t\t\tif (complete !== void 0) return renderCaptured(complete, config.maxOutputChars);', '\t\t\t\tif (complete !== void 0) return renderCaptured(complete, config.maxOutputChars) + (stdinStalled ? STDIN_STALL_NOTE : "");');
  return replaceOnce(text, PREVIOUS_TAIL, STALL_BLOCK);
}
