/** Staged editor for the Host-owned subagent model allowlist and default route. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsFormScope, SettingsFormShell } from '@deepseek-ai/dsh-client-ui-primitives'

/** Namespace of the Host-owned subagent model-selection preference. */
export const SUBAGENT_MODEL_SELECTION_NS = 'subagent-model-selection-settings'

/** One exact provider/model route stored as user authorization. */
export interface AllowedSubagentModel {
  provider: string
  model: string
}

/** The stored default child route, with its own reasoning effort. */
export interface DefaultSubagentModel extends AllowedSubagentModel {
  reasoningEffort?: string
}

/** Settings fields stored for subagent model selection. */
export interface SubagentModelSelectionSettings {
  /** Whether model-facing child route selection applies to new Sessions. */
  enabled: boolean
  /** Exact child routes offered to newly composed top-level Sessions. */
  allowedModels: AllowedSubagentModel[]
  /** Default child route applied when a call omits provider and model; null runs on the calling agent's route. */
  defaultModel: DefaultSubagentModel | null
}

/** One reasoning effort advertised for a candidate's model. */
export interface SubagentModelReasoningEffort {
  id: string
  name: string
}

/** One catalog row joined with a stored route that may no longer be advertised. */
export interface SubagentModelCandidate extends AllowedSubagentModel {
  /** Stable opaque identity used only for lookup. */
  key: string
  /** Adapter-owned provider display name. */
  providerName: string
  /** Adapter-owned model display name. */
  modelName: string
  /** Whether the current adapter catalog advertises this exact route. */
  available: boolean
  /** Whether the current draft authorizes this route. */
  selected: boolean
  /** Reasoning efforts and default advertised for this route, when the live catalog carries them. */
  reasoning?: { efforts: readonly SubagentModelReasoningEffort[]; defaultEffort?: string }
}

/** State rendered by the staged allowlist card. */
export interface SubagentModelSelectionCardState extends SettingsFormShell {
  /** Whether the draft enables model-facing child route selection. */
  enabled: boolean
  /** Live catalog joined with stored routes. */
  candidates: readonly SubagentModelCandidate[]
  /** Adapter-directory request state. */
  catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
  /** Whether any provider-local catalog request failed. */
  catalogPartial: boolean
  /** Whether a newer Host revision invalidated the current draft. */
  conflicted: boolean
  /** Staged default child route, among the currently checked routes; null runs on the calling agent's route. */
  defaultModel: AllowedSubagentModel | null
  /** Staged reasoning effort for the default route; undefined uses the model's own default. */
  defaultEffort: string | undefined
}

/** Registration-side face for the subagent model-selection card. */
export interface SubagentModelSelectionCardFace {
  hooks: {
    /** Card snapshot bound by the renderer as useSubagentModelSelectionCard. */
    subagentModelSelectionCard: SnapshotStore<SubagentModelSelectionCardState>
  }
  /** Stage the enabled state; enabling also loads the adapter directory. */
  toggleEnabled: () => void
  /** Stage one exact route as allowed or denied. Removing the default's route also clears the default. */
  toggleModel: (key: string) => void
  /** Stage the default child route by candidate key, or null to run on the calling agent's route. */
  setDefaultModel: (key: string | null) => void
  /** Stage the default route's reasoning effort, or undefined for the model's own default. */
  setDefaultEffort: (effort: string | undefined) => void
  /** Retry the adapter directory. */
  retryCatalog: () => void
  /** Persist the switch, exact routes, and default route as one revision-fenced mutation. */
  save: () => void
  /** Drop the staged enabled state, route choices, and default route. */
  discard: () => void
}

/** One staged default-route choice: a route plus its own effort, or no default. */
interface DraftDefault {
  route: AllowedSubagentModel | null
  effort: string | undefined
}

/**
 * Stable identity for one exact route; callers resolve it by lookup and never parse it.
 * @param route - Provider/model route to identify.
 * @returns Opaque key for lookup within the card.
 */
export function subagentModelKey(route: AllowedSubagentModel): string {
  return `${route.provider}\0${route.model}`
}

