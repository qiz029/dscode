/**
 * Terminal color tokens for the dsh TUI, mapped from the product design
 * platform's DeepSeek palette
 * (`packages/client/ui-theme/src/styles/design-platform.css`). Truecolor RGB
 * rides chalk, which degrades automatically on terminals without truecolor.
 *
 * Three palettes — `dark` (the default), `light`, and `prismatic` (the
 * neon synthwave skin) — share the same token keys with different values.
 * Painters and the palette accessor read the ACTIVE
 * palette selected through {@link setTheme}, so a theme switch recolors every
 * painted surface on the next render without touching call sites; consumers
 * read colors through {@link getPalette} or the painters below only.
 *
 * @module @deepseek-ai/dsh-tui/theme
 */

import chalk from 'chalk'

import { rainbowRoll } from './rainbow.ts'

/** One RGB triple for a palette token. */
export type RgbTriple = readonly [number, number, number]

/** Palette token keys shared by every theme. */
export type ThemeToken =
  | 'brand'
  | 'brandBright'
  | 'brandMid'
  | 'brandDeep'
  | 'dim'
  | 'success'
  | 'error'
  | 'warn'
  | 'text'
  | 'code'
  | 'composerBand'
  | 'diffAdd'
  | 'diffDel'
  | 'diffAddFg'
  | 'diffDelFg'
  | 'surface'
  | 'prompt'
  | 'queued'
  | 'steered'

/** One full color palette: every token key mapped to an RGB triple. */
export type ThemePalette = Readonly<Record<ThemeToken, RgbTriple>>

/** Selectable theme names: dark, light, prismatic, rainbow, or auto (terminal-sensed). */
export type ThemeName = 'dark' | 'light' | 'prismatic' | 'rainbow' | 'auto'

/** Valid theme names in canonical picker order. */
export const THEME_NAMES: readonly ThemeName[] = ['dark', 'light', 'prismatic', 'rainbow', 'auto']

/** One /theme picker row: the theme id plus its display copy. */
export interface ThemeDescriptor {
  /** The selectable theme name. */
  readonly id: ThemeName
  /** Short row label shown in the picker. */
  readonly label: string
  /** One-line description shown after the label. */
  readonly description: string
}

/**
 * Every theme's picker metadata in canonical order — the single source the
 * /theme panel rows derive from; {@link THEME_NAMES} stays the validation
 * list. Adding a theme means adding its palette plus one row here.
 */
export const THEMES: readonly ThemeDescriptor[] = [
  { id: 'dark', label: 'dark', description: 'DeepSeek dark palette (default)' },
  { id: 'light', label: 'light', description: 'light palette for bright terminals' },
  { id: 'prismatic', label: 'prismatic', description: 'neon synthwave palette (violet/magenta/cyan)' },
  { id: 'rainbow', label: 'rainbow', description: 'randomized carnival palette (/rainbow to reroll)' },
  { id: 'auto', label: 'auto', description: 'follow the terminal; dark until detection lands' },
]

/**
 * DeepSeek dark palette: the original TUI colors, one entry per
 * design-platform token in use. Keep names and values in sync with the CSS
 * custom properties cited inline.
 */
