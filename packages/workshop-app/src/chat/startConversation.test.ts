import { describe, expect, it, vi } from 'vitest'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { composerCommandOf } from './slashCommands'
import { startConversation, type NewConversationOverseer } from './startConversation'

const fakeOverseer = (workspaceId = 'ws-1', chatId = 0) => {
  const newChat = vi.fn<Overseer['newChat']>(async () => chatId)
  const getMetadata = vi.fn<Overseer['getMetadata']>(async () => ({ id: workspaceId, title: 'Untitled Workspace' }))
  const uploadBlob = vi.fn<Overseer['uploadBlob']>(async (content) => `oid-${content instanceof Uint8Array ? content.length : content.byteLength}`)
  const listSlashCommands = vi.fn<Overseer['listSlashCommands']>(async () => [
    { selection: { gatekeeperId: 4, commandId: 'c1/brief/SKILL.md' }, name: 'brief', description: 'Brief me', providerLabel: 'Context Library' },
  ])
  const dispose = vi.fn<() => void>()
  // Each connection made in this workspace, numbered as it numbers them: 50 and on.
  const made: string[] = []
  const connection = (what: string) => {
    made.push(what)
    return { getId: async () => 49 + made.length, [Symbol.dispose]: () => {} }
  }
  // Only getId() of what they return is used; the RPC types they would return cannot be built here.
  const newGatekeeper = ((accountId: number, resourceUrl: string) => connection(`${accountId} ${resourceUrl}`)) as unknown as Overseer['newGatekeeper']
  const newAiModelGatekeeper = ((modelId: string) => connection(modelId)) as unknown as Overseer['newAiModelGatekeeper']
  const newAgentSpawnerGatekeeper = (({ displayName, modelId }: { displayName: string; modelId: string | null }) => connection(`agent ${displayName} ${modelId}`)) as unknown as Overseer['newAgentSpawnerGatekeeper']
  const overseer: NewConversationOverseer = { newChat, getMetadata, uploadBlob, listSlashCommands, newGatekeeper, newAiModelGatekeeper, newAgentSpawnerGatekeeper, [Symbol.dispose]: dispose }
  return { overseer, newChat, getMetadata, uploadBlob, dispose, made }
}

const description = (title: string) => ({ url: `https://example.com/${title}`, title, snippet: '', suggestedBindingName: title.toUpperCase(), tsType: 'Thing' })

describe('startConversation', () => {
  it('starts the chat with the message and model, and returns the workspace and chat ids', async () => {
    const fake = fakeOverseer('abc123', 7)

    const ids = await startConversation(() => fake.overseer, 'Build me a dashboard', [], 'model-1')

    expect(ids).toEqual({ workspaceId: 'abc123', chatId: 7 })
    expect(fake.newChat).toHaveBeenCalledExactlyOnceWith('Build me a dashboard', 'model-1', undefined, undefined, undefined)
  })

  it('starts the chat with a command the workspace offers, given the words', async () => {
    const fake = fakeOverseer()
    const command = composerCommandOf({ selection: { gatekeeperId: 4, commandId: 'c1/brief/SKILL.md' }, name: 'brief', description: 'Brief me', providerLabel: 'Context Library' })

    await startConversation(() => fake.overseer, 'for Tuesday', [], 'model-1', command)

    expect(fake.newChat).toHaveBeenCalledExactlyOnceWith({ id: { gatekeeperId: 4, commandId: 'c1/brief/SKILL.md' }, args: 'for Tuesday', commandPosition: 0 }, 'model-1')
  })

  it('says so, and starts nothing, for a skill the workspace does not offer', async () => {
    const fake = fakeOverseer()
    const command = composerCommandOf({ selection: { gatekeeperId: 4, commandId: 'c1/gone/SKILL.md' }, name: 'gone', description: '', providerLabel: 'Context Library' })

    await expect(startConversation(() => fake.overseer, '', [], 'model-1', command)).rejects.toThrow('Gone isn’t available here')
    expect(fake.newChat).not.toHaveBeenCalled()
    expect(fake.dispose).toHaveBeenCalledOnce()
  })

  it('says where the message names a format', async () => {
    const fake = fakeOverseer()
    const formats = [{ position: 0, length: 8, noun: 'Document', icon: 'fileText' as const }]

    await startConversation(() => fake.overseer, 'Document about Q3', [], 'model-1', undefined, formats)

    expect(fake.newChat).toHaveBeenCalledExactlyOnceWith('Document about Q3', 'model-1', undefined, undefined, formats)
  })

  it('uploads the files into the workspace, and starts the chat with them', async () => {
    const fake = fakeOverseer()

    await startConversation(() => fake.overseer, 'Chart this', [new File(['a,b'], 'data.csv', { type: 'text/csv' })], 'model-1')

    expect(fake.newChat).toHaveBeenCalledExactlyOnceWith('Chart this', 'model-1', undefined, [
      { oid: 'oid-3', mimeType: 'text/csv', name: 'data.csv' },
    ], undefined)
  })

  it('opens no workspace for files that are more than a message can carry', async () => {
    const open = vi.fn<() => NewConversationOverseer>(() => fakeOverseer().overseer)
    const files = Array.from({ length: 6 }, (_, index) => new File(['x'], `${index}.txt`))

    await expect(startConversation(open, 'hi', files, 'model-1')).rejects.toThrow('A message can carry up to 5 files.')
    expect(open).not.toHaveBeenCalled()
  })

  it('releases the workspace connection when it succeeds', async () => {
    const fake = fakeOverseer()
    await startConversation(() => fake.overseer, 'hi', [], 'model-1')
    expect(fake.dispose).toHaveBeenCalledOnce()
  })

  it('releases it, and passes the failure on, when the chat cannot be started', async () => {
    const fake = fakeOverseer()
    fake.newChat.mockRejectedValueOnce(new Error('No such model'))

    await expect(startConversation(() => fake.overseer, 'hi', [], 'bad-model')).rejects.toThrow('No such model')
    expect(fake.dispose).toHaveBeenCalledOnce()
  })

  it('makes again in the workspace it starts in each connection the draft was given in another', async () => {
    const fake = fakeOverseer('chosen')
    const connections = [
      { gatekeeperId: 3, workspaceId: 'chosen', source: { modelId: 'kept' }, description: description('Kept'), vendorId: 'ai-model' },
      { gatekeeperId: 3, workspaceId: 'provisional', source: { accountId: 8, resourceUrl: 'https://example.com/repo' }, description: description('Repo'), vendorId: 'github' },
      { gatekeeperId: 4, workspaceId: 'provisional', source: { modelId: 'sonnet' }, description: description('Sonnet'), vendorId: 'ai-model' },
      { gatekeeperId: 5, workspaceId: 'provisional', source: { agent: { name: 'Helper', modelId: 'haiku' } }, description: description('Helper'), vendorId: 'agent-spawner' },
    ]

    await startConversation(() => fake.overseer, 'Compare', [], 'model-1', undefined, undefined, connections)

    expect(fake.made).toEqual(['8 https://example.com/repo', 'sonnet', 'agent Helper haiku'])
    const [text, , capsules] = fake.newChat.mock.calls[0]
    expect(text).toBe('Compare [0] [1] [2] [3]')
    expect(capsules?.map(({ gatekeeperId, description: { title } }) => [title, gatekeeperId])).toEqual([['Kept', 3], ['Repo', 50], ['Sonnet', 51], ['Helper', 52]])
  })
})
