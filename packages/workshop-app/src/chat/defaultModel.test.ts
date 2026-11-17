import { describe, expect, it } from 'vitest'
import { defaultModelOf } from './defaultModel'

const models = [{ id: 'first' }, { id: 'second' }]

describe('defaultModelOf', () => {
  it('is the model the user chose, while it is offered', () => {
    expect(defaultModelOf(models, 'second')).toEqual({ id: 'second' })
  })

  it('is the first offered while none is chosen', () => {
    expect(defaultModelOf(models, null)).toEqual({ id: 'first' })
  })

  it('is the first offered once the one chosen is no longer offered', () => {
    expect(defaultModelOf(models, 'retired')).toEqual({ id: 'first' })
  })

  it('is none while no model is offered', () => {
    expect(defaultModelOf([], 'second')).toBeUndefined()
  })
})
