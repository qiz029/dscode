import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { replaceOnce } from './patch-util.mjs';
import { patchMacStdin } from './patch-mac-stdin.mjs';
import { patchStdinStall } from './patch-stdin-stall.mjs';
import { patchShellCapture, patchTerminalCapture } from './patch-shell-capture.mjs';
import { ULTRA_POLICY, ultraRequest, FLASH_POLICY, flashRequest } from '../plugins/ultra/policy.mjs';

export function patchDeepSeek(text) {
  const marker = '// dscode-ultra-v1';
  const prefix = marker + '\nconst ULTRA_POLICY = ' + JSON.stringify(ULTRA_POLICY) + ';\n' + ultraRequest.toString() + '\nconst FLASH_POLICY = ' + JSON.stringify(FLASH_POLICY) + ';\n' + flashRequest.toString() + '\n';
  // Delegation tools are offered at every effort; workflow and ralph never are. Earlier builds hid delegation below Ultra.
  const toolFilter = 'options.tools?.filter((tool) => tool.name !== "workflow" && tool.name !== "ralph").map((tool) => ({';
  const ultraOnlyFilter = 'options.tools?.filter((tool) => options.reasoningEffort === "ultra" ? tool.name !== "workflow" && tool.name !== "ralph" : !["subagent", "subagent_fork", "workflow", "ralph"].includes(tool.name)).map((tool) => ({';
  const filterTools = body => replaceOnce(body, 'const tools = options.tools?.map((tool) => ({', 'const tools = ' + toolFilter);
  const addFlash = body => replaceOnce(body, 'messages = ultraRequest(options, messages);', 'messages = flashRequest(options, messages);\n\tmessages = ultraRequest(options, messages);');
  if (text.startsWith(marker)) {
    const start = text.indexOf('\nimport ');
    if (start < 0) throw new Error('Malformed patched DeepSeek module');
    const body = text.slice(start + 1);
    const filtered = body.includes(toolFilter) ? body : body.includes(ultraOnlyFilter) ? replaceOnce(body, ultraOnlyFilter, toolFilter) : filterTools(body);
    return prefix + (filtered.includes('messages = flashRequest(options, messages);') ? filtered : addFlash(filtered));
  }
  text = replaceOnce(text, 'function reasoningEffort(effort) {', 'function reasoningEffort(effort) {\n\tif (effort === "ultra") return "max";');
  text = replaceOnce(text, 'const REASONING_EFFORTS = [', 'const REASONING_EFFORTS = [\n{ id: ReasoningEffortId("ultra"), name: "Ultra", description: "DSCODE: max reasoning plus deliberate subagent collaboration; higher total token use." },');
  text = replaceOnce(text, 'function requestWithMessages(options, messages, defaults) {', 'function requestWithMessages(options, messages, defaults) {\n\tmessages = flashRequest(options, messages);\n\tmessages = ultraRequest(options, messages);');
  text = filterTools(text);
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
  if (!text.includes('// dscode-shell-reset-v1')) {
    text = '// dscode-shell-reset-v1\n' + replaceOnce(text, 'const existing = pending.get(owner);', `const liveId = live.get(owner);
      if (liveId !== undefined && !ctx.terminals.list(owner).some(s => s.sessionId === liveId && s.status.kind !== "exited")) { pending.delete(owner); live.delete(owner); }
      const existing = pending.get(owner);`);
  }
  return patchShellCapture(patchStdinStall(text));
}

export { STDIN_STALL_MS, STDIN_STALL_NOTE, patchStdinStall } from './patch-stdin-stall.mjs';
export { patchShellCapture, patchTerminalCapture } from './patch-shell-capture.mjs';

