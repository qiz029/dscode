/**
 * Producer identity of one message source.
 *
 * DSH 0.1.7 retired the shared `plugin` kind: every producer now declares its own
 * `kind`, and DSCODE's plugins name themselves the same way. Durable history carries two
 * older shapes — the raw `{ kind: 'plugin', plugin: '<producer>' }` of a session written
 * before the upgrade, and the `plugin:<producer>` kind the session format's v3-to-v4
 * migration writes for a producer it does not know — so every reader of history resolves
 * all three through this one function.
 *
 * @param source - a message source from any release.
 * @returns the producing subsystem's name, or `''` when the source names none.
 */
export function producerKind(source) {
  if (source === null || typeof source !== 'object') return '';
  const { kind, plugin } = source;
  if (kind === 'plugin') return typeof plugin === 'string' ? plugin : '';
  if (typeof kind !== 'string') return '';
  return kind.startsWith('plugin:') ? kind.slice('plugin:'.length) : kind;
}
