import { describe, expect, it } from 'vitest'
import type { AiChatMetadata } from '@gadgets/workshop-shared/api'
import type { AttentionGroup } from './activity/overview'
import { chatByOf, chatStatesOf, speakerOf } from './chatStates'

const now = Date.now()
const at = (minutes: number) => new Date(now - minutes * 60_000)
const chat = (id: number, minutes: number, more: Partial<AiChatMetadata> = {}): AiChatMetadata => ({ id, title: `Chat ${id}`, started: at(minutes + 5), lastActive: at(minutes), ...more })
const run = (id: number, minutes: number, spawnerId = 9) => chat(id, minutes, { spawnerId, spawnerName: `Agent ${spawnerId}` })
const ask = (id: number, title: string) => ({ id, type: 'action', resourceTitle: 'Thing', createdAt: at(10), state: 'pending', description: { title, description: '', implementsRevert: false, autoApprovable: true } }) as AttentionGroup['asks'][number]

const attention: AttentionGroup[] = [
  { key: 'chat:2', place: { kind: 'chat', chatId: 2, title: 'Chat 2' }, blocking: true, since: at(20), asks: [] },
  { key: 'chat:1', place: { kind: 'chat', chatId: 1, title: 'Chat 1' }, blocking: true, since: at(30), asks: [ask(10, 'Open a pull request'), ask(11, 'Post')] },
  { key: 'elsewhere', place: { kind: 'elsewhere' }, blocking: false, since: at(5), asks: [ask(12, 'Add an event'), ask(13, 'Append')] },
]

const states = chatStatesOf({
  attention,
  failed: [{ chatId: 3, title: 'Run', agent: 'Bot', at: at(40) }],
  reviews: [{ chatId: 4, title: 'Chat 4', workpieces: [7], at: at(50) }, { chatId: 1, title: 'Chat 1', workpieces: [7], at: at(1) }],
  working: [{ chatId: 5, title: 'Chat 5', at: at(1) }],
})

describe('chatStatesOf', () => {
  it('says how each chat in progress stands, in one way only, approvals first, then answers, failures, reviews and work', () => {
    expect([...states].map(([id, { kind, words }]) => [id, kind, words])).toEqual([
      [1, 'approval', 'Needs approval'],
      [2, 'answer', 'Needs action'],
      [3, 'failed', 'Run failed'],
      [4, 'review', 'Ready for review'],
      [5, 'working', 'Working…'],
    ])
  })
})

describe('chatByOf and speakerOf', () => {
  const me = { type: 'user', id: 'me', name: 'Me' } as const
  const ada = { type: 'user', id: 'ada', name: 'Ada' } as const
  const model = { type: 'agent', id: 'm', name: 'Model' } as const

  it('is the agent a run is of, or the person who started a chat, the viewer as You', () => {
    expect(chatByOf(run(1, 0), undefined, 'me')).toEqual({ kind: 'agent', name: 'Agent 9' })
    expect(chatByOf(chat(1, 0), me, 'me')).toEqual({ kind: 'person', name: 'You', fullName: 'Me' })
    expect(chatByOf(chat(1, 0), ada, 'me')).toEqual({ kind: 'person', name: 'Ada', fullName: 'Ada' })
    expect(chatByOf(chat(1, 0), undefined, 'me')).toBeUndefined()
  })

  it('says who said the latest message: a run’s agent, a person, but not a chat’s own assistant', () => {
    expect(speakerOf(run(1, 0), model, 'me')).toBe('Agent 9')
    expect(speakerOf(chat(1, 0), model, 'me')).toBeUndefined()
    expect(speakerOf(chat(1, 0), me, 'me')).toBe('You')
    expect(speakerOf(chat(1, 0), ada, 'me')).toBe('Ada')
  })
})
