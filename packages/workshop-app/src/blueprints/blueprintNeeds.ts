import type { AiChatAuthorInfo, BlueprintBindingAssignment, BlueprintMetadata, ModelKind } from '@gadgets/workshop-shared/api'

/** A model a blueprint's author suggests, as they had it: its provider and its name there. */
export type SuggestedModel = { provider: string; modelName: string }

/**
 * One thing a blueprint needs before a gadget can be made from it (`BlueprintMetadata.bindings`),
 * keyed by the name its code knows it by: a resource of a connected service, one of the user's AI
 * models, or the model an agent the gadget starts runs on.
 */
export type BlueprintNeed = { key: string; title: string; description: string } & (
  | {
      type: 'connection'
      /** The service's id, as the vendor list has it (`GATEKEEPER_<NAME>`, lowercased). */
      vendorId: string
      /** The kind of resource it accepts (`SupportedResource.urlPattern`). */
      urlPattern: string
      /** The one the author had, offered to start the service's form with. */
      resourceUrl?: string
    }
  | { type: 'model'; kind: ModelKind; suggested?: SuggestedModel }
  /** `suggested` null: the author's ran with no model, which the agent can do too. */
  | { type: 'agent'; suggested?: SuggestedModel | null }
)

/** How a need is met so far, by its key; one not met is absent. */
export type NeedAnswers = Record<string, BlueprintBindingAssignment>

/** The user's models of each kind (`listModels()` and `listModels('decision')`). */
export type ModelsByKind = { language: readonly AiChatAuthorInfo[]; decision: readonly AiChatAuthorInfo[] }

const ORDER: Record<BlueprintNeed['type'], number> = { connection: 0, model: 1, agent: 2 }

/** What a blueprint needs: connections first, then models, then agents, each as the author named them. */
export const needsOf = (metadata: Pick<BlueprintMetadata, 'bindings'>): BlueprintNeed[] =>
  Object.entries(metadata.bindings)
    .map(([key, binding]): BlueprintNeed => {
      const named = { key, title: binding.title || key, description: binding.description }
      switch (binding.type) {
        case 'gatekeeper':
          return { ...named, type: 'connection', vendorId: binding.gatekeeperName.toLowerCase(), urlPattern: binding.typeUrlPattern, resourceUrl: binding.resourceUrl }
        case 'aiModel':
          return { ...named, type: 'model', kind: binding.modelKind ?? 'language', suggested: binding.suggestedModel }
        case 'agentSpawner':
          return { ...named, type: 'agent', suggested: binding.suggestedModel }
      }
    })
    .toSorted((a, b) => ORDER[a.type] - ORDER[b.type])

/** The models a need can be met with: those of its kind. */
export const modelsFor = (need: BlueprintNeed, models: ModelsByKind) =>
  need.type === 'model' && need.kind === 'decision' ? models.decision : models.language

/**
 * The one of `models` the author's suggestion names, as the user's own configuration calls it: by
 * its id or name, alone or after its provider; else the only one that mentions both. None when it
 * is ambiguous, rather than a guess.
 */
export const suggestedModelId = (models: readonly AiChatAuthorInfo[], suggested: SuggestedModel): string | undefined => {
  const provider = suggested.provider.trim().toLowerCase()
  const name = suggested.modelName.trim().toLowerCase()
  const exact = models.filter(({ id, name: shown }) =>
    [id.toLowerCase(), shown.toLowerCase()].includes(name) || [`${provider}/${name}`, `${provider}:${name}`].includes(id.toLowerCase()))
  if (exact.length === 1) return exact[0].id
  const loose = models.filter(({ id, name: shown }) => {
    const text = `${id} ${shown}`.toLowerCase()
    return text.includes(provider) && text.includes(name)
  })
  return loose.length === 1 ? loose[0].id : undefined
}

/**
 * How each model or agent need starts out met: with the model the author suggested where the user
 * has it, else the one they prefer, else their first of its kind. An agent whose author ran it with
 * no model starts with none. Connections start unmet: only the user can say which.
 */
export const initialAnswers = (needs: readonly BlueprintNeed[], models: ModelsByKind, preferred?: string): NeedAnswers => {
  const answers: NeedAnswers = {}
  for (const need of needs) {
    if (need.type === 'connection') continue
    if (need.type === 'agent' && need.suggested === null) {
      answers[need.key] = { type: 'agentSpawner', modelId: null }
      continue
    }
    const offered = modelsFor(need, models)
    const modelId = (need.suggested ? suggestedModelId(offered, need.suggested) : undefined)
      ?? offered.find(({ id }) => id === preferred)?.id
      ?? offered[0]?.id
    if (modelId === undefined) continue
    answers[need.key] = need.type === 'model' ? { type: 'aiModel', modelId } : { type: 'agentSpawner', modelId }
  }
  return answers
}

/** The needs not met yet. */
export const unmet = (needs: readonly BlueprintNeed[], answers: NeedAnswers) => needs.filter(({ key }) => !answers[key])

/** A resource's address as a line can show it: without its scheme or a trailing slash. */
export const shortResource = (url: string) => url.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/\/+$/, '')
