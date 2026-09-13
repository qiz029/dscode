/** Route the native /review TUI entrypoint through DSCODE's shared review service. */
export function patchReview(text) {
  if (text.includes('// dscode-review-command-v1')) return text;
  const before = 'if (text === "/review" || text.startsWith("/review ")) {\n\t\t\t\treviewChanges(text.slice(7));\n\t\t\t\treturn;\n\t\t\t}';
  const after = 'if (text === "/review" || text.startsWith("/review ")) {\n\t\t\t\t// dscode-review-command-v1\n\t\t\t\tdispatch(text);\n\t\t\t\treturn;\n\t\t\t}';
  if (text.split(before).length !== 2) throw Error('Unsupported DSH-Code /review handler; refusing an ambiguous patch');
  return text.replace(before, after);
}