export const DARK_PALETTE = {
  /** Primary brand blue — `--dsw-static-deepseek-500`. */
  brand: [65, 118, 230],
  /** Brighter brand blue for live/streaming emphasis — `--dsw-static-deepseek-400`. */
  brandBright: [103, 158, 254],
  /** Intermediate brand blue between brand and brandBright — `--dsw-static-deepseek-450`. */
  brandMid: [86, 134, 254],
  /** Deep brand blue for secondary chrome — `--dsw-static-deepseek-600`. */
  brandDeep: [72, 104, 178],
  /** Muted caption gray — `--dsw-static-neutral-bluish-600`. */
  dim: [129, 133, 140],
  /** Success green — `--dsw-static-green-500`. */
  success: [34, 197, 94],
  /** Error red — `--dsw-static-red-500`. */
  error: [239, 68, 68],
  /** Warning amber — `--dsw-static-amber-500`. */
  warn: [245, 158, 11],
  /** Default foreground text — `--dsw-static-neutral-50`. */
  text: [236, 240, 246],
  /** Inline/fenced code — soft sky blue, distinct from brand accents. */
  code: [125, 211, 252],
  /** Composer three-row band base — neutral light gray, hue-free so wave tints read on it. */
  composerBand: [46, 48, 52],
  /** Diff added-line background — Codex's muted dark green tint (#213A2B). */
  diffAdd: [33, 58, 43],
  /** Diff removed-line background — Codex's muted dark red tint (#4A221D). */
  diffDel: [74, 34, 29],
  /** Diff added-line foreground — green-500, 5.4:1 on the diffAdd tint. */
  diffAddFg: [34, 197, 94],
  /** Diff removed-line foreground — red-400, 4.9:1 on the diffDel tint (error's red-500 sinks to 3.6:1 on it). */
  diffDelFg: [248, 113, 113],
  /** Terminal background this palette is designed against; row tints blend toward it. */
  surface: [0, 0, 0],
  /**
   * The three prompt-row colors, one per delivery kind. They are the palette's
   * own accents (bright brand, warning amber, violet) rather than fixed RGBs,
   * and every row's bar is these colors laid over {@link surface}.
   */
  prompt: [103, 158, 254],
  queued: [245, 158, 11],
  steered: [167, 139, 250],
} as const satisfies ThemePalette

/**
 * Light palette tuned for white terminals: the same token keys as dark with
 * contrast-driven values (AA on a white background). Brand keeps its dark
 * value (≈4.2:1 on white — reserved for bold/accent spans; body-size brand
 * text uses brandBright at ≈5.4:1); the bright/mid/deep blues, muted grays,
 * and status colors deepen so they stay legible on bright backgrounds.
 */
export const LIGHT_PALETTE = {
  /** Primary brand blue — unchanged design-platform value; ≈4.2:1 on white, so bold/accent spans only (body-size brand text uses brandBright). */
  brand: [65, 118, 230],
  /** Brighter brand blue deepened for white backgrounds (was 2.7:1). */
  brandBright: [72, 104, 178],
  /** Intermediate brand blue — Tailwind blue-500. */
  brandMid: [59, 130, 246],
  /** Deep brand blue for secondary chrome — `--dsw-static-deepseek-700`. */
  brandDeep: [47, 76, 143],
  /** Muted caption gray deepened for white backgrounds. */
  dim: [101, 103, 107],
  /** Success green — Tailwind green-700. */
  success: [21, 128, 61],
  /** Error red — Tailwind red-600. */
  error: [236, 19, 19],
  /** Warning amber — Tailwind amber-700. */
  warn: [180, 83, 9],
  /** Default foreground text — near-black. */
  text: [21, 21, 23],
  /** Inline/fenced code — Tailwind cyan-700, distinct from brand accents. */
  code: [14, 116, 144],
  /** Composer three-row band base — neutral light gray, hue-free so wave tints read on it. */
  composerBand: [229, 231, 235],
  /** Diff added-line background — GitHub's pastel green (#dafbe1), Codex's light pick. */
  diffAdd: [218, 251, 225],
  /** Diff removed-line background — GitHub's pastel red (#ffebe9), Codex's light pick. */
  diffDel: [255, 235, 233],
  /** Diff added-line foreground — green-800, 6.4:1 on the pastel tint (green-700 clears 4.5:1 by a hair). */
  diffAddFg: [22, 101, 52],
  /** Diff removed-line foreground — red-700, 5.6:1 on the pastel tint (error's red-600 is 3.9:1). */
  diffDelFg: [185, 28, 28],
  /** Terminal background this palette is designed against; row tints blend toward it. */
  surface: [255, 255, 255],
  /**
   * Prompt-row colors deepened for white: the amber and violet the dark theme
   * uses sit at the AA edge on their own pastel bars, so each kind carries a
   * value that clears 4.5:1 both on the bar and on plain white.
   */
  prompt: [47, 76, 143],
  queued: [124, 53, 10],
  steered: [109, 40, 217],
} as const satisfies ThemePalette

