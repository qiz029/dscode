import { createElement, useCallback, useEffect, useRef, useState } from 'react'
import { Box, Text, useInput, useStdout, type Key } from 'ink'
import { truncateColumns } from './render/text.ts'
import { PASTE_START_MARKER, PASTE_END_MARKER, PASTE_BRACKET_TIMEOUT_MS, stripPasteMarkers } from './keyboard.ts'

export interface CustomModel {
  id: string; name?: string; contextWindow?: number; maxTokens?: number
  contextSource?: string; outputSource?: string; thinking?: string
  inputModalities?: ('text' | 'image')[]
}
export interface CustomProfile {
  id: string; name: string; baseURL: string; api: string; auth: string
  backend: string; timeoutMs: number; models: CustomModel[]; credentialStatus?: string
}
interface Snapshot { providers: CustomProfile[]; revision: string }
interface ProbeStage { name: string; status: string; message?: string }
export interface CustomClient {
  list(): Promise<Snapshot>
  newProfile(): CustomProfile
  save(profile: CustomProfile, key: string, revision: string): Promise<Snapshot>
  remove(id: string, revision: string): Promise<Snapshot>
  discover(profile: CustomProfile, key: string, signal?: AbortSignal): Promise<{ backend: string; models: CustomModel[] }>
  test(profile: CustomProfile, model: string, key: string, signal?: AbortSignal): Promise<ProbeStage[]>
}
interface Row { label: string; value?: string; edit?: (value: string) => void; choices?: string[]; action?: () => void; secret?: boolean }
const protocols = ['chat-completions', 'responses', 'anthropic']
/** An endpoint/model edit invalidates facts reported by the previous deployment. */
export function clearReportedLimits(model: CustomModel): CustomModel {
  return { ...model,
    ...(model.contextSource === 'server' ? { contextWindow: undefined, contextSource: undefined } : {}),
    ...(model.outputSource === 'server' ? { maxTokens: undefined, outputSource: undefined } : {}),
  }
}
function useStableInput(handler: (input: string, key: Key) => void): void {
  const latest = useRef(handler); latest.current = handler
  useInput(useCallback((input: string, key: Key) => latest.current(input, key), []))
}
const clean = (s: string): string => s.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x1f\x7f]/g, ' ')

