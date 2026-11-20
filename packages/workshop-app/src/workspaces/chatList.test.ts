import { describe, expect, it } from 'vitest'
import type { AiChatMetadata } from '@gadgets/workshop-shared/api'
import { narrowList } from '@/components/listView'
import { chatList } from './chatList'

const chat = (id: number, title: string, lastActive: Date, started = lastActive): AiChatMetadata => ({ id, title, started, lastActive })

const NOW = new Date(2026, 10, 12, 15)
const CHATS = [
  chat(1, 'Interview Synthesis', NOW),
  chat(2, 'Alpha launch readiness', new Date(2026, 10, 10)),
  chat(3, '', new Date(2026, 10, 9)),
]
const spec = chatList(new Set([1, 3]), ({ id }) => id === 3)
const left = (query: string, ...ids: string[]) =>
  narrowList(CHATS, { query, searchText: spec.searchText, filters: spec.filters!.filter(({ id }) => ids.includes(id)) }).map(({ id }) => id)

describe('chatList', () => {
  it('searches titles, and an untitled chat by what it is called', () => {
    expect(left('launch')).toEqual([2])
    expect(left('untitled')).toEqual([3])
  })

  it('narrows to the chats with anything unread, and to those that need the viewer', () => {
    expect(left('', 'unread')).toEqual([1, 3])
    expect(left('', 'needs')).toEqual([3])
    expect(left('', 'unread', 'needs')).toEqual([3])
  })

  it('orders by when they were last active and by name', () => {
    const order = (id: string) => spec.orders.find((each) => each.id === id)!.arrange(CHATS, 1).flatMap(({ entries }) => entries.map(({ value }) => value.id))
    expect(order('active')).toEqual([1, 2, 3])
    expect(order('name')).toEqual([2, 1, 3])
  })

  it('orders by cost only where costs are shown, dearest first and the unknown last', () => {
    expect(spec.orders.map(({ id }) => id)).not.toContain('cost')
    const costly = chatList(new Set(), () => false, true)
    const chats = [{ ...CHATS[0], totalCost: 0.02 }, { ...CHATS[1], totalCost: 1.5 }, CHATS[2]]
    const byCost = costly.orders.find(({ id }) => id === 'cost')!
    expect(byCost.arrange(chats, 1).flatMap(({ entries }) => entries.map(({ value }) => value.id))).toEqual([2, 1, 3])
  })
})
