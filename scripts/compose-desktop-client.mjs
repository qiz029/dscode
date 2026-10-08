import { replaceOnce } from './patch-util.mjs';

/** Compose the existing client factories into one native package registration.
 * Component factories retain their own slot keys and scoped disposers. */
export function composeDesktopClient(id, sources) {
  if (!sources.length) throw Error('Desktop client requires at least one component');
  const bodies = sources.map(source => replaceOnce(source, 'globalThis.__ModuleLoader__.load(', 'components.push('));
  return `// Generated from the shared Desktop component sources.\n(() => {\nconst components = [];\n${bodies.join('\n')}\nglobalThis.__ModuleLoader__.load({
  id: ${JSON.stringify(id)},
  factory: require => {
    const plugins = components.map(component => component.factory(require));
    return {
      inject: [...new Set(plugins.flatMap(plugin => plugin.inject ?? []))],
      apply(ctx) { for (const plugin of plugins) plugin.apply(ctx); },
    };
  },
});\n})();\n`;
}
