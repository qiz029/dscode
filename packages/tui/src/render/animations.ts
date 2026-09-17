/**
 * Terminal animation helpers derived from the web design language:
 * thinking uses Codex's slow shimmer sweep, the busy composer marker uses the
 * original braille chase, and the streaming caret blink is the Claude-Code
 * convention.
 *
 * The DeepSeek model-switch easter egg ports Codex's effort-ignition "Wave"
 * style (`codex-rs/tui/src/bottom_pane/effort_ignition_styles.rs`): switching
 * INTO an official DeepSeek route sweeps a blue wave across the composer's
 * input row — one column per cell, `backgroundColor` = the sampled wave
 * color — then, on the deepseek (Ultra-equivalent) tier, drops the `· ✦ ✧`
 * sparkle sequence into the rightmost blank cell before fading. The prompt
 * marker keeps the tier accent afterwards (persistent, like Codex's prompt
 * charge). Pure functions only — the Ink layer owns timers and colors.
 *
 * Wave and Pulse deliberately extend the Codex port after in-terminal
 * testing: the per-row phase cascade was removed (Codex tints each column
 * across the whole band), Wave became a WATER SURFACE — one continuous sine
 * swell spanning the band, mirror-symmetric about the center column, its
 * crests flowing outward from the center with a symmetric fade envelope
 * (the deepseek tier adds one faster harmonic crossing it), painted with
 * Aurora's recipe: wide soft gradients, mirrored second-hue mixing, and a
 * low alpha cap — no hard core line — while Pulse became true
 * two-dimensional, cell-aspect-corrected detonations: soft wide rings whose
 * color grades across their width, expanding outward through a symmetric
 * fade envelope and each trailing an echo ripple in the next blue. Aurora
 * keeps Codex's geometry verbatim.
 *
 * @module @deepseek-ai/dsh-code/render/animations
 */

import type { RgbTriple } from '../theme.ts'

/** Cadence for the original busy braille chase (8 frames × 125ms = 1s). */
export const BUSY_CHASE_TICK_MS = 125

/** Original terminal StateDot chase frames. */
export const BUSY_CHASE_FRAMES = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'] as const

/** Chase frame for a monotonic tick. */
export function busyChaseFrame(tick: number): string {
  return BUSY_CHASE_FRAMES[tick % BUSY_CHASE_FRAMES.length] ?? BUSY_CHASE_FRAMES[0]
}

/** Clock cadence for the Codex-style Deep diving shimmer. */
export const DEEP_DIVING_SHIMMER_TICK_MS = 33

/** Codex shimmer timing and geometry. */
export const DEEP_DIVING_SHIMMER_DURATION_MS = 2_000
export const DEEP_DIVING_SHIMMER_PADDING = 10
export const DEEP_DIVING_SHIMMER_HALF_WIDTH = 5
export const DEEP_DIVING_SPARK_BREATH_DURATION_MS = 2_000

/**
 * Codex's 2-second shimmer sweep, expressed in terminal ticks. The sweep has
 * ten virtual columns of padding on either side and a five-column cosine
 * highlight band, so the text changes gently rather than cycling rapidly.
 */
export function deepDivingShimmerIntensity(index: number, tick: number, graphemeCount: number): number {
  if (graphemeCount <= 0) return 0
  const period = graphemeCount + DEEP_DIVING_SHIMMER_PADDING * 2
  const elapsed = ((tick * DEEP_DIVING_SHIMMER_TICK_MS) % DEEP_DIVING_SHIMMER_DURATION_MS + DEEP_DIVING_SHIMMER_DURATION_MS) % DEEP_DIVING_SHIMMER_DURATION_MS
  const position = elapsed / DEEP_DIVING_SHIMMER_DURATION_MS * period
  const distance = Math.abs(index + DEEP_DIVING_SHIMMER_PADDING - position)
  if (distance > DEEP_DIVING_SHIMMER_HALF_WIDTH) return 0
  const angle = Math.PI * distance / DEEP_DIVING_SHIMMER_HALF_WIDTH
  return 0.5 * (1 + Math.cos(angle))
}

/** Blue RGB color for one grapheme in the Codex-style shimmer. */
export function deepDivingGradientColor(
  index: number,
  tick: number,
  graphemeCount: number,
  base: RgbTriple,
  highlight: RgbTriple,
): RgbTriple {
  return blendRgb(highlight, base, deepDivingShimmerIntensity(index, tick, graphemeCount))
}

/** Smooth breathing intensity for the always-visible Deep diving sparkle. */
export function deepDivingSparkIntensity(tick: number): number {
  const elapsed = ((tick * DEEP_DIVING_SHIMMER_TICK_MS) % DEEP_DIVING_SPARK_BREATH_DURATION_MS
    + DEEP_DIVING_SPARK_BREATH_DURATION_MS) % DEEP_DIVING_SPARK_BREATH_DURATION_MS
  const phase = elapsed / DEEP_DIVING_SPARK_BREATH_DURATION_MS
  return 0.2 + 0.8 * (0.5 + 0.5 * Math.cos(Math.PI * 2 * phase))
}

