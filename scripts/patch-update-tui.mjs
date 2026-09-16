import { replaceOnce } from './patch-util.mjs';
import { newerVersion } from '../plugins/tui-tools/update.mjs';

// Startup version check: one registry read, at most eight seconds, silent on any failure.
// A newer release is announced through the TUI's own notice with the /update hint.

export const UPDATE_CHECK_MARKER = '// dscode-update-check-v1';
export const REGISTRY_URL = 'https://registry.npmjs.org/@toddzheng024/dscode/latest';
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/;

function effectBlock(version) {
  return `\t${UPDATE_CHECK_MARKER}
\t(0, import_react.useEffect)(() => {
\t\tif (process.env.DSCODE_UPDATE_CHECK === "off") return;
\t\tconst dscodeUpdateController = new AbortController();
\t\tconst dscodeUpdateTimer = setTimeout(() => dscodeUpdateController.abort(), 8000);
\t\tfetch(${JSON.stringify(REGISTRY_URL)}, { headers: { accept: "application/vnd.npm.install-v1+json" }, signal: dscodeUpdateController.signal })
\t\t\t.then((response) => response.ok ? response.json() : void 0)
\t\t\t.then((data) => {
\t\t\t\tconst latest = data?.version;
\t\t\t\tif (typeof latest === "string" && dscodeNewerVersion(latest, ${JSON.stringify(version)})) notify(dscodeT("update.available", { version: latest }), "warning");
\t\t\t})
\t\t\t.catch(() => {})
\t\t\t.finally(() => clearTimeout(dscodeUpdateTimer));
\t\treturn () => { clearTimeout(dscodeUpdateTimer); dscodeUpdateController.abort(); };
\t}, []);
`;
}

export function patchUpdateCheck(text, version) {
  if (!VERSION_PATTERN.test(version)) throw Error('Invalid DSCODE version for the startup update check');
  const block = effectBlock(version);
  if (text.includes(UPDATE_CHECK_MARKER)) {
    const start = text.indexOf(`\t${UPDATE_CHECK_MARKER}`);
    const end = text.indexOf('\t}, []);\n', start);
    if (end < 0) throw Error('Patched TUI update check drift; refresh the dependencies (npm ci)');
    return text.slice(0, start) + block + text.slice(end + '\t}, []);\n'.length);
  }
  const anchor = '\tconst notify = (0, import_react.useCallback)((text, tone = "info") => {\n\t\tsetNotice({\n\t\t\ttext,\n\t\t\ttone\n\t\t});\n\t}, []);\n';
  const helper = newerVersion.toString().replace('function newerVersion(', 'function dscodeNewerVersion(');
  return `// dscode-update-check-v1\n${helper}\n` + replaceOnce(text, anchor, anchor + block);
}
