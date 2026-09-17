/**
 * The rainbow theme's per-launch roll: a seeded shuffle over a twelve-color
 * bright-tier spectrum that fills every palette role, the status-bar tone map
 * (adjacent tones in canonical on-screen order never share a color, the
 * row1/row2 boundary included), the panel accent ring, and full-spectrum
 * flow anchors with a random phase. The roll happens once per launch and
 * stays stable for the whole run; setting RAINBOW_SEED=<uint32> pins it for
 * reproduction (the /theme notification prints the seed of the current roll).
 *
 * All pool colors clear AA body text (≥4.5:1) on a black terminal by a wide
 * margin (11-17:1); diff rows pair a bright hue with its own 22% dark tint
 * so the foreground stays 7.7-10.2:1 on its background.
 *
 * @module @deepseek-ai/dsh-tui/rainbow
 */

import type { StatusTone } from './render/status.ts'
import type { RgbTriple, ThemePalette } from './theme.ts'

/**
 * The bright-tier spectrum: twelve Tailwind *-300 hues covering red through
 * fuchsia, every one ≥11:1 on black. The roll samples this pool by shuffle;
 * nothing outside it is ever painted.
 */
export const RAINBOW_POOL: readonly RgbTriple[] = [
  [252, 165, 165],
  [253, 186, 116],
  [253, 230, 138],
  [253, 224, 71],
  [190, 242, 100],
  [134, 239, 172],
  [94, 234, 212],
  [103, 232, 249],
  [125, 211, 252],
  [147, 197, 253],
  [196, 181, 253],
  [240, 171, 252],
]

/**
 * Status tones in canonical on-screen order (row one left-to-right, then row
 * two): consecutive entries here are the pairs the "adjacent spans differ"
 * guarantee covers, including the accent→value step across the row boundary.
 */
const TONE_ORDER: readonly StatusTone[] = [
  'live', 'model', 'path', 'branch', 'accent',
  'value', 'label', 'meta', 'ctxFill', 'success', 'plan', 'warn', 'error',
]

/** One per-launch carnival roll: everything the rainbow theme paints from. */
export interface RainbowRoll {
  /** The seed this roll came from (print it to reproduce). */
  readonly seed: number
  /** The full 15-token palette for this launch. */
  readonly palette: ThemePalette
  /** The four-color panel ring (random order and start). */
  readonly ring: readonly RgbTriple[]
  /** Status-tone → color: adjacent tones in {@link TONE_ORDER} never match. */
  readonly toneColors: Readonly<Record<StatusTone, RgbTriple>>
  /** Full-spectrum flow anchors in hue order (a different subset every launch). */
  readonly flowAnchors: readonly RgbTriple[]
  /** Random phase offset into the flow lap, milliseconds. */
  readonly flowPhaseMs: number
}

/** Parse a RAINBOW_SEED value: a non-negative decimal uint32, else nothing. */
export function parseRainbowSeed(value: string | undefined): number | undefined {
  if (value === undefined || !/^\d{1,10}$/.test(value.trim())) return undefined
  const parsed = Number(value.trim())
  return Number.isSafeInteger(parsed) ? parsed >>> 0 : undefined
}

/**
 * One parsed `/rainbow` argument: empty means a fresh random roll; a
 * decimal uint32 pins that seed; anything else is a usage error.
 * @param argument - the raw text after `/rainbow`.
 * @returns `{ seed }`, `'random'`, or `'usage'`.
 */
export function parseRainbowArgument(argument: string): { seed: number } | 'random' | 'usage' {
  const trimmed = argument.trim()
  if (trimmed === '') return 'random'
  const parsed = parseRainbowSeed(trimmed)
  return parsed === undefined ? 'usage' : { seed: parsed }
}

