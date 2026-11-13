import { describe, expect, it } from 'vitest'
import type { ActionLogEntry, AiChatMessage } from '@gadgets/workshop-shared/api'
import {
  chatRequestIds,
  countFromElsewhere,
  describeGroupSize,
  isFromElsewhere,
  pendingChangeEntries,
  pendingChangeGroups,
} from './pendingChangeGroups'

const AUTHOR = { type: 'agent' as const, id: 'model', name: 'Model' }

function entry(overrides: Partial<ActionLogEntry> & { id: number }): ActionLogEntry {
  return {
    gatekeeperId: 1,
    resourceTitle: 'Road trip 2026',
    createdAt: new Date('2026-11-11T00:00:00Z'),
    state: 'pending',
    type: 'action',
    description: { title: `Write ${overrides.id}`, description: '' },
    ...overrides,
  } as ActionLogEntry
}

/** Nothing in the open chat accounts for these, which is the default the tray must handle. */
const NO_CHAT = new Set<number>()

function actionMessage(id: number, sequence = id): AiChatMessage {
  return {
    chatId: 1,
    sequence,
    timestamp: new Date('2026-11-11T00:00:00Z'),
    author: AUTHOR,
    type: 'action',
    actionId: id,
    actionLog: entry({ id }),
  }
}

function textMessage(sequence: number): AiChatMessage {
  return {
    chatId: 1,
    sequence,
    timestamp: new Date('2026-11-11T00:00:00Z'),
    author: AUTHOR,
    type: 'message',
    message: 'Do the work',
  }
}