/** Blue RGB color for the breathing Deep diving sparkle. */
export function deepDivingSparkColor(tick: number, base: RgbTriple, highlight: RgbTriple): RgbTriple {
  return blendRgb(highlight, base, deepDivingSparkIntensity(tick))
}

/** One full prismatic flow lap — lively: violet → fuchsia → cyan → violet in 2.4s. */
export const FLOW_PERIOD_MS = 2_400

/**
 * The prismatic flow color at one elapsed-time sample: a smoothstep walk
 * around the anchor triangle, one full lap per {@link FLOW_PERIOD_MS}. Pure —
 * the Ink layer owns the timer and passes its tick scaled by its own cadence
 * (tick × tickMs). Callers gate on the animations preference and fall back to
 * a static palette color when animation is off.
 * @param elapsedMs - milliseconds since the flow started (any sign or size).
 * @param anchors - the colors to walk, in order (theme.ts FLOW_ANCHORS).
 * @returns the interpolated anchor color at this instant.
 */
export function flowColor(elapsedMs: number, anchors: readonly RgbTriple[]): RgbTriple {
  if (anchors.length === 0) throw new Error('flowColor needs at least one anchor')
  if (anchors.length === 1) return anchors[0]
  const lap = ((elapsedMs % FLOW_PERIOD_MS) + FLOW_PERIOD_MS) % FLOW_PERIOD_MS
  const span = FLOW_PERIOD_MS / anchors.length
  const at = lap / span
  const index = Math.floor(at)
  const phase = at - index
  const eased = phase * phase * (3 - 2 * phase)
  return blendRgb(anchors[(index + 1) % anchors.length], anchors[index % anchors.length], eased)
}

/** Caret blink cadence: one blink step (on or off) per tick. */
export const CARET_BLINK_TICK_MS = 530

/** Caret visibility: half the ticks on, half off (530ms blink). */
export function caretVisible(tick: number): boolean {
  return tick % 2 === 0
}

/**
 * The one-shot DeepSeek model-switch easter egg: when the status bar model
 * label switches to an official DeepSeek route, the composer's input row
 * plays Codex's effort-ignition "Wave" — a blue crest sweeping the content
 * row column by column (background tint ≤ 0.55 under the draft), plus the
 * Ultra-style `· ✦ ✧` sparkles on the deepseek tier — and the prompt marker
 * keeps the tier accent afterwards. The Ink layer owns the timer and reads
 * the ACTIVE palette anchors (`getPalette`); everything below is pure
 * interpolation over the colors it is given.
 */

/** Frame cadence of the DeepSeek wave: Codex's IGNITION_FRAME_TICK (33ms ≈ 30fps). */
export const DEEPSEEK_WAVE_TICK_MS = 33

/**
 * The DeepSeek wave tiers. The concept maps Codex's reasoning tiers to
 * model ids: `flash` runs the Max parameters, `deepseek` (pro models) runs
 * the Ultra parameters (dual band + tail sparkles on the Wave style).
 * `unknown` is the "Into the Unknown" variant: it reuses the deepseek tier's
 * exact parameters (dual band, durations, sparkles) for NON-DeepSeek models
 * running a reasoning effort above high — the wordmark renders differently
 * but the motion is identical.
 */
export type DeepseekWaveTier = 'flash' | 'deepseek' | 'unknown'

/**
 * The three ignition styles — Codex `IgnitionStyle`: a traveling crest
 * (Wave), a drifting multi-hue band (Aurora), and an expanding ring (Pulse).
 * One style is picked at random per trigger and never repeats the previous.
 */
export type DeepseekWaveStyle = 'wave' | 'aurora' | 'pulse'

/** All styles in canonical order, for random selection. */
const DEEPSEEK_WAVE_STYLES: readonly DeepseekWaveStyle[] = ['wave', 'aurora', 'pulse']

/**
 * The water surface: ONE continuous sine line spanning the whole band,
 * mirror-symmetric about the center column, its crests flowing OUTWARD from
 * the center (phase k·|x − center| − ω·t). No sweep window, no return trip —
 * the surface fades in, flows, and fades out, symmetric in both space and
 * time. The deepseek tier adds one faster, finer HARMONIC line whose crests
 * cross the fundamental's: interleaved richness with both lines still
 * symmetric and still only ever flowing outward.
 */
export const WAVE_SURFACE_AMPLITUDE = 0.8
export const WAVE_SURFACE_HARMONIC = 0.45
export const WAVE_SURFACE_WAVELENGTH = 40
export const WAVE_SURFACE_OMEGA = 9
/** Vertical thickness in lane units — Aurora-wide: soft gradients, no hard edges. */
export const WAVE_SURFACE_THICKNESS = 1.2
/**
 * The mirrored second-hue profile: the space BELOW the surface carries a
 * second blue at this strength, so color (not just brightness) varies
 * continuously across the wave — Aurora-style hue mixing instead of a
 * single flat tint.
 */
