import { describe, expect, it, vi } from 'vitest'
import type { ActionHistoryPage, ActionLogEntry, AiChatMessage, AiChatMetadata } from '@gadgets/workshop-shared/api'
import { plainLine, WorkspaceActivity, type ActivityOverseer } from './WorkspaceActivity'

const at = (minutes: number) => new Date(Date.UTC(2026, 10, 20, 12, minutes))
const chat = (id: number, more: Partial<AiChatMetadata> = {}): AiChatMetadata => ({ id, title: `Chat ${id}`, started: at(0), lastActive: at(0), ...more }) as AiChatMetadata
const action = (id: number, more: Partial<ActionLogEntry> = {}): ActionLogEntry => ({
  id,
  type: 'action',
  resourceTitle: 'Repo',
  createdAt: at(id),
  state: 'pending',
  description: { title: `Action ${id}`, description: '', implementsRevert: false, autoApprovable: true },
  ...more,
}) as ActionLogEntry
const message = (chatId: number, author: AiChatMessage['author'], more: Record<string, unknown> = {}) =>
  ({ chatId, sequence: 1, timestamp: at(0), author, type: 'message', message: 'Please', ...more }) as AiChatMessage
const ada = { type: 'user', id: 'ada', name: 'Ada' } as const

type Fake = {
  chats?: AiChatMetadata[]
  pending?: ActionHistoryPage[]
  history?: Record<string, ActionHistoryPage>
  tails?: Record<number, AiChatMessage[]>
}

const fake = ({ chats = [], pending = [{ entries: [] }], history = { first: { entries: [] } }, tails = {} }: Fake) => {
  const events: { chat?: { message(message: AiChatMessage): void; metadata(chat: AiChatMetadata): void }; actions?: { entry(record: ActionLogEntry): void } } = {}
  const lease = Promise.resolve({ [Symbol.dispose]: () => {} })
  const overseer = {
    subscribeToChat: (subscriber: never) => {
      events.chat = subscriber
      return lease
    },
    subscribeToActions: (subscriber: never) => {
      events.actions = subscriber
      return lease
    },
    listChats: async () => chats,
    listActions: async ({ filter, beforeId }: { filter?: string; beforeId?: number } = {}) =>
      filter === 'pending' ? pending[beforeId === undefined ? 0 : 1] : history[beforeId === undefined ? 'first' : String(beforeId)],
    getChatHistory: vi.fn<(chatId: number) => Promise<{ messages: AiChatMessage[] }>>(async (chatId) => ({ messages: tails[chatId] ?? [] })),
    onRpcBroken: () => {},
    [Symbol.dispose]: () => {},
  }
  return { overseer: overseer as unknown as ActivityOverseer & { getChatHistory: ReturnType<typeof vi.fn> }, events }
}

const ready = (activity: WorkspaceActivity) => {
  const snapshot = activity.getSnapshot()
  if (snapshot.status !== 'ready') throw new Error(`not ready: ${snapshot.status}`)
  return snapshot
}

