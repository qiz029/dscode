/**
 * The /update panel: one bounded surface over the launcher update
 * pipeline. The panel never decides versions itself — it renders the
 * launcher `update --json` probe (plan plus refusals), takes one
 * confirmation, then streams `update --apply` progress and reports the
 * result with a restart hint. Every alignment guarantee (host pinned to
 * the release peers line, companion plugins carried, downgrade and
 * local-checkout refusals) lives in the launcher and is only displayed
 * here.
 */

import { createElement, useEffect, useState, type ReactElement } from 'react'
import { Box, Text, useInput, useStdout } from 'ink'
import type { LauncherUpdateStatus } from './update.ts'
import { clampScroll, panelViewport } from './render/inspector.ts'
import { singleLineText, truncateColumns } from './render/text.ts'
import { panelAccent } from './panel-accent.ts'
import { getPalette, inkColor } from './theme.ts'
import { t } from './i18n.ts'

/** Retained apply-progress lines (ring tail; npm output is ephemeral). */
export const UPDATE_OUTPUT_CAP = 800

/** Keep the newest UPDATE_OUTPUT_CAP lines of streamed update output. */
export function clipUpdateLines(lines: readonly string[]): readonly string[] {
  return lines.length <= UPDATE_OUTPUT_CAP ? lines : lines.slice(lines.length - UPDATE_OUTPUT_CAP)
}

/** One display row of the update surface. */
export interface UpdateRow {
  readonly key: string
  readonly text: string
  readonly tone?: 'ok' | 'warn' | 'error' | 'dim'
}

/** The plan view derived from one probe: facts to show and whether apply may run. */
export interface UpdatePlanView {
  readonly rows: readonly UpdateRow[]
  readonly runnable: boolean
}

/** Rendered facts of one probe: current/target versions, actions, refusals. */
export function updatePlanView(status: LauncherUpdateStatus): UpdatePlanView {
  const rows: UpdateRow[] = []
  const latest = status.code.latest ?? 'unknown'
  rows.push(status.aheadOfRegistry === true
    ? { key: 'code', text: `dsh-code    ${status.code.running} (newer than npm ${latest})` }
    : status.code.latest !== null && status.code.latest === status.code.running
      ? { key: 'code', text: `dsh-code    ${status.code.running} (latest)` }
      : { key: 'code', text: `dsh-code    ${status.code.running} → ${latest}` })
  if (status.host.targetLine === null) {
    rows.push({ key: 'host', text: 'harness     pinned line unreadable — update would install @deepseek-ai/dsh@latest', tone: 'warn' })
  } else if (status.host.installed === null) {
    rows.push({ key: 'host', text: `harness     not installed → ${status.host.targetLine}` })
  } else if (status.host.installed === status.host.targetLine) {
    rows.push({ key: 'host', text: `harness     ${status.host.installed} (on pinned line)` })
  } else {
    rows.push({ key: 'host', text: `harness     ${status.host.installed} → ${status.host.targetLine}` })
  }
  const mounted = status.profile.mounted === null
    ? status.profile.spec ?? 'not mounted'
    : `dsh-code ${status.profile.mounted}`
  rows.push({
    key: 'profile',
    text: `profile     ${mounted}${status.profile.localCheckout ? ' · local checkout' : ''}`,
    tone: status.profile.localCheckout ? 'dim' : undefined,
  })
  for (const plugin of status.plan.pluginSpecs) {
    rows.push({ key: `plugin:${plugin}`, text: `plugin      ${plugin}`, tone: 'dim' })
  }
  // A blocker key may be absent entirely (JSON.stringify drops undefined);
  // a missing value reads as "no blocker", never as an undefined row body.
  const registryBlocker = status.blockers.registry ?? null
  if (registryBlocker !== null) {
    rows.push({ key: 'blocker:registry', text: registryBlocker, tone: 'error' })
  }
  if (status.blockers.downgrade) {
    rows.push({
      key: 'blocker:downgrade',
      text: `refusing to downgrade the host: dsh-code@${latest} needs ${status.host.targetLine ?? 'the pinned line'}, but ${status.host.installed ?? 'the installed host'} is newer — wait for the next dsh-code release`,
      tone: 'error',
    })
  }
  const checkoutBlocker = status.blockers.localCheckout ?? null
  if (checkoutBlocker !== null) {
    for (const [index, line] of checkoutBlocker.entries()) {
      rows.push({ key: `blocker:checkout:${index}`, text: line, tone: 'error' })
    }
  }
  if (status.aheadOfRegistry === true) {
    rows.push({ key: 'ahead', text: 'this install is newer than npm latest — refusing to downgrade', tone: 'warn' })
  } else if (status.upToDate) {
    rows.push({ key: 'uptodate', text: 'everything is already on the pinned line — nothing to update', tone: 'ok' })
  }
  const runnable = status.upToDate !== true
    && registryBlocker === null
    && status.blockers.downgrade !== true
    && checkoutBlocker === null
  return { rows, runnable }
}

