import { replaceOnce } from './patch-util.mjs';

/** Show dropped image paths as compact attachment chips in the composer. */
export function patchImageMarker(text) {
  if (text.includes('// dscode-image-marker-v1')) return text;
  const before = 'let marker = source === "mention" ? `@${safeName}` : `[${label}: ${safeName}]`;';
  const after = '// dscode-image-marker-v1\n\t\tlet marker = source === "mention" ? `@${safeName}` : kind === "image" ? "[Image 1]" : `[${label}: ${safeName}]`;';
  text = replaceOnce(text, before, after);
  text = replaceOnce(text,
    'marker = source === "mention" ? `@${safeName} (${suffix})` : `[${label}: ${safeName} ${suffix}]`;',
    'marker = source === "mention" ? `@${safeName} (${suffix})` : kind === "image" ? `[Image ${suffix}]` : `[${label}: ${safeName} ${suffix}]`;');
  text = replaceOnce(text,
    'text = text.replaceAll(PASTE_START_MARKER, "");',
    'text = text.replaceAll(`\\x1b${PASTE_START_MARKER}`, "").replaceAll(PASTE_START_MARKER, "");');
  return replaceOnce(text,
    'text = text.replaceAll(PASTE_END_MARKER, "");',
    'text = text.replaceAll(`\\x1b${PASTE_END_MARKER}`, "").replaceAll(PASTE_END_MARKER, "");');
}
