import { delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';

const bin = fileURLToPath(new URL('../../bin/', import.meta.url));

/** Only DSCODE's copied shell providers receive the bundled helper directory. */
export function desktopShellEnvironment(environment = process.env) {
  return { PATH: bin + delimiter + (environment.PATH ?? '') };
}
