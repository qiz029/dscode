/** Bounded Ink surfaces for provider login and logout. */

import { createElement, useEffect, useRef, useState, type ReactElement } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import {
  AuthorizationDeclinedError,
  type AuthorizationInteraction,
  type AuthorizationNotice,
  type AuthorizationPrompt,
  type AuthorizationStatus,
} from '@deepseek-ai/dsh-authorization'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import type { ProviderAuthorizationRow } from './authorization.ts'
import { panelViewport } from './render/inspector.ts'
import { displayText, singleLineText, truncateColumns } from './render/text.ts'
import { panelAccent } from './panel-accent.ts'
import { getPalette, inkColor } from './theme.ts'
import { t } from './i18n.ts'

interface PromptReply {
  readonly resolve: (value: string) => void
  readonly reject: (reason: Error) => void
  readonly detach: () => void
}

export interface ProviderAuthorizationPanelProps {
  readonly row: ProviderAuthorizationRow
  begin(
    row: ProviderAuthorizationRow,
    method: string,
    interaction: AuthorizationInteraction,
    signal: AbortSignal,
  ): Promise<AuthorizationStatus>
  cancel(key: CredentialKey): void
  openUrl(url: string): boolean
  copy(text: string): Promise<void>
  done(): void
  back(): void
}

/** Run one upstream authorization flow without letting notices or prompts exceed the panel budget. */
export function ProviderAuthorizationPanel(props: ProviderAuthorizationPanelProps): ReactElement {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const [phase, setPhase] = useState<'methods' | 'running'>('methods')
  const [cursor, setCursor] = useState(0)
  const [notices, setNotices] = useState<readonly AuthorizationNotice[]>([])
  const [prompt, setPrompt] = useState<AuthorizationPrompt | undefined>(undefined)
  const [draft, setDraft] = useState('')
  const [promptCursor, setPromptCursor] = useState(0)
  const [error, setError] = useState<string | undefined>(undefined)
  const [copyState, setCopyState] = useState<string | undefined>(undefined)
  const controllerRef = useRef<AbortController | undefined>(undefined)
  const replyRef = useRef<PromptReply | undefined>(undefined)
  const openedUrls = useRef(new Set<string>())

  const clearReply = (): void => {
    replyRef.current?.detach()
    replyRef.current = undefined
    setPrompt(undefined)
    setDraft('')
    setPromptCursor(0)
  }

  const decline = (): void => {
    const reply = replyRef.current
    clearReply()
    reply?.reject(new AuthorizationDeclinedError())
  }

  const stop = (): void => {
    controllerRef.current?.abort()
    controllerRef.current = undefined
    props.cancel(props.row.key)
    decline()
  }

  useEffect(() => () => {
    controllerRef.current?.abort()
    props.cancel(props.row.key)
    const reply = replyRef.current
    replyRef.current = undefined
    reply?.detach()
    reply?.reject(new AuthorizationDeclinedError())
  }, [props.row.key])

  const start = (method: string): void => {
    setPhase('running')
    setError(undefined)
    setNotices([])
    setCopyState(undefined)
    const controller = new AbortController()
    controllerRef.current = controller
    const interaction: AuthorizationInteraction = {
      notify(notice): void {
        setNotices(current => [...current.slice(-19), notice])
        if (notice.url !== undefined && !openedUrls.current.has(notice.url)) {
          openedUrls.current.add(notice.url)
          props.openUrl(notice.url)
        }
      },
      prompt(next): Promise<string> {
        return new Promise((resolve, reject) => {
          const onWithdraw = (): void => {
            if (replyRef.current?.reject !== reject) return
            clearReply()
            reject(new Error('authorization prompt was withdrawn'))
          }
          next.signal?.addEventListener('abort', onWithdraw, { once: true })
          replyRef.current = {
            resolve,
            reject,
            detach: () => next.signal?.removeEventListener('abort', onWithdraw),
          }
          setPrompt(next)
          setDraft('')
          setPromptCursor(0)
        })
      },
    }
    void props.begin(props.row, method, interaction, controller.signal).then((status) => {
      controllerRef.current = undefined
      clearReply()
      if (status === 'authorized') props.done()
      else props.back()
    }, (reason: unknown) => {
      controllerRef.current = undefined
      clearReply()
      if (controller.signal.aborted) {
        props.back()
        return
      }
      setError(reason instanceof Error ? reason.message : String(reason))
      setPhase('methods')
    })
  }

  const answer = (value: string): void => {
    const reply = replyRef.current
    clearReply()
    reply?.resolve(value)
  }

  useInput((input, key) => {
    if (phase === 'methods') {
      if (key.escape || input === 'q') {
        props.back()
        return
      }
      if (props.row.methods.length === 0) return
      if (key.upArrow) {
        setCursor(current => (current + props.row.methods.length - 1) % props.row.methods.length)
        return
      }
      if (key.downArrow) {
        setCursor(current => (current + 1) % props.row.methods.length)
        return
      }
      if (key.return) start(props.row.methods[cursor]?.id ?? props.row.methods[0].id)
      return
    }

    if (key.escape) {
      stop()
      props.back()
      return
    }
    const copyValue = notices.at(-1)?.code ?? notices.at(-1)?.url
    if ((input === 'c' || input === 'C') && copyValue !== undefined) {
      void props.copy(copyValue).then(
        () => setCopyState('copied'),
        reason => setCopyState(`copy failed: ${reason instanceof Error ? reason.message : String(reason)}`),
      )
      return
    }
    if (prompt === undefined) return
    if (prompt.kind === 'select') {
      if (prompt.options.length === 0) return
      if (key.upArrow) {
        setPromptCursor(current => (current + prompt.options.length - 1) % prompt.options.length)
        return
      }
      if (key.downArrow) {
        setPromptCursor(current => (current + 1) % prompt.options.length)
        return
      }
      if (key.return) answer(prompt.options[promptCursor]?.id ?? prompt.options[0].id)
      return
    }
    if (key.backspace || key.delete) {
      setDraft(current => [...current].slice(0, -1).join(''))
      return
    }
    if (key.return) {
      if (draft.trim() !== '') answer(draft)
      return
    }
    if (input !== '' && !key.ctrl && !key.meta) setDraft(current => current + input)
  })

  if (viewport.maxHeight === 0 || viewport.compact) {
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(t('panel.auth.compact'), viewport.contentColumns))
  }

  const rows: Array<{ key: string; text: string; color?: string; bold?: boolean }> = []
  if (phase === 'methods') {
    if (error !== undefined) rows.push({ key: 'error', text: `  ${singleLineText(error)}`, color: inkColor(getPalette().error) })
    props.row.methods.forEach((method, index) => {
      rows.push({
        key: method.id,
        text: `${index === cursor ? '› ' : '  '}${displayText(method.label)}`,
        color: inkColor(index === cursor ? getPalette().brandBright : getPalette().dim),
      })
    })
  } else {
    notices.forEach((notice, index) => {
      rows.push({ key: `notice-${index}`, text: `  ${displayText(notice.message)}` })
      if (notice.url !== undefined) rows.push({ key: `url-${index}`, text: `  ${displayText(notice.url)}`, color: inkColor(getPalette().brandBright) })
      if (notice.code !== undefined) rows.push({ key: `code-${index}`, text: `  code ${displayText(notice.code)}`, color: inkColor(getPalette().success), bold: true })
    })
    if (prompt !== undefined) {
      rows.push({ key: 'prompt', text: `  ${displayText(prompt.message)}`, color: inkColor(getPalette().brandBright) })
      if (prompt.kind === 'select') {
        prompt.options.forEach((option, index) => rows.push({
          key: `option-${option.id}`,
          text: `${index === promptCursor ? '› ' : '  '}${displayText(option.label)}${option.description === undefined ? '' : ` · ${displayText(option.description)}`}`,
          color: inkColor(index === promptCursor ? getPalette().brandBright : getPalette().dim),
        }))
      } else {
        const shown = prompt.kind === 'secret' ? '•'.repeat([...draft].length) : displayText(draft)
        rows.push({ key: 'draft', text: `  ${shown}▏`, color: inkColor(getPalette().text) })
      }
    } else {
      rows.push({ key: 'waiting', text: `  ${t('panel.auth.waiting')}`, color: inkColor(getPalette().dim) })
    }
    if (copyState !== undefined) rows.push({ key: 'copy', text: `  ${singleLineText(copyState)}`, color: inkColor(copyState === 'copied' ? getPalette().success : getPalette().error) })
  }
  const visible = rows.slice(Math.max(0, rows.length - viewport.bodyRows))
  const footer = phase === 'methods'
    ? t('panel.auth.methodsFooter')
    : t('panel.auth.answerFooter')
  const accent = panelAccent('auth-login', getPalette().brand)
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(accent.border) },
    createElement(Text, { color: inkColor(accent.title), bold: true, wrap: 'truncate-end' }, truncateColumns(t('panel.auth.title', { provider: displayText(props.row.label) }), viewport.contentColumns)),
    ...visible.map(row => createElement(Text, { key: row.key, color: row.color, bold: row.bold, wrap: 'truncate-end' }, truncateColumns(row.text, viewport.contentColumns))),
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(footer, viewport.contentColumns)),
  )
}