export const WAVE_SURFACE_MIRROR = 0.6
/** Aurora-style soft alpha: low gain, capped well under the pulse ring's. */
export const WAVE_SURFACE_ALPHA_GAIN = 0.45
export const WAVE_SURFACE_ALPHA_CAP = 0.68

/**
 * Pulse ring geometry, softened to the Wave standard: a WIDE band
 * (half-width 5.5) with a moderate peak riding the radius — all inside the
 * hue blend, no hard white line — and an inner profile one hue over at a
 * slightly smaller radius, so the ring's color grades continuously across
 * its width (the radial analog of the water surface's mirrored hues).
 */
const PULSE_HALF_WIDTH = 5.5
const PULSE_PEAK_HALF_WIDTH = 1.8
const PULSE_PEAK_GAIN = 0.35
const PULSE_INNER_OFFSET = 2.5
const PULSE_INNER_STRENGTH = 0.6
/** The inner edge of each ring carries the tier's third blue. */
const PULSE_INNER_HUE = 2

/**
 * The trailing echo ripple: every pulse ring drags a second, weaker ring at
 * a fraction of its radius in the NEXT hue of the tier's blues, fading in a
 * little after the primary so the center hole opens first.
 */
const PULSE_ECHO_RADIUS = 0.7
const PULSE_ECHO_STRENGTH = 0.65
const PULSE_ECHO_DELAY = 0.12

/** Aurora-grade soft alpha for the detonation — a notch above the swell. */
export const PULSE_ALPHA_GAIN = 0.45
export const PULSE_ALPHA_CAP = 0.72

/**
 * Terminal cell aspect (row height ÷ column width, ≈2.2 for common fonts).
 * A ring computed in raw cell units looks vertically squashed; weighting row
 * distance by the aspect makes the Pulse ring appear circular on screen.
 */
const PULSE_ROW_ASPECT = 2.2

/** Sparkle start and frame cadence — Codex SPARK_START / SPARK_FRAME. */
const SPARK_START_MS = 900
const SPARK_FRAME_MS = 100

/** Sparkle glyphs in frame order — Codex SPARK_GLYPHS (`· ✦ ✧`). */
export const SPARK_GLYPHS = ['·', '✦', '✧'] as const

/**
 * Band tables — Codex `bands(style, tier)`. Each entry is a triple whose
 * meaning depends on the style: Wave/Pulse use `(launch, travel, strength)`;
 * Aurora uses `(speed, phase, hueIndex)`.
 */
export type DeepseekWaveBand = readonly [number, number, number]
export const DEEPSEEK_WAVE_BANDS: Readonly<Record<DeepseekWaveStyle, Readonly<Record<DeepseekWaveTier, readonly DeepseekWaveBand[]>>>> = {
  wave: {
    // Wave-Max: one band sweeping 0.10s..0.85s.
    flash: [[0.10, 0.75, 1.0]],
    // Wave-Ultra: two offset bands for a richer crest.
    deepseek: [[0.10, 0.70, 1.0], [0.35, 0.55, 1.0]],
    // Into the Unknown reuses the Ultra parameters verbatim.
    unknown: [[0.10, 0.70, 1.0], [0.35, 0.55, 1.0]],
  },
  aurora: {
    // Aurora-Max: two drifting bands (hues 0 and 1).
    flash: [[0.35, 0.15, 0.0], [-0.50, 0.60, 1.0]],
    // Aurora-Ultra: a third band adds hue 2.
    deepseek: [[0.35, 0.15, 0.0], [-0.50, 0.60, 1.0], [0.75, 0.35, 2.0]],
    unknown: [[0.35, 0.15, 0.0], [-0.50, 0.60, 1.0], [0.75, 0.35, 2.0]],
  },
  pulse: {
    // Pulse-Max: one expanding ring.
    flash: [[0.10, 0.60, 1.0]],
    // Pulse-Ultra: two rings (inner weaker, outer stronger).
    deepseek: [[0.10, 0.55, 0.8], [0.45, 0.55, 1.1]],
    unknown: [[0.10, 0.55, 0.8], [0.45, 0.55, 1.1]],
  },
}

/** Extra display time applied to every Codex ignition style. */
const DEEPSEEK_WAVE_DURATION_EXTENSION_MS = 200

/** Original Codex duration used as the animation's sampling timeline. */
function deepseekWaveBaseDuration(tier: DeepseekWaveTier, style: DeepseekWaveStyle): number {
  // The unknown tier reuses the deepseek (pro) durations exactly.
  const pro = tier === 'deepseek' || tier === 'unknown'
  switch (style) {
    case 'aurora': return pro ? 1600 : 1300
    case 'pulse': return pro ? 1250 : 900
    case 'wave': return pro ? 1300 : 1000
  }
}

