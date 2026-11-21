import { describe, expect, it, vi } from 'vitest'
import type { AiChatMetadata, CodeChangeSubmission, FileAtCommit, WorkpiecesSubscriber } from '@gadgets/workshop-shared/api'
import { withFile, type CodeDraft } from './codeDrafts'
import { saveCode, type SaveCodeOptions, type SavingOverseer } from './saveCode'

const GADGET = 7
const text = (value: string) => ({ kind: 'text', text: value }) as const

const chat = (id: number, extra: Partial<AiChatMetadata> = {}): AiChatMetadata => ({ id, title: 'Chat', started: new Date(0), lastActive: new Date(0), ...extra })

/**
 * A workspace holding one gadget, whose head is `heads` in turn, one for each read of it, and whose
 * files at each commit are `files`. Merges are answered from `merges`, in turn, then merged.
 */
const fakeWorkspace = ({ heads = ['c1'], files = {}, chats = [chat(1)], merges = [] }: {
  heads?: string[]
  files?: Record<string, Record<string, string>>
  chats?: AiChatMetadata[]
  merges?: Array<'merged' | 'stale'>
} = {}) => {
  let reads = 0
  const listed = [...chats]
  const overseer = {
    subscribeToWorkpieces: vi.fn<(subscriber: WorkpiecesSubscriber) => Promise<Disposable>>(async (subscriber) => {
      const commitId = heads[Math.min(reads++, heads.length - 1)]
      subscriber.entry({ id: GADGET, type: 'gadget', title: 'Counter', commitId })
      subscriber.ready()
      return { [Symbol.dispose]: () => {} }
    }),
    readFilesAtCommit: vi.fn<SavingOverseer['readFilesAtCommit']>(async (commit, paths) =>
      paths.map((path): [string, FileAtCommit] => [path, path in (files[commit] ?? {}) ? text(files[commit][path]) : { kind: 'absent' }])),
    getChatMetadata: vi.fn<SavingOverseer['getChatMetadata']>(async (chatId) => listed.find(({ id }) => id === chatId)),
    newChat: vi.fn<() => Promise<number>>(async () => {
      listed.push(chat(9))
      return 9
    }),
    setChatTitle: vi.fn<SavingOverseer['setChatTitle']>(async () => {}),
    submitCodeChange: vi.fn<(chatId: number, submission: CodeChangeSubmission) => Promise<{ generation: number; revision: number }>>(async () => ({ generation: 0, revision: 1 })),
    mergeChanges: vi.fn<SavingOverseer['mergeChanges']>(async () => ({ outcome: merges.shift() ?? 'merged' })),
    revertChanges: vi.fn<SavingOverseer['revertChanges']>(async () => {}),
    [Symbol.dispose]: vi.fn<() => void>(),
  }
  return overseer
}

const draftOf = (base = 'c1'): CodeDraft => withFile(withFile(undefined, base, 'client.ts', text('a'), 'A'), base, 'styles.css', text('s'), null)!

const save = (overseer: ReturnType<typeof fakeWorkspace>, options: Partial<SaveCodeOptions> = {}) =>
  saveCode(() => overseer as unknown as SavingOverseer, { gadgetId: GADGET, draft: draftOf(), chat: { title: 'Counter', reuse: 1 }, newClientId: () => 'client', ...options })

