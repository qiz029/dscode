import { apply as registerFixture } from '../../scripts/exec-fixture.mjs';
export const name = 'acp-runtime-fixture';
export const inject = ['llm', 'dscodeCustom'];
export function apply(ctx) {
  registerFixture(ctx);
  ctx.on('tools/pre-execute', (exec, next) => exec.name === 'bash' ? { kind: 'ask', reason: 'ACP fixture approval' } : next(), { prepend: true });
  ctx.get('dscodeCustom').adapter.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    if (process.env.DSCODE_ACP_VERIFY_VERBOSE) process.stderr.write('ACP_BODY ' + JSON.stringify(body.messages.map(m => ({ role: m.role, calls: m.tool_calls?.length, content: JSON.stringify(m.content)?.slice(0, 160) }))) + '\n');
    const userText = JSON.stringify(body.messages.filter(m => m.role === 'user'));
    if (userText.includes('WAIT_ABORT')) {
      process.stderr.write('ACP_WAIT_ABORT\n');
      return new Promise((_resolve, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    }
    const usedTool = body.messages.some(m => m.role === 'tool');
    const call = !usedTool && userText.includes('USE_TOOL');
    const delta = call ? { tool_calls: [{ index: 0, id: 'acp-fixture-call', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'echo acp-fixture', description: 'ACP fixture' }) } }] } : { content: 'fixture reply from custom API' };
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
}