/**
 * Total visible duration: the Codex ignition duration plus 200ms so its motion
 * remains readable in a busy terminal.
 * @param tier - the active wave tier.
 * @param style - the active ignition style.
 * @returns the duration in milliseconds.
 */
export function deepseekWaveDuration(tier: DeepseekWaveTier, style: DeepseekWaveStyle = 'wave'): number {
  return deepseekWaveBaseDuration(tier, style) + DEEPSEEK_WAVE_DURATION_EXTENSION_MS
}

/** Map the extended display timeline back onto the original Codex samples. */
function deepseekWaveSampleElapsedMs(tick: number, tier: DeepseekWaveTier, style: DeepseekWaveStyle): number {
  const base = deepseekWaveBaseDuration(tier, style)
  return tick * DEEPSEEK_WAVE_TICK_MS * base / deepseekWaveDuration(tier, style)
}

/**
 * Pick one ignition style at random, never repeating the previous one —
 * Codex `IgnitionStyle::random`. Falls back to the remaining styles.
 * @param previous - the style of the last trigger, if any.
 * @returns a style different from `previous`.
 */
export function deepseekWaveStyleRandom(previous: DeepseekWaveStyle | undefined): DeepseekWaveStyle {
  const candidates = DEEPSEEK_WAVE_STYLES.filter(style => style !== previous)
  return candidates[Math.floor(Math.random() * candidates.length)] ?? 'wave'
}

/**
 * Tier for a `provider/model` label: a MODEL ID containing `flash` runs the
 * single-band flash tier; everything else (pro/reasoner/chat) runs the
 * dual-band deepseek tier. Mirrors Codex's Max→Ultra mapping. Only the model
 * segment (after the `/`) is matched, so a provider whose name contains
 * `flash` cannot flip an unrelated model onto the flash tier.
 * @param model - the `provider/model` label of the applied model.
 * @returns the wave tier for that model.
 */
export function deepseekWaveTier(model: string): DeepseekWaveTier {
  const slash = model.indexOf('/')
  const id = slash < 0 ? model : model.slice(slash + 1)
  return id.toLowerCase().includes('flash') ? 'flash' : 'deepseek'
}

/**
 * Cosine window — Codex `crest`: 1 exactly under the wave center, 0 from
 * one half-width away.
 * @param distance - distance from the crest center in half-widths.
 * @returns the crest strength in 0..1.
 */
export function crest(distance: number): number {
  if (distance >= 1) return 0
  return 0.5 * (1 + Math.cos(Math.PI * distance))
}

/**
 * Cubic ease-in-out — Codex `ease_in_out`: flat at both ends, steepest in
 * the middle, so the crest accelerates and eases instead of sliding linearly.
 * @param progress - raw progress (clamped to 0..1).
 * @returns the eased progress in 0..1.
 */
export function easeInOut(progress: number): number {
  const p = Math.min(1, Math.max(0, progress))
  if (p < 0.5) return 4 * p * p * p
  const inverse = -2 * p + 2
  return 1 - (inverse * inverse * inverse) / 2
}

/**
 * Fade-in/fade-out envelope — Codex `envelope`: linear ramp over `fadeIn`
 * at the start and `fadeOut` at the end, plateau at 1 between, 0 outside the
 * total. The Wave style keeps the envelope at 1 (Codex paints Wave without
 * an envelope); exported for the Aurora-style fades and for tests.
 * @param elapsed - seconds since the animation started.
 * @param total - total duration in seconds.
 * @param fadeIn - seconds of fade-in.
 * @param fadeOut - seconds of fade-out.
 * @returns the envelope value in 0..1.
 */
export function envelope(elapsed: number, total: number, fadeIn: number, fadeOut: number): number {
  if (elapsed <= 0 || elapsed >= total) return 0
  const rise = elapsed / Math.max(fadeIn, Number.EPSILON)
  const fall = (total - elapsed) / Math.max(fadeOut, Number.EPSILON)
  return Math.min(Math.max(Math.min(rise, fall), 0), 1)
}

/**
 * The /rainbow celebration on the three-row composer band: a FIXED
 * seven-color spectrum (not the rolled palette) that slides across every
 * row as one ribbon. Triggered when switching to rainbow or rerolling the
 * seed; independent of RAINBOW_SEED so the burst always reads as a prism.
 */
export const RAINBOW_BURST_TICK_MS = 33
export const RAINBOW_BURST_DURATION_MS = 1_800
export const RAINBOW_BURST_HUES: readonly RgbTriple[] = [
  [255, 59, 48],
  [255, 149, 0],
  [255, 204, 0],
  [52, 199, 89],
  [0, 199, 190],
  [10, 132, 255],
  [175, 82, 222],
]

