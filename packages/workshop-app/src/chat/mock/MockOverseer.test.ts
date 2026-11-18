import { describe, expect, it, vi } from 'vitest'
import type { AiChatMessage, AiChatMetadata, AiChatStreamEvent } from '@gadgets/workshop-shared/api'
import { createMockApi } from './mockApi'
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
  const deleted: number[] = []
  void overseer.subscribeToChat({
    streamGeneration: () => {},
    message: (message) => void messages.push(message),
    metadata: (chat) => void metadata.push(chat),
    stream: (_chatId, event) => void stream.push(event),
    deleted: (chatId) => void deleted.push(chatId),
  })
  return { messages, metadata, stream, deleted }
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

  it('lists the workspace until it deletes itself, or one shared with the viewer is removed from their list', async () => {
    const own = createMockApi(scenario({}))
    expect(await own.overseer.getMetadata()).toMatchObject({ owner: undefined })
    await own.session.api.openWorkspace('mock').deleteSelf()
    expect(await own.session.api.listWorkspaces()).toEqual([])

    const grace = { type: 'user', id: 'grace@example.com', name: 'Grace Hopper' } as const
    const shared = createMockApi(scenario({ owner: grace }))
    expect(await shared.session.api.listWorkspaces()).toMatchObject([{ owner: grace }])
    expect((await shared.overseer.listCollaborators()).map(({ profile }) => profile.name)).toEqual(['Ada Lovelace', 'Alan Turing'])
    await shared.session.api.dismissSharedWorkspace('mock')
    expect(await shared.session.api.listWorkspaces()).toEqual([])
  })

  it('renames and deletes a gadget, which those listening to the workpieces hear of', async () => {
    const workspace = createMockApi(scenario({})).session.api.openWorkspace('mock')
    const titles: string[] = []
    const removed: number[] = []
    const subscriber = { entry: ({ title }: { title: string }) => void titles.push(title), removed: (id: number) => void removed.push(id), ready: () => {} }
    // Plain, as the fake answers whatever it is given.
    await workspace.subscribeToWorkpieces(subscriber as unknown as Parameters<typeof workspace.subscribeToWorkpieces>[0])
    // The gadget is listed once it has been asked for.
    workspace.getGadget(3)

    await workspace.getGadget(3).setTitle('Q4 platform review')
    expect(titles).toEqual(['Q3 platform review', 'Q4 platform review'])

    await workspace.getGadget(3).remove()
    expect(removed).toEqual([3])
    expect(() => workspace.getGadget(3)).toThrow('No gadget 3.')
  })

    it('deletes the chat, which its subscribers hear of and the workspace no longer lists', async () => {
    const overseer = new MockOverseer(scenario({ history: history([user('hi')]) }))
    const seen = subscribed(overseer)
    const chatUpdated = vi.fn<(workspaceId: string, chatId: number, chat: unknown) => Promise<void>>(async () => {})
    void overseer.subscribeToReadState('mock', { updated: async () => {}, chatUpdated })

    await overseer.deleteChat(0)

    expect(seen.deleted).toEqual([0])
    expect(chatUpdated).toHaveBeenCalledWith('mock', 0, null, expect.anything())
    expect(await overseer.listChats()).toEqual([])
  })

  it('keeps the viewer’s notifications for the chat as they choose them, and tells their read state', async () => {
    const overseer = new MockOverseer(scenario({}))
    const updated = vi.fn<(state: { chats: unknown[] }) => Promise<void>>(async () => {})
    const chatUpdated = vi.fn<(workspaceId: string, chatId: number, chat: unknown) => Promise<void>>(async () => {})
    void overseer.subscribeToReadState('mock', { updated, chatUpdated })
    expect(updated).toHaveBeenCalledWith(expect.objectContaining({ chats: [expect.objectContaining({ chatId: 0, notificationsEnabled: true })] }))

    await overseer.setChatNotificationsEnabled(0, false)

    expect(chatUpdated).toHaveBeenCalledWith('mock', 0, expect.objectContaining({ notificationsEnabled: false, notificationsEnabledOverride: false }), expect.anything())
  })
})