/**
 * Prismatic palette — the neon synthwave skin (docs/prismatic-theme-design.md):
 * electric violet replaces the brand blues, neon fuchsia carries live
 * emphasis, neon cyan paints code, and a lavender gray dims captions. Paints
 * on a black terminal; every value meets the same WCAG thresholds as the
 * other palettes (body tokens ≥4.5:1, accents ≥3:1 on pure black). Semantic
 * colors — success/error/warn and the four diff tokens — reuse the dark
 * values verbatim so green still means added and red still means removed.
 */
export const PRISMATIC_PALETTE = {
  /** Primary electric purple — violet-500 (#8B5CF6), 5.0:1 on black. */
  brand: [139, 92, 246],
  /** Live/streaming emphasis — neon fuchsia-300 (#F0ABFC), 11.9:1 on black. */
  brandBright: [240, 171, 252],
  /** Intermediate violet — violet-400 (#A78BFA), 7.7:1 on black. */
  brandMid: [167, 139, 250],
  /** Deep secondary chrome — violet-600 (#7C3AED), 3.7:1 on black (violet-700 misses 3:1). */
  brandDeep: [124, 58, 237],
  /** Muted captions — lavender gray (#A6A3B8), 8.6:1 on black. */
  dim: [166, 163, 184],
  /** Success green — unchanged from dark. */
  success: [34, 197, 94],
  /** Error red — unchanged from dark. */
  error: [239, 68, 68],
  /** Warning amber — unchanged from dark. */
  warn: [245, 158, 11],
  /** Default foreground text — white with a lavender cast (#F0EEF9). */
  text: [240, 238, 249],
  /** Inline/fenced code — neon cyan-300 (#67E8F9), 14.5:1 on black. */
  code: [103, 232, 249],
  /** Composer three-row band base — neutral dark gray, hue-free so wave tints read on it. */
  composerBand: [46, 46, 52],
  /** Diff added-line background — unchanged from dark. */
  diffAdd: [33, 58, 43],
  /** Diff removed-line background — unchanged from dark. */
  diffDel: [74, 34, 29],
  /** Diff added-line foreground — unchanged from dark. */
  diffAddFg: [34, 197, 94],
  /** Diff removed-line foreground — unchanged from dark. */
  diffDelFg: [248, 113, 113],
  /** Terminal background this palette is designed against; row tints blend toward it. */
  surface: [0, 0, 0],
  /** Prompt rows in the skin's own neon: fuchsia, amber, cyan. */
  prompt: [240, 171, 252],
  queued: [245, 158, 11],
  steered: [103, 232, 249],
} as const satisfies ThemePalette

/**
 * Every STATIC palette by theme name; auto resolves through {@link resolveTheme}
 * and rainbow is rolled per launch ({@link rainbowRoll}), so neither lives
 * here — {@link setTheme} resolves both through the same key space.
 */
export const PALETTES = {
  dark: DARK_PALETTE,
  light: LIGHT_PALETTE,
  prismatic: PRISMATIC_PALETTE,
} as const satisfies Record<Exclude<ThemeName, 'auto' | 'rainbow'>, ThemePalette>

/** The theme name in force (the requested name; 'auto' included). */
let activeName: ThemeName = 'dark'

/** The palette painters and {@link getPalette} read for the active theme. */
let activePalette: ThemePalette = DARK_PALETTE

/**
 * Resolve a theme name to the palette actually in use. `auto` detection
 * (OSC 11 terminal background query) is a later enhancement; until it lands,
 * auto falls back to the dark palette (prismatic and rainbow are always
 * explicit choices, never auto-resolved).
 * @param name - the requested theme name.
 * @returns 'dark', 'light', 'prismatic', or 'rainbow' — the palette key.
 */
