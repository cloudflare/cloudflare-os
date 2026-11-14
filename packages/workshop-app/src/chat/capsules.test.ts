import { describe, expect, it } from 'vitest'
import { withCapsules } from './capsules'

const sheet = { gatekeeperId: 4, vendorId: 'google', description: { url: 'https://docs.google.com/spreadsheets/d/1', title: 'Q3 forecast', snippet: '', suggestedBindingName: 'FORECAST', tsType: 'Spreadsheet' } }
const repo = { gatekeeperId: 9, description: { url: 'https://github.com/cloudflare/gadgets', title: 'cloudflare/gadgets', snippet: '', suggestedBindingName: 'GADGETS', tsType: 'Repository' } }

describe('withCapsules', () => {
  it('puts each connection after the words, where its capsule says', () => {
    const { text, capsules } = withCapsules('Compare these', [sheet, repo])
    expect(text).toBe('Compare these [0] [1]')
    expect(capsules.map(({ position, length }) => text.slice(position, position + length))).toEqual(['[0]', '[1]'])
    expect(capsules.map(({ gatekeeperId, vendorId }) => [gatekeeperId, vendorId])).toEqual([[4, 'google'], [9, undefined]])
  })

  it('is the connections alone with no words, and the words alone with none', () => {
    expect(withCapsules('', [sheet]).text).toBe('[0]')
    expect(withCapsules('Hello', [])).toEqual({ text: 'Hello', capsules: [] })
  })
})