/**
 * Smoothstep in 0..1, then wrap-lerp around the seven burst hues.
 * Position 0 is red, wrapping back toward red at 1. Shared by the
 * composer burst and the static rainbow whale header.
 */
export function rainbowSpectrumHue(position: number): RgbTriple {
  const hues = RAINBOW_BURST_HUES
  const x = ((position % 1) + 1) % 1
  const scaled = x * hues.length
  const index = Math.floor(scaled)
  const t = scaled - index
  const eased = t * t * (3 - 2 * t)
  const a = hues[index % hues.length]
  const b = hues[(index + 1) % hues.length]
  return [
    Math.round(a[0] + (b[0] - a[0]) * eased),
    Math.round(a[1] + (b[1] - a[1]) * eased),
    Math.round(a[2] + (b[2] - a[2]) * eased),
  ]
}

/**
 * Background tint for one composer-band cell during the rainbow burst.
 * Every row of a column shares the same hue (a solid ribbon); edge rows
 * are slightly dimmer so the middle editor row reads as the crest. The
 * spectrum slides ~1.2 widths over the burst, then fades to the band base.
 * @param tick - frame index at {@link RAINBOW_BURST_TICK_MS}.
 * @param column - band column (0..width-1).
 * @param width - band width in columns.
 * @param base - the theme's composerBand color to blend toward.
 * @param row - band row (0..rows-1).
 * @param rows - band height (composer is three rows: pad, editor, pad).
 * @returns the blended RGB, or null after the burst (or at zero alpha).
 */
export function rainbowBurstColumnBg(
  tick: number,
  column: number,
  width: number,
  base: RgbTriple,
  row = 0,
  rows = 1,
): RgbTriple | null {
  const elapsed = tick * RAINBOW_BURST_TICK_MS / 1000
  const total = RAINBOW_BURST_DURATION_MS / 1000
  const fade = envelope(elapsed, total, 0.18, 0.45)
  if (fade <= 0) return null
  const span = Math.max(1, width - 1)
  const slide = elapsed / total * 1.2
  const mixed = rainbowSpectrumHue(column / span + slide)
  const edge = rows > 1 && (row === 0 || row === rows - 1)
  const alpha = Math.min(0.72 * fade * (edge ? 0.78 : 1), 0.70)
  if (alpha < 0.02) return null
  return blendRgb(mixed, base, alpha)
}

/** Per-band sampling context: everything geometry needs beyond the timeline. */
interface BandContext {
  /** Aspect-weighted row offset from the band's center row (Pulse 2-D ring). */
  dy: number
  /** Normalized vertical position: -1 = top row, +1 = bottom row, 0 = middle
   * (or a single-row band, where the undulation cannot render). */
  u: number
  /** Whether the band has more than one row to undulate across. */
  undulating: boolean
  /** The pulse ring radius that covers the band's far corner. */
  pulseSpan: number
  /** Band ordinal: pulse rings and the wave harmonic key off it. */
  bandIndex: number
  /** The style's base duration in seconds (envelope timelines). */
  total: number
}

/**
 * One band's contributions at a column — Codex `band_sample`, redesigned:
 * Wave is a WATER SURFACE — one continuous sine line, mirror-symmetric
 * about the center column, crests flowing outward from the center (band 1
 * of the deepseek tier is a faster harmonic line crossing it). Pulse
 * detonates in TWO dimensions: soft rings that keep expanding through a
 * symmetric fade envelope, color grading across each ring's width, with a
 * trailing echo ripple. Aurora matches Codex verbatim.
 * @param style - the ignition style.
 * @param band - the band triple (meaning depends on the style).
 * @param elapsed - seconds since the animation started.
 * @param column - column index in the content row (0..width-1).
 * @param width - content-row width in columns.
 * @param context - band geometry (row position, undulation flag, pulse span).
 * @returns one or two `[hueIndex, strength, core]` contributions.
 */
