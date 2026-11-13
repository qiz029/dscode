import { apply as registerFixture } from '../../scripts/exec-fixture.mjs';
import { keyRef } from '../../plugins/custom/config.mjs';
import { LlmError } from '@deepseek-ai/dsh-llm';
export const name = 'acp-runtime-fixture';
export const inject = ['llm', 'dscodeCustom', 'credentials'];
export function apply(ctx) {
  registerFixture(ctx);
  const describe = ctx.credentials.describe.bind(ctx.credentials);
  const refs = new Set(['custom-acp', 'custom-acp-keyed', 'custom-acp-missing'].map(keyRef));
  ctx.credentials.describe = async ref => refs.has(ref) ? { configured: ref === keyRef('custom-acp-keyed') } : describe(ref);
  ctx.on('tools/pre-execute', (exec, next) => exec.name === 'bash' ? { kind: 'ask', reason: 'ACP fixture approval' } : next(), { prepend: true });
  ctx.get('dscodeCustom').adapter.fetch = async (_url, options) => {
    process.stderr.write('ACP_INFERENCE_CALL\n');
    const body = JSON.parse(options.body);
    if (process.env.DSCODE_ACP_VERIFY_VERBOSE) process.stderr.write('ACP_BODY ' + JSON.stringify(body.messages.map(m => ({ role: m.role, calls: m.tool_calls?.length, content: JSON.stringify(m.content)?.slice(0, 160) }))) + '\n');
    const userText = JSON.stringify(body.messages.filter(m => m.role === 'user'));
    const titleRequest = body.messages.some(m => m.role === 'system' && JSON.stringify(m.content).includes('Create a concise title'));
    if (titleRequest) {
      process.stderr.write('ACP_TITLE_CALL\n');
      const empty = userText.includes('TITLE_FAIL');
      if (empty) process.stderr.write('ACP_TITLE_EMPTY\n');
      return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: empty ? '' : 'ACP fixture session' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
    }
    if (userText.includes('WAIT_ABORT')) {
      process.stderr.write('ACP_WAIT_ABORT\n');
      return new Promise((_resolve, reject) => {
        if (options.signal.aborted) reject(options.signal.reason);
        else options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
    }
    const usedTool = body.messages.some(m => m.role === 'tool');
    if (usedTool && userText.includes('FAIL_AFTER_TOOL')) {
      throw new LlmError('fixture secret must not be returned: fake-token', 'TRANSPORT');
    }
    const call = !usedTool && userText.includes('USE_TOOL');
    const delta = call ? { tool_calls: [{ index: 0, id: 'acp-fixture-call', type: 'function', function: { name: 'bash', arguments: JSON.stringify({ command: 'echo acp-fixture', description: 'ACP fixture' }) } }] } : { content: 'fixture reply from custom API' };
    return new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: call ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`, { headers: { 'content-type': 'text/event-stream' } });
  };
}
