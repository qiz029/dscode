import { readFileSync } from 'node:fs';

/** Remove recursive regexp repetition; the upstream byte round trip stays exact. */
export function patchMcpImageValidation(source) {
  const original = 'const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;';
  if (source.split(original).length !== 2 || !source.includes('data.toString("base64") !== block.data')) throw Error('Unsupported MCP image validation implementation.');
  return source.replace(original, 'const CANONICAL_BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;');
}

// Load a scoped copy with the same dependency identities. No installed module or
// global RegExp behavior is changed; every other MCP admission rule is upstream.
const entry = import.meta.resolve('@deepseek-ai/dsh-mcp-client');
const version = JSON.parse(readFileSync(new URL('../package.json', entry), 'utf8')).version;
if (!['0.1.7-alpha.2', '0.2.0-rc.2', '0.2.1-alpha.1'].includes(version)) throw Error(`Unsupported browser MCP client version: ${version}`);
const source = patchMcpImageValidation(readFileSync(new URL(entry), 'utf8'))
  .replace(/^import (.+) from (["'])([^"']+)\2;$/gm, (_line, bindings, _quote, specifier) => {
    const resolved = specifier.startsWith('.') ? new URL(specifier, entry).href : import.meta.resolve(specifier);
    return `import ${bindings} from ${JSON.stringify(resolved)};`;
  });
const adapted = await import('data:text/javascript;base64,' + Buffer.from(source + '\n//# sourceURL=dscode-browser-mcp-client.mjs\n').toString('base64'));
export const createMcpToolDefinition = adapted.createMcpToolDefinition;
