/**
 * dscode: the footer telemetry tints its live numbers — the request rate by tier
 * and the cache-hit rate by how well the prompt prefix is being reused.
 *
 * @module dsh-code/dscode/telemetry
 */

import { createElement } from 'react'
import { Text } from 'ink'
import { getPalette, getTheme, inkColor } from '../theme.ts'

/** One tintable tier; `null` leaves the run in the surrounding colour. */
export type DscodeTelemetryTone = 'red' | 'yellow' | 'green' | 'blue' | 'purple' | null

/** Request-rate tiers: yellow under 75 tps, green to 150, blue to 250, purple above. */
export function dscodeTpsTone(rate: number): DscodeTelemetryTone {
  if (!Number.isFinite(rate) || rate < 0) return null
  if (rate < 75) return 'yellow'
  if (rate < 150) return 'green'
  if (rate <= 250) return 'blue'
  return 'purple'
}

/** Cache-hit tiers: red under 90%, yellow to 95, green to 98, blue above. */
export function dscodeCacheTone(rate: number): DscodeTelemetryTone {
  if (!Number.isFinite(rate) || rate < 0) return null
  if (rate < 90) return 'red'
  if (rate < 95) return 'yellow'
  if (rate < 98) return 'green'
  return 'blue'
}

/** Every label the cache figure can carry, across the shipped interface languages. */
const DSCode_CACHE_LABELS = ['cache hit', '缓存命中', '快取命中', 'キャッシュヒット', '캐시 적중', 'éxitos de caché']

/** The ink colour for a tier, theme-aware for the two ends of the scale. */
export function dscodeTpsInkColor(tone: DscodeTelemetryTone): ReturnType<typeof inkColor> | undefined {
  const palette = getPalette()
  if (tone === 'red') return inkColor(getTheme() === 'light' ? [185, 28, 28] : [248, 113, 113])
  if (tone === 'yellow') return inkColor(palette.warn)
  if (tone === 'green') return inkColor(palette.success)
  if (tone === 'blue') return inkColor(palette.brandBright)
  if (tone === 'purple') return inkColor(getTheme() === 'light' ? [126, 34, 206] : [192, 132, 252])
  return undefined
}

/** One run of the telemetry string with the tone it should be painted in. */
export interface DscodeTelemetryPart {
  text: string
  tone: DscodeTelemetryTone
}

/**
 * Split a telemetry string into tintable runs. The `tps` figures and the trailing
 * cache-hit rate carry a tier; everything else keeps the surrounding colour.
 */
export function dscodeTelemetryParts(value: string): readonly DscodeTelemetryPart[] {
  const result: DscodeTelemetryPart[] = []
  const parts = String(value).split(' | ')
  for (const [index, part] of parts.entries()) {
    if (index > 0) result.push({ text: ' | ', tone: null })
    const match = /^(.+?: )(~?(?:\d+(?:\.\d+)?|--)) tps$/.exec(part)
    if (match) {
      const display = match[2]
      const rate = Number(display.startsWith('~') ? display.slice(1) : display)
      result.push({ text: match[1], tone: null }, { text: display + ' tps', tone: display ? dscodeTpsTone(rate) : null })
      continue
    }
    // Only a recognised cache label at the very end of the line is tinted.
    const labelled = index === parts.length - 1 ? /^(.*?)(\d+(?:\.\d+)?)%$/.exec(part) : null
    const cache = labelled && DSCode_CACHE_LABELS.includes(labelled[1].replace(/:\s*$/, '').trim().toLowerCase()) ? labelled : null
    if (cache) {
      result.push({ text: cache[1], tone: null }, { text: cache[2] + '%', tone: dscodeCacheTone(Number(cache[2])) })
      continue
    }
    result.push({ text: part, tone: null })
  }
  return result
}

/** The telemetry run as Ink text nodes, one per tinted segment. */
export function dscodeTelemetryNodes(value: string, key: string): readonly ReturnType<typeof createElement>[] {
  return dscodeTelemetryParts(value).map((part, index) => createElement(
    Text,
    { key: key + 'p' + index, color: dscodeTpsInkColor(part.tone) },
    part.text,
  ))
}
