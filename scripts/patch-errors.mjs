import { replaceOnce } from './patch-util.mjs';

// Terminal states that are not a normal completion read as failures to the user, so the
// transcript shows them in the error tone instead of the dim turn marker. A cancel the
// user asked for, and the model's own output ceiling, stay quiet.

export function patchErrors(text) {
  if (text.includes('// dscode-turn-errors-v1')) return text;
  const before = '\t\t\t\tconst marker = reason.kind === "aborted" ? reason.reason.kind === "user" ? "turn cancelled by the user" : `turn cancelled (${reason.reason.kind})` : reason.kind === "max-tokens" ? "turn hit the output-token ceiling (max-tokens)" : reason.kind === "blocked" ? "turn ended blocked" : reason.kind === "interrupted" ? "turn was interrupted by a restart" : void 0;\n\t\t\t\tif (marker !== void 0) appended.push({\n\t\t\t\t\tkind: "turn-marker",\n\t\t\t\t\ttext: marker\n\t\t\t\t});';
  const after = '\t\t\t\tconst userCancelled = reason.kind === "aborted" && reason.reason.kind === "user";\n\t\t\t\tconst marker = reason.kind === "aborted" ? userCancelled ? "turn cancelled by the user" : `turn stopped (${reason.reason.kind})` : reason.kind === "max-tokens" ? "turn hit the output-token ceiling (max-tokens)" : reason.kind === "blocked" ? "turn ended blocked" : reason.kind === "interrupted" ? "turn was interrupted by a restart" : void 0;\n\t\t\t\tif (marker !== void 0) appended.push({\n\t\t\t\t\tkind: userCancelled || reason.kind === "max-tokens" ? "turn-marker" : "error",\n\t\t\t\t\ttext: marker\n\t\t\t\t});';
  return '// dscode-turn-errors-v1\n' + replaceOnce(text, before, after);
}
