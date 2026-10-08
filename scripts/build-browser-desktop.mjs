import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';

const root = resolve(import.meta.dirname, '..');
export const desktopRuntime = '0.2.1-alpha.1';
export const desktopRuntimes = ['0.2.0-rc.2', desktopRuntime];
export const desktopBrowserPackage = '@toddzheng024/dscode-browser-desktop';
export const browserDependencies = Object.freeze({ '@modelcontextprotocol/sdk': '1.30.0', 'chrome-devtools-mcp': '1.10.1', ws: '8.21.3' });

/** Package the shared browser implementation for the official Desktop Host. */
export function buildBrowserDesktop(destination, runtime = desktopRuntime) {
  if (!desktopRuntimes.includes(runtime)) throw Error(`Unsupported Desktop runtime: ${runtime}`);
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const write = (name, data) => writeFileSync(join(destination, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2) + '\n');
  mkdirSync(destination, { recursive: true });
  for (const name of ['browser', 'auto-review']) cpSync(join(root, 'plugins', name), join(destination, 'plugins', name), { recursive: true });
  cpSync(join(root, 'extensions/browser'), join(destination, 'extensions/browser'), { recursive: true });
  mkdirSync(join(destination, 'plugins/providers'), { recursive: true });
  cpSync(join(root, 'plugins/providers/effort.mjs'), join(destination, 'plugins/providers/effort.mjs'));
  cpSync(join(root, 'packages/LICENSE'), join(destination, 'LICENSE'));
  write('package.json', {
    name: desktopBrowserPackage, version: manifest.version, private: true, type: 'module', license: 'MIT',
    description: 'Experimental DSCODE browser tools for the official DeepSeek Harness Desktop Host.',
    engines: manifest.engines,
    exports: { '.': './plugins/browser/desktop-host.mjs', './client': './plugins/browser/desktop-client.mjs', './browser': './plugins/browser/index.mjs', './auto-review': './plugins/auto-review/index.mjs', './package.json': './package.json', './cordis.patch.yml': './cordis.patch.yml' },
    files: ['plugins', 'extensions', 'cordis.patch.yml', 'README.md', 'LICENSE'],
    dependencies: browserDependencies,
    peerDependencies: {
      '@deepseek-ai/dsh': runtime,
      '@deepseek-ai/dsh-tools': runtime,
      '@deepseek-ai/dsh-mcp-client': runtime,
      '@deepseek-ai/dsh-llm': runtime,
      '@deepseek-ai/dsh-client-connection': runtime,
      '@deepseek-ai/schemastery': runtime === '0.2.0-rc.2' ? '~3.18.4' : '~3.18.5-alpha.1',
    },
    dsh: { bundle: { patch: './cordis.patch.yml' }, client: { platform: 'web', inject: ['@deepseek-ai/dsh-api-remotes', '@deepseek-ai/dsh-client-ui-sidebar-right'] } },
  });
  write('cordis.patch.yml', stringify([{ insert: [
    { id: 'dscode-browser', name: `${desktopBrowserPackage}/browser` },
    { id: 'dscode-auto-review', name: `${desktopBrowserPackage}/auto-review` },
    { id: 'dscode-browser-preview', name: desktopBrowserPackage },
  ] }]));
  write('README.md', `# DSCODE browser Desktop integration\n\nExperimental local bundle for DeepSeek Harness ${runtime}. Build with \`node scripts/build-browser-desktop.mjs ${runtime}\` from the DSCODE source checkout. This package is private and has not been published.\n\nIt mounts the shared DSCODE browser tools, user-controlled site and Developer permissions, optional WebMCP, and action-review policy in the official Host. It uses that application's DSH_HOME for its browser configuration and dedicated Chrome profiles. Start with \`/browser start\` and inspect \`/browser permissions\`. The full command reference is in the DSCODE source at docs/browser-use.md.\n\nChrome runs separately. The official Sidebar Browser's Electron webviews are not controlled by these tools. Open Browser preview in the shared Web/Desktop sidebar to select a controlled Chrome tab, refresh its screenshot, and send a point annotation with the captured image into the current session. Optional refresh runs while the pane is visible and pauses when a point is selected. Site permission is required; each annotation receipt expires after 60 seconds and can be sent once.\n\nThe shared Web client and native Host on 0.2.1-alpha.1, and the official macOS Apple Silicon Electron application on 0.2.0-rc.2, have been exercised with a scripted local fixture. The Desktop build was launched from the signed mounted app with an isolated profile; persistent installation, updates, Windows and live-model visual understanding remain unverified. Experimental extension transport is included under extensions/browser; use /browser use extension and /browser pair, then load that folder unpacked in Chrome and share the current tab. The transport was verified separately with Chrome for Testing; Native Desktop Host pairing, screenshot and annotation endpoints also passed with extension transport. The combined rendered macOS panel and extension transport also passed: selecting a point paused refresh, one annotation reached the scripted model with its image, and revocation cleared the preview and stopped refresh while preserving an unsent draft. Migration of the complete DSCODE agent preset remains pending.\n\nThe review plugin preserves the Host's permission mode. Its model review requires the named auto-review permission preset; other modes use ordinary Host approval. Site and Developer grants remain independent and must come from the user.\n`);
  return destination;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(buildBrowserDesktop(join(root, 'artifacts/desktop/browser'), process.argv[2] ?? desktopRuntime));
}
