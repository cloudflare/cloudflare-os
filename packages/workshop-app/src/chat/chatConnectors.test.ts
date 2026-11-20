import { describe, expect, it } from 'vitest'
import { chatConnectors } from './chatConnectors'

describe('chatConnectors', () => {
  it('lists each service the chat used once, with what of it each connection reaches', () => {
    const connectors = chatConnectors([
      { gatekeeperId: 1, vendorId: 'drive', resourceTitle: 'Q3 plan' },
      { gatekeeperId: 2, vendorId: 'jira' },
      { gatekeeperId: 3, vendorId: 'drive', resourceTitle: 'Roadmap' },
      { gatekeeperId: 4, vendorId: 'drive', resourceTitle: 'Q3 plan' },
    ])
    expect(connectors.map(({ key, scopes }) => [key, scopes])).toEqual([
      ['drive', ['Q3 plan', 'Roadmap']],
      ['jira', []],
    ])
  })

  it('keeps a connection with no service apart, as one of its own', () => {
    expect(chatConnectors([{ gatekeeperId: 5, resourceTitle: 'Claude' }, { gatekeeperId: 6, resourceTitle: 'GPT' }])).toEqual([
      { key: 'connection:5', vendorId: undefined, scopes: ['Claude'] },
      { key: 'connection:6', vendorId: undefined, scopes: ['GPT'] },
    ])
  })
})
