import { IMAGE_OFFLOAD_REQUIRED_CODE, LlmError, contentHasImage, offloadedImageText, projectOffloadedImages, requiredImageOffload } from '@deepseek-ai/dsh-llm';
import { requestImageDimensions } from '@deepseek-ai/dsh-attachment';

const IMAGE_POLICY = Object.freeze({ maxPixels: 2048 * 2048, maxBytes: 1024 * 1024 });
const MAX_REQUEST_IMAGE_BYTES = 20 * 1024 * 1024;

/** Read durable images once per attachment; offloading remains a session decision. */
export async function prepareImages(history, model, attachments, access, signal) {
  const messages = projectOffloadedImages(history, ref => offloadedImageText(ref, access(ref)));
  const versions = new Map();
  if (!messages.some(m => contentHasImage(m.content))) return { messages, versions, access };
  if (!model.inputModalities?.includes('image')) throw new LlmError('Enable image input for this custom model before sending retained images', 'UNSUPPORTED_CONTENT');
  if (!attachments) throw new LlmError('Image input requires the durable attachment service', 'UNSUPPORTED_CONTENT');
  const refs = new Map();
  const collect = blocks => {
    for (const block of blocks) {
      if (block.type === 'image') refs.set(block.attachment.attachmentId, block.attachment);
      else if (block.type === 'tool-result') collect(block.content);
    }
  };
  for (const message of messages) collect(message.content);
  for (const ref of refs.values()) {
    signal?.throwIfAborted();
    const target = { ...requestImageDimensions(ref.width, ref.height, IMAGE_POLICY.maxPixels), maxBytes: IMAGE_POLICY.maxBytes };
    versions.set(ref.attachmentId, await attachments.readImageRequest(ref, target, signal));
  }
  const offloadImages = requiredImageOffload(messages,
    { representation: 'base64', maxBytes: MAX_REQUEST_IMAGE_BYTES, byteQuantum: 1 },
    block => versions.get(block.attachment.attachmentId).bytes);
  if (offloadImages > 0) throw new LlmError('Custom request images exceed the 20 MiB encoded image budget', IMAGE_OFFLOAD_REQUIRED_CODE, { offloadImages });
  return { messages, versions, access };
}