describe('saveCode', () => {
  it('submits the draft to the chat it reuses, pinned at the head, and keeps it', async () => {
    const overseer = fakeWorkspace({ heads: ['c1', 'c2'] })
    expect(await save(overseer)).toEqual({ status: 'saved', head: 'c2' })
    expect(overseer.submitCodeChange).toHaveBeenCalledWith(1, {
      generation: 0,
      revision: 0,
      clientId: 'client',
      seq: 1,
      pins: [{ gadgetId: GADGET, baseCommit: 'c1' }],
      change: { [GADGET]: [['client.ts', { set: 'A' }], ['styles.css', { remove: true }]] },
    })
    expect(overseer.mergeChanges).toHaveBeenCalledWith(1)
    expect(overseer.readFilesAtCommit).not.toHaveBeenCalled()
    expect(overseer[Symbol.dispose]).toHaveBeenCalled()
  })

  it('submits at the chat’s place in its stream, and declares no pin it has already', async () => {
    const codeBase = { pins: [{ gadgetId: GADGET, baseCommit: 'c1', mergedCommit: 'c1' }], generation: 3, revision: 5 }
    const overseer = fakeWorkspace({ chats: [chat(1, { codeBase } as Partial<AiChatMetadata>)] })
    await save(overseer)
    expect(overseer.submitCodeChange.mock.calls[0]?.[1]).toMatchObject({ generation: 3, revision: 5, pins: [] })
  })

  it('stops with the files someone else changed since the draft touched them', async () => {
    const overseer = fakeWorkspace({ heads: ['c2'], files: { c2: { 'client.ts': 'a', 'styles.css': 'theirs' } } })
    expect(await save(overseer)).toEqual({ status: 'conflict', paths: ['styles.css'] })
    expect(overseer.submitCodeChange).not.toHaveBeenCalled()
  })

  it('moves onto a head that changed none of the draft’s files, and pins there', async () => {
    const overseer = fakeWorkspace({ heads: ['c2'], files: { c2: { 'client.ts': 'a', 'styles.css': 's' } } })
    expect((await save(overseer)).status).toBe('saved')
    expect(overseer.submitCodeChange.mock.calls[0]?.[1].pins).toEqual([{ gadgetId: GADGET, baseCommit: 'c2' }])
  })

  it('saves the draft over the other change when asked to anyway', async () => {
    const overseer = fakeWorkspace({ heads: ['c2'], files: { c2: { 'client.ts': 'theirs', 'styles.css': 's' } } })
    expect((await save(overseer, { anyway: true })).status).toBe('saved')
    expect(overseer.submitCodeChange.mock.calls[0]?.[1].change).toEqual({ [GADGET]: [['client.ts', { set: 'A' }], ['styles.css', { remove: true }]] })
  })

  it('saves nothing where the head already has the draft', async () => {
    const overseer = fakeWorkspace({ heads: ['c2'], files: { c2: { 'client.ts': 'A' } } })
    expect(await save(overseer)).toEqual({ status: 'saved', head: 'c2' })
    expect(overseer.submitCodeChange).not.toHaveBeenCalled()
  })

  it('makes another chat where the one it made is working, as keeping it would keep that too', async () => {
    const overseer = fakeWorkspace({ chats: [chat(1, { activeAgent: { type: 'agent', id: 'm', name: 'M' } })] })
    expect((await save(overseer)).status).toBe('saved')
    expect(overseer.submitCodeChange.mock.calls[0]?.[0]).toBe(9)
  })

  it('takes a stale keep back out of the chat, checks again, and saves', async () => {
    const overseer = fakeWorkspace({ heads: ['c1', 'c2', 'c2'], files: { c2: { 'client.ts': 'a', 'styles.css': 's' } }, merges: ['stale'] })
    expect(await save(overseer)).toEqual({ status: 'saved', head: 'c2' })
    expect(overseer.revertChanges).toHaveBeenCalledWith(1, 0)
    expect(overseer.submitCodeChange).toHaveBeenCalledTimes(2)
    expect(overseer.submitCodeChange.mock.calls[1]?.[1].pins).toEqual([{ gadgetId: GADGET, baseCommit: 'c2' }])
  })

  it('stops at a conflict found after a stale keep', async () => {
    const overseer = fakeWorkspace({ heads: ['c1', 'c2'], files: { c2: { 'client.ts': 'theirs', 'styles.css': 's' } }, merges: ['stale'] })
    expect(await save(overseer)).toEqual({ status: 'conflict', paths: ['client.ts'] })
    expect(overseer.revertChanges).toHaveBeenCalledTimes(1)
  })

  it('gives up after a second stale keep', async () => {
    const overseer = fakeWorkspace({ merges: ['stale', 'stale'] })
    expect(await save(overseer)).toEqual({ status: 'failed', message: 'Someone else’s changes landed meanwhile. Try again.' })
    expect(overseer.revertChanges).toHaveBeenCalledTimes(2)
  })

  it('takes the change back out of the chat when keeping it fails', async () => {
    const overseer = fakeWorkspace()
    overseer.mergeChanges.mockRejectedValueOnce(new Error('Not allowed.'))
    expect(await save(overseer)).toEqual({ status: 'failed', message: 'Not allowed.' })
    expect(overseer.revertChanges).toHaveBeenCalledWith(1, 0)
  })

  it('makes a chat on the gadget’s own page, its agent off, saying what was done', async () => {
    const overseer = fakeWorkspace({ chats: [] })
    const onChatMade = vi.fn<(chatId: number) => void>()
    expect((await save(overseer, { chat: { title: 'Counter' }, onChatMade })).status).toBe('saved')
    expect(overseer.newChat).toHaveBeenCalledWith('Edited client.ts and styles.css', null)
    expect(overseer.setChatTitle).toHaveBeenCalledWith(9, 'Edits to Counter')
    expect(onChatMade).toHaveBeenCalledWith(9)
    expect(overseer.submitCodeChange.mock.calls[0]?.[0]).toBe(9)
    expect(overseer.submitCodeChange.mock.calls[0]?.[1]).toMatchObject({ generation: 0, revision: 0 })
  })

  it('reuses the chat it made last while it can take the save', async () => {
    const overseer = fakeWorkspace({ chats: [chat(4)] })
    await save(overseer, { chat: { title: 'Counter', reuse: 4 } })
    expect(overseer.newChat).not.toHaveBeenCalled()
    expect(overseer.submitCodeChange.mock.calls[0]?.[0]).toBe(4)

    const busy = fakeWorkspace({ chats: [chat(4, { proposedChangeWorkpieces: [GADGET] })] })
    await save(busy, { chat: { title: 'Counter', reuse: 4 } })
    expect(busy.newChat).toHaveBeenCalled()
  })

  it('says why a gadget still waiting in a chat cannot be saved', async () => {
    const overseer = fakeWorkspace()
    overseer.subscribeToWorkpieces.mockImplementationOnce(async (subscriber: WorkpiecesSubscriber) => {
      subscriber.entry({ id: GADGET, type: 'gadget', title: 'Counter', chatId: 1 })
      subscriber.ready()
      return { [Symbol.dispose]: () => {} }
    })
    expect(await save(overseer)).toEqual({ status: 'failed', message: 'It’s still waiting in a chat. Keep that chat’s changes to edit it here.' })
  })
})
