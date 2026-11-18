import { describe, expect, it } from 'vitest'
import type { ActionLogEntry } from '@gadgets/workshop-shared/api'
import { agentsOf, askDetail, askGroups, askTitle, isAskOf, targetsOf, type Ask } from './askGroups'

const NOW = new Date('2026-11-17T15:00:00Z')

const ask = (id: number, change: Partial<Ask> = {}, description: Partial<Ask['description']> = {}): Ask => ({
  id,
  type: 'action',
  state: 'pending',
  gatekeeperId: 3,
  resourceTitle: 'Q3 notes',
  createdAt: NOW,
  ...change,
  description: {
    title: `Append line ${id}`,
    description: 'Adds a line at the end.',
    implementsRevert: false,
    autoApprovable: true,
    actionKind: { tag: 'append', label: 'Append to document' },
    ...description,
  },
})

describe('isAskOf', () => {
  const scope = { targets: targetsOf([{ target: 3 }, { target: 9 }]), agents: new Map([[12, 'Researcher']]) }

  it('is what went through its connections from outside any chat', () => {
    expect(isAskOf(ask(1), scope)).toBe(true)
    expect(isAskOf(ask(2, { gatekeeperId: 4 }), scope)).toBe(false)
    expect(isAskOf(ask(3, { gatekeeperId: undefined }), scope)).toBe(false)
  })

  it('is what its agents ask, through whatever they were given', () => {
    expect(isAskOf(ask(1, { chatId: 12, gatekeeperId: 40 }), scope)).toBe(true)
  })

  it('leaves a chat’s to the chat, unless it is the one it is shown from, out of sight', () => {
    expect(isAskOf(ask(1, { chatId: 5 }), scope)).toBe(false)
    expect(isAskOf(ask(1, { chatId: 5 }), { ...scope, chatId: 5 })).toBe(true)
    // Through a connection that is not the gadget's, it is the chat's agent's, not the gadget's.
    expect(isAskOf(ask(1, { chatId: 5, gatekeeperId: 4 }), { ...scope, chatId: 5 })).toBe(false)
  })

  it('is only what still waits, and never an observation or a hook', () => {
    expect(isAskOf(ask(1, { state: 'approved' }), scope)).toBe(false)
    const observation = { id: 1, type: 'observation', state: 'approved', gatekeeperId: 3, resourceTitle: '', createdAt: NOW, description: { title: 'Read' } } as ActionLogEntry
    expect(isAskOf(observation, scope)).toBe(false)
  })
})

describe('agentsOf', () => {
  it('is the chats its spawners started, named as they were', () => {
    const chats = [{ id: 1 }, { id: 2, spawnerId: 9, spawnerName: 'Researcher' }, { id: 3, spawnerId: 8, spawnerName: 'Other' }]
    expect(agentsOf(chats, new Set([9]))).toEqual(new Map([[2, 'Researcher']]))
  })
})

describe('askGroups', () => {
  it('puts one kind through one connection together, where its first was asked', () => {
    const groups = askGroups([ask(4), ask(2, { gatekeeperId: 5 }), ask(1)])
    expect(groups.map(({ key, asks }) => [key, asks.map(({ id }) => id)])).toEqual([
      ['3:append', [1, 4]],
      ['5:append', [2]],
    ])
    expect(groups[0].allowable).toEqual({ tag: 'append', label: 'Append to document' })
  })

  it('asks a creation, or one with no kind, on its own', () => {
    const groups = askGroups([ask(1, { creation: true }), ask(2, { creation: true }), ask(3, {}, { actionKind: undefined, autoApprovable: false }), ask(4, {}, { actionKind: undefined, autoApprovable: false })])
    expect(groups.map(({ key }) => key)).toEqual(['action:1', 'action:2', 'action:3', 'action:4'])
    expect(groups.map(({ creation }) => creation)).toEqual([true, true, false, false])
    expect(groups[2].allowable).toBeUndefined()
  })

  it('allows a kind for good only where every one of it may be, and never once the workspace read restricted data', () => {
    expect(askGroups([ask(1), ask(2, {}, { autoApprovable: false })])[0].allowable).toBeUndefined()
    expect(askGroups([ask(1)], { restricted: true })[0].allowable).toBeUndefined()
  })
})

describe('askTitle and askDetail', () => {
  it('names it by its kind, else by what the one is', () => {
    expect(askTitle(askGroups([ask(1)])[0])).toBe('Append to document')
    expect(askTitle(askGroups([ask(1, {}, { actionKind: undefined })])[0])).toBe('Append line 1')
  })

  it('says where and how many, and when only once that was a while ago', () => {
    const [group] = askGroups([ask(1), ask(2)])
    expect(askDetail(group, new Map(), NOW)).toBe('Q3 notes · 2 changes')
    const [earlier] = askGroups([ask(1, { createdAt: new Date('2026-11-17T12:00:00Z') })])
    expect(askDetail(earlier, new Map(), NOW)).toBe('Q3 notes · asked 3 hours ago')
    const [lastWeek] = askGroups([ask(1, { resourceTitle: '', createdAt: new Date('2026-11-13T12:00:00Z') })])
    expect(askDetail(lastWeek, new Map(), NOW)).toBe('Asked Friday')
  })

  it('says which of its agents asks', () => {
    const [group] = askGroups([ask(1, { chatId: 12 })])
    expect(askDetail(group, new Map([[12, 'Researcher']]), NOW)).toBe('From Researcher · Q3 notes')
    expect(askDetail(group, new Map([[12, undefined]]), NOW)).toBe('From its agent · Q3 notes')
  })
})
