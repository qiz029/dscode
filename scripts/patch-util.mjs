/**
 * Single-anchor source rewrite shared by every patch stage. Kept in its own leaf module:
 * patch-runtime imports its own patchers, which import this back, and a cycle only worked
 * because the declaration was hoisted.
 */
export function replaceOnce(text, from, to) {
  if (text.split(from).length !== 2) throw new Error('Pinned runtime patch drift: ' + from.slice(0, 90));
  return text.replace(from, to);
}

/**
 * A legacy rewrite, or the upstream text that proves the release already carries it.
 * Missing anchors still fail loudly through replaceOnce, so drift keeps surfacing.
 */
export function replaceOrAdopt(text, from, to, adopted) {
  if (text.includes(from)) return replaceOnce(text, from, to);
  if (text.includes(adopted)) return text;
  return replaceOnce(text, from, to);
}