function bandSample(
  style: DeepseekWaveStyle,
  band: DeepseekWaveBand,
  elapsed: number,
  column: number,
  width: number,
  context: BandContext,
): [number, number, number][] {
  const [first, second, third] = band
  switch (style) {
    case 'wave': {
      // The water surface: one continuous sine line across the whole band,
      // mirror-symmetric about the center column (distance d = |x − center|
      // drives the phase), crests flowing OUTWARD from the center — one
      // direction, never a return trip. The band table's (launch, travel)
      // becomes the line's fade envelope: fade in at `launch`, full until
      // `launch + travel`, then fade out to the end — symmetric in time.
      const fadeIn = first
      const fadeOut = Math.max(0.05, context.total - (first + second))
      const fade = envelope(elapsed, context.total, fadeIn, fadeOut)
      if (fade <= 0.01) return [[0, 0, 0]]
      // Band 0 is the fundamental swell; band 1 (deepseek tier) is a faster,
      // finer harmonic crossing the fundamental's crests — two continuous
      // symmetric lines interleaving instead of one shuttling back and forth.
      const harmonic = context.bandIndex % 2 === 1
      const wavelength = harmonic ? WAVE_SURFACE_WAVELENGTH / 1.5 : WAVE_SURFACE_WAVELENGTH
      const omega = (harmonic ? 1.5 : 1) * WAVE_SURFACE_OMEGA
      const amplitude = (harmonic ? WAVE_SURFACE_HARMONIC : 1) * WAVE_SURFACE_AMPLITUDE
      const d = Math.abs(column - (width - 1) / 2)
      const surface = amplitude * Math.sin(Math.PI * 2 * d / wavelength - omega * elapsed + (harmonic ? Math.PI / 2 : 0))
      const fromSurface = Math.abs(context.u - surface)
      const vertical = context.undulating ? crest(fromSurface / WAVE_SURFACE_THICKNESS) : 1
      // Aurora-style hue mixing: the MIRRORED profile below the surface
      // carries a second blue (the harmonic band carries the third), so the
      // color distribution flows continuously with the wave instead of one
      // flat tint broken by a hard core line.
      const mirrorHue = harmonic ? 1 : 2
      const below = context.undulating ? crest(Math.abs(context.u + surface) / WAVE_SURFACE_THICKNESS) : vertical
      return [
        [0, fade * vertical, 0],
        [mirrorHue, fade * below * WAVE_SURFACE_MIRROR, 0],
      ]
    }
    case 'aurora': {
      const center = (0.5 + 0.38 * Math.sin(Math.PI * 2 * (first * elapsed + second))) * width
      const halfWidth = Math.max(width * 0.22, 4)
      return [[Math.trunc(third), crest(Math.abs(column - center) / halfWidth), 0]]
    }
    case 'pulse': {
      // Symmetric lifetime: the band table's (launch, travel) becomes the
      // fade envelope (fade in at launch, full until launch+travel, then
      // fade to the end) while the radius keeps expanding THROUGH the fade —
      // a shockwave that never hits a wall, it dissolves mid-flight.
      const launch = first
      const travel = second
      const fadeOut = Math.max(0.05, context.total - (launch + travel))
      const fade = envelope(elapsed, context.total, launch, fadeOut)
      if (fade <= 0.01) return [[0, 0, 0]]
      const progress = (elapsed - launch) / travel
      const radius = (1 - (1 - progress) ** 3) * context.pulseSpan
      const decay = third * (1 - 0.35 * Math.min(Math.max(progress, 0), 1))
      const distance = Math.hypot(column - width / 2, context.dy)
      const fromRing = Math.abs(distance - radius)
      // Wide soft band with a moderate peak riding the radius — all in the
      // hue blend, no hard line — and an inner edge one hue over at a
      // slightly smaller radius: the ring's color grades across its width.
      const band = crest(fromRing / PULSE_HALF_WIDTH) + PULSE_PEAK_GAIN * crest(fromRing / PULSE_PEAK_HALF_WIDTH)
      const inner = crest(Math.abs(distance - (radius - PULSE_INNER_OFFSET)) / PULSE_HALF_WIDTH)
      // Trailing echo ripple in the next blue, fading in after the primary
      // so the center hole opens first.
      const echoGate = envelope(elapsed, context.total, launch + PULSE_ECHO_DELAY, fadeOut)
      const echo = crest(Math.abs(distance - radius * PULSE_ECHO_RADIUS) / PULSE_HALF_WIDTH)
        * PULSE_ECHO_STRENGTH * echoGate
      return [
        [context.bandIndex, fade * band * decay, 0],
        [PULSE_INNER_HUE, fade * inner * decay * PULSE_INNER_STRENGTH, 0],
        [context.bandIndex + 1, fade * echo * decay, 0],
      ]
    }
  }
}

/** Linear RGB blend — Codex `blend`: `fg * alpha + bg * (1 - alpha)`. */
function blendRgb(fg: RgbTriple, bg: RgbTriple, alpha: number): RgbTriple {
  return [
    Math.round(fg[0] * alpha + bg[0] * (1 - alpha)),
    Math.round(fg[1] * alpha + bg[1] * (1 - alpha)),
    Math.round(fg[2] * alpha + bg[2] * (1 - alpha)),
  ]
}

/**
 * Aurora-only per-row phase share of the duration: its drifting bands reach
 * the top row first and the bottom row last, sweeping down the band. 0.12
 * keeps the bottom row's lag inside the 200ms duration extension. Wave and
 * Pulse deliberately share one timeline (see `deepseekWaveColumnBg`).
 */
const DEEPSEEK_WAVE_ROW_PHASE = 0.12