export function patchTerminalBash(text) {
  if (text.includes('// dscode-no-history-expansion-v1')) return patchTerminalCapture(text);
  // The persistent tool sends one interactive Bash line. History expansion on
  // a literal `!` rejects that line before its completion marker can run.
  return patchTerminalCapture('// dscode-no-history-expansion-v1\n' + replaceOnce(
    text,
    '"--norc",\n\t"-i"',
    '"--norc",\n\t"+H",\n\t"-i"',
  ));
}
// Child-effort guidance names no level: any model can delegate, and level names differ per model.
const CHILD_EFFORT_CHOICE = ' Optionally set reasoning_effort for this child without changing its provider/model. Omit to inherit. Use a level the current model offers: the lowest that fits the task, raised only for difficult work or real uncertainty.';
const CHILD_EFFORT_PARAMETER = 'Reasoning effort for this child only, validated against its model; use a level that model offers. Omit to inherit. Prefer the lowest level that fits the task and raise it only for difficult work or real uncertainty. Provider/model remain unchanged.';
// v1 named DeepSeek's low/high/max.
const CHILD_EFFORT_V1 = [
  [' Optionally set reasoning_effort for this child without changing its provider/model. Omit to inherit. Choose low for bounded tasks, high for difficult work, and max only when needed; use an effort supported by the current model.', CHILD_EFFORT_CHOICE],
  ['Reasoning effort for this child only, validated against its model. Omit to inherit. Prefer low for bounded tasks, high for difficult work, max for exceptional uncertainty. Provider/model remain unchanged.', CHILD_EFFORT_PARAMETER],
];
function patchSubagentBase(text) {
  if (text.includes('// dscode-child-effort-v1')) {
    for (const [from, to] of CHILD_EFFORT_V1) text = replaceOnce(text, from, to);
    text = text.replace('// dscode-child-effort-v1', '// dscode-child-effort-v2');
  } else if (!text.includes('// dscode-child-effort-v2')) {
    text = replaceOnce(text, 'const choiceDescription = !modelSelectionEnabled ? "" :', 'const choiceDescription = !modelSelectionEnabled ? (subagentProvider.capabilities.agentOptions ? "' + CHILD_EFFORT_CHOICE + '" : "") :');
    text = replaceOnce(text, '...backgroundEnabled ? { run_in_background:', `...!modelSelectionEnabled && subagentProvider.capabilities.agentOptions ? { reasoning_effort: {
              type: "string",
              description: "${CHILD_EFFORT_PARAMETER}"
            } } : {},
            ...backgroundEnabled ? { run_in_background:`);
    text = replaceOnce(text, '} : config.agentOptions, modelRequest, modelSelectionEnabled);', '} : config.agentOptions, modelRequest, modelSelectionEnabled || subagentProvider.capabilities.agentOptions && modelRequest.provider === void 0 && modelRequest.model === void 0);');
    text = replaceOnce(text, 'assertAllowedModelSelection(modelSelectionPolicy, parentOptions, requestedChildAgentOptions, modelRequest);', 'if (modelRequest.provider !== void 0 || modelRequest.model !== void 0) assertAllowedModelSelection(modelSelectionPolicy, parentOptions, requestedChildAgentOptions, modelRequest);');
    text = '// dscode-child-effort-v2\n' + text;
  }
  if (text.includes('// dscode-child-worktree-v3')) return text;
  if (text.includes('// dscode-child-worktree-v1')) {
    text = replaceOnce(text, 'const childWorktree = args.worktree === true ?', 'if (args.worktree === true && !(continuable && (config.provider === "spawn" || config.provider === "fork"))) throw new Error("worktree is unavailable for this subagent provider");\n\t\t\t\t\t\tconst childWorktree = args.worktree === true ?').replace('// dscode-child-worktree-v1', '// dscode-child-worktree-v2');
  }
  if (text.includes('// dscode-child-worktree-v2')) {
    text = replaceOnce(text, '? createChildWorktree(parent.session.header.cwd)', '? await createChildWorktree(parent.session.header.cwd, exec.signal)');
    text = replaceOnce(text, '!discardCleanChildWorktree(childWorktree)', '!await discardCleanChildWorktree(childWorktree)');
    return text.replace('// dscode-child-worktree-v2', '// dscode-child-worktree-v3');
  }
  text = replaceOnce(text, 'import z from "@deepseek-ai/schemastery";', 'import { createChildWorktree, discardCleanChildWorktree } from "../../../../plugins/worktree-subagent/worktree.mjs";\nimport z from "@deepseek-ai/schemastery";');
  text = replaceOnce(text, '+ choiceDescription,', '+ choiceDescription + (continuable && (config.provider === "spawn" || config.provider === "fork") ? " Set worktree: true for an isolated Git checkout when agents edit in parallel. It starts at HEAD and refuses a dirty parent workspace; omit for read-only tasks or when the child needs uncommitted parent edits. You must inspect and integrate its changes; the worktree remains after completion." : ""),');
  text = replaceOnce(text, '...backgroundEnabled ? { run_in_background: {', `...continuable && (config.provider === "spawn" || config.provider === "fork") ? { worktree: {
              type: "boolean",
              description: "Create an isolated Git worktree for this child at clean HEAD. Choose for parallel editing; omit or set false for read-only work or tasks requiring uncommitted parent changes. Parent must integrate the result."
            } } : {},
            ...backgroundEnabled ? { run_in_background: {`);
  text = replaceOnce(text, 'jobId: {\n', 'worktree: { type: "string" },\n\t\t\t\t\tjobId: {\n');
  text = replaceOnce(text, 'subagentId: {\n', 'worktree: { type: "string" },\n\t\t\t\t\tsubagentId: {\n');
  text = replaceOnce(text, 'runId: {\n', 'worktree: { type: "string" },\n\t\t\t\t\trunId: {\n');
  text = replaceOnce(text, ': outputValueText(value.output)\n', ': outputValueText(value.output)) + (value.worktree ? `\nWorktree: ${value.worktree}\nInspect and integrate its changes before removing it.` : "")\n');
  text = replaceOnce(text, 'text: value.kind === "background" ?', 'text: (value.kind === "background" ?');
  text = replaceOnce(text, 'const maxDepth = typeof config.maxDepth === "number" ? config.maxDepth : void 0;', 'if (args.worktree === true && !(continuable && (config.provider === "spawn" || config.provider === "fork"))) throw new Error("worktree is unavailable for this subagent provider");\n\t\t\t\t\t\tconst childWorktree = args.worktree === true ? await createChildWorktree(parent.session.header.cwd, exec.signal) : void 0;\n\t\t\t\t\t\tconst maxDepth = typeof config.maxDepth === "number" ? config.maxDepth : void 0;');
  text = replaceOnce(text, 'label: args.description,\n\t\t\t\t\t\t\tprompt:', 'label: args.description,\n\t\t\t\t\t\t\t...childWorktree ? { workspaceCwd: childWorktree.cwd } : {},\n\t\t\t\t\t\t\tprompt:');
  text = replaceOnce(text, 'if (resolveDelegationRun(args, {', 'try {\n\t\t\t\t\t\tif (resolveDelegationRun(args, {');
  text = replaceOnce(text, ')).childId\n', ')).childId,\n\t\t\t\t\t\t\t\t\t...childWorktree ? { worktree: childWorktree.cwd } : {}\n');
  text = replaceOnce(text, 'return settleForegroundRun(await runtimeCtx.subagents.start(config.provider, {', 'return { ...await settleForegroundRun(await runtimeCtx.subagents.start(config.provider, {');
  text = replaceOnce(text, 'signal: exec.signal\n\t\t\t\t\t\t}));\n\t\t\t\t\t}', 'signal: exec.signal\n\t\t\t\t\t\t})), ...childWorktree ? { worktree: childWorktree.cwd } : {} };\n\t\t\t\t\t\t} catch (error) {\n\t\t\t\t\t\t\tif (childWorktree && !await discardCleanChildWorktree(childWorktree)) throw new Error(`${String(error)}; child worktree retained at ${childWorktree.cwd}`, { cause: error });\n\t\t\t\t\t\t\tthrow error;\n\t\t\t\t\t\t}\n\t\t\t\t\t}');
  return '// dscode-child-worktree-v3\n' + text;
}
/** Parent-chosen child names: a required `name` parameter, /name labels and result text. Runs after the worktree patch, which anchors on the original label sites. */
function patchChildName(text) {
  if (text.includes('// dscode-child-name-v1')) return text;
  text = replaceOnce(text, 'parameters: {\n\t\t\t\t\t\tdescription: {', `parameters: {
\t\t\t\t\t\tname: {
\t\t\t\t\t\t\ttype: "string",
\t\t\t\t\t\t\trequired: true,
\t\t\t\t\t\t\tdescription: "Unique name you give this child: 1-10 characters, letters, digits and underscores only, starting and ending with a letter (for example read_code). Address the child as /name in send_message and interrupt_agent."
\t\t\t\t\t\t},
\t\t\t\t\t\tdescription: {`);
  text = replaceOnce(text, 'if (!parent) throw new Error("subagent tool requires a calling agent (exec.agent was undefined)");', 'if (!parent) throw new Error("subagent tool requires a calling agent (exec.agent was undefined)");\n\t\t\t\t\t\tif (typeof args.name !== "string" || !/^[A-Za-z](?:[A-Za-z0-9_]{0,8}[A-Za-z])?$/.test(args.name)) throw new Error("name must be 1-10 characters of letters, digits or underscores, starting and ending with a letter");');
  if (text.split('label: args.description').length !== 4) throw new Error('Pinned runtime patch drift: subagent label sites');
  text = text.split('label: args.description').join('label: "/" + args.name + " \u00b7 " + args.description');
  text = replaceOnce(text, 'started subagent ${value.subagentId}', 'started subagent /${_args.name} (${value.subagentId})');
  text = '// dscode-child-name-v1\n' + text;
  return text;
}

