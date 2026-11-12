import { describe, expect, it } from 'vitest'
import type { ChatSnapshot } from '@/chat/ChatSession'
import type { ChatItem, OutputItem, UserItem } from '@/chat/chatItems'
import { asideItemFor, chatAsideItems, formatAsideRef, itemPageId, parseAsideRef, parseItemPageId, validateAsideParam } from './asideItems'

const output = (id: number, workpieceId: number, title: string): OutputItem => ({
  kind: 'output', id, key: `output:${id}`, workpieceId, title, type: 'gadget', draft: false,
})
const user = (id: number, files: string[], sentAt?: Date): UserItem => ({
  kind: 'user', id, key: `user:${id}`, text: '', parts: [], sentAt, attachments: files.map((name) => ({ id: name, name, mimeType: 'text/plain', size: 1 })),
})
const ready = (items: ChatItem[], pinned: OutputItem[] = []): ChatSnapshot => ({
  status: 'ready', title: undefined, items, pinned, activity: undefined, work: [], agentActive: false,
  sendError: undefined, actionError: undefined, hasEarlier: false, loadingEarlier: false, historyError: undefined,
})

describe('aside refs', () => {
  it('reads back what it writes', () => {
    expect(parseAsideRef(formatAsideRef({ kind: 'output', workpieceId: 0 }))).toEqual({ kind: 'output', workpieceId: 0 })
    expect(parseAsideRef(formatAsideRef({ kind: 'file', fileId: 'a-b:c' }))).toEqual({ kind: 'file', fileId: 'a-b:c' })
  })

  it('takes what made it into the URL as a number', () => {
    expect(validateAsideParam(12)).toBe('12')
  })

  it('names nothing for what is not a ref', () => {
    for (const value of [undefined, 1.5, -1, '', 'output', 'output:12', '-1', '1.5', 'abc', 'file-', 'chat-1']) {
      expect(validateAsideParam(value)).toBeUndefined()
    }
  })

  it('puts the workspace in front on an item’s own page, and reads it back', () => {
    const workspaceId = '3f9a0c2e'
    for (const ref of [{ kind: 'output', workpieceId: 12 }, { kind: 'file', fileId: 'a-b-1' }] as const) {
      expect(itemPageId(workspaceId, ref)).toBe(`${workspaceId}-${formatAsideRef(ref)}`)
      expect(parseItemPageId(itemPageId(workspaceId, ref))).toEqual({ workspaceId, ref })
    }
    for (const id of ['3f9a0c2e', '3f9a0c2e-', '3f9a0c2e-abc', '-12', '3f9a0c2e-file-']) expect(parseItemPageId(id)).toBeUndefined()
  })
})

describe('chatAsideItems', () => {
  it('lists what the chat made and was sent, most recent first, each once with its latest title', () => {
    const chat = ready([output(1, 7, 'Report'), user(2, ['notes.txt']), output(3, 8, 'App'), output(4, 7, 'Report v2')], [output(5, 9, 'Slides')])
    expect(chatAsideItems('w', 3, chat).map(({ key, title }) => [key, title])).toEqual([
      ['9', 'Slides'],
      ['7', 'Report v2'],
      ['8', 'App'],
      ['file-notes.txt', 'notes.txt'],
    ])
  })

  it('dates a file by its message, and an output by the last message before it', () => {
    const [monday, tuesday] = [new Date('2026-11-09T10:00'), new Date('2026-11-10T10:00')]
    const chat = ready([user(1, ['notes.txt'], monday), output(2, 7, 'Report'), user(3, [], tuesday), output(4, 8, 'App')], [output(5, 7, 'Report v2')])
    expect(chatAsideItems('w', 3, chat).map(({ key, at }) => [key, at])).toEqual([
      ['7', tuesday],
      ['8', tuesday],
      ['file-notes.txt', monday],
    ])
  })

  it('shows an output with the changes proposed in the chat', () => {
    const [item] = chatAsideItems('w', 3, ready([output(1, 7, 'Report')]))
    expect(item).toMatchObject({ kind: 'output', output: { workspaceId: 'w', workpieceId: 7, chatId: 3 } })
  })

  it('has nothing until the chat is loaded', () => {
    expect(chatAsideItems('w', 3, { status: 'loading' })).toEqual([])
  })
})

describe('asideItemFor', () => {
  it('is what the chat has, when it has it', () => {
    const known = chatAsideItems('w', 3, ready([output(1, 7, 'Report')]))
    expect(asideItemFor('w', { kind: 'output', workpieceId: 7 }, 3, known)).toBe(known[0])
  })

  it('is as much as the ref says otherwise', () => {
    expect(asideItemFor('w', { kind: 'output', workpieceId: 7 }, undefined)).toMatchObject({
      key: '7', kind: 'output', output: { workspaceId: 'w', workpieceId: 7, chatId: undefined },
    })
  })
})