/**
 * The background color for one composer-band column at a tick — Codex
 * `paint_bands` + `Canvas::tint` for all three styles. Bands overlap with a
 * max for Wave/Pulse and a SUM for Aurora (Codex differs by style), the
 * weighted hues mix per column (Wave/Pulse always end on hue 0), the tint
 * blends the mixed hue toward the blank-cell base at the style's alpha cap,
 * and Aurora applies its own fade envelope. Returns `null` when the column
 * should stay transparent, so the row returns to no `backgroundColor` on
 * both ends. With `rows > 1`: Wave is a water surface — every column
 * lights the row nearest the surface's current height, so the light reads
 * as ONE continuous wavy line spanning the band, symmetric about the center
 * column and flowing outward (a single-row band falls back to a flat glow);
 * Pulse rings in two dimensions around the band's center cell with trailing
 * echo ripples; only Aurora samples the timeline shifted by a per-row phase
 * offset.
 * @param tick - wave frame (0, 1, … at DEEPSEEK_WAVE_TICK_MS).
 * @param column - column index in the content row (0..width-1).
 * @param width - content-row width in columns.
 * @param tier - the wave tier (flash = Max, deepseek = Ultra parameters).
 * @param style - the ignition style.
 * @param hues - the tier's three hues.
 * @param base - the blank-cell base color the tint blends toward.
 * @param row - row index in the band (0..rows-1; default 0 = old single-row).
 * @param rows - band height in rows (default 1).
 * @returns the blended RGB background, or null for transparent.
 */
export function deepseekWaveColumnBg(
  tick: number,
  column: number,
  width: number,
  tier: DeepseekWaveTier,
  style: DeepseekWaveStyle,
  hues: readonly [RgbTriple, RgbTriple, RgbTriple],
  base: RgbTriple,
  row = 0,
  rows = 1,
): RgbTriple | null {
  const total = deepseekWaveBaseDuration(tier, style) / 1000
  // Only Aurora keeps the per-row phase cascade (its drifting bands stagger
  // nicely). Wave and Pulse sample ONE shared timeline — Codex paints each
  // column across the whole band height (`tint_column`), and the cascade we
  // added on top of the port tore Pulse into misaligned per-row rings and
  // smeared Wave's crest into a diagonal.
  const elapsed = deepseekWaveSampleElapsedMs(tick, tier, style) / 1000
    - (style === 'aurora' ? (row - (rows - 1) / 2) * total * DEEPSEEK_WAVE_ROW_PHASE : 0)
  const dy = style === 'pulse' ? (row - (rows - 1) / 2) * PULSE_ROW_ASPECT : 0
  const undulating = rows > 1
  const u = undulating ? (row - (rows - 1) / 2) / ((rows - 1) / 2) : 0
  // The span is EXACTLY the band's far corner: the ring front reaches the
  // edges as the fade envelope closes, so the detonation stays visible for
  // its whole lifetime instead of rushing off the band mid-flight (the old
  // +2·half-width margin made the ring's second half invisible).
  const pulseSpan = Math.hypot(width / 2, ((rows - 1) / 2) * PULSE_ROW_ASPECT)
  const fade = style === 'aurora' ? envelope(elapsed, total, 0.25, 0.40) : 1
  const weights = [0, 0, 0]
  let bandIndex = 0
  for (const band of DEEPSEEK_WAVE_BANDS[style][tier]) {
    for (const [hue, strength] of bandSample(style, band, elapsed, column, width, { dy, u, undulating, pulseSpan, bandIndex, total })) {
      weights[hue] = style === 'aurora' ? weights[hue] + strength : Math.max(weights[hue], strength)
    }
    bandIndex += 1
  }
  const weight = weights[0] + weights[1] + weights[2]
  if (weight <= 0.01) return null
  let red = 0
  let green = 0
  let blue = 0
  for (let index = 0; index < 3; index += 1) {
    red += weights[index] * hues[index][0]
    green += weights[index] * hues[index][1]
    blue += weights[index] * hues[index][2]
  }
  const mixed: RgbTriple = [
    Math.round(red / weight),
    Math.round(green / weight),
    Math.round(blue / weight),
  ]
  // Alpha caps, all Aurora-grade now: Aurora ≤0.50, the swell ≤0.68, the
  // detonation a notch above at ≤0.72 — soft gradients everywhere, no hard
  // lines, the color work done by hue mixing instead of brightness spikes.
  const alpha = style === 'aurora'
    ? Math.min(weight * 0.40, 0.50) * fade
    : style === 'wave'
      ? Math.min(weight * WAVE_SURFACE_ALPHA_GAIN, WAVE_SURFACE_ALPHA_CAP)
      : Math.min(weight * PULSE_ALPHA_GAIN, PULSE_ALPHA_CAP)
  if (alpha < 0.02) return null
  return blendRgb(mixed, base, alpha)
}

/**
 * The sparkle glyph for a tick — Codex `spark_frame`, sampled on the same
 * proportionally slowed DeepSeek Wave timeline as the composer background.
 * The Ink layer still must skip occupied cells.
 * @param tick - wave frame at DEEPSEEK_WAVE_TICK_MS.
 * @returns the sparkle glyph, or null outside the stretched tail window.
 */
