#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { run } from './manager.mjs';
const release = JSON.parse(readFileSync(new URL('./release.json', import.meta.url), 'utf8'));
const args = process.argv.slice(2);
if (args[0] === '--version') console.log(release.version);
else if (args[0] === '--help' || args[0] === '-h') console.log(`DSCODE ${release.version}\n\n  dscode                         Start; first launch installs the Hub preset\n  dscode install [version]       Install an exact preset release\n  dscode update [version]        Upgrade (default: launcher release)\n  dscode history                 List retained preset revisions\n  dscode rollback [revision]     Restore a retained revision\n  dscode doctor                  Check the installed Hub profile\n  dscode --continue              Continue the previous session\n  dscode --resume SESSION_ID     Resume a session\n  dscode --cwd DIRECTORY         Work in a directory\n\nState: $DSCODE_HOME or ~/.local/share/dscode-hub\nModel credentials: configure /model in the TUI or set DEEPSEEK_API_KEY.`);
else run(args, release).catch(error => { console.error(error.message); process.exitCode = 1; });
