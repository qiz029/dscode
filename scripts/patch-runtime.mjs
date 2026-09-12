import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ULTRA_POLICY, ultraRequest } from '../plugins/ultra/policy.mjs';

export function replaceOnce(text, from, to) {
  if (text.split(from).length !== 2) throw new Error('Pinned runtime patch drift: ' + from.slice(0, 90));
  return text.replace(from, to);
}
export function patchDeepSeek(text) {
  const marker = '// dscode-ultra-v1';
  const prefix = marker + '\nconst ULTRA_POLICY = ' + JSON.stringify(ULTRA_POLICY) + ';\n' + ultraRequest.toString() + '\n';
  if (text.startsWith(marker)) {
    const start = text.indexOf('\nimport ');
    if (start < 0) throw new Error('Malformed patched DeepSeek module');
    return prefix + text.slice(start + 1);
  }
  text = replaceOnce(text, 'function reasoningEffort(effort) {', 'function reasoningEffort(effort) {\n\tif (effort === "ultra") return "max";');
  text = replaceOnce(text, 'const REASONING_EFFORTS = [', 'const REASONING_EFFORTS = [\n{ id: ReasoningEffortId("ultra"), name: "Ultra", description: "DSCODE: max reasoning plus deliberate subagent collaboration; higher total token use." },');
  text = replaceOnce(text, 'function requestWithMessages(options, messages, defaults) {', 'function requestWithMessages(options, messages, defaults) {\n\tmessages = ultraRequest(options, messages);');
  return prefix + text;
}
export function patchBash(text) {
  text = text.replace('text: "Check the [exit code: N] marker on every bash result; investigate failures before moving on."', 'text: `Check the [exit code: N] marker on every ${config.toolName} result; investigate failures before moving on.`');
  if (text.includes('// dscode-named-shell-v1')) return text;
  text = replaceOnce(text, 'z.object({ enableRunInBackground:', 'z.object({ toolName: z.string().default("bash"), enableRunInBackground:');
  text = replaceOnce(text, 'toolName: "bash",', 'toolName: config.toolName,');
  text = replaceOnce(text, 'name: "tool:bash",', 'name: "tool:" + config.toolName,');
  text = replaceOnce(text, 'name: "bash",', 'name: config.toolName,');
  return '// dscode-named-shell-v1\n' + text;
}
export function patchPersistent(text) {
  if (text.includes('// dscode-shell-reset-v1')) return text;
  return '// dscode-shell-reset-v1\n' + replaceOnce(text, 'const existing = pending.get(owner);', `const liveId = live.get(owner);
      if (liveId !== undefined && !ctx.terminals.list(owner).some(s => s.sessionId === liveId && s.status.kind !== "exited")) { pending.delete(owner); live.delete(owner); }
      const existing = pending.get(owner);`);
}
export function patchSubagent(text) {
  if (text.includes('// dscode-child-effort-v1')) return text;
  text = replaceOnce(text, 'const choiceDescription = !modelSelectionEnabled ? "" :', 'const choiceDescription = !modelSelectionEnabled ? (subagentProvider.capabilities.agentOptions ? " Optionally set reasoning_effort for this child without changing its provider/model. Omit to inherit. Choose low for bounded tasks, high for difficult work, and max only when needed; use an effort supported by the current model." : "") :');
  text = replaceOnce(text, '...backgroundEnabled ? { run_in_background:', `...!modelSelectionEnabled && subagentProvider.capabilities.agentOptions ? { reasoning_effort: {
              type: "string",
              description: "Reasoning effort for this child only, validated against its model. Omit to inherit. Prefer low for bounded tasks, high for difficult work, max for exceptional uncertainty. Provider/model remain unchanged."
            } } : {},
            ...backgroundEnabled ? { run_in_background:`);
  text = replaceOnce(text, '} : config.agentOptions, modelRequest, modelSelectionEnabled);', '} : config.agentOptions, modelRequest, modelSelectionEnabled || subagentProvider.capabilities.agentOptions && modelRequest.provider === void 0 && modelRequest.model === void 0);');
  text = replaceOnce(text, 'assertAllowedModelSelection(modelSelectionPolicy, parentOptions, requestedChildAgentOptions, modelRequest);', 'if (modelRequest.provider !== void 0 || modelRequest.model !== void 0) assertAllowedModelSelection(modelSelectionPolicy, parentOptions, requestedChildAgentOptions, modelRequest);');
  return '// dscode-child-effort-v1\n' + text;
}
export function patchRuntime(root) {
  for (const [pkg, patch] of [['dsh-tool-subagent', patchSubagent], ['dsh-llm-deepseek', patchDeepSeek], ['dsh-tool-bash', patchBash], ['dsh-tool-bash-persistent', patchPersistent]]) {
    const dir = join(root, 'node_modules/@deepseek-ai', pkg);
    if (JSON.parse(readFileSync(join(dir, 'package.json'))).version !== '0.1.5-rc.1') throw new Error('Revalidate runtime patches before upgrading ' + pkg);
    const path = join(dir, 'lib/index.js');
    const before = readFileSync(path, 'utf8');
    const after = patch(before);
    if (before !== after) writeFileSync(path, after);
  }
}
