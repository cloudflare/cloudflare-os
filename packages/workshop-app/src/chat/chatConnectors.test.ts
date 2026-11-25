import { describe, expect, it } from 'vitest'
import { chatConnectors } from './chatConnectors'

describe('chatConnectors', () => {
  it('lists each thing reached once, by its address or else its title, taking what each connection says of it', () => {
    const connectors = chatConnectors([
      { gatekeeperId: 1, vendorId: 'drive', resourceTitle: 'Q3 plan', resourceUrl: 'https://docs/1' },
      { gatekeeperId: 2, vendorId: 'jira' },
      { gatekeeperId: 3, vendorId: 'drive', resourceTitle: 'Roadmap' },
      { gatekeeperId: 4, vendorId: 'drive', resourceUrl: 'https://docs/1', resourceTypeId: 'doc' },
    ])
    expect(connectors.map(({ key, title, resourceTypeId }) => [key, title, resourceTypeId])).toEqual([
      ['drive:https://docs/1', 'Q3 plan', 'doc'],
      ['jira:', undefined, undefined],
      ['drive:Roadmap', 'Roadmap', undefined],
    ])
  })

  it('keeps a connection with no service apart, as one of its own', () => {
    expect(chatConnectors([{ gatekeeperId: 5, resourceTitle: 'Claude' }, { gatekeeperId: 6, resourceTitle: 'GPT' }]).map(({ key, title }) => [key, title])).toEqual([
      ['connection:5', 'Claude'],
      ['connection:6', 'GPT'],
    ])
  })
})
