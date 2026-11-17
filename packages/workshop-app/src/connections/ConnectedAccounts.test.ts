import { describe, expect, it } from 'vitest'
import { ConnectedAccounts } from './ConnectedAccounts'
import type { ConnectedAccount } from './connectionList'

const VENDOR = { displayName: 'Google', url: 'https://google.example' }
const start = () => {
  const told: ConnectedAccount[][] = []
  const accounts = new ConnectedAccounts((next) => told.push(next))
  const add = (id: number, uniqueName: string, credentialsValid = true) =>
    accounts.add(id, { uniqueName, avatar: { url: '' } }, VENDOR, [], credentialsValid, 'google')
  return { accounts, add, told, latest: () => told.at(-1)!.map(({ id, description, credentialsValid }) => [id, description.uniqueName, credentialsValid]) }
}

describe('ConnectedAccounts', () => {
  it('says nothing until the accounts known so far are all in, then says them together', () => {
    const { accounts, add, told, latest } = start()
    add(1, 'ada@work.example')
    add(2, 'ada@home.example')
    expect(told).toEqual([])
    accounts.ready()
    expect(told).toHaveLength(1)
    expect(latest()).toEqual([[1, 'ada@work.example', true], [2, 'ada@home.example', true]])
  })

  it('says an account that is connected or disconnected afterwards as it happens', () => {
    const { accounts, add, latest } = start()
    add(1, 'ada@work.example')
    accounts.ready()
    add(2, 'ada@home.example')
    expect(latest().map(([id]) => id)).toEqual([1, 2])
    accounts.remove(1)
    expect(latest().map(([id]) => id)).toEqual([2])
  })

  it('replaces an account it is told of again, as when its sign-in runs out or the backend starts over', () => {
    const { accounts, add, latest } = start()
    add(1, 'ada@work.example')
    accounts.ready()
    add(1, 'ada@work.example', false)
    expect(latest()).toEqual([[1, 'ada@work.example', false]])
    // Everything again, as after a restart.
    add(1, 'ada@work.example', true)
    accounts.ready()
    expect(latest()).toEqual([[1, 'ada@work.example', true]])
  })

  it('says nothing of an account it never knew being removed', () => {
    const { accounts, told } = start()
    accounts.ready()
    accounts.remove(7)
    expect(told).toHaveLength(1)
  })
})
