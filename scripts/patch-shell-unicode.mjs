import { replaceOnce } from './patch-util.mjs';

// Interactive Readline defaults to converting high bytes into Meta key sequences
// in the C locale. Configure it before publishing the first ready prompt, without
// changing the locale (and therefore sorting/number formatting) of user commands.
const MARKER = '// dscode-shell-unicode-v1';
export function patchShellUnicode(text) {
  if (text.includes(MARKER)) return text;
  return MARKER + '\n' + replaceOnce(text,
    "; PS1='${CONTROLLED_PROMPT}'",
    "; bind 'set convert-meta off'; bind 'set input-meta on'; bind 'set output-meta on'; PS1='${CONTROLLED_PROMPT}'");
}
