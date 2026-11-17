import { SUGGESTED_MODELS, type AiModelProvider, type ReasoningLevel } from '@gadgets/workshop-shared/api'

/** What there is to set of one model, which is not the same from one to the next. */
export type ModelOptions = {
  /**
   * The levels of reasoning it can be asked for, least to most. None for a model that does no
   * reasoning, and for one nothing is known of.
   */
  reasoningLevels: readonly ReasoningLevel[]
  /** The most one request to it may hold, in tokens, where that is known. */
  contextWindow?: number
}

// The levels a provider's models take. The backend knows them model by model, from its model
// runtime, but tells only an admin (`AdminModelView.reasoningLevels`): this stands in for that,
// by provider, until it tells the user too, and is only as right as a provider's models are alike.
const REASONING: Partial<Record<AiModelProvider, readonly ReasoningLevel[]>> = {
  anthropic: ['off', 'low', 'medium', 'high', 'max'],
  openai: ['minimal', 'low', 'medium', 'high', 'xhigh'],
  google: ['off', 'low', 'medium', 'high'],
}

const NOTHING_KNOWN: ModelOptions = { reasoningLevels: [] }

/**
 * What there is to set of the model `modelId` names: from the models the Workshop knows
 * (`SUGGESTED_MODELS`), by its id, whichever provider's it is. One it does not know, such as one
 * the user added under a name of their own, has nothing to offer here.
 */
export const modelOptionsOf = (modelId: string): ModelOptions => {
  for (const [provider, models] of Object.entries(SUGGESTED_MODELS)) {
    const known = models[modelId]
    if (known) return { reasoningLevels: REASONING[provider as AiModelProvider] ?? [], contextWindow: known.contextWindow }
  }
  return NOTHING_KNOWN
}

/** A number of tokens in a few characters, as models' limits are spoken of: 200K, 1M. */
export const formatTokens = (tokens: number) => {
  if (tokens >= 1_000_000) return `${Number((tokens / 1_000_000).toFixed(1))}M`
  return `${Math.round(tokens / 1000)}K`
}

// The sizes context windows are spoken of in, largest first.
const USUAL_WINDOWS = [1_000_000, 400_000, 200_000, 128_000, 64_000, 32_000]

/**
 * The context windows a model could be held to, by the number of tokens each is kept as: its own
 * first, which is kept as nothing, then the usual sizes that are less than it, largest first, or
 * all of them for a model whose own is not known.
 */
export const contextWindowPresets = (contextWindow: number | undefined): { id: string; label: string }[] => [
  { id: '', label: contextWindow === undefined ? 'Model default' : `${formatTokens(contextWindow)} (model default)` },
  ...USUAL_WINDOWS.filter((tokens) => contextWindow === undefined || tokens < contextWindow).map((tokens) => ({ id: String(tokens), label: formatTokens(tokens) })),
]
