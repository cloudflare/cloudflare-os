import { describe, expect, it, vi } from 'vitest'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { skillCommandOf } from './slashCommands'
import { startConversation, type NewConversationOverseer } from './startConversation'

const fakeOverseer = (workspaceId = 'ws-1', chatId = 0) => {
  const newChat = vi.fn<Overseer['newChat']>(async () => chatId)
  const getMetadata = vi.fn<Overseer['getMetadata']>(async () => ({ id: workspaceId, title: 'Untitled Workspace' }))
  const uploadBlob = vi.fn<Overseer['uploadBlob']>(async (content) => `oid-${content.byteLength}`)
  const listSlashCommands = vi.fn<Overseer['listSlashCommands']>(async () => [
    { selection: { gatekeeperId: 4, commandId: 'c1/brief/SKILL.md' }, name: 'brief', description: 'Brief me', providerLabel: 'Context Library' },
  ])
  const dispose = vi.fn<() => void>()
  const overseer: NewConversationOverseer = { newChat, getMetadata, uploadBlob, listSlashCommands, [Symbol.dispose]: dispose }
  return { overseer, newChat, getMetadata, uploadBlob, dispose }
}

describe('startConversation', () => {
  it('starts the chat with a Library skill, as the new workspace offers it, given the words', async () => {
    const fake = fakeOverseer()
    const command = skillCommandOf({ id: 'c1/brief/SKILL.md', name: 'brief', description: 'Brief me' })

    await startConversation(() => fake.overseer, 'for Tuesday', [], 'model-1', command)

    expect(fake.newChat).toHaveBeenCalledExactlyOnceWith({ id: { gatekeeperId: 4, commandId: 'c1/brief/SKILL.md' }, args: 'for Tuesday', commandPosition: 0 }, 'model-1')
  })

  it('says so, and starts nothing, for a skill the workspace does not offer', async () => {
    const fake = fakeOverseer()
    const command = skillCommandOf({ id: 'c1/gone/SKILL.md', name: 'gone', description: '' })

    await expect(startConversation(() => fake.overseer, '', [], 'model-1', command)).rejects.toThrow('Gone isn’t available here')
    expect(fake.newChat).not.toHaveBeenCalled()
    expect(fake.dispose).toHaveBeenCalledOnce()
  })

  it('starts the chat with the message and model, and returns the workspace and chat ids', async () => {
    const fake = fakeOverseer('abc123', 7)

    const ids = await startConversation(() => fake.overseer, 'Build me a dashboard', [], 'model-1')

    expect(ids).toEqual({ workspaceId: 'abc123', chatId: 7 })
    expect(fake.newChat).toHaveBeenCalledExactlyOnceWith('Build me a dashboard', 'model-1', undefined, undefined, undefined)
  })

  it('says where the message names a format', async () => {
    const fake = fakeOverseer()
    const formats = [{ position: 0, length: 8, noun: 'Document', icon: 'fileText' as const }]

    await startConversation(() => fake.overseer, 'Document about Q3', [], 'model-1', undefined, formats)

    expect(fake.newChat).toHaveBeenCalledExactlyOnceWith('Document about Q3', 'model-1', undefined, undefined, formats)
  })

  it('gives the chat the connections that go with its first message', async () => {
    const fake = fakeOverseer()
    const capsules = [{ position: 13, length: 3, gatekeeperId: 9, description: { title: 'Budget', url: 'https://docs.google.com/spreadsheets/d/x', snippet: '', suggestedBindingName: 'BUDGET', tsType: 'Spreadsheet' } }]

    await startConversation(() => fake.overseer, 'Summarize it [0]', [], 'model-1', undefined, undefined, capsules)

    expect(fake.newChat).toHaveBeenCalledExactlyOnceWith('Summarize it [0]', 'model-1', capsules, undefined, undefined)
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
})
