import { REASONING_LEVELS, WORKERS_AI_OUTPUT_LIMIT } from '@gadgets/workshop-shared/api'
import type {
  AiModelProvider,
  GatewayModel,
  GatewayModelCapabilities,
  ReasoningLevel,
} from '@gadgets/workshop-shared/api'

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
 * The reasoning levels the models.dev `entry` states for its model, least to most, or undefined
 * where it states none: "off" alone for a model it says does no reasoning, and otherwise the
 * efforts it names, of which "none" is "off". Of the ways it lists to set a model's reasoning only
 * the efforts are levels: a switch and a token budget name none, and a switch does not say that
 * the model takes "off" as an effort. Efforts with no level above "off" among them state nothing,
 * since they would state a model that does no reasoning.
 */
const statedReasoningLevels = (entry: unknown): ReasoningLevel[] | undefined => {
  if (own(entry, 'reasoning') === false) return ['off']
  const options = own(entry, 'reasoning_options')
  const efforts = new Set((Array.isArray(options) ? options : []).flatMap((option) => {
    const values = own(option, 'type') === 'effort' ? own(option, 'values') : undefined
    return Array.isArray(values) ? values.map((effort) => (effort === 'none' ? 'off' : effort)) : []
  }))
  const levels = REASONING_LEVELS.filter((level) => efforts.has(level))
  return levels.some((level) => level !== 'off') ? levels : undefined
}

/**
 * What the models.dev `entry` states that its model can do, or undefined where it states nothing of
 * it: whether the kinds of input it lists include images, and its reasoning levels (see
 * statedReasoningLevels).
 */
const statedCapabilities = (entry: unknown): GatewayModelCapabilities | undefined => {
  const inputs = own(own(entry, 'modalities'), 'input')
  const reasoningLevels = statedReasoningLevels(entry)
  const capabilities: GatewayModelCapabilities = {}
  if (Array.isArray(inputs)) capabilities.imageInput = inputs.includes('image')
  if (reasoningLevels) capabilities.reasoningLevels = reasoningLevels
  return Object.keys(capabilities).length > 0 ? capabilities : undefined
}

/**
 * The models to suggest out of `modelsDev`, the parsed models.dev list: for each of `providers`, in
 * the order given, the models it lists that call tools, answer in text and state a context window,
 * in the order it lists them, without those it marks deprecated and those whose ID is among
 * `existingIds`. Each carries the capabilities its entry states. Whatever in `modelsDev` is not
 * shaped as expected is skipped, so a surprising document costs suggestions and never throws.
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
      const capabilities = statedCapabilities(entry)
      taken.add(id)
      suggestions.push({
        provider,
        id,
        name,
        contextWindow,
        ...(outputLimit && { outputLimit }),
        ...(capabilities && { capabilities }),
      })
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
