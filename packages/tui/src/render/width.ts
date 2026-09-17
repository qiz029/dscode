/**
 * Precise terminal-cell width measurement — the single authority every
 * budget, wrap, and truncation path shares. The previous heuristic
 * (`codePoint > 0x2e7f ? 2 : 1)) mis-sized Hangul Jamo (narrow), high
 * non-CJK code points (wide), and emoji: text-default glyphs like ✳ ⚠ ❤
 * counted 2 while terminals draw 1, and VS16 sequences counted 1 while
 * terminals draw 2 — the exact drift class the community dsh-TUI string
 * engine documents (a spinner glyph drifting one column per frame). This
 * module adapts that engine's rules without its Ink-fork renderer: an ASCII
 * fast path, grapheme-cluster iteration via Intl.Segmenter (code-point
 * fallback), a merged East-Asian-Wide/Fullwidth + Emoji_Presentation range
 * table, text-default emoji = 1, VS16 = 2, marks/selectors/ZWJ = 0.
 * @module @deepseek-ai/dsh-code/render/width
 */

/**
 * Code-point ranges rendered two cells wide: East Asian Wide/Fullwidth
 * blocks merged with the Emoji_Presentation set (default-wide emoji) and
 * regional indicators (flags). Sorted, inclusive, binary-searched.
 */
const WIDE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x115f],
  [0x231a, 0x231b],
  [0x2329, 0x232a],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x23f8, 0x23fa],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18aff],
  [0x1b000, 0x1b2ff],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f1e6, 0x1f1ff],
  [0x1f200, 0x1f320],
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6d5, 0x1f6d7],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1fa7c],
  [0x1fa80, 0x1fa89],
  [0x1fa8f, 0x1fac6],
  [0x1face, 0x1fadc],
  [0x1fadf, 0x1fae9],
  [0x1faf0, 0x1faf8],
  [0x20000, 0x2fffd],
  [0x30000, 0x3fffd],
]

/** Whether one code point falls inside a wide range (binary search). */
function isWideCodePoint(code: number): boolean {
  let low = 0
  let high = WIDE_RANGES.length - 1
  while (low <= high) {
    const mid = (low + high) >> 1
    const [start, end] = WIDE_RANGES[mid]
    if (code < start) high = mid - 1
    else if (code > end) low = mid + 1
    else return true
  }
  return false
}

/** Zero-width code points: combining marks, enclosing marks, format controls. */
const ZERO_WIDTH = /^[\p{Mn}\p{Me}\p{Cf}]$/u

/** Module-cached grapheme segmenter; undefined when the runtime lacks it. */
let segmenter: Intl.Segmenter | undefined
try {
  segmenter = new Intl.Segmenter('en', { granularity: 'grapheme' })
} catch {
  segmenter = undefined
}

/** Split text into grapheme clusters (code points when Segmenter is absent). */
export function splitGraphemes(text: string): string[] {
  if (segmenter === undefined) return Array.from(text)
  return Array.from(segmenter.segment(text), part => part.segment)
}

/** Terminal-cell width of one grapheme cluster. */
export function graphemeWidth(cluster: string): number {
  // VS16 requests emoji presentation: ❤️ / ✳️ render two cells even when the
  // base glyph is text-default (width 1 without the selector).
  if (cluster.includes('\u{fe0f}', 0)) return 2
  const first = cluster.codePointAt(0) ?? 0
  if (ZERO_WIDTH.test(String.fromCodePoint(first))) return 0
  return isWideCodePoint(first) ? 2 : 1
}

/** Terminal-cell width of one code point (surrogate pairs must stay paired). */
export function codePointWidth(char: string): number {
  if (ZERO_WIDTH.test(char)) return 0
  return isWideCodePoint(char.codePointAt(0) ?? 0) ? 2 : 1
}

/**
 * Terminal-cell width of a string: an ASCII fast path avoids the segmenter
 * for the overwhelmingly common case; everything else sums grapheme clusters.
 * Control characters occupy no cells (display sanitization makes them
 * visible escapes before they ever reach a budget).
 * @param text - display-safe or raw text to measure.
 * @returns the column count the terminal will draw.
 */
export function stringWidth(text: string): number {
  let asciiOnly = true
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) > 0x7f) {
      asciiOnly = false
      break
    }
  }
  if (asciiOnly) {
    let columns = 0
    for (let index = 0; index < text.length; index += 1) {
      const code = text.charCodeAt(index)
      if (code >= 0x20 && code !== 0x7f) columns += 1
    }
    return columns
  }
  let columns = 0
  for (const cluster of splitGraphemes(text)) columns += graphemeWidth(cluster)
  return columns
}