/** Each field owns input only after Enter. Pasted q, spaces and arrows never save a form. */
export function CustomProviderPanel({ client, initialId, select, back }: {
  client: CustomClient; initialId?: string
  select: (provider: string, model: string) => void; back: () => void
}) {
  const [snapshot, setSnapshot] = useState<Snapshot>({ providers: [], revision: '' })
  const [page, setPage] = useState<'list' | 'provider' | 'model' | 'discover' | 'remove'>('list')
  const [profile, setProfile] = useState<CustomProfile>(() => client.newProfile())
  const [modelIndex, setModelIndex] = useState(0)
  const [cursor, setCursor] = useState(0)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [key, setKey] = useState('')
  const [discovered, setDiscovered] = useState<CustomModel[]>([])
  const [adopted, setAdopted] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [report, setReport] = useState<{ model: string; stages: ProbeStage[] } | null>(null)
  const pending = useRef<AbortController | undefined>(undefined)
  const alive = useRef(true)
  const saving = useRef(false)
  const pasteUntil = useRef(0)
  const terminal = useStdout().stdout
  const width = Math.max(20, (terminal?.columns ?? 80) - 4)
  const height = Math.max(3, (terminal?.rows ?? 24) - 10)
  const go = (next: typeof page): void => { pasteUntil.current = 0; setPage(next); setCursor(0); setEditing(false); setError('') }
  const open = (p: CustomProfile): void => { setProfile(structuredClone(p)); setKey(''); setReport(null); go('provider') }
  useEffect(() => {
    alive.current = true
    void client.list().then(value => {
      if (!alive.current) return
      setSnapshot(value)
      const p = value.providers.find(p => p.id === initialId)
      if (p) open(p)
    }, () => { if (alive.current) setError('Could not read ~/.dscode/providers.yaml') })
    return () => { alive.current = false; pending.current?.abort() }
  }, [])
  const work = (operation: (signal: AbortSignal) => Promise<void>): void => {
    if (pending.current || saving.current) return
    const controller = new AbortController(); pending.current = controller
    setBusy(true); setError('')
    void operation(controller.signal).catch((reason: unknown) => {
      if (alive.current && !controller.signal.aborted) setError(clean(reason instanceof Error ? reason.message : String(reason)).split(key || '\u0000').join('[redacted]'))
    }).finally(() => { if (pending.current === controller) pending.current = undefined; if (alive.current) setBusy(false) })
  }
  const change = (value: Partial<CustomProfile>): void => { setProfile(p => ({ ...p, ...value })); setReport(null) }
  const model = profile.models[modelIndex]
  const changeModel = (value: Partial<CustomModel>): void => {
    change({ models: profile.models.map((m, i) => i === modelIndex ? { ...m, ...value } : m) })
  }
  const save = (switchModel?: string): void => work(async () => {
    saving.current = true
    try {
      const next = await client.save(profile, key, snapshot.revision)
      if (!alive.current) return
      setSnapshot(next); setKey('')
      if (switchModel) select(profile.id, switchModel)
      else go('list')
    } finally { saving.current = false }
  })
  const discover = (): void => work(async signal => {
    const result = await client.discover(profile, key, signal)
    if (signal.aborted || !alive.current) return
    change({ backend: result.backend }); setDiscovered(result.models)
    setAdopted(new Set(profile.models.map(m => m.id))); go('discover')
  })
  const rows: Row[] = []
  if (page === 'list') {
    rows.push(...snapshot.providers.map(p => ({ label: p.name, value: `${p.models.length} model(s) · ${p.credentialStatus ?? ''}`, action: () => open(p) })))
    rows.push({ label: '+ Add provider', action: () => open(client.newProfile()) })
  } else if (page === 'provider') {
    rows.push(
      { label: 'Name', value: profile.name, edit: v => change({ name: v }) },
      { label: 'Base URL', value: profile.baseURL, edit: v => { if (v !== profile.baseURL) change({ baseURL: v, backend: 'generic', models: profile.models.map(m => ({ ...clearReportedLimits(m), thinking: 'default', inputModalities: ['text'] })) }) } },
      { label: 'API format', value: profile.api, choices: protocols, edit: v => { if (v !== profile.api) change({ api: v, auth: v === 'anthropic' ? 'x-api-key' : 'bearer', models: profile.models.map(m => ({ ...m, inputModalities: ['text'] })) }) } },
      { label: 'Authentication', value: profile.auth, choices: ['none', 'bearer', 'x-api-key'], edit: v => change({ auth: v }) },
      { label: 'API key', value: key, secret: true, edit: v => { setKey(v); setReport(null) } },
      { label: 'Idle timeout (ms)', value: String(profile.timeoutMs), edit: v => change({ timeoutMs: Number(v) }) },
      { label: 'Discover models', action: discover },
      ...profile.models.map((m, i) => ({ label: m.id, value: m.contextWindow ? `${m.contextWindow} ctx · ${m.contextSource ?? 'user'}` : 'Context required', action: () => { setModelIndex(i); go('model') } })),
      { label: '+ Add model manually', action: () => { const i = profile.models.length; change({ models: [...profile.models, { id: '', thinking: 'default' }] }); setModelIndex(i); go('model') } },
      { label: 'Save', action: () => save() },
    )
    if (snapshot.providers.some(p => p.id === profile.id)) rows.push({ label: 'Remove provider…', action: () => go('remove') })
  } else if (page === 'model' && model) {
    rows.push(
      { label: 'Model ID', value: model.id, edit: v => { if (v !== model.id) changeModel({ ...clearReportedLimits(model), id: v, name: v, thinking: 'default', inputModalities: ['text'] }) } },
      { label: `Context (${model.contextSource ?? 'unknown'})`, value: model.contextWindow?.toString() ?? '', edit: v => changeModel({ contextWindow: v ? Number(v) : undefined, contextSource: 'user' }) },
      { label: `Output budget (${model.outputSource ?? 'default'})`, value: model.maxTokens?.toString() ?? '', edit: v => changeModel({ maxTokens: v ? Number(v) : undefined, outputSource: 'user' }) },
      { label: 'Thinking', value: model.thinking ?? 'default', choices: profile.backend === 'omlx' ? ['default', 'off', 'on'] : ['default'], edit: v => changeModel({ thinking: v }) },
      { label: 'Input', value: model.inputModalities?.includes('image') ? 'Text and images' : 'Text only', choices: ['Text only', 'Text and images'], edit: v => changeModel({ inputModalities: v === 'Text and images' ? ['text', 'image'] : ['text'] }) },
      { label: 'Test text, streaming and tools', action: () => work(async signal => {
        setReport(null)
        const stages = await client.test(profile, model.id, key, signal)
        if (!signal.aborted && alive.current) setReport({ model: model.id, stages })
      }) },
      { label: 'Save and switch to this model', action: () => { if (!model.contextWindow) setError('Enter a context window first'); else save(model.id) } },
      { label: 'Remove model from draft', action: () => { change({ models: profile.models.filter((_, i) => i !== modelIndex) }); go('provider') } },
      { label: 'Back to provider', action: () => go('provider') },
    )
  } else if (page === 'discover') {
    rows.push(...discovered.map(m => ({ label: `${adopted.has(m.id) ? '[x]' : '[ ]'} ${m.id}`, value: m.contextWindow ? `${m.contextWindow} ctx · server` : 'Context unknown', action: () => setAdopted(previous => { const next = new Set(previous); if (next.has(m.id)) next.delete(m.id); else next.add(m.id); return next }) })))
    rows.push({ label: 'Use selected models', action: () => {
      const merged = [...profile.models]
      for (const found of discovered.filter(m => adopted.has(m.id))) {
        const index = merged.findIndex(m => m.id === found.id), previous = merged[index]
        if (index < 0) merged.push(found)
        else merged[index] = { ...previous, ...found, thinking: previous.thinking,
          ...(previous.contextSource === 'user' ? { contextWindow: previous.contextWindow, contextSource: 'user' } : {}),
          ...(previous.outputSource === 'user' ? { maxTokens: previous.maxTokens, outputSource: 'user' } : {}) }
      }
      change({ models: merged }); go('provider')
    } })
  } else if (page === 'remove') {
    rows.push({ label: 'Cancel', action: () => go('provider') }, { label: `Remove ${profile.name} and its stored key`, action: () => work(async () => {
      saving.current = true
      try { const next = await client.remove(profile.id, snapshot.revision); if (alive.current) { setSnapshot(next); go('list') } }
      finally { saving.current = false }
    }) })
  }
  const selected = rows[Math.min(cursor, Math.max(0, rows.length - 1))]
  useStableInput((input, k) => {
    if (busy) { if ((k.escape || k.ctrl && input === 'c') && !saving.current) pending.current?.abort(); return }
    if (editing) {
      // Ink can strip ESC from bracketed-paste markers. Handle the whole paste
      // before key commands, including newline chunks that look like Enter.
      const startsPaste = input.includes(PASTE_START_MARKER), endsPaste = input.includes(PASTE_END_MARKER)
      if (startsPaste || endsPaste || Date.now() < pasteUntil.current) {
        pasteUntil.current = endsPaste ? 0 : Date.now() + PASTE_BRACKET_TIMEOUT_MS
        if (!selected?.choices) setDraft(v => (v + stripPasteMarkers(input).replace(/\x1b\[[0-9;]*[A-Za-z]/g, '').replace(/[\x00-\x1f\x7f]/g, '')).slice(0, 4096))
        return
      }
      if (k.escape) { setEditing(false); setDraft(''); return }
      if (k.return) { selected?.edit?.(draft); setDraft(''); setEditing(false); return }
      if (k.ctrl && input === 'c') { setDraft(''); back(); return }
      if (selected?.choices) {
        const choices = selected.choices
        if (k.leftArrow || k.upArrow || k.rightArrow || k.downArrow || k.tab) {
          setDraft(v => choices[(choices.indexOf(v) + (k.leftArrow || k.upArrow ? choices.length - 1 : 1)) % choices.length])
        }
        return
      }
      if (k.ctrl && input === 'u') { setDraft(''); return }
      if (k.backspace || k.delete) { setDraft(v => [...v].slice(0, -1).join('')); return }
      if (!k.ctrl && !k.meta && !k.upArrow && !k.downArrow && !k.leftArrow && !k.rightArrow && !k.tab) setDraft(v => (v + stripPasteMarkers(input).replace(/[\x00-\x1f\x7f]/g, '')).slice(0, 4096))
      return
    }
    if (k.ctrl && input === 'c') { back(); return }
    if (k.escape) { if (page === 'list') back(); else go(page === 'provider' ? 'list' : 'provider'); return }
    if (k.upArrow) { setCursor(v => (v + rows.length - 1) % rows.length); return }
    if (k.downArrow || k.tab) { setCursor(v => (v + 1) % rows.length); return }
    if (selected?.choices && (k.leftArrow || k.rightArrow || k.return)) {
      const i = selected.choices.indexOf(selected.value ?? '')
      setDraft(selected.choices[(i + (k.return ? 0 : k.leftArrow ? selected.choices.length - 1 : 1)) % selected.choices.length]); setEditing(true); return
    }
    if (k.return || page === 'discover' && input === ' ') {
      if (selected?.edit) { setDraft(selected.value ?? ''); setEditing(true) }
      else selected?.action?.()
    }
  })
  const first = Math.max(0, Math.min(cursor - height + 1, rows.length - height))
  const lines = rows.slice(first, first + height).map((row, index) => {
    const active = first + index === cursor
    const value = active && editing ? draft : row.value
    const shown = row.secret ? value ? '••••••••' : profile.credentialStatus ?? 'Optional; blank keeps saved key' : value
    return createElement(Text, { key: first + index, bold: active, wrap: 'truncate-end' }, truncateColumns(clean(`${active ? '› ' : '  '}${row.label}${shown === undefined ? '' : ': ' + shown}`), width))
  })
  return createElement(Box, { flexDirection: 'column', paddingX: 1 },
    createElement(Text, { bold: true }, `Custom${page === 'list' ? '' : ' · ' + clean(profile.name || 'New provider')}`),
    ...lines,
    ...(editing && selected?.choices ? selected.choices.map(choice => createElement(Text, { key: choice, bold: choice === draft, wrap: 'truncate-end' }, truncateColumns(`  ${choice === draft ? '›' : ' '} ${choice}`, width))) : []),
    report ? createElement(Text, { bold: true, wrap: 'truncate-end' }, truncateColumns(clean(`Test results: ${report.model}`), width)) : undefined,
    ...(report?.stages ?? []).map(s => createElement(Text, { key: s.name, color: s.status === 'failed' ? 'red' : undefined, wrap: 'truncate-end' }, truncateColumns(clean(`${s.name}: ${s.status}${s.message ? ' · ' + s.message : ''}`), width))),
    error ? createElement(Text, { color: 'red', wrap: 'truncate-end' }, truncateColumns(error, width)) : undefined,
    page === 'provider' && profile.baseURL ? createElement(Text, { dimColor: true, wrap: 'truncate-end' }, clean(`Request: ${profile.baseURL.replace(/\/+$/, '')}/${profile.api === 'anthropic' ? 'messages' : profile.api === 'responses' ? 'responses' : 'chat/completions'}`)) : undefined,
    createElement(Text, { dimColor: true }, busy ? 'Working… Esc cancels network requests' : editing ? selected?.choices ? '↑↓ choose · Enter apply · Esc cancel' : 'Enter apply · Ctrl+U clear · Esc cancel' : '↑↓ navigate · Enter edit/select · ←→ choice · Esc back'),
  )
}
