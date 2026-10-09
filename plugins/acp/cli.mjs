export const USAGE = `Usage: dscode acp [options]
Serve Agent Client Protocol over stdio using the DSCODE agent preset.
The client supplies each session's workspace. Stdout contains only ACP frames.

Options:
  --model PROVIDER/ID   initial model (default: the saved default model)
  --patch FILE          additional composition overlay (repeatable)
  -h, --help            show this help

Configure credentials and custom providers in the TUI before connecting.
Permission requests are answered by the ACP client. Disconnecting exits.`;

export function parseAcpArgs(argv) {
  const options = { patches: [], help: false };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') { options.help = true; continue; }
    if (!['--model', '--patch'].includes(arg)) throw Error(`Unknown ACP option: ${arg}`);
    const value = argv[++index];
    if (!value || value.startsWith('-')) throw Error(`${arg} requires a value`);
    if (arg === '--patch') options.patches.push(value);
    else {
      if (!/^[^/\s]+\/\S+$/.test(value)) throw Error('--model expects provider/model');
      options.model = value;
    }
  }
  return options;
}

export function acpOverlay(entry, options = {}) {
  return `${['tui-startup', 'tui-runner', 'session-title-llm'].map(id => `- id: ${id}\n  disabled: true`).join('\n')}
- id: dscode-session-cards
  config:
    enabled: false
- id: dscode-memory
  config:
    generate: false
- insert:
    - id: acp-app-startup
      name: '@deepseek-ai/dsh-acp-app'
    - id: dscode-acp
      name: ${JSON.stringify(entry)}
      config: ${JSON.stringify(options.model ? { model: options.model } : {})}
`;
}
