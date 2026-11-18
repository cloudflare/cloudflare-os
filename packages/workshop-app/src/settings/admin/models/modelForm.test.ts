import { describe, expect, it } from 'vitest'
import { addAllowedNames, allowedModelSuggestions, movedOne, parseTokenLimit, settingsWith, statedFacts } from './modelForm'

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

describe('parseTokenLimit', () => {
  it('is nothing for a blank field, a number for a positive whole one, and null for anything else', () => {
    expect(parseTokenLimit('  ')).toBeUndefined()
    expect(parseTokenLimit(' 200000 ')).toBe(200000)
    expect(parseTokenLimit('0')).toBeNull()
    expect(parseTokenLimit('1.5')).toBeNull()
    expect(parseTokenLimit('200,000')).toBeNull()
    expect(parseTokenLimit('99999999999999999999')).toBeNull()
  })
})

describe('settingsWith', () => {
  const model = { settings: { reasoning: 'high' as const, compactionInputBudget: 150000 }, maxCompactionInputBudget: 200000 }

  it('sends the whole of the settings with the change, less what it unsets', () => {
    expect(settingsWith(model, { reasoning: undefined })).toEqual({ compactionInputBudget: 150000 })
    expect(settingsWith(model, { allowedModels: ['openai/*'] })).toEqual({ reasoning: 'high', compactionInputBudget: 150000, allowedModels: ['openai/*'] })
  })

  it('sends a budget at no more than the maximum, and none where the maximum leaves no room', () => {
    expect(settingsWith({ ...model, maxCompactionInputBudget: 100000 }, {})).toEqual({ reasoning: 'high', compactionInputBudget: 100000 })
    expect(settingsWith({ ...model, maxCompactionInputBudget: 0 }, {})).toEqual({ reasoning: 'high' })
  })
})

describe('movedOne', () => {
  it('swaps one with its neighbour, and is nothing at the end it would go past', () => {
    expect(movedOne(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c'])
    expect(movedOne(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b'])
    expect(movedOne(['a', 'b', 'c'], 0, -1)).toBeUndefined()
    expect(movedOne(['a', 'b', 'c'], 2, 1)).toBeUndefined()
  })
})

describe('addAllowedNames', () => {
  it('adds the gateway model names of a comma-separated list once each, and gives back the rest as typed', () => {
    expect(addAllowedNames(['openai/*'], ' anthropic/*, openai/*, claude ,@cf/*/*,')).toEqual({ names: ['openai/*', 'anthropic/*', '@cf/*/*'], refused: ['claude'] })
  })
})

describe('statedFacts', () => {
  it('says what is stated, and a list with no level above Off as no reasoning', () => {
    expect(statedFacts({ imageInput: false, reasoningLevels: ['off'] })).toEqual(['takes no images', 'no reasoning'])
    expect(statedFacts({ reasoningLevels: ['off', 'high'] })).toEqual(['reasoning levels Off, High'])
    expect(statedFacts()).toEqual([])
  })
})
