import { describe, expect, it } from 'vitest'
import type { AiChatMessage } from '@gadgets/workshop-shared/api'
import { toChatItems } from './chatItems'

const user = { type: 'user', id: 'u', name: 'User' } as const
const agent = { type: 'agent', id: 'a', name: 'Agent' } as const
const gadget = { type: 'gadget', id: 'g', name: 'Gadget' } as const

let sequence = 0
const message = (author: AiChatMessage['author'], text: string, extra: object = {}): AiChatMessage => ({
  chatId: 0,
  sequence: sequence++,
  timestamp: new Date(0),
  author,
  type: 'message',
  message: text,
  ...extra,
})
const useGadget = (): AiChatMessage => ({
  chatId: 0,
  sequence: sequence++,
  timestamp: new Date(0),
  author: agent,
  type: 'useGadget',
})

describe('toChatItems', () => {
  it('maps user and agent text, keeping order and sequence ids', () => {
    const items = toChatItems([message(user, 'hi'), message(agent, 'hello')])
    expect(items.map(({ kind }) => kind)).toEqual(['user', 'assistant'])
    expect(items[0]).toMatchObject({ text: 'hi' })
    expect(items[1]).toMatchObject({ text: 'hello' })
    expect(items[1].id).toBe(items[0].id + 1)
  })

  it('shows errors', () => {
    const error: AiChatMessage = {
      chatId: 0,
      sequence: 9,
      timestamp: new Date(0),
      author: agent,
      type: 'error',
      message: 'Rate limited',
    }
    expect(toChatItems([error])).toEqual([{ kind: 'error', id: 9, text: 'Rate limited' }])
  })

  it('hides what the full Workshop never shows', () => {
    const nudge: AiChatMessage = {
      chatId: 0,
      sequence: 1,
      timestamp: new Date(0),
      author: agent,
      type: 'agentNudge',
      text: 'continue',
    }
    const catalog: AiChatMessage = {
      chatId: 0,
      sequence: 2,
      timestamp: new Date(0),
      author: agent,
      type: 'catalogChange',
      resources: [],
    }
    expect(toChatItems([nudge, catalog])).toEqual([])
  })

  it('shows a placeholder for message kinds it cannot render', () => {
    expect(toChatItems([useGadget()])).toEqual([{ kind: 'unsupported', id: expect.any(Number) }])
  })

  it('collapses consecutive placeholders into one, but not across a real message', () => {
    const kinds = toChatItems([
      useGadget(),
      useGadget(),
      message(agent, 'done'),
      useGadget(),
    ]).map(({ kind }) => kind)
    expect(kinds).toEqual(['unsupported', 'assistant', 'unsupported'])
  })

  it('gives a tool-only agent turn a placeholder, and a reasoning-only one nothing', () => {
    const toolOnly = message(agent, '', { toolCalls: [{}] })
    const reasoningOnly = message(agent, '', { reasoning: 'thinking…' })
    expect(toChatItems([toolOnly]).map(({ kind }) => kind)).toEqual(['unsupported'])
    expect(toChatItems([reasoningOnly])).toEqual([])
  })

  it('shows agent text even when the message also called tools', () => {
    const items = toChatItems([message(agent, 'Working on it', { toolCalls: [{}] })])
    expect(items).toMatchObject([{ kind: 'assistant', text: 'Working on it' }])
  })

  it('does not call a gadget-authored prompt a user message', () => {
    expect(toChatItems([message(gadget, 'spawned prompt')]).map(({ kind }) => kind)).toEqual(['unsupported'])
  })
})
