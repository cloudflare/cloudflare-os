import {
  modelKind,
  type AdminModelView,
  type AiModelProvider,
  type BuiltInReasoning,
  type ReasoningLevel,
} from '@gadgets/workshop-shared/api'

/** Each provider's name as the model forms and lists show it. */
export const PROVIDER_LABELS: Record<AiModelProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  cloudflare: 'Cloudflare Workers AI',
  ollama: 'Ollama',
  'cloudflare-auto-router': 'AI Gateway Auto Router',
}

/** Each reasoning level's name as the Models tab shows it. */
export const REASONING_LEVEL_LABELS: Record<ReasoningLevel, string> = {
  off: 'Off',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
}

/** What a model is asked for while no reasoning level is set for it, as the Models tab words it. */
export const builtInReasoningLabel = (builtIn: BuiltInReasoning): string => {
  if (builtIn === null) return 'no level sent'
  return builtIn === 'adaptive' ? 'Provider default' : REASONING_LEVEL_LABELS[builtIn]
}

/** Parse a token-limit field: undefined when blank, null when not a positive whole number. */
export const parseTokenLimit = (text: string): number | undefined | null => {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}

// A gateway model name as Auto Router's allow-list takes one: provider/model, where * stands for
// a whole model name. The server checks the same shape.
const ALLOWED_MODEL_NAME = /^[^\s,/]+\/[^\s,]+$/

/** Whether `name` is a gateway model name as Auto Router's allow-list takes one. */
export const isAllowedModelName = (name: string): boolean => ALLOWED_MODEL_NAME.test(name)

/** A gateway model name the allowed-models picker suggests, and what it stands for. */
export type AllowedModelSuggestion = { name: string; description: string }

// How Auto Router names the models of each provider it routes to, as the server's
// AUTO_ROUTER_PROVIDER_NAMES does: every model of the provider, and the prefix that makes one of
// its model IDs a gateway name, where that is certain. Anthropic's gateway names differ from its
// API's model IDs, so only its wildcard is suggested. Google is absent from the router's pool.
const AUTO_ROUTER_NAMES: Partial<Record<AiModelProvider, { every: string; prefix?: string }>> = {
  anthropic: { every: 'anthropic/*' },
  openai: { every: 'openai/*', prefix: 'openai/' },
  cloudflare: { every: '@cf/*/*', prefix: '' },
}

/**
 * The names the allowed-models picker suggests, for the providers that are on (`providers`):
 * each provider's every model, then the language models among `models` whose gateway name is
 * certain, once each.
 */
export const allowedModelSuggestions = (
  providers: readonly AiModelProvider[],
  models: readonly Pick<AdminModelView, 'provider' | 'id' | 'name'>[],
): AllowedModelSuggestion[] => {
  const suggestions: AllowedModelSuggestion[] = []
  const add = (suggestion: AllowedModelSuggestion) => {
    if (!suggestions.some(({ name }) => name === suggestion.name)) suggestions.push(suggestion)
  }
  for (const provider of providers) {
    const names = AUTO_ROUTER_NAMES[provider]
    if (!names) continue
    add({ name: names.every, description: `Every ${PROVIDER_LABELS[provider]} model` })
    if (names.prefix === undefined) continue
    for (const model of models) {
      if (model.provider !== provider || modelKind(provider, model.id) !== 'language') continue
      add({ name: `${names.prefix}${model.id}`, description: model.name })
    }
  }
  return suggestions.filter(({ name }) => isAllowedModelName(name))
}

/**
 * Parse the allowed-models field, a comma-separated list of gateway model names: the names,
 * trimmed and once each (none when blank), or else the first entry that is no such name.
 */
export const parseAllowedModels = (text: string): { names: string[] } | { malformed: string } => {
  const names: string[] = []
  for (const entry of text.split(',')) {
    const name = entry.trim()
    if (!name) continue
    if (!ALLOWED_MODEL_NAME.test(name)) return { malformed: name }
    if (!names.includes(name)) names.push(name)
  }
  return { names }
}