export function deepseekWaveSpark(tick: number): string | null {
  const elapsed = deepseekWaveSampleElapsedMs(tick, 'deepseek', 'wave')
  if (elapsed < SPARK_START_MS) return null
  const frame = Math.floor((elapsed - SPARK_START_MS) / SPARK_FRAME_MS)
  return SPARK_GLYPHS[frame] ?? null
}

/**
 * Whether the `deepseek` wordmark rides the wave at this tick: it fades in
 * shortly after the first crest launches and out before the wave settles,
 * so the brand name surfaces through the sweep's middle. The Ink layer
 * places it in the row's blank mid-section (never over real draft text).
 * @param tick - wave frame at DEEPSEEK_WAVE_TICK_MS.
 * @param tier - the wave tier.
 * @returns true while the wordmark should be visible.
 */
export function deepseekWaveWordVisible(tick: number, tier: DeepseekWaveTier, style: DeepseekWaveStyle = 'wave'): boolean {
  const total = deepseekWaveBaseDuration(tier, style) / 1000
  const elapsed = deepseekWaveSampleElapsedMs(tick, tier, style) / 1000
  return envelope(elapsed, total, total * 0.2, total * 0.35) > 0.25
}

/**
 * The per-character color for the `deepseek` wordmark: the tier's hues
 * cycled per character (d→hue0, e→hue1, e→hue2, …), a brand-gradient text.
 * @param index - character index in the wordmark.
 * @param hues - the tier's three hues.
 * @returns the hue for that character.
 */
export function deepseekWaveWordHue(index: number, hues: readonly [RgbTriple, RgbTriple, RgbTriple]): RgbTriple {
  return hues[index % hues.length]
}

/**
 * True when a `provider/model` status label addresses the official DeepSeek
 * route: either segment contains `deepseek` (case-insensitive), covering the
 * `deepseek-official` provider route and its `deepseek-*` model ids.
 * @param label - the status bar model label (`provider/model`).
 * @returns whether the label names an official DeepSeek model.
 */
export function isOfficialDeepSeekLabel(label: string): boolean {
  const slash = label.indexOf('/')
  const provider = slash < 0 ? label : label.slice(0, slash)
  const model = slash < 0 ? '' : label.slice(slash + 1)
  return provider.toLowerCase().includes('deepseek') || model.toLowerCase().includes('deepseek')
}

/**
 * Known reasoning-effort ranks in ascending order. Effort ids are opaque
 * adapter-owned strings, so the rank table covers the conventional names
 * (off → low → medium → high → xhigh → max/ultra); an unrecognized id
 * ranks as unknown (0), which never triggers the high-effort wave.
 */
const EFFORT_RANK: Readonly<Record<string, number>> = {
  off: 0,
  none: 0,
  low: 1,
  medium: 2,
  med: 2,
  high: 3,
  xhigh: 4,
  'x-high': 4,
  'very-high': 4,
  max: 5,
  maximum: 5,
  ultra: 5,
}

/**
 * True when an effective reasoning effort is STRICTLY above `high` — the
 * trigger gate for the "Into the Unknown" wave on non-DeepSeek routes.
 * Absent efforts and unrecognized ids never qualify.
 * @param effort - the effective reasoning-effort id ('' or undefined when none).
 * @returns whether the effort ranks above high.
 */
export function effortAboveHigh(effort: string | undefined): boolean {
  if (effort === undefined || effort === '') return false
  const rank = EFFORT_RANK[effort.trim().toLowerCase()]
  return rank !== undefined && rank > 3
}

/**
 * Parse a persisted animations preference (`animations.json`): timed
 * animations are on by default and only an explicit `false` disables them —
 * a missing key, corrupt value, or absent file all mean enabled, so the
 * /animation toggle degrades exactly like every other user preference.
 * @param value - the raw parsed JSON value (expected boolean).
 * @returns whether timed animations should run.
 */
export function parseAnimationsPref(value: unknown): boolean {
  return value !== false
}

/**
 * One parsed `/animation` argument: '' toggles, `on|true|1` enables,
 * `off|false|0` disables (case-insensitive, surrounding whitespace ignored),
 * and anything else is a usage error the caller surfaces. Kept pure so the
 * command's entire decision table is unit-testable.
 * @param argument - the raw text after `/animation`.
 * @returns `{ enabled }`, `'toggle'`, or `'usage'`.
 */
export function parseAnimationsArgument(argument: string): { enabled: boolean } | 'toggle' | 'usage' {
  const normalized = argument.trim().toLowerCase()
  if (normalized === '') return 'toggle'
  if (normalized === 'on' || normalized === 'true' || normalized === '1') return { enabled: true }
  if (normalized === 'off' || normalized === 'false' || normalized === '0') return { enabled: false }
  return 'usage'
}
