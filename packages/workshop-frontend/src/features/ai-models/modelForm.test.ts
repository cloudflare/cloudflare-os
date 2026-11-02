import { describe, expect, it } from 'vitest'
import { allowedModelSuggestions } from './modelForm'

describe('allowedModelSuggestions', () => {
  const MODELS = [
    { provider: 'cloudflare' as const, id: '@cf/zai-org/glm-5.2', name: 'GLM 5.2 (Workers AI)' },
    { provider: 'cloudflare' as const, id: '@cf/cloudflare/clef', name: 'Clef (Workers AI)' },
    { provider: 'cloudflare' as const, id: '@hf/acme/model', name: 'Acme (Workers AI)' },
    { provider: 'openai' as const, id: 'gpt-6-luna', name: 'GPT-6 Luna' },
    { provider: 'anthropic' as const, id: 'claude-sonnet-5-5', name: 'Claude Sonnet 5.5' },
    { provider: 'google' as const, id: 'gemini-4-pro', name: 'Gemini 4 Pro' },
  ]

  it('suggests each routable provider whole, then the language models whose name is certain', () => {
    expect(allowedModelSuggestions(['cloudflare', 'openai', 'anthropic', 'google'], MODELS))
      .toEqual([
        { name: '@cf/*/*', description: 'Every Cloudflare Workers AI model' },
        // Clef is a decision model, which the router never picks, and the router's pool holds
        // only @cf/ Workers AI models.
        { name: '@cf/zai-org/glm-5.2', description: 'GLM 5.2 (Workers AI)' },
        { name: 'openai/*', description: 'Every OpenAI model' },
        { name: 'openai/gpt-6-luna', description: 'GPT-6 Luna' },
        // Anthropic's gateway names differ from its model IDs, and Google is not in the pool.
        { name: 'anthropic/*', description: 'Every Anthropic model' },
      ])
  })

  it('suggests nothing of a provider that is off', () => {
    expect(allowedModelSuggestions(['openai'], MODELS).map(({ name }) => name))
      .toEqual(['openai/*', 'openai/gpt-6-luna'])
  })
})
