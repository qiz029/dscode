#!/usr/bin/env node
import { main } from '../scripts/harness.mjs';

main(['start', ...process.argv.slice(2)], process.cwd()).catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