/**
 * Join live adapter metadata with stored routes that remain removable after disappearance.
 * @param groups - Current model directory grouped by provider.
 * @param stored - Routes in the effective settings value.
 * @param selected - Opaque route keys selected in the current draft.
 * @returns Candidate rows for the card.
 */
export function subagentModelCandidates(
  groups: readonly ModelProviderGroup[],
  stored: readonly AllowedSubagentModel[],
  selected: ReadonlySet<string>,
): SubagentModelCandidate[] {
  const storedByKey = new Map(stored.map(route => [subagentModelKey(route), route]))
  const candidates = groups.flatMap(group => group.models.map((model): SubagentModelCandidate => {
    const route = { provider: group.id, model: model.id }
    const key = subagentModelKey(route)
    storedByKey.delete(key)
    return {
      ...route,
      key,
      providerName: group.name,
      modelName: model.name,
      available: true,
      selected: selected.has(key),
      ...model.reasoning === undefined ? {} : { reasoning: model.reasoning },
    }
  }))
  for (const route of storedByKey.values()) {
    const key = subagentModelKey(route)
    candidates.push({
      ...route,
      key,
      providerName: route.provider,
      modelName: route.model,
      available: false,
      selected: selected.has(key),
    })
  }
  return candidates
}

function sameRoutes(left: readonly AllowedSubagentModel[], right: readonly AllowedSubagentModel[]): boolean {
  if (left.length !== right.length) return false
  const rightKeys = new Set(right.map(subagentModelKey))
  return left.every(route => rightKeys.has(subagentModelKey(route)))
}

/** Whether two staged default routes (with their effort) are the same value. */
function sameDefault(left: DraftDefault, right: DraftDefault): boolean {
  if (left.route === null || right.route === null) return left.route === null && right.route === null
  return subagentModelKey(left.route) === subagentModelKey(right.route) && left.effort === right.effort
}

/** Bridges one configuration form and the live adapter directory onto a staged card. */
export class SubagentModelSelectionCardController {
  private catalogGroups: readonly ModelProviderGroup[] = []
  private catalogPartial = false
  private catalogStatus: SubagentModelSelectionCardState['catalogStatus'] = 'idle'
  private draftEnabled: boolean | undefined
  private draftRoutes: Map<string, AllowedSubagentModel> | undefined
  private draftDefault: DraftDefault | undefined
  private draftRevision: number | undefined
  private saving = false
  private failed = false
  private conflicted = false
  private disposed = false
  private saveGeneration = 0
  private catalogGeneration = 0
  private readonly store: SnapshotStore<SubagentModelSelectionCardState>
  private readonly unsubscribe: () => void

  /**
   * @param scope - bound `subagent-model-selection` configuration form.
   * @param ctx - the card plugin's context, whose `remote.session` namespace
   * answers the Host model catalog.
   */
  constructor(
    private readonly scope: SettingsFormScope<SubagentModelSelectionSettings>,
    private readonly ctx: ClientContext,
  ) {
    this.store = createSnapshotStore(this.projection())
    this.unsubscribe = scope.subscribe(() => {
      if (!this.saving && this.draftRoutes !== undefined
        && this.scope.getSnapshot().revision !== this.draftRevision) {
        if (this.currentEnabled() === this.enabled()
          && sameRoutes(this.currentRoutes(), this.desiredRoutes())
          && sameDefault(this.currentDefault(), this.effectiveDefault())) this.clearDraft()
        else this.conflicted = true
      }
      if (this.enabled() && this.catalogStatus === 'idle') void this.loadCatalog()
      this.publish()
    })
    if (this.enabled() && this.catalogStatus === 'idle') void this.loadCatalog()
  }

  /** Stop observing settings and suppress late directory/write settlements. */
  dispose(): void {
    this.disposed = true
    this.saveGeneration += 1
    this.catalogGeneration += 1
    this.unsubscribe()
  }

  /**
   * Build the renderer face for this card.
   * @returns The snapshot and staged card actions injected into the renderer.
   */
  inject(): SubagentModelSelectionCardFace {
    return {
      hooks: { subagentModelSelectionCard: this.store },
      toggleEnabled: () => { this.toggleEnabled() },
      toggleModel: (key) => { this.toggleModel(key) },
      setDefaultModel: (key) => { this.setDefaultModel(key) },
      setDefaultEffort: (effort) => { this.setDefaultEffort(effort) },
      retryCatalog: () => { void this.loadCatalog() },
      save: () => { void this.save() },
      discard: () => { this.discard() },
    }
  }

