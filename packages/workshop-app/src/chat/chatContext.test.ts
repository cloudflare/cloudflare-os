import { describe, expect, it } from 'vitest'
import { chatContextOf, contextCount, contextSummary } from './chatContext'
import type { ChatItem, ConnectionItem, HookItem, OutputItem, UserItem } from './chatItems'

const output = (id: number, workpieceId: number, title: string): OutputItem => ({ kind: 'output', id, key: `output:${id}`, workpieceId, title, type: 'gadget', draft: false })
const hook = (id: number, hookId: number | undefined): HookItem => ({ kind: 'hook', id, key: `hook:${id}`, hookId, title: `Hook ${id}`, description: '', enabled: true })
const user = (id: number, files: string[]): UserItem => ({
  kind: 'user', id, key: `user:${id}`, text: '', parts: [], attachments: files.map((name) => ({ id: name, name, mimeType: 'text/plain', size: 1 })),
})
const connection = (id: number, vendorId: string): ConnectionItem => ({
  kind: 'connection', id, key: `connection:${id}`, requestId: String(id), vendorId, vendorName: vendorId, reason: '', state: 'connected',
})

describe('chatContextOf', () => {
  it('lists what the conversation shows, each once, latest first, with an output as it was last titled', () => {
    const rows: ChatItem[] = [
      output(1, 7, 'Report'), user(2, ['a.txt', 'b.txt']), output(3, 8, 'App'), output(4, 7, 'Report v2'), user(5, ['a.txt']),
      hook(6, 3), hook(7, 3), hook(8, undefined), connection(9, 'drive'),
    ]
    const context = chatContextOf(rows)
    expect(context.outputs.map(({ title }) => title)).toEqual(['Report v2', 'App'])
    expect(context.files.map(({ name }) => name)).toEqual(['a.txt', 'b.txt'])
    expect(context.hooks.map(({ id }) => id)).toEqual([7])
    expect(context.connectors.map(({ key }) => key)).toEqual(['drive'])
  })
})

describe('contextSummary', () => {
  it('says the first two kinds there are, with how many others', () => {
    expect(contextSummary(chatContextOf([]))).toBe('')
    expect(contextSummary(chatContextOf([output(1, 1, 'A')]))).toBe('1 output')
    expect(contextSummary(chatContextOf([output(1, 1, 'A'), output(2, 2, 'B'), hook(3, 1)]))).toBe('2 outputs · 1 automation')
    const all = chatContextOf([output(1, 1, 'A'), hook(2, 1), user(3, ['a.txt']), connection(4, 'drive')])
    expect(contextSummary(all)).toBe('1 output · 1 automation · +2')
    expect(contextCount(all)).toBe(4)
  })
})
