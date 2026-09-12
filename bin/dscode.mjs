#!/usr/bin/env node
import { main, runtimeHome } from '../scripts/harness.mjs';
import { CLIENT_COMMANDS, runClient } from '../plugins/session-bridge/client.mjs';

const args = process.argv.slice(2);
if (args[0] === 'resume') {
  args.shift();
  const id = args[0] && !args[0].startsWith('-') ? args.shift() : undefined;
  args.unshift(...(id ? ['--resume', id] : ['--continue']));
}
(CLIENT_COMMANDS.includes(args[0]) ? runClient(args, runtimeHome) : main(['start', ...args], process.cwd())).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