export function resolveTheme(name: ThemeName): 'dark' | 'light' | 'prismatic' | 'rainbow' {
  return name === 'light' ? 'light' : name === 'prismatic' ? 'prismatic' : name === 'rainbow' ? 'rainbow' : 'dark'
}

/**
 * Switch the active theme: painters and {@link getPalette} reflect the new
 * palette from the next render onward. The default is dark, so a process
 * that never calls this paints exactly as before.
 * @param name - the theme to activate ('auto' resolves to dark for now).
 */
export function setTheme(name: ThemeName): void {
  activeName = name
  const resolved = resolveTheme(name)
  activePalette = resolved === 'rainbow' ? rainbowRoll().palette : PALETTES[resolved]
}

/**
 * The theme name in force. Returns the requested name ('auto' included) so
 * the /theme picker and persistence can round-trip the user's choice; the
 * palette actually used is {@link getPalette}.
 */
export function getTheme(): ThemeName {
  return activeName
}

/** The palette in force; theme-aware call sites read colors through it. */
export function getPalette(): ThemePalette {
  return activePalette
}

/**
 * Parse a persisted theme name: only names in {@link THEME_NAMES} survive;
 * anything else (missing, corrupt, or unknown) falls back to the dark default.
 * @param value - the raw parsed JSON value (expected string).
 * @returns a valid theme name.
 */
export function parseThemeName(value: unknown): ThemeName {
  return typeof value === 'string' && (THEME_NAMES as readonly string[]).includes(value)
    ? (value as ThemeName)
    : 'dark'
}

/** Ink `color` string for one RGB triple. */
export function inkColor(triple: RgbTriple): string {
  return `rgb(${triple[0]}, ${triple[1]}, ${triple[2]})`
}

/**
 * Diff-line background as an Ink `backgroundColor` string, theme-aware and
 * depth-gated (the Codex diff renderer's rule): 16-color terminals paint
 * backgrounds from the saturated system palette, which drowns the text, so
 * they keep the foreground-only look; 256-color and truecolor terminals get
 * the palette's tint (chalk quantizes the RGB form down automatically).
 * @param token - which diff background, added or removed lines.
 * @returns the Ink background color, or undefined to paint foreground-only.
 */
export function diffBackground(token: 'diffAdd' | 'diffDel'): string | undefined {
  if (chalk.level < 2) return undefined
  return inkColor(activePalette[token])
}

/** One prompt-row color: the palette token whose color paints the row. */
export interface PromptRowTokens {
  readonly fg: 'prompt' | 'queued' | 'steered'
}

/** How far one prompt-row tint leans toward its color, over the surface. */
const PROMPT_ROW_TINT = 0.22

/**
 * The color family one prompt row wears, chosen by how it was delivered: the
 * ordinary brand accent, the warning amber for a queued prompt, and the
 * palette's own third accent for a steered one. The bar behind it is derived
 * from that same color, so every theme — including a freshly rolled rainbow —
 * carries its own look instead of a fixed triple.
 * @param delivery - how the prompt was delivered; undefined is an ordinary one.
 * @returns the palette token whose color paints the row.
 */
export function promptRowTokens(delivery: 'queued' | 'steered' | undefined): PromptRowTokens {
  if (delivery === 'queued') return { fg: 'queued' }
  if (delivery === 'steered') return { fg: 'steered' }
  return { fg: 'prompt' }
}

/**
 * Blended prompt-row background for one row color: the palette color laid
 * over the surface the palette is designed for (dark themes over black, light
 * over white), depth-gated exactly like {@link diffBackground} — a 16-color
 * terminal keeps the foreground-only look rather than painting a saturated
 * system background behind the text.
 * @param color - the row's palette token.
 * @returns the Ink background color, or undefined to paint foreground-only.
 */
export function rowBackground(color: PromptRowTokens['fg']): string | undefined {
  if (chalk.level < 2) return undefined
  const surface = activePalette.surface
  const tint = activePalette[color]
  const blend = (index: number): number =>
    Math.round(surface[index] + (tint[index] - surface[index]) * PROMPT_ROW_TINT)
  return inkColor([blend(0), blend(1), blend(2)] as RgbTriple)
}

