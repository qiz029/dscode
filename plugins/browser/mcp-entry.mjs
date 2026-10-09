// Adapt the pinned MCP process in memory; installed dependency files stay intact.
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { installDocumentIdentity } from './document-identity.mjs';
import { installInlinePngScreenshots } from './screenshots.mjs';

const require = createRequire(import.meta.url);
const manifest = require.resolve('chrome-devtools-mcp/package.json');
if (JSON.parse(readFileSync(manifest, 'utf8')).version !== '1.10.1') throw Error('Unsupported Chrome MCP version for DSCODE browser adapters.');
const source = join(dirname(manifest), 'build/src');
const { McpResponse } = await import(pathToFileURL(join(source, 'McpResponse.js')).href);
installDocumentIdentity(McpResponse);
const { McpServer } = await import(pathToFileURL(join(source, 'third_party/index.js')).href);
const { McpContext } = await import(pathToFileURL(join(source, 'McpContext.js')).href);
installInlinePngScreenshots(McpServer, McpContext);
await import(pathToFileURL(join(source, 'bin/chrome-devtools-mcp.js')).href);
