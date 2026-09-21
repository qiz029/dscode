#!/usr/bin/env node
import { main, manifest, runtimeHome } from '../scripts/harness.mjs';
import { CLIENT_COMMANDS, runClient } from '../plugins/session-bridge/client.mjs';
import { runEmailClient } from '../plugins/email/cli.mjs';
import { runDoctorCli } from '../scripts/doctor-cli.mjs';
import { selfUpdate } from '../scripts/self-update.mjs';
import { runExec } from '../scripts/exec.mjs';
import { runTriggerCli } from '../scripts/trigger.mjs';

const args = process.argv.slice(2);
// Once a session starts the DSH CLI owns `--version`, so DSCODE answers it here instead.
if (args[0] === '--version' || args[0] === '-v') console.log(manifest.version);
else {
  if (args[0] === 'resume') {
    args.shift();
    const id = args[0] && !args[0].startsWith('-') ? args.shift() : undefined;
    args.unshift(...(id ? ['--resume', id] : ['--continue']));
  }
  (args[0] === 'exec' ? runExec(args.slice(1)).then(code => { process.exitCode = code; }) : args[0] === 'trigger' ? runTriggerCli(args.slice(1)).then(code => { process.exitCode = code; }) : args[0] === 'doctor' ? (args.length <= 2 && (!args[1] || ['--local', '--preview'].includes(args[1])) ? runDoctorCli(runtimeHome, args[1]?.slice(2) ?? 'analyze') : Promise.reject(Error('Usage: dscode doctor [--local|--preview]'))) : args[0] === 'email' ? runEmailClient(args.slice(1)) : args[0] === 'update' ? selfUpdate(args.slice(1)) : CLIENT_COMMANDS.includes(args[0]) ? runClient(args, runtimeHome) : main(['start', ...args], process.cwd())).catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