/**
 * The prismatic surface ring: four neon accents panels cycle through by
 * mount order (cyan → fuchsia → violet → lime), all ≥3:1 on black. Dark and
 * light ignore the ring — {@link surfaceAccent} falls back to the passed-in
 * base color so those themes stay pixel-identical.
 */
export const ACCENT_RING: readonly RgbTriple[] = [
  [34, 211, 238],
  [232, 121, 249],
  [167, 139, 250],
  [163, 230, 53],
]

/**
 * The prismatic flow anchors: brand violet → neon fuchsia → neon cyan. All
 * three clear 4.5:1 on black, so a flowing foreground stays AA throughout
 * the oscillation (render/animations.ts walks the triangle).
 */
export const FLOW_ANCHORS: readonly RgbTriple[] = [
  [139, 92, 246],
  [232, 121, 249],
  [34, 211, 238],
]

/**
 * Whether the active theme is prismatic (the neon skin with surface rings
 * and flowing accents).
 */
export function isPrismatic(): boolean {
  return activeName === 'prismatic'
}

/** Whether the active theme is rainbow (the per-launch carnival roll). */
export function isRainbow(): boolean {
  return activeName === 'rainbow'
}

/** The active theme's flow walk, if it has one (anchors plus phase offset). */
export interface ThemeFlow {
  /** Anchor colors walked in order over one 2.4s lap. */
  readonly anchors: readonly RgbTriple[]
  /** Phase offset into the lap, milliseconds (0 for prismatic). */
  readonly phaseMs: number
}

/**
 * The flowing theme's anchor walk: prismatic rides the fixed violet→fuchsia→
 * cyan triangle; rainbow rides its rolled full-spectrum anchors with a random
 * phase; dark and light have no flow (undefined) and keep static accents.
 */
export function themeFlow(): ThemeFlow | undefined {
  if (isPrismatic()) return { anchors: FLOW_ANCHORS, phaseMs: 0 }
  if (isRainbow()) {
    const roll = rainbowRoll()
    return { anchors: roll.flowAnchors, phaseMs: roll.flowPhaseMs }
  }
  return undefined
}

/**
 * The accent for one surface slot: prismatic rotates the {@link ACCENT_RING}
 * by slot index; every other theme gets the caller's base color back.
 * @param index - the slot's position in the mount-order sequence.
 * @param base - the color to use outside prismatic (the surface's usual one).
 * @returns the accent to paint the surface's border/title with.
 */
export function surfaceAccent(index: number, base: RgbTriple): RgbTriple {
  if (isPrismatic()) {
    const ring = ACCENT_RING
    return ring[((index % ring.length) + ring.length) % ring.length]
  }
  if (isRainbow()) {
    const ring = rainbowRoll().ring
    return ring[((index % ring.length) + ring.length) % ring.length]
  }
  return base
}

/** Paint with the primary brand blue: whale, wordmark, tool names, accents. */
export function brand(text: string): string {
  return chalk.rgb(...activePalette.brand)(text)
}

/** Paint with the bright brand blue: streaming output and active spinners. */
export function brandBright(text: string): string {
  return chalk.rgb(...activePalette.brandBright)(text)
}

/** Paint with the deep brand blue: borders and secondary chrome. */
export function brandDeep(text: string): string {
  return chalk.rgb(...activePalette.brandDeep)(text)
}

/** Paint muted captions, hints, and meta lines. */
export function dim(text: string): string {
  return chalk.rgb(...activePalette.dim)(text)
}

/** Paint completed tool results and confirmations. */
export function success(text: string): string {
  return chalk.rgb(...activePalette.success)(text)
}

/** Paint failures and error entries. */
export function error(text: string): string {
  return chalk.rgb(...activePalette.error)(text)
}

/** Paint warnings. */
export function warn(text: string): string {
  return chalk.rgb(...activePalette.warn)(text)
}
