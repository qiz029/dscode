import { cpSync } from 'node:fs';
import { join } from 'node:path';
import { replaceOnce } from './patch-runtime.mjs';

export function patchClipboardImage(text, root) {
  cpSync(new URL('../plugins/clipboard-image/', import.meta.url), join(root, 'node_modules/dsh-code/lib/dscode-clipboard-image'), { recursive: true });
  if (text.includes('// dscode-clipboard-image-v1')) return text;
  text = 'import { readClipboardImage as dscodeReadClipboardImage } from "./dscode-clipboard-image/index.mjs";\n// dscode-clipboard-image-v1\n' + text;
  text = replaceOnce(text,
    'inspectImages, prepareImages, inspectFiles, prepareFiles, cyclePermission',
    'inspectImages, prepareImages, inspectFiles, prepareFiles, readClipboardImage, cyclePermission');
  text = replaceOnce(text,
    'const insertDroppedAttachments = (imagePaths, filePaths) => {\n\t\tconst originalValue = valueRef.current;\n\t\tconst originalCursor = cursorRef.current;',
    'const insertDroppedAttachments = (imagePaths, filePaths, originalValue = valueRef.current, originalCursor = cursorRef.current) => {');
  text = replaceOnce(text,
    'if (key.ctrl && input === "o") {\n\t\t\topenVerbose();',
    'if ((key.ctrl || key.meta) && input === "v") {\n      const atValue = liveValue, atCursor = liveCursor;\n      notify("reading clipboard image…");\n      readClipboardImage().then(path => insertDroppedAttachments([path], [], atValue, atCursor), reason => notify(reason instanceof Error ? reason.message : String(reason), "warning"));\n      return;\n    }\n\t\tif (key.ctrl && input === "o") {\n\t\t\topenVerbose();');
  text = replaceOnce(text,
    'inspectImages: (paths) => inspectImagePaths(paths, ctx.get("attachments"), session?.header.cwd ?? cwd),',
    'readClipboardImage: dscodeReadClipboardImage,\n\t\t\tinspectImages: (paths) => inspectImagePaths(paths, ctx.get("attachments"), session?.header.cwd ?? cwd),');
  return text;
}
