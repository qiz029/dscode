import { randomUUID } from 'node:crypto';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
import { MAX_PREVIEW_PNG_BYTES } from './screenshots.mjs';

/** Human preview receipts bind annotations to the exact captured pixels. */
export class BrowserPreview {
  constructor(browser, now = Date.now) { this.browser = browser; this.now = now; }
  async capture(pageId, signal) {
    if (!Number.isSafeInteger(pageId)) throw Error('Choose a browser page to preview.');
    const browser = this.browser;
    const listing = await browser.call('list_pages', {}, signal);
    if (listing.isError) throw Error('Could not refresh browser pages.');
    const url = browser.pages.find(page => page.id === pageId)?.url;
    if (!url) throw Error('The preview page is no longer open.');
    const documentId = browser.pages.find(page => page.id === pageId)?.documentId;
    const generation = browser.generation;
    if (typeof documentId !== 'string' || !documentId) throw Error('Could not verify the page document. Refresh the preview.');
    // Chrome does not return a pixel capture timestamp. Start conservatively
    // before dispatch so queueing, image transfer and verification cannot renew it.
    const capturedAt = this.now();
    const result = await browser.call('take_screenshot', { pageId, format: 'png', fullPage: false }, signal, { url });
    if (result.isError) throw Error(result.content.filter(b => b.type === 'text').map(b => b.text).join('\n'));
    const page = browser.pages.find(page => page.id === pageId);
    if (browser.generation !== generation || page?.url !== url || page.documentId !== documentId) throw Error('The page changed during capture. Refresh the preview.');
    const image = result.content.find(b => b.type === 'image' && b.mimeType === 'image/png');
    if (!image || image.data.length > Math.ceil(MAX_PREVIEW_PNG_BYTES / 3) * 4) throw Error('Preview requires a PNG screenshot of at most 12 MiB. Reduce the viewport and refresh.');
    const bytes = Buffer.from(image.data, 'base64');
    if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw Error('Invalid preview image.');
    const width = bytes.readUInt32BE(16), height = bytes.readUInt32BE(20);
    if (!width || !height) throw Error('Empty preview image.');
    if (this.now() - capturedAt >= 60000) throw Error('This preview expired while capturing. Refresh the preview.');
    if (browser.owned.has(pageId)) browser.keep(pageId, 'preview');
    this.frame = { token: randomUUID(), generation, pageId, url, documentId, capturedAt, width, height, image: { data: image.data, mimeType: image.mimeType } };
    return this.frame;
  }
  async annotate(input, ctx, agent, signal) {
    const frame = this.frame;
    if (!frame || input?.token !== frame.token || this.now() - frame.capturedAt >= 60000) throw Error('This preview has expired or was replaced. Refresh and annotate again.');
    if (!Number.isFinite(input.x) || !Number.isFinite(input.y) || input.x < 0 || input.x > 1 || input.y < 0 || input.y > 1) throw Error('Annotation coordinates must be within the preview.');
    if (typeof input.text !== 'string' || !input.text.trim() || input.text.length > 4000) throw Error('Enter an annotation of 1–4000 characters.');
    const assertCurrent = () => {
      signal?.throwIfAborted();
      this.browser.assertAgentControl();
      if (this.now() - frame.capturedAt >= 60000) throw Error('This preview has expired. Refresh before sending an annotation.');
      if (!this.isCurrent(frame)) throw Error('The browser page changed. Refresh before sending an annotation.');
    };
    this.browser.assertAgentControl();
    const listing = await this.browser.call('list_pages', {}, signal);
    if (listing.isError || !this.isCurrent(frame)) throw Error('The browser page changed. Refresh before sending an annotation.');
    await this.browser.access.checkUrl(frame.url);
    assertCurrent();
    if (this.frame !== frame) throw Error('The preview was replaced. Refresh before sending an annotation.');
    // Consume before the first durable write: concurrent sends cannot enqueue twice.
    this.frame = undefined;
    const attachment = await ctx.get('attachments').saveImage({ data: Buffer.from(frame.image.data, 'base64'), mediaType: frame.image.mimeType, name: 'browser-annotation.png' });
    assertCurrent();
    const route = agent.session.requestHeader()?.config ?? agent.options;
    let supportsImages = false;
    try { supportsImages = (await ctx.get('llm').resolveModelInfo(route.provider, route.model, signal)).inputModalities?.includes('image') === true; } catch { /* Preserve the image in history with a text-only model projection. */ }
    assertCurrent();
    // Storage and model metadata can yield while Chrome navigates independently.
    // Refresh observations, then recheck every admission boundary after the last
    // awaited permission read. The consumed receipt still prevents duplicate sends.
    const currentPages = await this.browser.call('list_pages', {}, signal);
    if (currentPages.isError) throw Error('Could not refresh browser pages. Refresh before sending an annotation.');
    await this.browser.access.checkUrl(frame.url);
    assertCurrent();
    const text = `Browser annotation from the user\nPage: ${frame.url}\nPage ID: ${frame.pageId}\nCaptured: ${new Date(frame.capturedAt).toISOString()}\nPoint: (${Math.round(input.x * (frame.width - 1))}, ${Math.round(input.y * (frame.height - 1))}) in the attached ${frame.width}×${frame.height} viewport screenshot. This records past pixels; inspect the live page before acting.\n\n${input.text.trim()}`;
    agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }, { type: 'image', attachment, ...(!supportsImages ? { offloaded: true } : {}) }] }));
    return { sent: true, message: supportsImages ? 'Annotation sent with the captured page image.' : 'Annotation sent. The model will receive text only; the screenshot is saved in the conversation.', imageInput: supportsImages };
  }
  isCurrent(frame) {
    const page = this.browser.pages.find(page => page.id === frame.pageId);
    return this.browser.generation === frame.generation && page?.url === frame.url &&
      typeof frame.documentId === 'string' && !!frame.documentId && page.documentId === frame.documentId;
  }
}
