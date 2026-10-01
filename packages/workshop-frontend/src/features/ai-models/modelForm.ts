import type { AiModelProvider } from '@gadgets/workshop-shared/api'

/** Each provider's name as the model forms and lists show it. */
export const PROVIDER_LABELS: Record<AiModelProvider, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  cloudflare: 'Cloudflare Workers AI',
  ollama: 'Ollama',
}

/** Parse a token-limit field: undefined when blank, null when not a positive whole number. */
export const parseTokenLimit = (text: string): number | undefined | null => {
  const trimmed = text.trim()
  if (!trimmed) return undefined
  if (!/^\d+$/.test(trimmed)) return null
  const value = Number(trimmed)
  return Number.isSafeInteger(value) && value > 0 ? value : null
}
