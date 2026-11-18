import { describe, expect, it } from 'vitest'
import { chatConnectors } from './chatConnectors'
import type { ChatItem, ConnectionItem, WebFetchItem } from './chatItems'

const connection = (id: number, vendorId: string, state: ConnectionItem['state'], scope?: string): ConnectionItem => ({
  kind: 'connection', id, key: `connection:${id}`, requestId: String(id), vendorId, vendorName: vendorId.toUpperCase(), reason: '', state, scope,
})
const fetched = (id: number, state: WebFetchItem['state']): WebFetchItem => ({
  kind: 'webFetch', id, key: `webFetch:${id}`, requestId: String(id), url: 'https://example.com', state,
})

describe('chatConnectors', () => {
  it('lists the services whose connection was made, once each, with what was asked for, latest used first', () => {
    const rows: ChatItem[] = [
      connection(1, 'drive', 'connected', 'Q3 plan'),
      connection(2, 'jira', 'connected'),
      connection(3, 'drive', 'connected', 'Roadmap'),
      connection(4, 'drive', 'connected', 'Q3 plan'),
    ]
    expect(chatConnectors(rows).map(({ key, scopes }) => [key, scopes])).toEqual([
      ['drive', ['Q3 plan', 'Roadmap']],
      ['jira', []],
    ])
  })

  it('leaves out what was asked for and not made', () => {
    expect(chatConnectors([connection(1, 'drive', 'pending'), connection(2, 'jira', 'denied')])).toEqual([])
  })

  it('lists the web once a page was fetched, and not for one that was refused', () => {
    expect(chatConnectors([fetched(1, 'denied')])).toEqual([])
    expect(chatConnectors([fetched(1, 'approved'), fetched(2, 'approved')]).map(({ name }) => name)).toEqual(['Web fetch'])
  })
})
