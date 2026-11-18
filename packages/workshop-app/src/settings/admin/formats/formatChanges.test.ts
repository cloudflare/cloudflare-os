import { describe, expect, it } from 'vitest'
import type { AdminFormat, BlueprintPublicInfo, BlueprintUserSummary } from '@gadgets/workshop-shared/api'
import { catalogLine, movedOrder, offeredOf, overrideOf, promotableOf } from './formatChanges'

const SLIDES = { id: 'presentation', noun: 'Slides', plural: 'Slides', icon: 'presentation' } as const

const format = (blueprintId: string, more: Partial<AdminFormat> = {}): AdminFormat => ({
  blueprintId,
  blueprintTitle: blueprintId,
  blueprintDescription: '',
  output: SLIDES,
  declared: SLIDES,
  enabled: true,
  agentHint: '',
  missing: false,
  bundled: false,
  ...more,
})

const featured = (id: string, title: string): BlueprintPublicInfo => ({ id, metadata: { title, output: SLIDES } } as BlueprintPublicInfo)
const own = (id: string, title: string): BlueprintUserSummary => ({ id, title } as BlueprintUserSummary)

describe('format changes', () => {
  it('offers the featured blueprints with what they make, then the admin’s own, leaving out what is promoted', () => {
    expect(promotableOf([featured('deck', 'Deck'), featured('doc', 'Doc')], [own('deck', 'My deck'), own('mine', 'Mine')], [format('doc')])).toEqual([
      { id: 'deck', title: 'Deck', declared: SLIDES },
      { id: 'mine', title: 'Mine' },
    ])
  })

  it('keeps an override only where it differs from what the blueprint declares', () => {
    expect(overrideOf('Deck', 'Slides')).toBe('Deck')
    expect(overrideOf('Slides', 'Slides')).toBeNull()
    expect(overrideOf('', 'Slides')).toBeNull()
    expect(overrideOf('Deck', undefined)).toBe('Deck')
  })

  it('moves a format by a place, and not off either end', () => {
    expect(movedOrder(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c'])
    expect(movedOrder(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b'])
    expect(movedOrder(['a', 'b', 'c'], 0, -1)).toBeUndefined()
    expect(movedOrder(['a', 'b', 'c'], 2, 1)).toBeUndefined()
  })

  it('offers people only formats that are on, there and named', () => {
    const offered = offeredOf([format('on'), format('off', { enabled: false }), format('gone', { missing: true }), format('unnamed', { output: undefined })])
    expect(offered.map(({ blueprintId }) => blueprintId)).toEqual(['on'])
  })

  it('writes the agent’s catalog line with the hint at its end, if there is one', () => {
    expect(catalogLine('Slides', '')).toBe('“Slides” — a standard format on this deployment')
    expect(catalogLine('Slides', 'for decks')).toBe('“Slides” — a standard format on this deployment -- for decks')
  })
})
