import test from 'node:test';
import assert from 'node:assert/strict';
import { installInlinePngScreenshots, MAX_PREVIEW_PNG_BYTES, BROWSER_STDIO_MAX_BYTES } from '../plugins/browser/screenshots.mjs';

function png(length = 32, marker = 1) {
  const bytes = Buffer.alloc(length, marker);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes);
  return bytes;
}
function fixture() {
  const saves = [];
  class Context {
    async saveTemporaryFile(data, filename) { saves.push({ data, filename }); return { filepath: `/owned-temp/${filename}` }; }
  }
  class Server {
    registerTool(_name, _config, callback) { this.callback = callback; return { registered: true }; }
  }
  class Handler {
    constructor(name = 'take_screenshot') {
      const server = new Server(); server.registerTool(name, {}, this.capture);
      this.handle = server.callback;
    }
    capture = async params => {
      await params.before?.();
      if (params.bytes) await new Context().saveTemporaryFile(params.bytes, params.filename ?? 'screenshot.png');
      await params.after?.();
      if (params.throw) throw Error('capture failed');
      return { content: params.existing ? [params.existing] : [{ type: 'text', text: 'Saved screenshot to /owned-temp/screenshot.png.' }], ...(params.error ? { isError: true } : {}) };
    };
  }
  installInlinePngScreenshots(Server, Context);
  return { Handler, Context, saves };
}
const images = result => result.content.filter(block => block.type === 'image');

test('automatic PNG offload preserves its native file response and returns the exact pixels inline', async () => {
  const { Handler, saves } = fixture(), bytes = png();
  const result = await new Handler().handle({ bytes });
  assert.equal(saves.length, 1); assert.equal(saves[0].data, bytes);
  assert.match(result.content[0].text, /Saved screenshot/);
  assert.equal(images(result)[0].mimeType, 'image/png');
  assert.deepEqual(Buffer.from(images(result)[0].data, 'base64'), bytes);
});

test('PNG offload accepts the exact byte limit and rejects one byte over it within bounded transport capacity', async () => {
  const { Handler } = fixture(), handler = new Handler();
  const accepted = await handler.handle({ bytes: png(MAX_PREVIEW_PNG_BYTES) });
  assert.equal(Buffer.from(images(accepted)[0].data, 'base64').length, MAX_PREVIEW_PNG_BYTES);
  assert(Buffer.byteLength(JSON.stringify(accepted)) < BROWSER_STDIO_MAX_BYTES);
  assert.equal(images(await handler.handle({ bytes: png(MAX_PREVIEW_PNG_BYTES + 1) })).length, 0);
});

test('explicit files, other tools, other formats, malformed PNGs and failed captures do not gain images', async () => {
  const { Handler } = fixture(), bytes = png();
  for (const [name, params] of [
    ['take_screenshot', { bytes, filePath: '/chosen/export.png' }],
    ['get_network_request', { bytes }],
    ['take_screenshot', { bytes, filename: 'screenshot.jpeg' }],
    ['take_screenshot', { bytes: Buffer.from('not a PNG') }],
    ['take_screenshot', { bytes, error: true }],
  ]) assert.equal(images(await new Handler(name).handle(params)).length, 0);
  await assert.rejects(new Handler().handle({ bytes, throw: true }), /capture failed/);
});

test('existing images are not duplicated and later responses do not retain prior pixels', async () => {
  const { Handler } = fixture(), handler = new Handler();
  const existing = { type: 'image', mimeType: 'image/png', data: png(32, 7).toString('base64') };
  assert.deepEqual(images(await handler.handle({ bytes: png(), existing })), [existing]);
  assert.equal(images(await handler.handle({})).length, 0);
});

test('concurrent captures cannot borrow each other’s buffers or unrelated temporary files', async () => {
  const { Handler, Context } = fixture(), handler = new Handler();
  const firstSaved = Promise.withResolvers(), release = Promise.withResolvers();
  const first = handler.handle({ bytes: png(32, 3), after: async () => { firstSaved.resolve(); await release.promise; } });
  await firstSaved.promise;
  await new Context().saveTemporaryFile(png(32, 9), 'screenshot.png');
  const second = await handler.handle({ bytes: png(32, 5) });
  release.resolve();
  assert.deepEqual(Buffer.from(images(await first)[0].data, 'base64'), png(32, 3));
  assert.deepEqual(Buffer.from(images(second)[0].data, 'base64'), png(32, 5));
  assert.equal(images(await handler.handle({})).length, 0);
});

test('unsupported upstream adapters fail before mutating their prototypes', () => {
  class Server { registerTool() {} }
  class Context {}
  const original = Server.prototype.registerTool;
  assert.throws(() => installInlinePngScreenshots(Server, Context), /Unsupported/);
  assert.equal(Server.prototype.registerTool, original);
});
