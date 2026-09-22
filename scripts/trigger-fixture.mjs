// Local, deterministic model for verify-triggers: two turns per goal, recording
// the actual model input so the probe can prove history crossed a Host restart.
import { appendFileSync } from 'node:fs';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
export const name = 'dscode-trigger-fixture';
export const inject = ['llm', 'agents', 'goals'];
export function apply(ctx) {
  let calls = 0;
  class Adapter extends LlmAdapter {
    async resolveModel(provider, model) { return { provider, id: model, name: model, context: { contextWindow: 100000 } }; }
    async *stream(options) {
      if (!options.purpose) {
        calls += 1;
        const agent = ctx.agents.roots()[0];
        const goal = ctx.goals.get(agent);
        appendFileSync(process.env.DSCODE_TRIGGER_TRACE, JSON.stringify({ sessionId: agent.session.id, goalId: goal.id, calls, messages: options.messages }) + '\n');
        if (calls >= 2) ctx.goals.complete(agent, { id: goal.id, revision: goal.revision });
      }
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'block-end', index: 0, block: { type: 'text', text: calls < 2 ? 'Continuing this event.' : 'Event finished.' } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }
  ctx.llm.registerAdapter(['trigger-fixture'], new Adapter());
}
