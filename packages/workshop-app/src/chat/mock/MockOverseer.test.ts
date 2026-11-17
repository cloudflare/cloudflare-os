import { describe, expect, it, vi } from 'vitest'
import type { AiChatMessage, AiChatMetadata, AiChatStreamEvent } from '@gadgets/workshop-shared/api'
import { MockOverseer } from './MockOverseer'
import { action, agent, connectionRequest, history, turn, user, when, type Scenario } from './scenario'

const scenario = (partial: Partial<Scenario>): Scenario => ({
  id: 'test',
  title: 'Test',
  description: '',
  history: [],
  script: [],
  ...partial,
})

const subscribed = (overseer: MockOverseer) => {
  const messages: AiChatMessage[] = []
  const metadata: AiChatMetadata[] = []
  const stream: AiChatStreamEvent[] = []
  void overseer.subscribeToChat({
    streamGeneration: () => {},
    message: (message) => void messages.push(message),
    metadata: (chat) => void metadata.push(chat),
    stream: (_chatId, event) => void stream.push(event),
  })
  return { messages, metadata, stream }
}

describe('MockOverseer', () => {
  it('pages history backwards from the tail, as the real server does with a limit', async () => {
    const overseer = new MockOverseer(scenario({ history: history(Array.from({ length: 7 }, (_, i) => user(`m${i}`))) }))

    const tail = await overseer.getChatHistory(0, undefined, 3)
    expect(tail.messages.map(({ sequence }) => sequence)).toEqual([4, 5, 6])
    expect(tail.nextBeforeSequence).toBe(4)

    const middle = await overseer.getChatHistory(0, tail.nextBeforeSequence, 3)
    expect(middle.messages.map(({ sequence }) => sequence)).toEqual([1, 2, 3])

    const first = await overseer.getChatHistory(0, middle.nextBeforeSequence, 3)
    expect(first.messages.map(({ sequence }) => sequence)).toEqual([0])
    expect(first.nextBeforeSequence).toBeUndefined()
  })

  it('runs steps in order when stepped, numbering each message after the last', () => {
    const overseer = new MockOverseer(scenario({
      history: history([user('hi')]),
      script: turn({ stream: { type: 'textDelta', delta: 'Hel' } }, { message: agent({ text: 'Hello' }) }),
    }))
    const seen = subscribed(overseer)

    overseer.player.step()
    expect(seen.metadata.at(-1)?.activeAgent).toBeDefined()
    overseer.player.step()
    expect(seen.stream).toEqual([{ type: 'textDelta', delta: 'Hel' }])
    overseer.player.step()
    expect(seen.messages).toMatchObject([{ sequence: 1, message: 'Hello' }])
    overseer.player.step()
    expect(seen.metadata.at(-1)?.activeAgent).toBeUndefined()
    expect(overseer.player.getSnapshot()).toMatchObject({ position: 4, total: 4 })
  })

  it('holds a step that waits for the user until they act, and ignores what nothing waits for', async () => {
    const pending = action({ title: 'Create issue' })
    const overseer = new MockOverseer(scenario({
      history: history([pending]),
      script: when('onApprove', [{ message: agent({ text: 'Created.' }) }]),
    }))
    const seen = subscribed(overseer)
    const entry = vi.fn<(record: unknown) => void>()
    void overseer.subscribeToActions({ entry })

    await overseer.retryAgent()
    overseer.player.step()
    expect(seen.messages).toEqual([])
    expect(overseer.player.getSnapshot().waitingFor).toEqual(['onApprove'])

    await overseer.approveAction(pending.actionId)
    // A decided action is reported through the actions subscription, not as a chat message.
    expect(entry).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: pending.actionId, state: 'approved' }))
    overseer.player.step()
    expect(seen.messages).toMatchObject([{ message: 'Created.' }])
  })

  it('queues a message sent while the agent works, and delivers it when the turn ends unread', async () => {
    const overseer = new MockOverseer(scenario({ script: turn() }))
    const seen = subscribed(overseer)

    overseer.player.step()
    await overseer.sendChatMessage(0, 'Shorter please')
    expect(seen.metadata.at(-1)?.queuedSteers).toMatchObject([{ text: 'Shorter please' }])
    expect(seen.messages).toEqual([])

    overseer.player.step()
    expect(seen.metadata.at(-1)?.queuedSteers).toBeUndefined()
    expect(seen.messages).toMatchObject([{ message: 'Shorter please' }])
  })

  it('delivers a resolved connection request as its chat message again', async () => {
    const request = connectionRequest({ vendorName: 'ClickHouse', reason: 'Read error rates.' })
    const overseer = new MockOverseer(scenario({ history: history([request]) }))
    const seen = subscribed(overseer)

    await overseer.denyConnectionRequest(request.requestId)

    expect(seen.messages).toMatchObject([{ sequence: 0, type: 'connectionRequest', state: 'denied' }])
    await expect(overseer.denyConnectionRequest(request.requestId)).rejects.toThrow('No such pending request.')
  })
})
