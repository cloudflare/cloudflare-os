import { describe, expect, it } from 'vitest'
import type { ChatArtifact, ChatConnectionUse } from '@gadgets/workshop-shared/api'
import { chatContextOf, contextCount, contextSummary } from './chatContext'
import type { ChatItem, HookItem } from './chatItems'

const made = (sequence: number, id: number, title: string, chatId?: number): ChatArtifact =>
  ({ type: 'workpiece', sequence, timestamp: new Date(sequence), workpiece: { type: 'gadget', id, title, chatId } })
const sent = (sequence: number, id: string, name?: string): ChatArtifact =>
  ({ type: 'attachment', timestamp: new Date(sequence), attachment: { id, name, mimeType: 'text/plain', size: 1, sequence } })
const used = (gatekeeperId: number, vendorId?: string, resourceTitle?: string): ChatConnectionUse => ({ gatekeeperId, vendorId, resourceTitle })
const hook = (id: number, hookId: number | undefined): HookItem => ({ kind: 'hook', id, key: `hook:${id}`, hookId, title: `Hook ${id}`, description: '', enabled: true })

describe('chatContextOf', () => {
  it('lists what the workspace says the chat has, each once, latest first, and the automations the conversation shows', () => {
    const rows: ChatItem[] = [hook(6, 3), hook(7, 3), hook(8, undefined)]
    const context = chatContextOf({
      artifacts: [made(1, 7, 'Report'), sent(2, 'a', 'a.txt'), sent(2, 'b'), made(3, 8, 'App', 3)],
      connections: [used(1, 'drive', 'Q3 plan'), used(2, 'drive', 'Roadmap'), used(3, undefined, 'Claude')],
    }, rows)
    expect(context.outputs.map(({ title, draft }) => [title, draft])).toEqual([['App', true], ['Report', false]])
    expect(context.files.map(({ name }) => name)).toEqual(['Attached file', 'a.txt'])
    expect(context.hooks.map(({ id }) => id)).toEqual([7])
    expect(context.connectors.map(({ key, title }) => [key, title])).toEqual([['drive:Q3 plan', 'Q3 plan'], ['drive:Roadmap', 'Roadmap'], ['connection:3', 'Claude']])
  })

  it('has only the automations until what the chat has is read', () => {
    const context = chatContextOf(undefined, [hook(1, 1)])
    expect(contextCount(context)).toBe(1)
  })
})

describe('contextSummary', () => {
  it('says the first two kinds there are, with how many others', () => {
    expect(contextSummary(chatContextOf(undefined, []))).toBe('')
    expect(contextSummary(chatContextOf({ artifacts: [made(1, 1, 'A')], connections: [] }, []))).toBe('1 library item')
    expect(contextSummary(chatContextOf({ artifacts: [made(1, 1, 'A'), made(2, 2, 'B')], connections: [] }, [hook(3, 1)]))).toBe('2 library items · 1 automation')
    const all = chatContextOf({ artifacts: [made(1, 1, 'A'), sent(3, 'a', 'a.txt')], connections: [used(4, 'drive')] }, [hook(2, 1)])
    expect(contextSummary(all)).toBe('1 library item · 1 automation · +2')
    expect(contextCount(all)).toBe(4)
  })
})