describe('WorkspaceActivity', () => {
  it('reads every page of what waits, and the history a page at a time as it is asked for', async () => {
    const { overseer } = fake({
      chats: [chat(1)],
      pending: [{ entries: [action(9)], nextBeforeId: 9 }, { entries: [action(2)] }],
      history: { first: { entries: [action(9), action(8, { state: 'approved' })], nextBeforeId: 8 }, 8: { entries: [action(2)] } },
    })
    const activity = new WorkspaceActivity(() => overseer)
    activity.start()
    await vi.waitFor(() => expect(ready(activity).history.read).toBe(true))
    await vi.waitFor(() => expect(ready(activity).pending.map(({ id }) => id).toSorted()).toEqual([2, 9]))
    expect(ready(activity).history).toMatchObject({ more: true, reading: false })
    expect(ready(activity).history.entries.map(({ id }) => id)).toEqual([9, 8])

    activity.loadOlder()
    await vi.waitFor(() => expect(ready(activity).history.entries.map(({ id }) => id)).toEqual([9, 8, 2]))
    expect(ready(activity).history.more).toBe(false)
  })

  it('lays what changes live over the history, and takes what was decided out of what waits', async () => {
    const { overseer, events } = fake({ pending: [{ entries: [action(5)] }], history: { first: { entries: [action(5)] } } })
    const activity = new WorkspaceActivity(() => overseer)
    activity.start()
    await vi.waitFor(() => expect(ready(activity).pending).toHaveLength(1))
    await vi.waitFor(() => expect(ready(activity).history.read).toBe(true))

    events.actions!.entry(action(5, { state: 'approved', resolvedBy: ada }))
    events.actions!.entry(action(6))
    expect(ready(activity).pending.map(({ id }) => id)).toEqual([6])
    expect(ready(activity).history.entries.map(({ id, state }) => [id, state])).toEqual([[6, 'pending'], [5, 'approved']])
  })

  it('reads who last wrote from the last messages of each chat that waits, and of the latest people had, once, and hears it as they write', async () => {
    const { overseer, events } = fake({
      chats: [chat(1), chat(2, { awaitingDecision: true }), chat(3)],
      pending: [{ entries: [action(4, { chatId: 1 })] }],
      tails: { 1: [message(1, ada), message(1, { type: 'agent', id: 'm', name: 'M' })], 2: [message(2, { type: 'gadget', id: 'g', name: 'Inbox' })] },
    })
    const activity = new WorkspaceActivity(() => overseer)
    activity.start()
    await vi.waitFor(() => expect(ready(activity).askers.get(1)).toEqual(ada))
    await vi.waitFor(() => expect(overseer.getChatHistory).toHaveBeenCalledTimes(3))
    expect(ready(activity).askers.has(2)).toBe(false)
    expect(overseer.getChatHistory.mock.calls.map(([chatId]) => chatId).slice(0, 2).toSorted()).toEqual([1, 2])

    events.chat!.message(message(3, { type: 'user', id: 'alan', name: 'Alan' }))
    expect(ready(activity).askers.get(3)?.name).toBe('Alan')
  })

  it('reads what each chat that waits last asked: a connection to make, or an action to approve, while undecided', async () => {
    const model = { type: 'agent', id: 'm', name: 'M' } as const
    const { overseer, events } = fake({
      chats: [chat(1, { awaitingDecision: true }), chat(2, { awaitingDecision: true })],
      tails: {
        1: [message(1, ada, { message: 'Write the **report**' }), message(1, model, { type: 'connectionRequest', state: 'pending', vendorName: 'Jira', reason: 'To read the tickets.' })],
        2: [message(2, model, { type: 'action', actionId: 3, actionLog: action(3, { chatId: 2, description: { title: 'Share `plan`', description: '', implementsRevert: false, autoApprovable: true } }) })],
      },
    })
    const activity = new WorkspaceActivity(() => overseer)
    activity.start()
    await vi.waitFor(() => expect(ready(activity).asks.size).toBe(2))
    expect(ready(activity).asks.get(1)?.text).toBe('Connect Jira · To read the tickets.')
    expect(ready(activity).asks.get(2)?.text).toBe('Share plan')
    expect(ready(activity).latest.get(1)?.text).toBe('Write the report')

    events.chat!.message(message(1, model, { type: 'connectionRequest', state: 'pending', vendorName: 'Linear', reason: 'To file it.' }))
    expect(ready(activity).asks.get(1)?.text).toBe('Connect Linear · To file it.')
  })

  it('learns an action’s chat from the message that names it, where the action does not say', async () => {
    const { overseer, events } = fake({ chats: [chat(1)], pending: [{ entries: [action(7)] }] })
    const activity = new WorkspaceActivity(() => overseer)
    activity.start()
    await vi.waitFor(() => expect(ready(activity).pending).toHaveLength(1))
    events.chat!.message({ chatId: 1, sequence: 2, timestamp: at(0), author: ada, type: 'action', actionId: 7 } as unknown as AiChatMessage)
    expect(ready(activity).actionChats.get(7)).toBe(1)
  })
})

describe('plainLine', () => {
  it('says a line of Markdown in plain words', () => {
    expect(plainLine('The **Inbox helper**: see [its page](https://example.com).')).toBe('The Inbox helper: see its page.')
    expect(plainLine('The sign-in page drops the `next` parameter, _again_.')).toBe('The sign-in page drops the next parameter, again.')
    expect(plainLine('## Summary')).toBe('Summary')
    expect(plainLine('- one * two, snake_case_name')).toBe('one * two, snake_case_name')
  })
})
