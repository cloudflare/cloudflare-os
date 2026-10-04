import { WORKERS_AI_OUTPUT_LIMIT } from '@gadgets/workshop-shared/api'
import type { AiModelProvider, GatewayModel } from '@gadgets/workshop-shared/api'

/** The public model list suggestions are read from. */
export const MODELS_DEV_URL = 'https://models.dev/api.json'

/**
 * A model models.dev lists, as the values the add-model form starts from. It carries no authority:
 * the server checks a model added from one exactly as it checks a hand-typed one.
 */
export type ModelSuggestion = GatewayModel

// Each provider's ID in models.dev, or null where models.dev has no list to suggest from: an Ollama
// server offers whatever its operator pulled. Total over AiModelProvider, so a provider added there
// does not compile until it is decided here.
const MODELS_DEV_PROVIDER_IDS: Record<AiModelProvider, string | null> = {
  anthropic: 'anthropic',
  openai: 'openai',
  google: 'google',
  cloudflare: 'cloudflare-workers-ai',
  ollama: null,
}

// The longest ID or name the server accepts for an added model.
const MAX_TEXT_LENGTH = 200

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** `value[key]`, or undefined unless `value` is an object with that key of its own. */
const own = (value: unknown, key: string): unknown =>
  isRecord(value) && Object.hasOwn(value, key) ? value[key] : undefined

const isTokenLimit = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0

/** `value` trimmed, or undefined unless that is an ID or name the server accepts. */
const acceptedText = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed && trimmed.length <= MAX_TEXT_LENGTH ? trimmed : undefined
}

/**
 * The models to suggest out of `modelsDev`, the parsed models.dev list: for each of `providers`, in
 * the order given, the models it lists that call tools, answer in text and state a context window,
 * in the order it lists them, without those it marks deprecated and those whose ID is among
 * `existingIds`. Whatever in
 * `modelsDev` is not shaped as expected is skipped, so a surprising document costs suggestions and
 * never throws.
 */
export const suggestModels = (
  modelsDev: unknown,
  providers: readonly AiModelProvider[],
  existingIds: readonly string[],
): ModelSuggestion[] => {
  const suggestions: ModelSuggestion[] = []
  for (const provider of new Set(providers)) {
    const providerId =
      Object.hasOwn(MODELS_DEV_PROVIDER_IDS, provider) ? MODELS_DEV_PROVIDER_IDS[provider] : null
    const models = providerId === null ? undefined : own(own(modelsDev, providerId), 'models')
    if (!isRecord(models)) continue
    // Grows with each suggestion, so one provider never offers the same ID twice.
    const taken = new Set(existingIds)
    for (const entry of Object.values(models)) {
      const id = acceptedText(own(entry, 'id'))
      const name = acceptedText(own(entry, 'name'))
      const outputs = own(own(entry, 'modalities'), 'output')
      const limit = own(entry, 'limit')
      const contextWindow = own(limit, 'context')
      const output = own(limit, 'output')
      if (!id || !name || taken.has(id)) continue
      if (own(entry, 'tool_call') !== true) continue
      if (!Array.isArray(outputs) || !outputs.includes('text')) continue
      if (!isTokenLimit(contextWindow)) continue
      if (own(entry, 'status') === 'deprecated') continue
      // An output limit is also reserved out of the window, so one that fills the window leaves a
      // prompt no room and is not suggested. models.dev states such limits for several Workers AI
      // models, where a request over the window is rejected, so a Cloudflare model takes none and
      // gets the server's Workers AI default. One whose window that default fills is left out.
      if (provider === 'cloudflare' && contextWindow <= WORKERS_AI_OUTPUT_LIMIT) continue
      const outputLimit =
        provider !== 'cloudflare' && isTokenLimit(output) && output < contextWindow
          ? output
          : undefined
      taken.add(id)
      suggestions.push({ provider, id, name, contextWindow, ...(outputLimit && { outputLimit }) })
    }
  }
  return suggestions
}

/**
 * Download models.dev's list, parsed and otherwise unchecked: suggestModels() is what reads it.
 * Rejects when the request fails or is aborted through `signal`, or when the answer is not JSON.
 */
export const fetchModelsDev = async (signal: AbortSignal): Promise<unknown> => {
  const response = await fetch(MODELS_DEV_URL, { signal, credentials: 'omit' })
  if (!response.ok) throw new Error(`models.dev answered ${response.status}`)
  return response.json()
}
