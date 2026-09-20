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

/** Pixel rows of the welcome snowflake for terminals of 24+ rows. */
export const WELCOME_ART: readonly string[] = [
  "...........1.1..........",
  "............1...........",
  "............1...........",
  ".........1..1..1........",
  ".......1..22222..1......",
  "...1...1....2....1...1..",
  "..11...2....2....2...11.",
  "....11.2...222...2.11...",
  "......22.22.3.22.22.....",
  ".....22.22.333.22.22....",
  "....1...2.33332.2...1...",
  "........2.33322.2.......",
  "....1...2.33222.2...1...",
  ".....22.22.222.22.22....",
  "......22.22.3.22.22.....",
  "....11.2...222...2.11...",
  "..11...2....2....2...11.",
  "...1...1....2....1...1..",
  ".......1..22222..1......",
  ".........1..1..1........",
  "............1...........",
  "............1...........",
  "...........1.1..........",
  "........................"
]

/** The shorter snowflake used under 26 rows. */
export const WELCOME_ART_SMALL: readonly string[] = [
  "..........1.1.........",
  "...........1..........",
  "........1..1..1.......",
  ".........1.2.1........",
  "...1..1...222...1..1..",
  "...1..1....2....1..1..",
  "..1.1.2...222...2.1.1.",
  ".....22.22.3.22.22....",
  "....12.22.333.22.21...",
  "...1...2.33332.2...1..",
  ".......2.33322.2......",
  "...1...2.33222.2...1..",
  "....12.22.222.22.21...",
  ".....22.22.3.22.22....",
  "..1.1.2...222...2.1.1.",
  "...1..1....2....1..1..",
  "...1..1...222...1..1..",
  ".........1.2.1........",
  "........1..1..1.......",
  "...........1..........",
  "..........1.1.........",
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
