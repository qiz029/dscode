/**
 * The interactive terminal app's command-line provider: parses `--resume`,
 * `--continue`, `--session`, `--mode`, `--theme`, `--image`, an optional
 * initial prompt, and `--help`, then
 * publishes {@link TUI_STARTUP_SERVICE} for the runner to consume lazily.
 * Follows the headless bundle's startup shape (a commander action publishing
 * a service through {@link parseCmdline}).
 *
 * Semantics:
 * - `--resume <id|prefix>` — continue the persisted session whose id or unique
 *   id-prefix matches; the TUI replays its transcript and appends to the same
 *   durable log.
 * - `--continue` / `-c` — resume the most recently modified persisted session
 *   whose project directory matches the current working directory.
 * - `--session <id>` — create a new session under an explicit identity (the
 *   id must not exist yet).
 * - `--theme <dark|light|prismatic|rainbow|auto>` — the color palette; auto follows the
 *   terminal (dark fallback until OSC-11 detection lands).
 * - no flags — a fresh session with a minted id.
 *
 * @module @deepseek-ai/dsh-tui/startup
 */

import { Command, Option } from 'commander'
import { requireDscodePreset } from './dscode/preset.ts'
import type { Context } from '@deepseek-ai/cordis'
import { parseCmdline } from '@deepseek-ai/dsh-cmdline'
import { THEME_NAMES, type ThemeName } from './theme.ts'

/** Stable Cordis plugin name. */
export const name = 'tui-startup'

/** Services required before the invocation can be resolved. */
export const inject = ['cmdlineArgs']

/** Service provided by this plugin and injected by the terminal runner. */
const TUI_STARTUP_SERVICE = 'tuiStartup'

/** How the runner obtains its session identity. */
export type TuiStartup =
  | ({ readonly kind: 'fresh'; readonly mode?: string } & TuiStartupInput)
  | ({ readonly kind: 'named'; readonly sessionId: string; readonly mode?: string } & TuiStartupInput)
  | ({ readonly kind: 'resume'; readonly sessionId: string } & TuiStartupInput)
  | ({ readonly kind: 'latest' } & TuiStartupInput)

interface TuiStartupInput {
  readonly theme?: ThemeName
  readonly prompt?: string
  readonly images?: readonly string[]
}

export interface TuiStartupOptions {
  readonly resume?: string
  readonly continue?: boolean
  readonly session?: string
  readonly mode?: string
  readonly theme?: ThemeName
  readonly prompt?: string
  readonly images?: readonly string[]
}

/** Pure option policy shared by Commander and tests. */
export function resolveTuiStartup(options: TuiStartupOptions): TuiStartup {
  const selected = [options.resume !== undefined, options.continue === true, options.session !== undefined]
  if (selected.filter(Boolean).length > 1) throw new Error('--resume, --continue, and --session are mutually exclusive')
  if (options.session === '') throw new Error('--session needs an id')
  if (options.resume === '') throw new Error('--resume needs a session id or id prefix')
  requireDscodePreset(options.mode)
  if (options.mode !== undefined && (options.resume !== undefined || options.continue === true)) {
    throw new Error('--mode applies only to a new session; it cannot be combined with --resume or --continue')
  }
  if (options.theme !== undefined && !THEME_NAMES.includes(options.theme)) {
    throw new Error(`--theme must be one of: ${THEME_NAMES.join(', ')}`)
  }
  const input = {
    ...(options.theme === undefined ? {} : { theme: options.theme }),
    ...(options.prompt === undefined || options.prompt.trim() === '' ? {} : { prompt: options.prompt.trim() }),
    ...(options.images === undefined || options.images.length === 0 ? {} : { images: [...options.images] }),
  }
  return options.resume !== undefined
    ? { kind: 'resume', sessionId: options.resume, ...input }
    : options.continue === true
      ? { kind: 'latest', ...input }
      : options.session !== undefined
        ? { kind: 'named', sessionId: options.session, ...options.mode === undefined ? {} : { mode: options.mode }, ...input }
        : { kind: 'fresh', ...options.mode === undefined ? {} : { mode: options.mode }, ...input }
}

/**
 * This app's command: the launcher's flags this app owns, its description,
 * and its help text.
 * @returns a fresh program, so one process can parse more than once (tests).
 */
function tuiCommand(): Command {
  return new Command()
    .name('dsh --profile cli')
    .description('DeepSeek Harness CLI core: the interactive coding terminal.')
    .helpOption('-h, --help', 'show this help')
    .option('-r, --resume <session>', 'resume the persisted session with this id (or unique id prefix)')
    .option('-c, --continue', 'resume the most recent persisted session for this working directory')
    .option('--session <id>', 'create a new session under this explicit id')
    .addOption(new Option('--mode <preset>', 'compatibility flag; only dscode is accepted').hideHelp())
    .option('--theme <name>', 'color theme: dark (default), light, prismatic, rainbow, or auto')
    .option('-i, --image <path>', 'attach an image to the initial prompt (repeatable)', (path, paths: string[]) => [...paths, path], [])
    .argument('[prompt...]', 'initial prompt; sends immediately after startup')
    .addHelpText('after', `
Examples:
  dsh --profile cli                       fresh session, minted id
  dsh --profile cli --resume abc123       resume session by id prefix
  dsh --profile cli --continue            resume the latest local session
  dsh --profile cli --theme light         light palette for bright terminals
  dsh --profile cli "explain this repo"   start and send an initial prompt
  dsh --profile cli -i diagram.png "review this diagram"
`)
}

/**
 * Parse the invocation and publish the startup service. Mutual exclusions are
 * usage errors rejected from the action before anything is provided.
 * @param ctx - plugin context carrying the command line and exit request.
 */
export function apply(ctx: Context): void {
  const program = tuiCommand()
  program.action((prompt: string[]) => {
    const options = { ...program.opts<TuiStartupOptions>(), prompt: prompt.join(' ') }
    let startup: TuiStartup | undefined
    try {
      startup = resolveTuiStartup(options)
    } catch (error: unknown) {
      program.error(`error: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (startup === undefined) return
    ctx.provide(TUI_STARTUP_SERVICE, { startup } satisfies { startup: TuiStartup })
  })
  parseCmdline(ctx, program)
}
