import { readFileSync } from 'node:fs';

/** The DSCODE version third-party services see; the package root is two levels up in a checkout and in the bundle. */
export function dscodeVersion() {
  try {
    return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version;
  } catch {
    return undefined;
  }
}
