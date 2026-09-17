/**
 * The /language picker: one row per interface language, the active one
 * marked, arrow selection, Enter applies (persisting through the runner and
 * repainting the whole screen so Static-region text switches too).
 */

import { createElement, useState, type ReactElement } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import { panelViewport } from './render/inspector.ts'
import { truncateColumns } from './render/text.ts'
import { LANGUAGES, t, type LanguageName } from './i18n.ts'
import { getPalette, inkColor } from './theme.ts'

export function LanguagePanel({ current, select, close }: {
  current: LanguageName
  select: (name: LanguageName) => void
  close: () => void
}): ReactElement {
  const [cursor, setCursor] = useState(() => {
    const index = LANGUAGES.findIndex(language => language.id === current)
    return index < 0 ? 0 : index
  })
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  useInput((input, key) => {
    if (key.escape || input === 'q') return close()
    if (key.upArrow) return setCursor(value => (value + LANGUAGES.length - 1) % LANGUAGES.length)
    if (key.downArrow) return setCursor(value => (value + 1) % LANGUAGES.length)
    if (key.return) return select(LANGUAGES[cursor].id)
  })
  if (viewport.maxHeight === 0 || viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns('/language · esc/q close', viewport.contentColumns))
  }
  return createElement(
    Box,
    { width: viewport.outerColumns, borderStyle: 'round', borderColor: inkColor(getPalette().dim), flexDirection: 'column', paddingX: 1 },
    createElement(Text, { color: inkColor(getPalette().brandBright), wrap: 'truncate-end' }, truncateColumns(t('language.title'), viewport.contentColumns)),
    ...LANGUAGES.map((language, index) => {
      const selected = index === cursor
      const active = language.id === current
      return createElement(
        Text,
        {
          key: language.id,
          color: selected ? inkColor(getPalette().brandBright) : undefined,
          wrap: 'truncate-end',
        },
        truncateColumns(`${selected ? '› ' : '  '}${language.label}${active ? '  ●' : ''}`, viewport.contentColumns),
      )
    }),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, truncateColumns(t('language.hint'), viewport.contentColumns)),
  )
}
