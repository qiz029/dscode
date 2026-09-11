export const ULTRA_POLICY = `DSCODE ULTRA — max reasoning with deliberate collaboration.
Actively look for useful independent tasks: investigation, implementation in disjoint files, and independent review. Delegate only when it improves the outcome; simple tasks need no child agents. Give each child a bounded objective, relevant context, file ownership and acceptance criteria. Keep useful work for yourself while children run. Never have multiple agents edit the same files concurrently. Shared files are not isolated worktrees.
In ultra use subagent/subagent_fork and send_message for delegation, not workflow or ralph. Use at most three child agents concurrently across this root session. Do not recursively proliferate agents or duplicate investigations. The parent owns integration, verifies child claims, resolves conflicts and runs appropriate checks. Seek independent review of substantial changes when useful. Parent/child messages are available; sibling direct messaging is not. Preserve the user's permission policy: ultra grants no extra authority. Track progress and costs, reuse findings, and stop delegating when coordination costs outweigh value.`;
export function ultraRequest(options, messages) {
  if (options.reasoningEffort !== 'ultra' || options.purpose || !options.tools?.some(t => t.name === 'subagent' || t.name === 'subagent_fork')) return messages;
  const copy = messages.map(m => ({ ...m }));
  const system = copy.findLast(m => m.role === 'system' && typeof m.content === 'string');
  if (system) system.content += '\n\n' + ULTRA_POLICY;
  else copy.unshift({ role: 'system', content: ULTRA_POLICY });
  return copy;
}