  private currentRoutes(): AllowedSubagentModel[] {
    return this.scope.getSnapshot().value?.allowedModels.map(route => ({ ...route })) ?? []
  }

  private currentEnabled(): boolean {
    return this.scope.getSnapshot().value?.enabled ?? false
  }

  private currentDefault(): DraftDefault {
    const value = this.scope.getSnapshot().value?.defaultModel
    if (value === null || value === undefined) return { route: null, effort: undefined }
    const { reasoningEffort, ...route } = value
    return { route: { ...route }, effort: reasoningEffort }
  }

  private selected(): Set<string> {
    return new Set(this.draftRoutes?.keys() ?? this.currentRoutes().map(subagentModelKey))
  }

  private enabled(): boolean {
    return this.draftEnabled ?? this.currentEnabled()
  }

  /** The default draft as staged, or the current value while untouched. */
  private effectiveDefault(): DraftDefault {
    return this.draftDefault ?? this.currentDefault()
  }

  private beginDraft(): Map<string, AllowedSubagentModel> {
    if (this.draftRoutes === undefined) {
      const snapshot = this.scope.getSnapshot()
      this.draftEnabled = snapshot.value?.enabled ?? false
      this.draftRoutes = new Map(
        snapshot.value?.allowedModels.map(route => [subagentModelKey(route), { ...route }]) ?? [],
      )
      this.draftDefault = this.currentDefault()
      this.draftRevision = snapshot.revision
    }
    return this.draftRoutes
  }

  private toggleEnabled(): void {
    const snapshot = this.scope.getSnapshot()
    if (this.disposed || snapshot.status !== 'ready' || !snapshot.writable || this.saving) return
    this.beginDraft()
    this.draftEnabled = !this.draftEnabled
    this.failed = false
    if (this.draftEnabled && this.catalogStatus === 'idle') void this.loadCatalog()
    this.publish()
  }

  private toggleModel(key: string): void {
    if (!this.enabled() || this.saving || !this.scope.getSnapshot().writable) return
    const candidate = this.candidates().find(candidate => candidate.key === key)
    if (candidate === undefined) return
    const routes = this.beginDraft()
    if (routes.has(key)) {
      routes.delete(key)
      // A route no longer authorized cannot remain the default.
      const current = this.effectiveDefault()
      if (current.route !== null && subagentModelKey(current.route) === key) {
        this.draftDefault = { route: null, effort: undefined }
      }
    } else {
      routes.set(key, { provider: candidate.provider, model: candidate.model })
    }
    this.failed = false
    this.publish()
  }

  private setDefaultModel(key: string | null): void {
    if (!this.enabled() || this.saving || !this.scope.getSnapshot().writable) return
    this.beginDraft()
    if (key === null) {
      this.draftDefault = { route: null, effort: undefined }
      this.publish()
      return
    }
    const candidate = this.candidates().find(entry => entry.key === key)
    if (candidate === undefined || !candidate.selected) return
    this.draftDefault = { route: { provider: candidate.provider, model: candidate.model }, effort: undefined }
    this.publish()
  }

  private setDefaultEffort(effort: string | undefined): void {
    if (!this.enabled() || this.saving || !this.scope.getSnapshot().writable) return
    this.beginDraft()
    const current = this.effectiveDefault()
    if (current.route === null) return
    this.draftDefault = { route: current.route, effort }
    this.publish()
  }

  private clearDraft(): void {
    this.draftEnabled = undefined
    this.draftRoutes = undefined
    this.draftDefault = undefined
    this.draftRevision = undefined
    this.failed = false
    this.conflicted = false
  }

  private discard(): void {
    if (this.saving) return
    this.clearDraft()
    this.publish()
  }

  private candidates(): SubagentModelCandidate[] {
    const retained = new Map(this.currentRoutes().map(route => [subagentModelKey(route), route]))
    for (const [key, route] of this.draftRoutes ?? []) retained.set(key, route)
    return subagentModelCandidates(this.catalogGroups, [...retained.values()], this.selected())
  }