export function patchSubagent(text) {
  return patchChildName(patchSubagentBase(text));
}

export function patchSubagentCore(text) {
  if (text.includes('// dscode-child-cwd-v1')) return text;
  text = replaceOnce(text, 'function childSessionMeta(parent, childDepth, isSeeded) {', 'function childSessionMeta(parent, childDepth, isSeeded, workspaceCwd) {');
  text = replaceOnce(text, '...parentHeader.cwd !== void 0 ? { cwd: parentHeader.cwd } : {},', '...workspaceCwd !== void 0 ? { cwd: workspaceCwd } : parentHeader.cwd !== void 0 ? { cwd: parentHeader.cwd } : {},');
  text = replaceOnce(text, 'meta: childSessionMeta(parent, childDepth, prepared.seed !== void 0),', 'meta: childSessionMeta(parent, childDepth, prepared.seed !== void 0, request.workspaceCwd),');
  text = replaceOnce(text, 'The parent shares your workspace but does not automatically receive your transcript', 'The parent may use a different workspace and does not automatically receive your transcript');
  return '// dscode-child-cwd-v1\n' + text;
}
export function patchSubagentDriver(text) {
  if (text.includes('// dscode-child-cwd-v1')) return text;
  return '// dscode-child-cwd-v1\n' + replaceOnce(text, 'meta: childSessionMeta(parent, childDepth, seed !== void 0),', 'meta: childSessionMeta(parent, childDepth, seed !== void 0, request.workspaceCwd),');
}
/**
 * The invoking directory's `.env` belongs to the project being worked on, not to DSCODE:
 * upstream reads it as a "project layer", so a workspace file could inject variables into
 * the agent process, and one bootstrap-only name in it (any `DSH_*`, `NODE_OPTIONS`, a CA
 * path) aborted the launch. DSCODE's own settings come from the installation's `.env`,
 * which the launcher loads; only the Harness-home layer is still read here.
 */
