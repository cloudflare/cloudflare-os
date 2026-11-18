import { describe, expect, it } from 'vitest'
import type { ActionLogEntry, AiChatMetadata } from '@gadgets/workshop-shared/api'
import { AgentsWaiting, runsWaiting } from './AgentsWaiting'

const chat = (id: number, more: Partial<AiChatMetadata> = {}) => ({ id, title: '', started: new Date(0), lastActive: new Date(0), ...more }) as AiChatMetadata
const action = (chatId: number, state: ActionLogEntry['state'] = 'pending') => ({ id: chatId * 10, chatId, state }) as ActionLogEntry
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('runsWaiting', () => {
  it('counts the agents’ runs stopped on a decision or with an action waiting, each once', () => {
    const chats = [chat(1, { spawnerId: 4, awaitingDecision: true }), chat(2, { spawnerId: 4 }), chat(3, { spawnerId: 4 }), chat(4, { awaitingDecision: true })]
    expect(runsWaiting(chats, [action(1), action(2), action(3, 'approved'), action(4)])).toBe(2)
  })
})

describe('AgentsWaiting', () => {
  it('asks each workspace once while what it said is fresh, and takes what an open one says over it', async () => {
    let now = 0
    const waiting = new AgentsWaiting(() => now)
    const asked: string[] = []
    const load = async (id: string) => {
      asked.push(id)
      return id === 'a' ? 2 : 0
    }
    waiting.want(['a', 'b'], load)
    await flush()
    expect([...waiting.snapshot()]).toEqual([['a', 2], ['b', 0]])
    waiting.want(['a', 'b'], load)
    expect(asked).toEqual(['a', 'b'])

    waiting.report('a', 0)
    expect(waiting.snapshot().get('a')).toBe(0)
    now += 3 * 60_000
    waiting.want(['a'], load)
    await flush()
    expect(asked).toEqual(['a', 'b', 'a'])
    expect(waiting.snapshot().get('a')).toBe(2)
  })
})
