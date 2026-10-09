// Real Chrome + large, deterministic PNGs; loopback only, no model credentials.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrowserConnection } from '../plugins/browser/connection.mjs';
import { BrowserPreview } from '../plugins/browser/preview.mjs';

const home = await mkdtemp(join(tmpdir(), 'dscode-preview-images-'));
const html = `<!doctype html><style>body{margin:0}canvas{display:block}output{position:fixed;top:0;left:0;background:white}</style>
<canvas></canvas><output></output><script>
function draw(){
 const canvas=document.querySelector('canvas'); canvas.width=innerWidth;canvas.height=innerHeight;
 const ctx=canvas.getContext('2d'),image=ctx.createImageData(canvas.width,canvas.height);let seed=123456789;
 for(let i=0;i<image.data.length;i+=4){for(let j=0;j<3;j++){seed^=seed<<13;seed^=seed>>>17;seed^=seed<<5;image.data[i+j]=seed>>>24;}image.data[i+3]=255;}
 ctx.putImageData(image,0,0);document.querySelector('output').textContent='Ready '+innerWidth+'x'+innerHeight;
}draw();addEventListener('resize',draw);
</script>`;
const server = createServer((_req, res) => { res.setHeader('content-type', 'text/html'); res.end(html); });
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const browser = new BrowserConnection({ home, sessionId: 'large-images', fileRoots: [home],
  config: { mode: 'isolated', headless: true, ...(process.env.DSCODE_TEST_CHROME ? { executablePath: process.env.DSCODE_TEST_CHROME } : {}) } });
const text = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
async function call(name, args) { const result = await browser.call(name, args); assert(!result.isError, text(result)); return result; }
try {
  await browser.access.update('allow', url);
  browser.args.push('--filesystem-root', home);
  await browser.start();
  const opened = await call('new_page', { url, background: true });
  const pageId = opened.structuredContent.pages.find(page => page.selected).id;
  const preview = new BrowserPreview(browser), messages = [], saved = [];
  const ctx = { get: name => name === 'attachments' ? { saveImage: async image => { saved.push(image.data); return { id: 'large-image' }; } } :
    { resolveModelInfo: async () => ({ inputModalities: ['text', 'image'] }) } };
  const agent = { session: { requestHeader: () => undefined }, options: {}, followup: message => messages.push(message) };
  for (const [width, height] of [[1280, 800], [1920, 1440]]) {
    await call('resize_page', { pageId, width, height });
    await call('wait_for', { pageId, text: [`Ready ${width}x${height}`], timeout: 5000 });
    const path = join(home, `explicit-${width}.png`);
    const exported = await call('take_screenshot', { pageId, format: 'png', filePath: path });
    assert(!exported.content.some(block => block.type === 'image'), 'Explicit export stays a file-only operation');
    const exportedBytes = await readFile(path);
    assert(exportedBytes.length > 2_000_000 && exportedBytes.length <= 12 * 1024 * 1024);
    console.log(`PREVIEW_IMAGE_EXPORT: ${width}x${height}; ${exportedBytes.length} PNG bytes`);
    const frame = await preview.capture(pageId);
    const bytes = Buffer.from(frame.image.data, 'base64');
    assert(bytes.length > 2_000_000 && bytes.length <= 12 * 1024 * 1024);
    if (width === 1920) assert(frame.image.data.length > 10 * 1024 * 1024, 'Exercise a payload beyond the default MCP stdio buffer');
    assert.deepEqual([frame.width, frame.height], [width, height]);
    const count = messages.length;
    await preview.annotate({ token: frame.token, x: 0.5, y: 0.5, text: 'Inspect the complex image.' }, ctx, agent);
    assert.equal(messages.length, count + 1); assert.deepEqual(saved.at(-1), bytes);
    console.log(`PREVIEW_IMAGE_CASE_PASSED: ${width}x${height}; ${bytes.length} PNG bytes; exact annotation attachment and file export`);
  }
  await call('resize_page', { pageId, width: 2560, height: 1920 });
  await call('wait_for', { pageId, text: ['Ready 2560x1920'], timeout: 5000 });
  await assert.rejects(preview.capture(pageId), /12 MiB/);
  assert.equal(messages.length, 2);
  await call('resize_page', { pageId, width: 800, height: 600 });
  await call('wait_for', { pageId, text: ['Ready 800x600'], timeout: 5000 });
  assert.equal((await preview.capture(pageId)).width, 800, 'Oversize refusal leaves the connection usable');
  assert.equal((await browser.access.status()).developerMode, false);
  console.log('BROWSER_PREVIEW_IMAGES_PASSED: large inline PNGs, transport capacity, exact storage, explicit exports, oversize refusal and recovery without Developer access.');
} finally {
  await browser.close(); await new Promise(resolve => server.close(resolve)); await rm(home, { recursive: true, force: true });
}
