import { describe, expect, it } from 'vitest'
import { contextWindowPresets, formatTokens, modelOptionsOf } from './modelOptions'

describe('modelOptionsOf', () => {
  it('offers reasoning levels and a context window for a model that reasons', () => {
    const options = modelOptionsOf('claude-haiku-4-5')
    expect(options.reasoningLevels).toContain('high')
    expect(options.contextWindow).toBe(200000)
  })

  it('offers no reasoning for a model whose provider’s models are not known to reason', () => {
    const options = modelOptionsOf('@cf/moonshotai/kimi-k2.7-code')
    expect(options.reasoningLevels).toEqual([])
    expect(options.contextWindow).toBe(262144)
  })

  it('offers nothing for a model it does not know', () => {
    expect(modelOptionsOf('my-own-llama')).toEqual({ reasoningLevels: [] })
  })

  it('does not take a property of every object for a model', () => {
    expect(modelOptionsOf('constructor')).toEqual({ reasoningLevels: [] })
  })
})

describe('formatTokens', () => {
  it('says thousands and millions in a few characters', () => {
    expect(formatTokens(200000)).toBe('200K')
    expect(formatTokens(262144)).toBe('262K')
    expect(formatTokens(1000000)).toBe('1M')
    expect(formatTokens(1048576)).toBe('1M')
    expect(formatTokens(1500000)).toBe('1.5M')
  })
})

describe('contextWindowPresets', () => {
  it('offers the model’s own, kept as nothing, then the usual sizes under it', () => {
    expect(contextWindowPresets(262144)).toEqual([
      { id: '', label: '262K (model default)' },
      { id: '200000', label: '200K' },
      { id: '128000', label: '128K' },
      { id: '64000', label: '64K' },
      { id: '32000', label: '32K' },
    ])
  })

  it('does not offer the model’s own twice', () => {
    expect(contextWindowPresets(200000).map(({ id }) => id)).toEqual(['', '128000', '64000', '32000'])
  })

  it('offers every usual size for a model whose own is not known', () => {
    const presets = contextWindowPresets(undefined)
    expect(presets[0]).toEqual({ id: '', label: 'Model default' })
    expect(presets.map(({ id }) => id)).toContain('1000000')
  })
})
