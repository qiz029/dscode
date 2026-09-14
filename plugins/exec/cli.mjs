// The CLI half of `dscode exec` shared by the source checkout (scripts/exec.mjs)
// and the npm launcher: argument parsing, usage text and the headless overlay.

export const USAGE = `Usage: dscode exec [options] [prompt]
Run one prompt through the dscode agent without the TUI and print the reply.
The prompt is read from stdin when omitted or given as "-".

Options:
  --cwd DIR             workspace for the agent (default: current directory)
  --model PROVIDER/ID   model route (default: the saved default model)
  --effort LEVEL        reasoning effort the model offers: off, minimal, low, medium, high, xhigh, max or ultra
  --permission PRESET   permission preset: auto, ask, workspace-write, read-only, danger-full-access
  --approve-all         answer every approval request with allow (no human is present)
  --resume SESSION_ID   continue an existing session instead of starting a new one
  --json                emit JSON lines (session, text, tool, result) instead of plain text
  --quiet               no tool activity or session id on stderr
  --timeout SECONDS     give up after this many seconds (exit code 124)
  --patch FILE          extra dsh composition overlay (repeatable)
  -h, --help            show this help

Exit codes: 0 completed, 1 model or runtime error, 2 output-token ceiling, 130 aborted, 124 timeout.`;

export function parseExecArgs(argv) {
  const options = { prompt: '', cwd: undefined, model: undefined, effort: undefined, permission: undefined, approveAll: false, resume: undefined, json: false, quiet: false, timeoutMs: 0, patches: [], help: false };
  const words = [];
  const take = (flag, index) => { const value = argv[index + 1]; if (value === undefined) throw new Error(`${flag} requires a value`); return value; };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--') { words.push(...argv.slice(index + 1)); break; }
    switch (arg) {
      case '-h': case '--help': options.help = true; break;
      case '--cwd': options.cwd = take(arg, index++); break;
      case '--model': options.model = take(arg, index++); break;
      case '--effort': options.effort = take(arg, index++); break;
      case '--permission': options.permission = take(arg, index++); break;
      case '--approve-all': options.approveAll = true; break;
      case '--resume': options.resume = take(arg, index++); break;
      case '--json': options.json = true; break;
      case '--quiet': options.quiet = true; break;
      case '--timeout': { const seconds = Number(take(arg, index++)); if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('--timeout expects a positive number of seconds'); options.timeoutMs = Math.round(seconds * 1000); break; }
      case '--patch': options.patches.push(take(arg, index++)); break;
      default:
        if (arg.startsWith('-') && arg !== '-') throw new Error(`Unknown option: ${arg}\n${USAGE}`);
        words.push(arg);
    }
  }
  // Only the level name is checked here; the Host checks it against the model. This file ships alone in the launcher, so the names are inlined.
  if (options.effort !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(options.effort)) throw new Error('--effort expects off, minimal, low, medium, high, xhigh, max or ultra');
  if (options.model !== undefined && !/^[^/]+\/.+$/.test(options.model)) throw new Error('--model expects provider/model');
  options.prompt = words.join(' ');
  return options;
}

/** The overlay that turns the TUI profile into a headless one-shot Host. */
export function execOverlay(pluginPath) {
  return `- id: tui-startup\n  disabled: true\n- id: tui-runner\n  disabled: true\n- id: dscode-session-cards\n  config:\n    enabled: false\n- insert:\n    - id: dscode-exec\n      name: ${JSON.stringify(pluginPath)}\n`;
}

export async function readStream(stream) {
  let text = '';
  stream.setEncoding('utf8');
  for await (const chunk of stream) text += chunk;
  return text;
}
