// The Desktop packager replaces these imports with the pinned vendored files.
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
export { MacOSComputerUseProvider } from 'dscode-desktop-computer-use/provider-macos';
const entry = pathToFileURL(createRequire(import.meta.url).resolve('dscode-desktop-computer-use/package.json'));
export const { Config } = await import(new URL('lib/config.js', entry));
export const { createComputerUseTools } = await import(new URL('lib/tools.js', entry));
