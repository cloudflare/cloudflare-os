import { describe, expect, it } from 'vitest'
import { WorkspaceMemberships } from './WorkspaceMemberships'
import type { WorkspaceMember } from './workspaceMembers'

const member = (id: string): WorkspaceMember => ({ profile: { type: 'user', id, name: id }, role: 'owner' })

/** A `load` whose answers are given by hand, with the ids asked so far and not yet answered. */
const loader = () => {
  const asked: string[] = []
  const waiting = new Map<string, { resolve: (members: WorkspaceMember[]) => void; reject: (error: Error) => void }>()
  const load = (id: string) => {
    asked.push(id)
    return new Promise<WorkspaceMember[]>((resolve, reject) => waiting.set(id, { resolve, reject }))
  }
  const settle = async (id: string, members?: WorkspaceMember[]) => {
    const { resolve, reject } = waiting.get(id)!
    waiting.delete(id)
    if (members) resolve(members)
    else reject(new Error('refused'))
    // Past the store's own handlers.
    await new Promise((done) => setTimeout(done))
  }
  return { asked, load, settle }
}

const IDS = ['a', 'b', 'c', 'd', 'e', 'f']

describe('WorkspaceMemberships', () => {
  it('asks a few workspaces at a time, in order, and the next as each answers', async () => {
    const { asked, load, settle } = loader()
    const store = new WorkspaceMemberships()
    store.want(IDS, load)
    expect(asked).toEqual(['a', 'b', 'c', 'd'])
    await settle('b', [member('ada')])
    expect(asked).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(store.snapshot().get('b')).toEqual([member('ada')])
  })

  it('tells its listeners with a new snapshot each time one answers', async () => {
    const { load, settle } = loader()
    const store = new WorkspaceMemberships()
    let told = 0
    store.subscribe(() => (told += 1))
    const before = store.snapshot()
    store.want(['a'], load)
    await settle('a', [member('ada')])
    expect(told).toBe(1)
    expect(store.snapshot()).not.toBe(before)
    expect(before.size).toBe(0)
  })

  it('does not ask again one that has said, until that was long ago, and keeps what it said meanwhile', async () => {
    const { asked, load, settle } = loader()
    let now = 0
    const store = new WorkspaceMemberships(() => now)
    store.want(['a'], load)
    await settle('a', [member('ada')])
    store.want(['a'], load)
    expect(asked).toEqual(['a'])

    now = 6 * 60_000
    store.want(['a'], load)
    expect(asked).toEqual(['a', 'a'])
    expect(store.snapshot().get('a')).toEqual([member('ada')])
    await settle('a', [member('ada'), member('grace')])
    expect(store.snapshot().get('a')).toHaveLength(2)
  })

  it('does not ask twice one that is being asked', () => {
    const { asked, load } = loader()
    const store = new WorkspaceMemberships()
    store.want(['a'], load)
    store.want(['a', 'b'], load)
    expect(asked).toEqual(['a', 'b'])
  })

  it('leaves one that could not be read unknown, and asks it again when wanted', async () => {
    const { asked, load, settle } = loader()
    const store = new WorkspaceMemberships()
    store.want(['a'], load)
    await settle('a')
    expect(store.snapshot().has('a')).toBe(false)
    store.want(['a'], load)
    expect(asked).toEqual(['a', 'a'])
  })

  it('asks no more once stopped, and takes up with what is wanted next', async () => {
    const { asked, load, settle } = loader()
    const store = new WorkspaceMemberships()
    store.want(IDS, load)
    store.stop()
    await settle('a', [member('ada')])
    expect(asked).toEqual(['a', 'b', 'c', 'd'])
    store.want(IDS, load)
    expect(asked).toEqual(['a', 'b', 'c', 'd', 'e'])
  })
})
