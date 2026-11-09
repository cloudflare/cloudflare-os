// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest'
import type { ObserverBindingNeed } from '@gadgets/workshop-shared/api'
import { answerFromMemory, readExploreMemory, writeExploreMemory } from './exploreMemory'

const NEED: ObserverBindingNeed = {
  gatekeeperId: 7, vendorId: 'bigquery', resourceTitle: 'finance.accounts', resourceUrl: '',
}

afterEach(() => localStorage.clear())

describe('explore memory', () => {
  it('is kept per workspace and gadget', () => {
    writeExploreMemory('ws', 1, { mode: 'view', refusedChoices: [{ gatekeeperId: 7, accountId: 3 }] })
    expect(readExploreMemory('ws', 1)).toEqual(
      { mode: 'view', refusedChoices: [{ gatekeeperId: 7, accountId: 3 }] })
    expect(readExploreMemory('ws', 2)).toBeNull()
  })

  it('ignores anything it did not write', () => {
    localStorage.setItem('shared-view:ws:1', '{"mode":"owner"}')
    expect(readExploreMemory('ws', 1)).toBeNull()
    localStorage.setItem('shared-view:ws:1', 'not json')
    expect(readExploreMemory('ws', 1)).toBeNull()
  })

  it('answers only what it remembers, and never a failure', () => {
    const remembered = [{ gatekeeperId: 7, accountId: 3 }]
    expect(answerFromMemory([NEED], remembered)).toEqual(remembered)
    expect(() => answerFromMemory([{ ...NEED, gatekeeperId: 8 }], remembered)).toThrow('Not now.')
    expect(() => answerFromMemory(
      [{ ...NEED, failure: { accountId: 3, reason: 'no' } }], remembered)).toThrow('Not now.')
  })
})