export function ProviderAuthorizationLogoutPanel({ row, confirm, done, back }: {
  row: ProviderAuthorizationRow
  confirm: (row: ProviderAuthorizationRow) => Promise<void>
  done: () => void
  back: () => void
}): ReactElement {
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  useInput((input, key) => {
    if (busy) return
    if (key.escape || input === 'n' || input === 'N') {
      back()
      return
    }
    if (input !== 'y' && input !== 'Y') return
    setBusy(true)
    setError(undefined)
    void confirm(row).then(done, (reason: unknown) => {
      setBusy(false)
      setError(reason instanceof Error ? reason.message : String(reason))
    })
  })
  if (viewport.maxHeight === 0 || viewport.compact) return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(t('panel.auth.logoutCompact'), viewport.contentColumns))
  return createElement(
    Box,
    { flexDirection: 'column', width: viewport.outerColumns, paddingX: 1, borderStyle: 'round', borderColor: inkColor(getPalette().warn) },
    createElement(Text, { color: inkColor(getPalette().warn), bold: true, wrap: 'truncate-end' }, truncateColumns(t('panel.auth.logoutTitle'), viewport.contentColumns)),
    createElement(Text, { wrap: 'truncate-end' }, truncateColumns(`  ${t('panel.auth.removeRecord', { provider: displayText(row.label) })}`, viewport.contentColumns)),
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(`  ${t('panel.auth.unchanged')}`, viewport.contentColumns)),
    error === undefined ? undefined : createElement(Text, { color: inkColor(getPalette().error), wrap: 'truncate-end' }, truncateColumns(`  ${singleLineText(error)}`, viewport.contentColumns)),
    createElement(Text, { color: inkColor(getPalette().dim), wrap: 'truncate-end' }, truncateColumns(busy ? t('panel.auth.working') : t('panel.auth.logoutFooter'), viewport.contentColumns)),
  )
}