export function patchAppBoot(text) {
  if (text.includes('// dscode-no-project-env-v1')) return text;
  text = replaceOnce(text, '\tconst project = readEnvLayer(binName, cwd, warn, home);', '\tconst project = void 0;');
  text = replaceOnce(text, '\tconst user = home === resolve(cwd) ? void 0 : readEnvLayer(binName, home, warn, home);', '\tconst user = readEnvLayer(binName, home, warn, home);');
  return '// dscode-no-project-env-v1\n' + text;
}
/**
 * Apply the pinned runtime patches to an installed dependency tree.
 * @param root - install root holding `node_modules`.
 * @param options - `requireMacStdin` fails when the macOS process inspector is absent
 * (the repository install); a staged release build passes false, because a published
 * package cannot carry its own copy of that package.
 */
/** The upstream DSH release every runtime patch in this file was validated against. */
export const RUNTIME_VERSION = '0.1.5-rc.2';

/**
 * dscode: the round cap is a goal field the model-facing tools can set, and the
 * human-facing `/goal` could not: this teaches it the `[N]` shorthand, so a
 * person can set or change the cap from the command plane — `/goal[20] <objective>`
 * creates with that cap, `/goal[20]` re-caps the current goal. Retire the patch
 * when @deepseek-ai/dsh-command-goal carries the syntax upstream.
 */
