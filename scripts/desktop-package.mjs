// One public identity shared by local qualification and release builds.
export const desktopPresetPackage = '@toddzheng024/dscode-desktop';
export const desktopReleaseRuntime = '0.2.0-rc.2';
export const legacyDesktopPresetPackage = '@toddzheng024/dscode-desktop-preset-probe';
export const desktopNodeRange = '^22.19.0 || >=24.0.0';

export function desktopHubListing(runtime) {
  return { schemaVersion: 1, displayName: 'DSCODE Desktop',
    summary: 'Coding collaboration, memory, browser workflows and community plugin discovery for Harness Desktop.',
    description: `Adds DSCODE to the official Harness Desktop application. Requires the exact DSH runtime ${runtime}. Qualified on macOS Apple Silicon. Install the plugin, select the DSCODE agent preset and configure a model account. This package does not include a standalone application or the terminal UI.`,
    homepage: 'https://github.com/qiz029/dscode#readme', categories: ['developer-tools', 'agents-orchestration'],
    keywords: ['coding', 'desktop', 'browser', 'collaboration', 'plugin-hub'],
    compatibility: { dsh: runtime, node: desktopNodeRange, platforms: ['darwin'], surfaces: ['desktop'], hmr: 'restart' },
    entryIds: ['dscode-desktop', 'dscode-hub', 'dscode-browser'], before: [], after: [], channel: 'beta' };
}

export function desktopPackageMetadata(version, runtime, { release = false } = {}) {
  if (release && runtime !== desktopReleaseRuntime) {
    throw Error(`Desktop publication requires qualified runtime ${desktopReleaseRuntime}; received ${runtime}`);
  }
  return {
    name: desktopPresetPackage, version, private: !release,
    description: 'DSCODE for Harness Desktop: coding collaboration, session memory, browser workflows and task management.',
    license: 'MIT', type: 'module',
    repository: { type: 'git', url: 'https://github.com/qiz029/dscode.git' },
    homepage: 'https://github.com/qiz029/dscode#readme',
    bugs: { url: 'https://github.com/qiz029/dscode/issues' },
    keywords: ['dsh-plugin', 'deepseek-harness', 'desktop', 'coding', 'collaboration'],
    engines: { node: desktopNodeRange, dsh: runtime },
    peerDependencies: { '@deepseek-ai/dsh': runtime },
    icon: './icon.svg',
    publishConfig: { access: 'public', tag: 'preview' },
  };
}
