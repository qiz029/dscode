/**
 * Model directory for the `/model` panel: the in-process equivalent of the
 * web host's model catalog (`buildModelCatalog`), reading the advisory
 * `ctx.llm` registry directly. Catalog membership is advisory — a route
 * serving a model it stopped advertising stays usable — so selection never
 * fails on catalog absence alone.
 *
 * @module @deepseek-ai/dsh-tui/models
 */

import type { Context } from '@deepseek-ai/cordis'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  ReasoningEffortId,
  type LlmCallConfig,
  type LlmModelInfo,
  type LlmModelReasoningInfo,
  type LlmResolvedModelInfo,
  type ModelModality,
} from '@deepseek-ai/dsh-llm'

/** Display metadata for one adapter-owned reasoning effort (mirrors `LlmReasoningEffortInfo`). */
export interface ModelReasoningEffort {
  /** Opaque value accepted by the model's `GenerateOptions.reasoningEffort`. */
  id: string
  /** Human-readable effort name for selectors. */
  name: string
  /** Optional user-facing distinction from otherwise similar efforts. */
  description?: string
}

/** Selectable reasoning efforts for one model (mirrors `LlmModelReasoningInfo`). */
export interface ModelReasoning {
  /** Supported efforts in adapter-preferred display order. */
  efforts: readonly ModelReasoningEffort[]
  /** Adapter-configured default materialized when callers omit an effort. */
  defaultEffort?: string
}

/** One selectable row in the `/model` panel. */
export interface ModelRow {
  /** Registered provider route. */
  provider: string
  /** Display name of the provider route. */
  providerName: string
  /** Provider-owned model id. */
  model: string
  /** Human-readable model name. */
  modelName: string
  /** Request modalities advertised for this exact route; absent means unknown. */
  inputModalities?: readonly ModelModality[]
  /** Adapter-owned selectable reasoning levels when the model exposes any. */
  reasoning?: ModelReasoning
}

/** Preserve an advertised effort, otherwise use the target model's own default. */
export function resolveModelEffort(row: ModelRow, current?: string): string | undefined {
  const reasoning = row.reasoning
  const offered = reasoning?.efforts ?? []
  if (current && offered.some(effort => effort.id === current)) return current
  return offered.find(effort => effort.id === reasoning?.defaultEffort)?.id
}

/** The resolved directory: rows plus per-provider discovery failures. */
export interface ModelDirectory {
  /** Advisory rows, provider-major in registry order. */
  rows: readonly ModelRow[]
  /** Provider ids whose model listing failed; those providers contribute no rows. */
  failures: readonly string[]
  /**
   * `provider/model` labels whose per-model capability lookup failed. Those
   * rows still appear (advisory degrade, mirroring the web catalog), but
   * without an effort picker — a picker caller must not misread the absence
   * as "this model exposes no reasoning" (e.g. deepseek-v4-flash always
   * advertises off/high/max unless thinking is disabled). Optional for
   * callers that shape a directory by hand; {@link loadModelDirectory}
   * always populates it (empty when nothing failed).
   */
  reasoningFailures?: readonly string[]
}

/** Map an adapter's reasoning capability onto the panel's plain-id shape. */
export function mapReasoning(reasoning: LlmModelReasoningInfo): ModelReasoning {
  return {
    efforts: reasoning.efforts.map(effort => ({
      id: effort.id,
      name: effort.name,
      ...effort.description === undefined ? {} : { description: effort.description },
    })),
    ...reasoning.defaultEffort === undefined ? {} : { defaultEffort: reasoning.defaultEffort },
  }
}

/**
 * Resolve the effective model selection for one live session, in the
 * documented precedence: the in-process explicit pick, then the session's
 * last `request/header` config, then the deployment default.
 * @param picked - the explicit selection made in this process, when any.
 * @param logged - the last logged request header config, when any.
 * @param defaults - the deployment default selection.
 * @returns the effective selection, carrying a reasoning effort when one is in force.
 */
export function resolveEffectiveSelection(
  picked: ModelSelection | undefined,
  logged: { provider: string; model: string; reasoningEffort?: string } | undefined,
  defaults: ModelSelection,
): ModelSelection {
  if (picked !== undefined) return picked
  if (logged !== undefined) {
    return {
      provider: logged.provider,
      model: logged.model,
      ...logged.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: ReasoningEffortId(logged.reasoningEffort) },
    }
  }
  return defaults
}

