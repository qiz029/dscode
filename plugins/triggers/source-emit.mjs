// Private command exposed to sandboxed producers; it grants only emit access.
import { readFileSync } from 'node:fs';
import { emitToSource } from './source-ingress.mjs';

try {
  const [group, command, triggerId, ...args] = process.argv.slice(2);
  if (group !== 'trigger' || command !== 'emit' || !triggerId) throw new Error('source scripts may use: dscode trigger emit ID --event-id ID --text TEXT (or --event FILE)');
  let eventId, payload = {}, bodySet = false;
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (value === undefined) throw new Error(`${flag} requires a value`);
    if (flag === '--event-id') eventId = value;
    else if (['--text', '--event'].includes(flag) && !bodySet) {
      payload = flag === '--text' ? { source: 'cli', text: value } : JSON.parse(readFileSync(value === '-' ? 0 : value, 'utf8'));
      bodySet = true;
    } else throw new Error(`unsupported or repeated option ${flag}`);
  }
  console.log(JSON.stringify(await emitToSource({ triggerId, eventId, payload })));
} catch (error) { console.error(error.message); process.exitCode = 1; }
