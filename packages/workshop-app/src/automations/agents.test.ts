import { describe, expect, it } from 'vitest'
import type { AgentSpawnerInfo, AiChatMetadata } from '@gadgets/workshop-shared/api'
import { agentsOf, calledByGadget, startedInChat } from './agents'

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 14, 12, minutes))
const chat = (id: number, minutes: number, more: Partial<AiChatMetadata> = {}): AiChatMetadata =>
  ({ id, title: `Run ${id}`, started: at(0), lastActive: at(minutes), ...more }) as AiChatMetadata
const spawner = (id: number, name: string): AgentSpawnerInfo =>
  ({ gatekeeperId: id, displayName: name, modelId: 'm', modelName: 'Model', gadgetIds: [2], access: [{ name: 'INBOX', target: 4, resourceTitle: 'Support inbox' }, { name: 'NOTES', target: 5 }] })

describe('agentsOf', () => {
  it('gives each agent its runs, latest first, and the chats that started them', () => {
    const chats = [
      chat(1, 5, { spawnerId: 7, parentChatId: 0 }),
      chat(2, 9, { spawnerId: 7, awaitingDecision: true }),
      chat(3, 1, { spawnerId: 8 }),
      chat(4, 2),
      // Spawned before chats named their spawner: known by its name.
      chat(5, 3, { spawnerName: 'Inbox helper' }),
    ]
    const [helper, other] = agentsOf('w', [spawner(7, 'Inbox helper'), spawner(8, 'Other')], chats)
    expect(helper).toMatchObject({ key: 'w:7', name: 'Inbox helper', access: [{ name: 'INBOX', title: 'Support inbox' }, { name: 'NOTES', title: 'NOTES' }] })
    expect(helper.runs.map(({ chatId, waiting }) => [chatId, waiting])).toEqual([[2, true], [1, false], [5, false]])
    expect([...helper.startedFrom]).toEqual([0])
    expect(other.runs.map(({ chatId }) => chatId)).toEqual([3])
    expect([calledByGadget(2)(helper), calledByGadget(3)(helper), startedInChat(0)(helper), startedInChat(0)(other)]).toEqual([true, false, true, false])
  })

  it('names its model as the user’s models do, else as recorded', () => {
    const [named, recorded] = agentsOf('w', [spawner(7, 'A'), { ...spawner(8, 'B'), modelId: 'gone' }], [], new Map([['m', 'Claude Sonnet 5.5']]))
    expect([named.modelName, recorded.modelName]).toEqual(['Claude Sonnet 5.5', 'Model'])
  })
})