  private desiredRoutes(): AllowedSubagentModel[] {
    return [...this.draftRoutes?.values() ?? this.currentRoutes()].map(route => ({ ...route }))
  }

  /** The default value to persist, in the settings wire shape. */
  private desiredDefault(): DefaultSubagentModel | null {
    const { route, effort } = this.effectiveDefault()
    if (route === null) return null
    return { provider: route.provider, model: route.model, ...effort === undefined ? {} : { reasoningEffort: effort } }
  }

  private async save(): Promise<void> {
    const snapshot = this.scope.getSnapshot()
    const desiredEnabled = this.enabled()
    const desired = this.desiredRoutes()
    const desiredDefault = this.effectiveDefault()
    if (this.disposed || snapshot.status !== 'ready' || !snapshot.writable || this.saving
      || (this.currentEnabled() === desiredEnabled && sameRoutes(this.currentRoutes(), desired)
        && sameDefault(this.currentDefault(), desiredDefault))
      || (desiredEnabled && desired.length === 0)) return
    if (this.draftRoutes !== undefined && snapshot.revision !== this.draftRevision) {
      this.conflicted = true
      this.publish()
      return
    }
    const generation = this.saveGeneration
    this.saving = true
    this.failed = false
    this.conflicted = false
    this.publish()
    await this.scope.mutate([
      { op: 'set', path: ['enabled'], value: desiredEnabled },
      {
        op: 'set',
        path: ['allowedModels'],
        value: desired.map(route => ({ provider: route.provider, model: route.model })),
      },
      { op: 'set', path: ['defaultModel'], value: this.desiredDefault() },
    ], this.draftRevision)
    if (generation !== this.saveGeneration) return
    const landed = this.currentEnabled() === desiredEnabled && sameRoutes(this.currentRoutes(), desired)
      && sameDefault(this.currentDefault(), desiredDefault)
    this.saving = false
    this.failed = !landed
    if (landed) this.clearDraft()
    this.publish()
  }

  /** Invalidate and reload model candidates after a Host model input changes. */
  refreshCatalog(): void {
    if (this.disposed) return
    this.catalogGeneration += 1
    this.catalogStatus = 'idle'
    this.catalogPartial = false
    if (this.enabled()) void this.loadCatalog()
    else this.publish()
  }

  /** Drop Host-specific candidates and drafts, then reload after reconnecting. */
  resetConnection(): void {
    if (this.disposed) return
    this.saveGeneration += 1
    this.saving = false
    this.clearDraft()
    this.catalogGroups = []
    this.refreshCatalog()
  }

  private async loadCatalog(): Promise<void> {
    if (this.disposed || this.catalogStatus === 'loading') return
    const generation = this.catalogGeneration
    this.catalogStatus = 'loading'
    this.catalogPartial = false
    this.publish()
    const response = await this.ctx.remote.session.modelCatalog()
    if (generation !== this.catalogGeneration) return
    if (response.ok) {
      this.catalogGroups = response.value.groups
      this.catalogPartial = response.value.failures.length > 0
      this.catalogStatus = 'ready'
    } else {
      this.catalogStatus = 'error'
    }
    this.publish()
  }

  private projection(): SubagentModelSelectionCardState {
    const snapshot = this.scope.getSnapshot()
    const current = this.currentRoutes()
    const desired = this.desiredRoutes()
    const enabled = this.enabled()
    const effectiveDefault = this.effectiveDefault()
    return {
      available: snapshot.status === 'ready',
      writable: snapshot.writable,
      dirty: this.currentEnabled() !== enabled || !sameRoutes(current, desired)
        || !sameDefault(this.currentDefault(), effectiveDefault),
      invalid: enabled && desired.length === 0,
      saving: this.saving,
      failed: this.failed,
      enabled,
      candidates: this.candidates(),
      catalogStatus: this.catalogStatus,
      catalogPartial: this.catalogPartial,
      conflicted: this.conflicted,
      defaultModel: effectiveDefault.route,
      defaultEffort: effectiveDefault.effort,
    }
  }

  private publish(): void {
    this.store.set(this.projection())
  }
}