/** Structural equality of two selections (upstream `sameSelection`). */
function sameModelSelection(left: ModelSelection, right: ModelSelection): boolean {
  return left.provider === right.provider
    && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

/**
 * The session log's unconsumed explicit model selection (the resume layer of
 * the documented precedence). `model/selection` events are log-only facts the
 * web host's session-controller appends when its user picks a model for the
 * NEXT request; a request header assembling exactly that selection retires
 * it, while a header for different values (another route forced the request)
 * leaves it armed. Seeding the resumed pick from here restores a selection
 * that was made but never sent — the request header alone would answer with
 * the older model.
 * @param events - the full persisted event list of the resumed session.
 * @returns the still-pending selection, when one exists.
 */
export function pendingModelSelection(events: readonly SessionEvent[]): ModelSelection | undefined {
  let pending: ModelSelection | undefined
  for (const event of events) {
    // The event map merge lives in @deepseek-ai/dsh-api-session-controller,
    // which this bundle does not depend on; the string guard keeps the fold
    // decoupled while matching the typed upstream projection exactly.
    if ((event.type as string) === 'model/selection') {
      const data = event.data as Partial<ModelSelection>
      if (typeof data.provider === 'string' && typeof data.model === 'string') {
        const selection: ModelSelection = {
          provider: data.provider,
          model: data.model,
          ...data.reasoningEffort === undefined ? {} : { reasoningEffort: data.reasoningEffort },
        }
        if (pending === undefined || !sameModelSelection(pending, selection)) pending = selection
      }
      continue
    }
    if (event.type === 'request/header') {
      const config = event.data.header.config
      if (pending !== undefined && sameModelSelection(pending, {
        provider: config.provider,
        model: config.model,
        ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
      })) {
        pending = undefined
      }
    }
  }
  return pending
}

/**
 * Build the selection one `/model` pick applies, rejecting an effort the
 * row does not advertise. The row is the picker's source of truth, so a
 * stale directory cannot smuggle an unsupported effort into the next step
 * (the request pipeline would reject it before network I/O regardless). The
 * empty string is the picker's "provider default" sentinel — an explicit
 * choice to leave the effort to the model's own default, exactly like an
 * absent effort.
 * @param row - the picked model row.
 * @param effortId - the chosen advertised effort, '' or undefined for the model default.
 * @returns the selection the runner records for the next assembled step.
 */
export function buildModelSelection(row: ModelRow, effortId?: string): ModelSelection {
  const selected = effortId === undefined || effortId === '' ? undefined : effortId
  if (selected !== undefined
    && (row.reasoning === undefined || !row.reasoning.efforts.some(effort => effort.id === selected))) {
    throw new Error(`model ${row.provider}/${row.model} does not support reasoning effort "${selected}"`)
  }
  return {
    provider: row.provider,
    model: row.model,
    ...selected === undefined ? {} : { reasoningEffort: ReasoningEffortId(selected) },
  }
}

/** Display label for one applied selection: `provider/model` or `provider/model@effort`. */
export function modelSelectionLabel(selection: ModelSelection): string {
  return selection.reasoningEffort === undefined
    ? `${selection.provider}/${selection.model}`
    : `${selection.provider}/${selection.model}@${selection.reasoningEffort}`
}

/**
 * Apply one model selection onto a resolved request config — the exact
 * semantics of the kernel's `installModelSelection` request listener,
 * extracted so the TUI can mirror it for subagent-origin requests: children
 * spawned by the subagent tool inherit the parent's CREATE-TIME AgentOptions,
 * which a mid-session /model switch never touches, so delegated work would
 * otherwise keep running on the launch-time route. An absent effort strips
 * any inherited effort (restoring the selected model's provider default),
 * matching the kernel listener field-for-field.
 * @param resolved - the config the inner chain produced.
 * @param selection - the selection to enforce.
 * @returns the overridden config.
 */
export function applyModelSelectionToConfig(resolved: LlmCallConfig, selection: ModelSelection): LlmCallConfig {
  const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
  return {
    ...withoutInheritedEffort,
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: selection.reasoningEffort },
  }
}

/**
 * Load the selectable model directory from the live `ctx.llm` registry.
 * Providers are listed synchronously; each provider's models are discovered
 * with a bounded parallel fan-out whose failures degrade to that provider
 * contributing no rows (mirrors the web catalog's per-provider failures).
 * Each row's reasoning levels are resolved per exact model like the web
 * catalog (`buildModelCatalog`); a single model's capability lookup failure
 * degrades to that row having no effort picker rather than hiding the model,
 * and the failure rides `reasoningFailures` so the caller can tell "no
 * advertised reasoning" from "capability lookup failed".
 * @param ctx - context carrying the `llm` service.
 * @returns the resolved directory; empty rows when `llm` is unavailable.
 */
export async function loadModelDirectory(ctx: Context): Promise<ModelDirectory> {
  const llm = ctx.get('llm')
  if (llm === undefined) return { rows: [], failures: [], reasoningFailures: [] }
  // Call resolveModelInfo AS A METHOD (llm.resolveModelInfo(...)): destructured
  // off the service it loses `this` — this.registration() then throws on the
  // first provider, the catch swallows it, and every row lands in
  // reasoningFailures ("capability lookup failed") even though the adapter
  // itself never fails.
  const llmResolve = llm as { resolveModelInfo?: (provider: string, model: string) => Promise<LlmResolvedModelInfo> }
  const providers = llm.listProviders()
  const listed = await Promise.all(providers.map(async (provider) => {
    try {
      const models: readonly LlmModelInfo[] = await llm.listModels(provider.id)
      const reasoningFailures: string[] = []
      const rows = await Promise.all(models.map(async (model): Promise<ModelRow> => {
        const row: ModelRow = {
          provider: provider.id,
          providerName: provider.name,
          model: model.id,
          modelName: model.name,
          ...model.inputModalities === undefined ? {} : { inputModalities: [...model.inputModalities] },
        }
        if (llmResolve.resolveModelInfo === undefined) return row
        try {
          const resolved = await llmResolve.resolveModelInfo(provider.id, model.id)
          return {
            ...row,
            ...resolved.inputModalities === undefined ? {} : { inputModalities: [...resolved.inputModalities] },
            ...resolved.reasoning === undefined ? {} : { reasoning: mapReasoning(resolved.reasoning) },
          }
        } catch {
          reasoningFailures.push(`${provider.id}/${model.id}`)
          return row
        }
      }))
      return {
        provider: provider.id,
        providerName: provider.name,
        models: rows,
        reasoningFailures,
      }
    } catch {
      return { provider: provider.id, providerName: provider.name, models: [] as ModelRow[], failed: true }
    }
  }))
  const rows = listed.flatMap(entry => entry.models)
  const failures = listed.filter(entry => 'failed' in entry && entry.failed === true).map(entry => entry.provider)
  const reasoningFailures = listed.flatMap(entry => 'failed' in entry ? [] : entry.reasoningFailures)
  return { rows, failures, reasoningFailures }
}
