/**
 * Computer Use, mounted through DSCODE so a retired settings API still resolves.
 *
 * `@anionex/dsh-computer-use` reads its configuration with `ctx.settings.register`, an API
 * DSH removed in 0.1.7: Settings now projects forms from the profile entry itself, and the
 * missing method made the whole Computer Use bundle fail to activate. The package is
 * pinned at 0.3.2 with no newer release, so this row restores the method — as a read-only
 * view over the composition config, which is where DSCODE configures Computer Use anyway —
 * and then mounts the upstream bundle as its child, which is what makes the order
 * dependable: the shim is installed before the provider's constructor runs.
 *
 * Retire this wrapper when the package reads volatile configuration, and mount
 * `@anionex/dsh-computer-use` directly again.
 *
 * @module dscode-computer-use
 */

import ComputerUseBundle from '@anionex/dsh-computer-use';

export const name = 'dscode-computer-use';
export const inject = ['settings'];

/** Section handle the 0.3.x provider expects: one read of the composition config, no live writes. */
function staticSection(base) {
  return { get: () => base, watch: () => () => {} };
}

export function apply(ctx, config = {}) {
  const settings = ctx.settings;
  // Only ever adds what upstream no longer defines; a Settings service that carries its
  // own `register` again is left untouched, and the shim is dropped with this row.
  if (typeof settings.register !== 'function') {
    settings.register = (_namespace, _schema, options = {}) => staticSection(options.base ?? {});
    ctx.effect(() => () => { delete settings.register; });
  }
  ctx.plugin(ComputerUseBundle, config);
}
