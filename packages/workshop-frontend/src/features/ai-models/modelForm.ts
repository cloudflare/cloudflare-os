import type {
  AiModelProvider,
  BuiltInReasoning,
  ReasoningLevel,
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
