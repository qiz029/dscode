import { AsyncLocalStorage } from 'node:async_hooks';

export const MAX_PREVIEW_PNG_BYTES = 12 * 1024 * 1024;
// A 12 MiB PNG needs 16 MiB as base64, plus the JSON-RPC response metadata.
export const BROWSER_STDIO_MAX_BYTES = 20 * 1024 * 1024;

/** Preserve bounded PNG pixels when pinned Chrome MCP offloads a large image. */
export function installInlinePngScreenshots(McpServer, McpContext) {
  const register = McpServer.prototype.registerTool, save = McpContext.prototype.saveTemporaryFile;
  if (typeof register !== 'function' || typeof save !== 'function') throw Error('Unsupported Chrome MCP screenshot adapter.');
  const scope = new AsyncLocalStorage();
  McpContext.prototype.saveTemporaryFile = async function (data, filename, ...args) {
    const result = await save.call(this, data, filename, ...args);
    const capture = scope.getStore();
    if (capture && filename === 'screenshot.png' && data instanceof Uint8Array && data.byteLength <= MAX_PREVIEW_PNG_BYTES) {
      const bytes = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      if (bytes.subarray(0, 8).toString('hex') === '89504e470d0a1a0a') capture.image = { type: 'image', mimeType: 'image/png', data: bytes.toString('base64') };
    }
    return result;
  };
  // The public registration boundary works with both prototype methods and
  // instance callbacks used by upstream ToolHandler implementations.
  McpServer.prototype.registerTool = function (name, config, callback) {
    if (name !== 'take_screenshot' || typeof callback !== 'function') return register.call(this, name, config, callback);
    return register.call(this, name, config, async function (params, ...args) {
      if (params.filePath !== undefined) return callback.call(this, params, ...args);
      return scope.run({}, async () => {
        const result = await callback.call(this, params, ...args);
        const image = scope.getStore().image;
        if (!result.isError && image && !result.content.some(block => block.type === 'image')) result.content.push(image);
        return result;
      });
    });
  };
}
