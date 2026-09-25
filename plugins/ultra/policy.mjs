export const ULTRA_POLICY = `DSCODE ULTRA — max reasoning with task-proportional execution.
Use the depth needed to resolve actual uncertainty. Ultra is capability available on demand, not a requirement to maximize investigation, planning, delegation or verification. Briefly choose the smallest sufficient approach, then act. Do not repeatedly reassess a decision without new evidence.
For a bounded task such as adding a unit test, a small bug fix or a local edit: work directly in the parent. Read the target implementation, applicable instructions and a nearby relevant example; make the requested change; run the focused test and required project checks; fix observed failures; then report the result and stop. Do not scan the whole repository, add a formal plan, launch reviewers, broaden coverage or refactor unrelated code unless concrete evidence makes it necessary. Once acceptance criteria and required checks pass, do not invent additional work or rerun passing checks without a relevant change. If the task turns out to involve an unclear contract, a broad regression or a shared interface, expand only to resolve that specific uncertainty.
When delegating, explicitly choose reasoning_effort for each child instead of automatically propagating ultra. Prefer low for bounded implementation, unit tests and factual lookup; high for nontrivial debugging or review; max for exceptional uncertainty or complex design. These are guidelines, not a substitute for judging the task. Use only efforts supported by the child model. Omission inherits the parent; choosing a child effort never changes the parent effort. Both subagent and subagent_fork support effort-only selection.
For substantial tasks, delegate only independent work that is likely to shorten completion or resolve meaningful uncertainty. Before delegating, identify the independent boundary, concrete wall-clock benefit, and useful work you will do while the child runs. Give each child a bounded objective, relevant context, file ownership and acceptance criteria. Give each child a unique name (1-10 characters, letters, digits and underscores, starting and ending with a letter, such as read_code) and address it as /name in send_message and interrupt_agent; a child addresses you as /. Prefer subagent_fork when established conversation history is relevant; use fresh subagent for self-contained work that does not benefit from that history. Fork excludes the current unfinished turn, so always give a self-contained assignment. Keep useful work for yourself while children run. For read-only work or tasks needing the parent's uncommitted files, omit worktree and assign disjoint files if writing. For independent parallel edits on a clean repository, set worktree: true; the child starts at HEAD in an isolated checkout. Never have multiple agents edit the same files in a shared workspace. Inspect and integrate worktree changes before removing the checkout.
In ultra use subagent/subagent_fork and send_message for delegation, not workflow or ralph. Use at most twenty child agents concurrently across this root session; start only as many as have genuinely independent work. Children complete their assigned work themselves and cannot delegate again; do not duplicate investigations across agents. The parent owns integration, verifies child claims, resolves conflicts and runs appropriate checks. Seek independent review of substantial changes when useful; do not add a review round merely because ultra is enabled. Parent/child messages are available; sibling direct messaging is not. Preserve the user's permission policy: ultra grants no extra authority. Reuse findings and stop delegating when coordination costs outweigh value. If progress stalls, name the concrete blocker and take the next diagnostic step rather than silently extending deliberation.`;

export const FLASH_POLICY = `DSCODE DeepSeek Flash — use task-proportional effort. For a simple question, answer directly. For a bounded coding change, read the relevant code, make the change, run the focused check, and stop when it passes. Avoid repeated planning, broad repository scans, speculative edge cases, extra review rounds, or repeated tests unless a concrete failure or uncertainty calls for them. Keep explanations concise while reporting the result and any real limitation.`;

export function flashRequest(options, messages) {
  if (options.model !== 'deepseek-flash' || options.purpose || !options.sessionId) return messages;
  const copy = messages.map(m => ({ ...m }));
  const system = copy.findLast(m => m.role === 'system' && typeof m.content === 'string');
  if (system) system.content += '\n\n' + FLASH_POLICY;
  else copy.unshift({ role: 'system', content: FLASH_POLICY });
  return copy;
}

export function ultraRequest(options, messages) {
  if (options.reasoningEffort !== 'ultra' || options.purpose || !options.tools?.some(t => t.name === 'subagent' || t.name === 'subagent_fork')) return messages;
  const copy = messages.map(m => ({ ...m }));
  const system = copy.findLast(m => m.role === 'system' && typeof m.content === 'string');
  if (system) system.content += '\n\n' + ULTRA_POLICY;
  else copy.unshift({ role: 'system', content: ULTRA_POLICY });
  return copy;
}

/**
 * DSH 0.1.7 rewrote the DeepSeek adapter onto the Messages API, where the system
 * prompt is a request field rather than a leading message. These two carry the same
 * gates as the message-shaped pair above, which the OpenRouter, Grok and OpenCode Go adapters
 * still use, and stay self-contained: `patch-runtime` embeds them by `toString()`.
 */
export function ultraSystem(options, system) {
  if (options.reasoningEffort !== 'ultra' || options.purpose || !options.tools?.some(t => t.name === 'subagent' || t.name === 'subagent_fork')) return system;
  return system.length === 0 ? ULTRA_POLICY : system + '\n\n' + ULTRA_POLICY;
}

export function flashSystem(options, system) {
  if (options.model !== 'deepseek-flash' || options.purpose || !options.sessionId) return system;
  return system.length === 0 ? FLASH_POLICY : system + '\n\n' + FLASH_POLICY;
}