/** Deterministic 32-bit RNG (mulberry32) — one roll, one stream. */
function mulberry32(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Fisher–Yates shuffle over a copy, driven by the roll's RNG. */
function shuffle<T>(items: readonly T[], rng: () => number): T[] {
  const out = [...items]
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

/** Approximate HSL hue of one RGB triple, degrees in [0, 360). */
function hueOf([r, g, b]: RgbTriple): number {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  if (max === min) return 0
  const span = max - min
  if (max === r) return (60 * (g - b) / span + 360) % 360
  if (max === g) return (60 * (b - r) / span + 120) % 360
  return (60 * (r - g) / span + 240) % 360
}

/** A dark row tint for diff backgrounds: the hue at 22% strength over black. */
function darkTint(hue: RgbTriple): RgbTriple {
  return [Math.round(hue[0] * 0.22), Math.round(hue[1] * 0.22), Math.round(hue[2] * 0.22)]
}

/** Readability anchors shared by every roll: captions, text, band stay calm. */
const DIM: RgbTriple = [166, 163, 184]
const TEXT: RgbTriple = [240, 238, 249]
const BAND: RgbTriple = [46, 46, 52]

/**
 * Build the roll for one seed: pure and deterministic, so tests pin exact
 * outcomes and RAINBOW_SEED reproduces a lucky launch exactly.
 * @param seed - the uint32 seed to roll from.
 * @returns the complete carnival roll.
 */
export function rollRainbow(seed: number): RainbowRoll {
  const rng = mulberry32(seed)
  const pool = shuffle(RAINBOW_POOL, rng)
  const [brand, brandBright, brandMid, brandDeep, code, success, error, warn, addHue, delHue] = pool
  const palette: ThemePalette = {
    brand: brand,
    brandBright: brandBright,
    brandMid: brandMid,
    brandDeep: brandDeep,
    dim: DIM,
    success: success,
    error: error,
    warn: warn,
    text: TEXT,
    code: code,
    composerBand: BAND,
    diffAdd: darkTint(addHue),
    diffDel: darkTint(delHue),
    diffAddFg: addHue,
    diffDelFg: delHue,
    // Prompt-row bars ride the roll's own colors: the bright brand hue for an
    // ordinary prompt, the rolled warning hue for a queued one, and the rolled
    // code hue for a steered one. Each bar is that color over the surface.
    surface: [0, 0, 0],
    prompt: brandBright,
    queued: warn,
    steered: code,
  }
  const ring = shuffle(RAINBOW_POOL, rng).slice(0, 4)
  // Adjacency by construction: consecutive tones take consecutive slots of a
  // 12-distinct shuffle, so neighbors can never match (13 tones wrap the
  // first color onto 'error', which is never adjacent to 'live' on screen).
  const offset = Math.floor(rng() * RAINBOW_POOL.length)
  const toneColors = {} as Record<StatusTone, RgbTriple>
  TONE_ORDER.forEach((tone, index) => {
    toneColors[tone] = pool[(offset + index) % pool.length]!
  })
  const flowAnchors = [...RAINBOW_POOL].sort((a, b) => hueOf(a) - hueOf(b))
  const flowPhaseMs = Math.floor(rng() * 2400)
  return { seed, palette, ring, toneColors, flowAnchors, flowPhaseMs }
}

/** The launch seed: RAINBOW_SEED when parseable, else a fresh random roll. */
function launchSeed(): number {
  const pinned = parseRainbowSeed(process.env.RAINBOW_SEED)
  if (pinned !== undefined) return pinned
  return (Date.now() ^ Math.floor(Math.random() * 0x100000000)) >>> 0
}

let rolled: RainbowRoll | undefined

/** The memoized per-launch roll; computed once, stable for the whole run. */
export function rainbowRoll(): RainbowRoll {
  if (rolled === undefined) rolled = rollRainbow(launchSeed())
  return rolled
}

/**
 * Replace the memoized roll: omit the seed for a fresh random one, or pass
 * a uint32 to pin it. `/rainbow` uses this so a mid-session reroll actually
 * recolors; {@link setTheme}(`'rainbow'`) must run afterwards so the
 * palette accessor picks the new values up.
 * @param seed - the seed to pin, or undefined for a new random roll.
 * @returns the roll now in force.
 */
export function rerollRainbow(seed?: number): RainbowRoll {
  const next = seed ?? ((Date.now() ^ Math.floor(Math.random() * 0x100000000)) >>> 0)
  rolled = rollRainbow(next)
  return rolled
}

/** The current roll's seed as display copy (also the RAINBOW_SEED value). */
export function rainbowSeedLabel(): string {
  return String(rainbowRoll().seed)
}
