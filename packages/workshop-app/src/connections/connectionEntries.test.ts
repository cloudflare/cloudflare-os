import { describe, expect, it, vi } from 'vitest'
import { searchMatches } from '@/blocks/searchMatches'
import { connectionEntries } from './connectionEntries'
import type { Connection } from './connectionList'

const service = (vendorId: string, displayName: string, tagline?: string) =>
  ({ kind: 'service', key: `service:${vendorId}`, vendorId, vendor: { displayName, tagline }, resources: [] }) as unknown as Connection

const account = (id: number, vendorId: string, displayName: string, who: { displayName?: string; uniqueName?: string } = {}, credentialsValid = true) =>
  ({
    kind: 'account',
    key: `account:${id}`,
    vendorId,
    vendor: { displayName },
    resources: [],
    account: { id, vendorId, description: who, credentialsValid },
    takesAnother: true,
  }) as unknown as Connection

const entriesOf = (connections: Connection[], onOpen = vi.fn<(key: string) => void>()) => ({ entries: connectionEntries(connections, onOpen), onOpen })
const rows = (connections: Connection[]) => entriesOf(connections).entries.map(({ title, detail }) => [title, detail])
const found = (query: string, connections: Connection[]) => searchMatches(query, entriesOf(connections).entries).map(({ title }) => title)

describe('connectionEntries', () => {
  it('is nothing where nothing is connected and nothing could be', () => {
    expect(connectionEntries([], vi.fn())).toEqual([])
  })

  it('has an entry for each connection, the accounts first and then the services that could be connected, each saying whether it is', () => {
    expect(rows([service('slack', 'Slack'), account(1, 'github', 'GitHub'), service('google', 'Google'), account(2, 'scheduler', 'Scheduled Tasks')])).toEqual([
      ['Connections › GitHub', 'Connected'],
      ['Connections › Scheduled Tasks', 'Connected'],
      ['Connections › Google', 'Not connected'],
      ['Connections › Slack', 'Not connected'],
    ])
  })

  it('has a service that is connected once, as its account, which is also where another is added', () => {
    expect(rows([account(1, 'slack', 'Slack'), service('slack', 'Slack')])).toEqual([['Connections › Slack', 'Connected']])
  })

  it('tells the accounts of one service apart by whose they are, and says one has to be signed in to again', () => {
    expect(
      rows([
        account(1, 'google', 'Google', { displayName: 'Ada', uniqueName: 'ada@example.com' }),
        account(2, 'google', 'Google', { uniqueName: 'work@example.com' }, false),
        account(3, 'github', 'GitHub', { uniqueName: 'ada' }),
      ]),
    ).toEqual([
      ['Connections › GitHub', 'Connected'],
      ['Connections › Google · Ada · ada@example.com', 'Connected'],
      ['Connections › Google · work@example.com', 'Needs sign-in'],
    ])
  })

  it('is found by a service’s name, and by whose an account is', () => {
    const connections = [account(1, 'google', 'Google', { uniqueName: 'ada@example.com' }), service('slack', 'Slack')]
    expect(found('google', connections)).toEqual(['Connections › Google'])
    expect(found('slack', connections)).toEqual(['Connections › Slack'])
    expect(found('ada', connections)).toEqual(['Connections › Google'])
  })

  it('is found by what a service is for', () => {
    expect(found('calendars', [service('mail', 'Fastmail', 'Email and calendars'), service('slack', 'Slack', 'Team chat')])).toEqual(['Connections › Fastmail'])
  })

  it('is found by what choosing it does: "manage" lists what is connected, and "add google" only finds Google if it is not', () => {
    const connected = [account(1, 'google', 'Google'), service('slack', 'Slack')]
    expect(found('manage', connected)).toEqual(['Connections › Google'])
    expect(found('manage google', connected)).toEqual(['Connections › Google'])
    expect(found('add slack', connected)).toEqual(['Connections › Slack'])
    expect(found('add google', connected)).toEqual([])
    expect(found('add google', [service('google', 'Google')])).toEqual(['Connections › Google'])
  })

  it('is found by "connections", which is every one of them', () => {
    expect(found('connections', [account(1, 'github', 'GitHub'), service('slack', 'Slack')])).toEqual(['Connections › GitHub', 'Connections › Slack'])
  })

  it('hands the connection chosen to be shown by its key, an account to manage and a service to connect, and changes nothing itself', async () => {
    const { entries, onOpen } = entriesOf([account(7, 'github', 'GitHub'), service('slack', 'Slack')])
    await entries[0].onSelect()
    await entries[1].onSelect()
    expect(onOpen.mock.calls).toEqual([['account:7'], ['service:slack']])
  })
})
