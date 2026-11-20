import { describe, expect, it } from 'vitest'
import type { AiChatAuthorInfo, AiChatMetadata } from '@gadgets/workshop-shared/api'
import type { AttentionGroup } from './activity/overview'
import { favoritesFirst, groupChats, ownerOf } from './chatGroups'
import { chatStatesOf } from './chatStates'

// Wednesday 28 October 2026, 09:00 local time.
const now = new Date(2026, 9, 28, 9)
const at = (minutes: number) => new Date(now.getTime() - minutes * 60_000)
const chat = (id: number, minutes: number, more: Partial<AiChatMetadata> = {}): AiChatMetadata => ({ id, title: `Chat ${id}`, started: at(minutes + 5), lastActive: at(minutes), ...more })
const ask = (id: number) => ({ id, type: 'action', resourceTitle: 'Thing', createdAt: at(10), state: 'pending', description: { title: 'Post', description: '', implementsRevert: false, autoApprovable: true } }) as AttentionGroup['asks'][number]
const waiting = (chatId: number, asks: number): AttentionGroup => ({ key: `chat:${chatId}`, place: { kind: 'chat', chatId, title: `Chat ${chatId}` }, blocking: true, since: at(5), asks: Array.from({ length: asks }, (_, index) => ask(chatId * 10 + index)) })

const states = chatStatesOf({
  attention: [waiting(1, 1), waiting(2, 0)],
  failed: [{ chatId: 3, title: 'Run', agent: 'Bot', at: at(40) }],
  reviews: [{ chatId: 4, title: 'Chat 4', workpieces: [7], at: at(50) }],
  working: [{ chatId: 5, title: 'Chat 5', at: at(1) }],
})
const viewer = { type: 'user', id: 'me', name: 'Me' } as const
const ada = { type: 'user', id: 'ada', name: 'Ada' } as const
const starters = new Map<number, AiChatAuthorInfo>([[1, viewer], [2, ada], [6, ada]])
const context = {
  states,
  unread: (id: number) => id === 7,
  owner: (each: AiChatMetadata) => ownerOf(each, starters.get(each.id), 'me'),
  at: ({ lastActive }: AiChatMetadata) => lastActive,
  now,
}
const keys = ({ groups }: ReturnType<typeof groupChats>) => groups.map(({ key, entries }) => [key, entries.map(({ value }) => value.id)])

// In the order chosen, the latest first.
const chats = [chat(5, 1), chat(1, 2), chat(7, 3), chat(2, 4), chat(9, 6, { spawnerName: 'Inbox helper' }), chat(3, 40), chat(4, 50), chat(6, 3000), chat(8, 9000)]

describe('groupChats', () => {
  it('by status, most urgent first and unheaded, each group in the order chosen, what is at work where it would be otherwise', () => {
    const grouped = groupChats('status', chats, context)
    expect(grouped.headed).toBe(false)
    expect(keys(grouped)).toEqual([
      ['approval', [1]],
      ['answer', [2]],
      ['failed', [3]],
      ['review', [4]],
      ['unread', [7]],
      ['rest', [5, 9, 6, 8]],
    ])
  })

  it('by date, in headed stretches of time, nearest first, the quiet days folded together', () => {
    const grouped = groupChats('date', chats, context)
    expect(grouped.headed).toBe(true)
    expect(grouped.groups.map(({ label, entries }) => [label, entries.length])).toEqual([['Today', 7], ['Thursday to Monday', 2]])
  })

  it('by owner, the viewer first, then people and then agents by name, then those not known', () => {
    const grouped = groupChats('owner', chats, context)
    expect(grouped.groups.map(({ label, entries }) => [label, entries.map(({ value }) => value.id)])).toEqual([
      ['You', [1]],
      ['Ada', [2, 6]],
      ['Inbox helper', [9]],
      ['Someone', [5, 7, 3, 4, 8]],
    ])
  })

  it('not at all, in one group', () => {
    expect(keys(groupChats('none', chats, context))).toEqual([['all', chats.map(({ id }) => id)]])
    expect(groupChats('none', [], context).groups).toEqual([])
  })
})

describe('favoritesFirst', () => {
  it('puts favorites first in a group of their own, in the order and grouping chosen', () => {
    const groups = favoritesFirst(chats, ({ id }) => id === 4 || id === 8, (each) => groupChats('status', each, context).groups)
    expect(groups.map(({ key, entries }) => [key, entries.map(({ value }) => value.id)])).toEqual([
      ['favorites', [4, 8]],
      ['approval', [1]],
      ['answer', [2]],
      ['failed', [3]],
      ['unread', [7]],
      ['rest', [5, 9, 6]],
    ])
  })
})
