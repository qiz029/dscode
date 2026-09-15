/**
 * Single-anchor source rewrite shared by every patch stage. Kept in its own leaf module:
 * patch-runtime imports its own patchers, which import this back, and a cycle only worked
 * because the declaration was hoisted.
 */
export function replaceOnce(text, from, to) {
  if (text.split(from).length !== 2) throw new Error('Pinned runtime patch drift: ' + from.slice(0, 90));
  return text.replace(from, to);
}
