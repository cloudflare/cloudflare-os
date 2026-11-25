import { describe, expect, it, vi } from 'vitest'
import type { AiChatMessage, AiChatMetadata, AiChatStreamEvent, GadgetSummary, WorkspacesSubscriber } from '@gadgets/workshop-shared/api'
import type { CodeChange } from '@gadgets/workshop-shared/code-change'
import type { StreamRow } from '../code/changeStream'
import type { ApiSession } from '@/rpc/ApiContext'
import { createMockApi } from './mockApi'
import { withFile, type CodeDraft } from '@/gadgets/codeDrafts'
import { saveCode, type SavingOverseer } from '@/gadgets/saveCode'
import { templateUpdateStatus } from '@/gadgets/templateUpdate'
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
  const rows: StreamRow[] = []
  void overseer.subscribeToChat({
    streamGeneration: () => {},
    message: (message) => void messages.push(message),
    metadata: (chat) => void metadata.push(chat),
    stream: (_chatId, event) => void stream.push(event),
    deleted: (chatId) => void deleted.push(chatId),
    changeApplied: (_chatId, generation, revision, _author, change, submission) => void rows.push({ generation, revision, change, submission }),
  })
  return { messages, metadata, stream, deleted, rows }
}

// Sets gadget 3's notes.
const set = (text: string): CodeChange => ({ 3: [['notes.md', { set: text }]] })

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
    // What the list shows, by id: what the fake said first, then each change.
    const listed = async (api: ApiSession['api']) => {
      const ids = new Set<string>()
      const subscriber: Pick<WorkspacesSubscriber, 'snapshot' | 'updated'> = {
        snapshot: async (workspaces) => workspaces.forEach(({ id }) => ids.add(id)),
        updated: async (id, workspace) => void (workspace ? ids.add(id) : ids.delete(id)),
      }
      // Plain, as the fake answers whatever it is given.
      await api.subscribeToWorkspaces(subscriber as unknown as Parameters<typeof api.subscribeToWorkspaces>[0])
      return ids
    }
    const own = createMockApi(scenario({}))
    expect(await own.overseer.getMetadata()).toMatchObject({ owner: undefined })
    const ownList = await listed(own.session.api)
    expect([...ownList]).toEqual(['mock'])
    await own.session.api.openWorkspace('mock').deleteSelf()
    expect([...ownList]).toEqual([])

    const grace = { type: 'user', id: 'grace@example.com', name: 'Grace Hopper' } as const
    const shared = createMockApi(scenario({ owner: grace }))
    const sharedList = await listed(shared.session.api)
    expect([...sharedList]).toEqual(['mock'])
    expect((await shared.overseer.listCollaborators()).map(({ profile }) => profile.name)).toEqual(['Ada Lovelace', 'Alan Turing'])
    await shared.session.api.dismissSharedWorkspace('mock')
    expect([...sharedList]).toEqual([])
    expect([...(await listed(shared.session.api))]).toEqual([])
  })

  it('offers the output scenario a newer published release through the public API', async () => {
    const { overseer, session, publicApi } = createMockApi(scenario({ templateUpdate: true }))
    using workspace = session.api.openWorkspace('mock')
    using _gadget = workspace.getGadget(3)
    const entries: GadgetSummary[] = []
    using _lease = await overseer.subscribeToWorkpieces({
      entry: (summary) => {
        if (summary.type === 'gadget') entries.push(summary)
      },
      removed: () => {},
      ready: () => {},
    })
    const upstream = entries[0]?.upstream
    const release = await publicApi.getBlueprint(upstream?.blueprintId ?? '')
    expect(templateUpdateStatus(upstream, release?.metadata)).toBe('available')
    expect(await publicApi.getBlueprint('no-such-template')).toBeNull()
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

  it('keeps edits saved through a chat, and holds them back once someone else changed their file', async () => {
    const { overseer, session } = createMockApi(scenario({ history: history([user('hi')]) }))
    const workspace = session.api.openWorkspace('mock')
    workspace.getGadget(3)
    const heads: Array<string | undefined> = []
    const subscriber = { entry: ({ commitId }: { commitId?: string }) => void heads.push(commitId), removed: () => {}, ready: () => {} }
    await workspace.subscribeToWorkpieces(subscriber as unknown as Parameters<typeof workspace.subscribeToWorkpieces>[0])
    const head = heads.at(-1)!
    const read = async (commit: string) => (await workspace.readFilesAtCommit(commit, ['client.js']))[0]![1]
    const was = await read(head)
    if (was.kind !== 'text') throw new Error('No client.js')
    const save = (draft: CodeDraft) => saveCode(() => overseer.open() as unknown as SavingOverseer, { gadgetId: 3, draft, chat: { title: 'Tip jar', reuse: 0 }, newClientId: () => 'client' })

    expect((await save(withFile(undefined, head, 'client.js', was, 'h1 { font-size: 28px }')!)).status).toBe('saved')
    const saved = heads.at(-1)!
    expect(saved).not.toBe(head)
    expect(await read(saved)).toEqual({ kind: 'text', text: 'h1 { font-size: 28px }' })
    expect((await overseer.listChats())[0]?.proposedChangeWorkpieces).toBeUndefined()

    overseer.keepElsewhere()
    expect(await save(withFile(undefined, saved, 'client.js', { kind: 'text', text: 'h1 { font-size: 28px }' }, 'mine')!)).toEqual({ status: 'conflict', paths: ['client.js'] })
  })

  it('takes each edit to the chat’s code as the server does, and records what it took once kept', async () => {
    const { overseer, session } = createMockApi(scenario({ history: history([user('hi')]) }))
    const workspace = session.api.openWorkspace('mock')
    workspace.getGadget(3)
    let head = ''
    const subscriber = { entry: ({ commitId }: { commitId?: string }) => void (head = commitId ?? head), removed: () => {}, ready: () => {} }
    await workspace.subscribeToWorkpieces(subscriber as unknown as Parameters<typeof workspace.subscribeToWorkpieces>[0])
    const seen = subscribed(overseer)
    const generation = (await overseer.listChats())[0]?.codeBase?.generation ?? 0

    // Unpinned, it has to say the head it is over.
    await expect(overseer.submitCodeChange(0, { generation, revision: 0, clientId: 'a', seq: 1, change: set('a') })).rejects.toThrow('isn’t pinned at its head')
    const first = { generation, revision: 0, clientId: 'a', seq: 1, pins: [{ gadgetId: 3, baseCommit: head }], change: set('a') }
    expect(await overseer.submitCodeChange(0, first)).toEqual({ generation, revision: 1 })
    // Sent again, it is taken once.
    expect(await overseer.submitCodeChange(0, first)).toEqual({ generation, revision: 1 })
    // Made over what came before the first, it lands after it, and wins as the later one.
    expect(await overseer.submitCodeChange(0, { generation, revision: 0, clientId: 'b', seq: 1, change: set('b') })).toEqual({ generation, revision: 2 })
    expect(seen.rows.map(({ revision, submission }) => [revision, submission?.clientId])).toEqual([[1, 'a'], [2, 'b']])
    expect((await overseer.listChats())[0]?.codeBase?.pins).toEqual([{ gadgetId: 3, baseCommit: head, mergedCommit: head }])

    expect(await overseer.mergeChanges(0)).toEqual({ outcome: 'merged' })
    const recorded = seen.messages.find((message) => message.type === 'changes' && message.watermark)
    expect(recorded).toMatchObject({ watermark: { changesGeneration: generation, throughRevision: 2 } })
    expect((await overseer.listChats())[0]?.codeBase).toMatchObject({ generation: generation + 1, prior: { generation, finalRevision: 2 } })
    const merged = seen.messages.at(-1)
    if (merged?.type !== 'merge') throw new Error('It wasn’t marked as kept.')
    expect(merged.commits.map(({ gadgetId }) => gadgetId)).toEqual([3])
    expect(await overseer.readFilesAtCommit(merged.commits[0]!.commitId, ['notes.md'])).toEqual([['notes.md', { kind: 'text', text: 'b' }]])
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
