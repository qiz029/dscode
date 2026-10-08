import { apply as nativeControl } from '@deepseek-ai/dsh-tool-subagent-control';
import { childTarget } from './child-target.mjs';

export const inject = ['tools', 'subagents'];
export function apply(ctx) {
  nativeControl({ subagents: ctx.subagents, tools: { register(tool) {
    const execute = tool.execute;
    // Retain the native definition identity, including its non-enumerable
    // adjacent-agent messaging marker and its result schema/presentation.
    tool.execute = (args, exec) => {
      const target = childTarget(exec);
      if (typeof target === 'string' && target.startsWith('/')) throw Error('The DSCODE child-name policy is unavailable for this call.');
      return execute({ ...args, agent_id: target }, exec);
    };
    return ctx.tools.register(tool);
  } } });
}
