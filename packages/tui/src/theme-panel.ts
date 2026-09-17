/**
 * The `/theme` picker (the Codex `/theme` contract): one bounded list over
 * the three color themes — dark, light, and auto (terminal-sensed; auto
 * falls back to dark until OSC-11 detection lands). Enter applies the row
 * and the runner persists it; Esc closes without changing the theme.
 *
 * @module @deepseek-ai/dsh-tui/theme-panel
 */

import { createElement, useState, type ReactElement } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import { clampScroll, panelViewport } from './render/inspector.ts'
import { truncateColumns } from './render/text.ts'
import { panelAccent } from './panel-accent.ts'
import { getPalette, inkColor, THEMES, type ThemeName } from './theme.ts'
import { t } from './i18n.ts'

/**
 * The /theme list: one row per theme, the current one marked with ●, the
 * focused one with ›. Enter applies the focused theme (the runner persists
 * it), Esc/q closes without changing anything. Colors read the ACTIVE
 * palette, so the panel itself adapts to a light theme once applied.
 */
export function ThemePanel({ current, select, close }: {
  /** Theme name in force (the requested name; 'auto' included). */
  current: ThemeName
  /** Accept one theme name: applied immediately and persisted by the runner. */
  select: (name: ThemeName) => void
  /** Close without changing the theme. */
  close: () => void
}): ReactElement {
  const [cursor, setCursor] = useState(() => {
    const index = THEMES.findIndex(theme => theme.id === current)
    return index < 0 ? 0 : index
  })
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  useInput((input, key) => {
    if (key.escape || input === 'q') return close()
    if (key.upArrow) return setCursor(value => (value + THEMES.length - 1) % THEMES.length)
    if (key.downArrow) return setCursor(value => (value + 1) % THEMES.length)
    if (key.return) return select(THEMES[cursor].id)
  })
  if (viewport.maxHeight === 0 || viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(t('theme.compact'), viewport.contentColumns))
  }
  // The theme rows share the panel's body budget like every other panel: an
  // unsliced three-row list reached terminal-height equality on short
  // terminals, where Ink rewrites the whole Static region every frame.
  // Reveal-cursor slicing keeps the focused row visible instead.
  const rowBudget = Math.max(1, viewport.bodyRows)
  const first = clampScroll(cursor, THEMES.length, rowBudget)
  const visibleThemes = THEMES.slice(first, first + rowBudget)
  const hiddenThemes = THEMES.length - visibleThemes.length
  const accent = panelAccent('theme', getPalette().dim, getPalette().brandBright)
  return createElement(
    Box,
    { width: viewport.outerColumns, borderStyle: 'round', borderColor: inkColor(accent.border), flexDirection: 'column', paddingX: 1 },
    createElement(Text, { color: inkColor(accent.title), wrap: 'truncate-end' }, truncateColumns(t('theme.title'), viewport.contentColumns)),
    ...visibleThemes.map((theme, index) => {
      const selected = first + index === cursor
      const active = theme.id === current
      return createElement(
        Text,
        {
          key: theme.id,
          color: selected ? inkColor(getPalette().brandBright) : undefined,
          wrap: 'truncate-end',
        },
        truncateColumns(`${selected ? '› ' : '  '}${active ? '● ' : '○ '}${t(`theme.${theme.id}.label`)}${active ? ` · ${t('theme.current')}` : ''} · ${t(`theme.${theme.id}.description`)}`, viewport.contentColumns),
      )
    }),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, truncateColumns(`↑↓ choose · enter apply · esc/q close${hiddenThemes > 0 ? ` · +${hiddenThemes} more` : ''}`, viewport.contentColumns)),
  )
}