describe('pendingChangeGroups', () => {
  it('groups pending requests by the connection they target', () => {
    const groups = pendingChangeGroups([
      entry({ id: 1, gatekeeperId: 7, resourceTitle: 'Team calendar' }),
      entry({ id: 2, gatekeeperId: 9, resourceTitle: 'Road trip 2026' }),
      entry({ id: 3, gatekeeperId: 9, resourceTitle: 'Road trip 2026' }),
    ], NO_CHAT, true)

    expect(groups.map(group => ({
      gatekeeperId: group.gatekeeperId,
      title: group.title,
      ids: group.entries.map(e => e.id),
    }))).toEqual([
      { gatekeeperId: 7, title: 'Team calendar', ids: [1] },
      { gatekeeperId: 9, title: 'Road trip 2026', ids: [2, 3] },
    ])
  })

  it('orders groups by their oldest request, and requests within a group by id', () => {
    const groups = pendingChangeGroups([
      entry({ id: 5, gatekeeperId: 9 }),
      entry({ id: 2, gatekeeperId: 7 }),
      entry({ id: 3, gatekeeperId: 9 }),
    ], NO_CHAT, true)

    expect(groups.map(group => group.gatekeeperId)).toEqual([7, 9])
    expect(groups[1].entries.map(e => e.id)).toEqual([3, 5])
  })

  it('leaves out everything that is not a pending decision', () => {
    const groups = pendingChangeGroups([
      entry({ id: 1, state: 'approved' }),
      entry({ id: 2, state: 'rejected' }),
      { ...entry({ id: 3 }), type: 'observation' } as ActionLogEntry,
      // A built-in agent tool's entry reaches the client with no connection to act on.
      entry({ id: 4, gatekeeperId: undefined }),
      entry({ id: 6 }),
    ], NO_CHAT, true)

    expect(groups.flatMap(group => group.entries.map(e => e.id))).toEqual([6])
  })

  it('puts the connections this conversation asked of first', () => {
    // Nothing is hidden -- the workspace owes every one of these -- but a request the user
    // recognises is the first thing they meet.
    const groups = pendingChangeGroups([
      entry({ id: 1, gatekeeperId: 7, resourceTitle: 'Team calendar' }),
      entry({ id: 2, gatekeeperId: 9, resourceTitle: 'Road trip 2026' }),
    ], new Set([2]), true)

    expect(groups.map(group => group.gatekeeperId)).toEqual([9, 7])
  })

  it('keeps a group ahead of elsewhere when it holds any of this chat\'s requests', () => {
    const groups = pendingChangeGroups([
      entry({ id: 1, gatekeeperId: 7, resourceTitle: 'Team calendar' }),
      entry({ id: 2, gatekeeperId: 9, resourceTitle: 'Road trip 2026' }),
      entry({ id: 3, gatekeeperId: 9, resourceTitle: 'Road trip 2026' }),
    ], new Set([3]), true)

    expect(groups.map(group => group.gatekeeperId)).toEqual([9, 7])
    // Only the groups move: a group's entries stay in id order, which is the order a bulk apply
    // takes and what "waiting on the request above it" points at.
    expect(groups[0].entries.map(e => e.id)).toEqual([2, 3])
  })

  it('marks which requests the open chat asked for', () => {
    // The whole point of the workspace scope: a hook, a scheduled task or another chat queues
    // requests this conversation has no message for, and they still need deciding.
    const groups = pendingChangeGroups([
      entry({ id: 1 }),
      entry({ id: 2 }),
    ], new Set([1]), true)

    expect(groups[0].entries.map(e => e.origin)).toEqual(['open-chat', 'elsewhere'])
    expect(countFromElsewhere(groups)).toBe(1)
    // The group as a whole is not "elsewhere": this conversation asked something of it.
    expect(isFromElsewhere(groups[0])).toBe(false)
  })

  it('claims nothing about origin while the chat\'s earlier history is unloaded', async () => {
    // A compacted conversation opens at the tail, so a request it asked for can sit before the
    // loaded pages. Calling that "elsewhere" is a claim the client cannot make yet, and it would
    // also sort the user's own connection below the ones they recognise.
    const groups = pendingChangeGroups([
      entry({ id: 1, gatekeeperId: 7, resourceTitle: 'Team calendar' }),
      entry({ id: 2, gatekeeperId: 9, resourceTitle: 'Road trip 2026' }),
    ], new Set([2]), false)

    expect(groups.map(group => group.gatekeeperId)).toEqual([7, 9])
    expect(groups[0].entries[0].origin).toBe('unknown')
    expect(isFromElsewhere(groups[0])).toBe(false)
    expect(countFromElsewhere(groups)).toBe(0)
  })

  it('names a connection whose first request has no title yet', () => {
    // A creation has no resource to name until it applies, so a later request may be the first
    // entry that knows what the resource is called.
    const groups = pendingChangeGroups([
      entry({ id: 1, resourceTitle: '', creation: true }),
      entry({ id: 2, resourceTitle: 'Road trip 2026' }),
    ], NO_CHAT, true)

    expect(groups[0].title).toBe('Road trip 2026')
    expect(groups[0].hasCreation).toBe(true)
  })

  it('falls back to a placeholder when no request names the resource', () => {
    const groups = pendingChangeGroups([entry({ id: 1, resourceTitle: '' })], NO_CHAT, true)

    expect(groups[0].title).toBe('Unavailable connection')
  })

  it('reports no creation for a group of ordinary requests', () => {
    const groups = pendingChangeGroups([entry({ id: 1 }), entry({ id: 2 })], NO_CHAT, true)

    expect(groups[0].hasCreation).toBe(false)
  })
})

describe('chatRequestIds', () => {
  it('collects the ids the open chat has a message for, once each', () => {
    // A reconnect replays the gap, so the same action can arrive twice in one transcript.
    const ids = chatRequestIds([
      textMessage(0),
      actionMessage(1),
      actionMessage(2, 2),
      actionMessage(2, 3),
    ])

    expect([...ids].toSorted()).toEqual([1, 2])
  })
})

describe('pendingChangeEntries', () => {
  it('flattens groups back into submission order across connections', () => {
    // Apply order is global, not per group: ids count up across the workspace.
    const groups = pendingChangeGroups([
      entry({ id: 1, gatekeeperId: 7 }),
      entry({ id: 2, gatekeeperId: 9 }),
      entry({ id: 3, gatekeeperId: 7 }),
    ], NO_CHAT, true)

    expect(pendingChangeEntries(groups).map(e => e.id)).toEqual([1, 2, 3])
  })
})

describe('describeGroupSize', () => {
  it('counts requests, singular and plural', () => {
    const [one] = pendingChangeGroups([entry({ id: 1 })], NO_CHAT, true)
    const [two] = pendingChangeGroups([entry({ id: 1 }), entry({ id: 2 })], NO_CHAT, true)

    expect(describeGroupSize(one)).toBe('1 request')
    expect(describeGroupSize(two)).toBe('2 requests')
  })
})