export function patchGoalCommand(text) {
  const marker = '// dscode-goal-cap-v1';
  if (text.includes(marker)) return text;
  // The parsed command carries an optional cap, so create/edit pass it through.
  const helper = '/** dscode: the create/edit request, carrying the `[N]` cap when the human set one. */\nfunction goalRequest(command) {\n\treturn { objective: command.objective, ...command.maxGoalRounds === void 0 ? {} : { maxGoalRounds: command.maxGoalRounds } };\n}\n';
  // `[N]` must be the whole input or immediately precede an objective: a control
  // word after a cap would read as an objective, which is never what was meant.
  const parse = '\tconst capMatch = /^\\[(\\d+)\\]\\s*(.*)$/su.exec(input);\n\tif (capMatch !== null) {\n\t\tconst maxGoalRounds = Number(capMatch[1]);\n\t\tconst rest = capMatch[2].trim();\n\t\tif (maxGoalRounds < 1 || ["clear", "pause", "resume", "edit"].includes(rest.toLowerCase())) return { kind: "invalid-cap" };\n\t\treturn rest === "" ? { kind: "cap", maxGoalRounds } : { kind: "create", objective: rest, maxGoalRounds };\n\t}\n';
  const cases = '\t\t\tcase "cap": {\n\t\t\t\tif (current === void 0) return {\n\t\t\t\t\tkind: "error",\n\t\t\t\t\ttext: `No goal is currently set; /goal[<rounds>] changes the round cap of an existing goal. ${USAGE}`\n\t\t\t\t};\n\t\t\t\treturn renderGoal("Goal updated", ctx.goals.edit(invocation.agent, goalRef(current), { maxGoalRounds: command.maxGoalRounds }));\n\t\t\t}\n\t\t\tcase "invalid-cap": return {\n\t\t\t\tkind: "error",\n\t\t\t\ttext: `The round cap must be a positive whole number and cannot accompany a control word.\\n${USAGE}`\n\t\t\t};\n';
  text = replaceOnce(text, 'const USAGE = "Usage: /goal [<objective>|clear|edit <objective>|pause|resume]";',
    'const USAGE = "Usage: /goal [<objective>|clear|edit <objective>|pause|resume], /goal[<rounds>] set the round cap";');
  text = replaceOnce(text, '/** Direct error for an operation that requires a current goal. */', helper + '/** Direct error for an operation that requires a current goal. */');
  text = replaceOnce(text, 'function parseGoalCommand(rawInput) {\n\tconst input = rawInput.trim();\n', 'function parseGoalCommand(rawInput) {\n\tconst input = rawInput.trim();\n' + parse);
  text = replaceOnce(text, '\t\t\t\tconst created = ctx.goals.create(invocation.agent, { objective: command.objective });', '\t\t\t\tconst created = ctx.goals.create(invocation.agent, goalRequest(command));');
  text = replaceOnce(text, '\t\t\t\t\tconst replaced = ctx.goals.create(invocation.agent, { objective: command.objective });', '\t\t\t\t\tconst replaced = ctx.goals.create(invocation.agent, goalRequest(command));');
  text = replaceOnce(text, '\t\t\t\tconst edited = ctx.goals.edit(invocation.agent, goalRef(current), { objective: command.objective });', '\t\t\t\tconst edited = ctx.goals.edit(invocation.agent, goalRef(current), goalRequest(command));');
  text = replaceOnce(text, '\t\t\t/* v8 ignore next 2 -- GoalCommand is closed and every member is handled above */', cases + '\t\t\t/* v8 ignore next 2 -- GoalCommand is closed and every member is handled above */');
  text = replaceOnce(text, 'input: {\n\t\t\thint: "[<objective>|clear|edit <objective>|pause|resume]",', 'input: {\n\t\t\thint: "[<objective>|clear|edit <objective>|pause|resume], [<rounds>]",');
  return marker + '\n' + text;
}

