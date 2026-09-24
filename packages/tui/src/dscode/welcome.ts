/**
 * dscode: the welcome screen's pixel snowflake, its half-block row packing and
 * the path folding that keeps a long directory inside the details column.
 *
 * @module dsh-code/dscode/welcome
 */

import { singleLineText, truncateColumns } from '../render/text.ts'
import { visibleColumns } from '../render/markdown.ts'

export function welcomePath(path: string, width: number): string {
  const full = singleLineText(path || '');
  if (visibleColumns(full) <= width) return full;
  const segments = full.split(/[\\/]/).filter(Boolean);
  let suffix = '';
  for (let index = segments.length - 1; index >= 0; index--) {
    const candidate = '/' + segments[index] + suffix;
    if (visibleColumns('…' + candidate) > width) break;
    suffix = candidate;
  }
  return suffix ? '…' + suffix : '…' + truncateColumns(segments.at(-1) || full, Math.max(1, width - 1));
}

/**
 * Pixel rows of the welcome snowflake for terminals of 26+ rows: six arms 60°
 * apart around a hexagonal crystal, each arm with one branch pair parallel to
 * its neighbours. 3 is the crystal and its centre, 2 the arms, 1 the branches
 * and the inner corners that keep the 30° arms reading as one line; the ripple
 * lights them crystal → arms → branches.
 */
export const WELCOME_ART: readonly string[] = [
  "............2...........",
  "............2...........",
  "............2...........",
  ".........11.2.11........",
  "...........121..........",
  "..2...1.....2.....1...2.",
  "..122.1.....2.....1.221.",
  "....121.....3.....121...",
  ".....122..33233..221....",
  "....11.133..2..331.11...",
  "...1....322.3.223....1..",
  "........3..333..3.......",
  "...1....322.3.223....1..",
  "....11.133..2..331.11...",
  ".....122..33233..221....",
  "....121.....3.....121...",
  "..122.1.....2.....1.221.",
  "..2...1.....2.....1...2.",
  "...........121..........",
  ".........11.2.11........",
  "............2...........",
  "............2...........",
  "............2...........",
  "........................"
]

/** The shorter snowflake used under 26 rows. */
export const WELCOME_ART_SMALL: readonly string[] = [
  "...........2..........",
  "...........2..........",
  ".........11211........",
  "...........2..........",
  "...........2..........",
  "..2..1.....2.....1..2.",
  "..1221.....3.....1221.",
  "....122..33233..221...",
  "...11.123..2..321.11..",
  ".......132.2.231......",
  "........3.232.3.......",
  ".......132.2.231......",
  "...11.123..2..321.11..",
  "....122..33233..221...",
  "..1221.....3.....1221.",
  "..2..1.....2.....1..2.",
  "...........2..........",
  "...........2..........",
  ".........11211........",
  "...........2..........",
  "...........2..........",
  "......................"
]

export interface WelcomeArtSegment {
  glyph: string
  text: string
  color: string
  background: string
}

export function welcomeArtRows(
  grid: readonly string[],
  tones: Readonly<Record<string, string>>,
): readonly (readonly WelcomeArtSegment[])[] {
  const rows: WelcomeArtSegment[][] = [];
  for (let y = 0; y < grid.length; y += 2) {
    const top = grid[y] || '';
    const bottom = grid[y + 1] || '';
    const segments: WelcomeArtSegment[] = [];
    for (let x = 0; x < Math.max(top.length, bottom.length); x++) {
      const upper = tones[top[x]] || '';
      const lower = tones[bottom[x]] || '';
      const glyph = upper && lower ? upper === lower ? '\u2588' : '\u2580' : upper ? '\u2580' : lower ? '\u2584' : ' ';
      const color = upper || lower;
      const background = upper && lower && upper !== lower ? lower : '';
      const last = segments[segments.length - 1];
      if (last && last.glyph === glyph && last.color === color && last.background === background) last.text += glyph;
      else segments.push({ glyph, text: glyph, color, background });
    }
    rows.push(segments);
  }
  return rows;
}

/** dscode: pad a label to a column width (CJK-safe). */
export function dscodePadEnd(text: string, width: number): string {
  return text + ' '.repeat(Math.max(1, width - visibleColumns(text)))
}