/** Panel lifecycle phases; the footer names the keys each phase accepts. */
export type UpdatePhase = 'probe' | 'error' | 'plan' | 'apply' | 'done'

/** Footer hint line per phase; the plan phase names the confirm key only when runnable. */
export function updateFooter(phase: UpdatePhase, runnable: boolean, upToDate: boolean, aheadOfRegistry = false): string {
  if (phase === 'probe') return t('panel.update.footer.probe')
  if (phase === 'error') return t('panel.update.footer.error')
  if (phase === 'apply') return t('panel.update.footer.apply')
  if (phase === 'done') return t('panel.update.footer.error')
  if (aheadOfRegistry) return t('panel.update.footer.ahead')
  if (upToDate) return t('panel.update.footer.current')
  return runnable ? t('panel.update.footer.update') : t('panel.update.footer.blocked')
}

/**
 * The /update surface: probe on open (and on r), confirm with enter/y,
 * stream the aligned apply, and land on a bounded result view. Escape is
 * locked while the apply child runs — killing npm mid-install is exactly
 * the half-updated state this command exists to prevent.
 */
export function UpdatePanel({ probe, apply, close, notify }: {
  /** Read-only probe of the launcher update status (never installs). */
  probe: () => Promise<LauncherUpdateStatus>
  /** Run the aligned update; streams sanitized progress lines. */
  apply: (onLine: (line: string) => void, plan: LauncherUpdateStatus['plan']) => Promise<number>
  /** Close the panel (App keeps ownership of the flag). */
  close: () => void
  /** One bounded cross-surface notice (phase completions). */
  notify: (text: string, tone?: 'info' | 'warning' | 'error') => void
}): ReactElement {
  const [phase, setPhase] = useState<UpdatePhase>('probe')
  const [status, setStatus] = useState<LauncherUpdateStatus>()
  const [probeError, setProbeError] = useState<string>()
  const [lines, setLines] = useState<readonly string[]>([])
  const [exit, setExit] = useState<number>()
  const [applyError, setApplyError] = useState<string>()
  // Viewport anchor: 'tail' follows new output; a number pins the first
  // visible row (up moves away from the tail, down onto it re-follows).
  const [anchor, setAnchor] = useState<'tail' | number>('tail')
  const [epoch, setEpoch] = useState(0)
  useEffect(() => {
    let disposed = false
    setPhase('probe')
    setStatus(undefined)
    setProbeError(undefined)
    setAnchor('tail')
    probe().then(value => {
      if (disposed) return
      setStatus(value)
      setPhase('plan')
    }, reason => {
      if (disposed) return
      setProbeError(reason instanceof Error ? reason.message : String(reason))
      setPhase('error')
    })
    return () => { disposed = true }
  }, [epoch, probe])
  const stdout = useStdout().stdout
  const viewport = panelViewport(stdout?.columns ?? 80, stdout?.rows ?? 30)
  const start = (): void => {
    if (phase !== 'plan' || status === undefined) return
    if (!updatePlanView(status).runnable) return
    setPhase('apply')
    setLines([])
    setExit(undefined)
    setApplyError(undefined)
    setAnchor('tail')
    apply(line => {
      setLines(previous => clipUpdateLines([...previous, singleLineText(line)]))
    }, status.plan).then(code => {
      setExit(code)
      setPhase('done')
      notify(code === 0 ? 'update installed — restart dsh to activate' : `update failed (exit ${code})`, code === 0 ? 'info' : 'error')
    }, reason => {
      const message = reason instanceof Error ? reason.message : String(reason)
      setApplyError(message)
      setPhase('done')
      notify(`update failed: ${message}`, 'error')
    })
  }
  const planView = status === undefined ? undefined : updatePlanView(status)
  const rows: readonly UpdateRow[] = phase === 'probe'
    ? [{ key: 'probe', text: 'checking npm for the aligned update…', tone: 'dim' }]
    : phase === 'error'
      ? [{ key: 'error', text: singleLineText(probeError ?? 'probe failed'), tone: 'error' }]
      : phase === 'plan' && planView !== undefined
        ? planView.rows
        : phase === 'apply'
          ? lines.map((line, index) => ({ key: `out:${index}`, text: line, tone: 'dim' as const }))
          : [
            ...(exit === 0 ? [{ key: 'ok', text: 'update installed — restart dsh to load the new version (/quit or ctrl+c)', tone: 'ok' as const }] : []),
            ...(exit !== undefined && exit !== 0 ? [{ key: 'fail', text: `update failed (exit ${exit})`, tone: 'error' as const }] : []),
            ...(applyError !== undefined ? [{ key: 'fail:start', text: singleLineText(applyError), tone: 'error' as const }] : []),
            ...lines.map((line, index) => ({ key: `out:${index}`, text: line, tone: 'dim' as const })),
          ]
  const budget = Math.max(1, viewport.bodyRows)
  const tailOffset = clampScroll(Math.max(0, rows.length - budget), rows.length, budget)
  const offset = anchor === 'tail' ? tailOffset : clampScroll(anchor, rows.length, budget)
  useInput((input, key) => {
    if (phase === 'apply') {
      // Scroll-only while the installer runs: escape stays locked.
      if (key.upArrow) setAnchor(offset <= 0 ? 0 : offset - 1)
      if (key.downArrow && offset >= tailOffset) setAnchor('tail')
      else if (key.downArrow) setAnchor(offset + 1)
      return
    }
    if (key.escape || input === 'q') return close()
    if (input === 'r') {
      setEpoch(value => value + 1)
      return
    }
    if (key.return || input === 'y') {
      void start()
      return
    }
    if (key.upArrow) setAnchor(offset <= 0 ? 0 : offset - 1)
    if (key.downArrow && offset >= tailOffset) setAnchor('tail')
    else if (key.downArrow) setAnchor(offset + 1)
  })
  if (viewport.maxHeight === 0 || viewport.compact) {
    const summary = phase === 'probe' ? t('panel.update.checking')
      : phase === 'error' ? t('panel.update.probeFailed')
      : phase === 'apply' ? singleLineText(lines[lines.length - 1] ?? t('panel.update.updating'))
      : phase === 'done' ? (exit === 0 ? t('panel.update.installed') : t('panel.update.failed'))
      : status?.aheadOfRegistry === true ? t('panel.update.aheadOfNpm') : status?.upToDate === true ? t('panel.update.upToDate') : planView?.runnable === true ? t('panel.update.enter') : t('panel.update.blocked')
    return createElement(Text, { wrap: 'truncate-end' }, truncateColumns(singleLineText(t('panel.update.compact', { summary })), viewport.contentColumns))
  }
  const visible = rows.slice(offset, offset + budget)
  const toneColor = (tone: UpdateRow['tone']): ReturnType<typeof inkColor> | undefined => tone === 'ok'
    ? inkColor(getPalette().success)
    : tone === 'error'
    ? inkColor(getPalette().error)
    : tone === 'warn'
    ? inkColor(getPalette().warn)
    : tone === 'dim'
    ? inkColor(getPalette().dim)
    : undefined
  const title = status === undefined
    ? t('panel.update.title')
    : status.aheadOfRegistry === true
      ? `/update · dsh-code ${status.code.running}`
      : `/update · dsh-code ${status.code.running}${status.code.latest !== null && status.code.latest !== status.code.running ? ` → ${status.code.latest}` : ''}`
  const accent = panelAccent('update', getPalette().dim, getPalette().brandBright)
  return createElement(
    Box,
    { width: viewport.outerColumns, borderStyle: 'round', borderColor: inkColor(accent.border), flexDirection: 'column', paddingX: 1 },
    createElement(Text, { color: inkColor(accent.title), wrap: 'truncate-end' }, truncateColumns(singleLineText(title), viewport.contentColumns)),
    ...visible.map(row => createElement(Text, {
      key: row.key,
      color: toneColor(row.tone),
      wrap: 'truncate-end',
    }, truncateColumns(`  ${singleLineText(row.text)}`, viewport.contentColumns))),
    createElement(Text, { dimColor: true, wrap: 'truncate-end' }, truncateColumns(singleLineText(updateFooter(phase, planView?.runnable ?? false, status?.upToDate === true, status?.aheadOfRegistry === true)), viewport.contentColumns)),
  )
}