export function patchRuntime(root, { requireMacStdin = true } = {}) {
  for (const [pkg, patch] of [['dsh-tool-subagent', patchSubagent], ['dsh-subagent', patchSubagentCore], ['dsh-subagent-in-process-driver', patchSubagentDriver], ['dsh-llm-deepseek', patchDeepSeek], ['dsh-tool-bash', patchBash], ['dsh-tool-bash-persistent', patchPersistent], ['dsh-terminal-bash', patchTerminalBash], ['dsh-command-goal', patchGoalCommand]]) {
    const dir = join(root, 'node_modules/@deepseek-ai', pkg);
    if (JSON.parse(readFileSync(join(dir, 'package.json'))).version !== RUNTIME_VERSION) throw new Error('Revalidate runtime patches before upgrading ' + pkg);
    const path = join(dir, 'lib/index.js');
    const before = readFileSync(path, 'utf8');
    const after = patch(before);
    if (before !== after) writeFileSync(path, after);
  }
  patchMacStdinPackage(root, { required: requireMacStdin });
}

// dsh-app-boot is host plane: a repository or tar install owns its copy, while a staged
// release build vendors only plugin packages, so this runs from provision instead.
export function patchAppBootPackage(root) {
  const dir = join(root, 'node_modules/@deepseek-ai/dsh-app-boot');
  if (JSON.parse(readFileSync(join(dir, 'package.json'))).version !== RUNTIME_VERSION) throw new Error('Revalidate runtime patches before upgrading dsh-app-boot');
  const path = join(dir, 'lib/index.js');
  const before = readFileSync(path, 'utf8');
  const after = patchAppBoot(before);
  if (before !== after) writeFileSync(path, after);
}

// The macOS process inspector lives in a content-hashed chunk, so find the file
// that carries the stub instead of pinning its name.
export function patchMacStdinPackage(root, { required = true } = {}) {
  const dir = join(root, 'node_modules/@deepseek-ai/dsh-subprocess-local');
  if (!existsSync(join(dir, 'package.json'))) {
    const note = `dsh-subprocess-local is not installed under ${root}: the macOS stdin probe was not applied to this tree.`;
    if (required) throw new Error(`${note} Run npm ci for a repository install, or pass requireMacStdin: false for a staged release build.`);
    process.emitWarning(note);
    return 'missing';
  }
  if (JSON.parse(readFileSync(join(dir, 'package.json'))).version !== RUNTIME_VERSION) throw new Error('Revalidate runtime patches before upgrading dsh-subprocess-local');
  const lib = join(dir, 'lib');
  // An already patched chunk carries the probe signature (and the marker) instead of the
  // stub, so recognise both: a re-run must report `unchanged`, not drift.
  const carrier = entry => entry.endsWith('.js') && /isStdinWaiting\(_?pgid, _?shellPid\)|dscode-mac-stdin-wait-v1/.test(readFileSync(join(lib, entry), 'utf8'));
  const name = readdirSync(lib).find(carrier);
  if (name === undefined) throw new Error('Pinned macOS stdin probe drift: dsh-subprocess-local');
  const path = join(lib, name);
  const before = readFileSync(path, 'utf8');
  const after = patchMacStdin(before);
  if (before === after) return 'unchanged';
  writeFileSync(path, after);
  return 'patched';
}
