// Loaded only by verify-exec.mjs: a fake LLM route that answers every prompt
// with a fixed text, optionally after one bash tool call, so `dscode exec`
// can be exercised end to end without network access.
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
export const name = 'dscode-exec-fixture';
export const inject = ['llm'];
export function apply(ctx) {
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, reasoning: { efforts: ['low', 'high', 'max', 'ultra'].map(id => ({ id, name: id })), defaultEffort: 'high' }, context: { contextWindow: 100000 } }; }
    async *stream(options) {
      const textOf = m => (Array.isArray(m?.content) ? m.content.filter(b => b.type === 'text').map(b => b.text) : [String(m?.content ?? '')]).filter(t => !/^\s*(<system-reminder>|Current runtime context)/.test(t)).join('').trim();
      const text = textOf(options.messages.findLast(m => m.role === 'user' && textOf(m)));
      const usedTool = options.messages.some(m => m.role === 'tool' || (Array.isArray(m.content) && m.content.some(b => b.type === 'tool-result' || b.type === 'tool_result')));
      const toolText = options.messages.flatMap(m => {
        const blocks = Array.isArray(m?.content) ? m.content : [{ type: 'text', text: String(m?.content ?? '') }];
        return blocks.flatMap(block => {
          if (block?.type === 'tool-result' || block?.type === 'tool_result') return Array.isArray(block.content) ? block.content.map(part => part?.text ?? '') : [block.text ?? String(block.content ?? '')];
          return m.role === 'tool' && block?.type === 'text' ? [block.text ?? ''] : [];
        });
      }).join('\n');
      if (text.includes('USE_BLOCKING_TOOL') && !usedTool && options.tools?.some(t => t.name === 'bash')) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'bash', arguments: JSON.stringify({ command: 'cat > /dev/null', description: 'fixture command that only terminal input could finish' }) } };
        yield { type: 'finish', reason: { kind: 'tool-use' } };
        return;
      }
      if (text.includes('USE_BLOCKING_TOOL') && usedTool) {
        yield { type: 'block-start', index: 0, blockType: 'text' };
        yield { type: 'block-end', index: 0, block: { type: 'text', text: `fixture reply: ${toolText.includes('cannot supply terminal input') ? 'stall noted' : toolText.includes('posix_openpt') ? 'no pty' : 'stall missing'}` } };
        yield { type: 'finish', reason: { kind: 'stop' } };
        return;
      }
      if (text.includes('USE_TOOL') && !usedTool && options.tools?.some(t => t.name === 'bash')) {
        yield { type: 'block-start', index: 0, blockType: 'tool-call' };
        yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'call-1', name: 'bash', arguments: JSON.stringify({ command: 'echo fixture-tool', description: 'fixture command' }) } };
        yield { type: 'finish', reason: { kind: 'tool-use' } };
        return;
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: `fixture reply: ${text.replace('USE_TOOL', '').trim()}` } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['exec-fixture'], new Adapter());
}
