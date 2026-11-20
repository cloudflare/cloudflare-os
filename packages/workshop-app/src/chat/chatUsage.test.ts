import { describe, expect, it } from 'vitest'
import type { AiChatMetadata } from '@gadgets/workshop-shared/api'
import { sameUsage, usageOf } from './chatUsage'
import { heldWindow, windowSizes } from './contextWindow'

const chat = (change: Partial<AiChatMetadata> = {}): AiChatMetadata => ({ id: 1, title: 'Plans', started: new Date(0), lastActive: new Date(0), ...change })
const measured = (tokens: number, model = 'claude') => ({ totalTokens: tokens, contextBudget: { tokens: 168_000, model } })

describe('usageOf', () => {
  it('takes what the metadata has measured, and nothing for what it has not', () => {
    expect(usageOf(chat())).toEqual({})
    expect(usageOf(chat({ ...measured(83_312), totalCost: 0.04, cacheReadTokens: 5 }))).toEqual({ context: { tokens: 83_312, budget: 168_000, model: 'claude' }, cost: 0.04, cacheReadTokens: 5 })
  })

  it('is the same usage only when each part is', () => {
    expect(sameUsage(usageOf(chat(measured(1))), usageOf(chat({ ...measured(1), title: 'Other' })))).toBe(true)
    expect(sameUsage(usageOf(chat(measured(1))), usageOf(chat(measured(2))))).toBe(false)
    expect(sameUsage(usageOf(chat(measured(1))), usageOf(chat(measured(1, 'gpt'))))).toBe(false)
    expect(sameUsage(usageOf(chat(measured(1))), usageOf(chat()))).toBe(false)
    expect(sameUsage(usageOf(chat({ totalCost: 1 })), usageOf(chat()))).toBe(false)
  })
})

describe('context window', () => {
  it('offers the model’s own as nothing, and the smaller usual sizes', () => {
    const { value, options } = windowSizes(200_000, undefined)
    expect(value).toBe('')
    expect(options.map(({ id }) => id)).toEqual(['', '128000', '64000', '32000'])
  })

  it('offers a size set elsewhere as one of the options, so that it is chosen', () => {
    const { value, options } = windowSizes(200_000, 150_000)
    expect(value).toBe('150000')
    expect(options.at(-1)).toEqual({ id: '150000', label: '150K' })
    expect(windowSizes(200_000, 64_000).options.filter(({ id }) => id === '64000')).toHaveLength(1)
  })

  it('reads a choice back as what the model is held to', () => {
    expect(heldWindow('')).toBeUndefined()
    expect(heldWindow('128000')).toBe(128_000)
  })
})
