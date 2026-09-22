// TUI management and agent tools use one definitions/jobs/source service.
import { registerTriggerTools, mutationProblem } from './tools.mjs';
import { TriggerManagement } from './management.mjs';
import { triggerCommand } from './commands.mjs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const name = 'dscode-triggers';
export const inject = ['commands'];
const stateHome = () => process.env.DSH_HOME ?? process.env.DSCODE_HOME ?? join(homedir(), '.local/share/dscode-hub');

export function apply(ctx) {
  const home = stateHome();
  let managementContext;
  ctx.inject(['tools', 'systemPrompt', 'permissionPresets'], toolCtx => {
    managementContext = toolCtx;
    registerTriggerTools(toolCtx, { home });
  });
  const management = new TriggerManagement({ home, dscodePath: process.env.DSCODE_CLI_PATH });
  const handler = triggerCommand({ management, mutationProblem: agent => managementContext
    ? mutationProblem(managementContext, agent) : 'Trigger management services are not available yet.' });
  for (const name of ['trigger', 'triggers']) ctx.commands.register({
    name, description: 'Manage triggers, jobs and script sources; /trigger help',
    input: { hint: '[list|show|new|update|enable|disable|run|schedule|jobs|cancel|source|scheduler|help]' },
    handler,
  });
}
