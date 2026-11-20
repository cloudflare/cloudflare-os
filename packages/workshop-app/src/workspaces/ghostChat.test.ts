import { describe, expect, it } from 'vitest'
import type { ChatItem } from '@/chat/chatItems'
import { ghostLineOf } from './ghostChat'

const OPENED = 1_000_000
const user = (key: string, text: string, sentAt?: number, from?: string) =>
  ({ kind: 'user', key, text, parts: [], attachments: [], from, sentAt: sentAt === undefined ? undefined : new Date(sentAt) }) as unknown as ChatItem
const assistant = (key: string, text: string, sentAt: number) =>
  ({ kind: 'assistant', key, text, parts: [], sender: 'Claude', sentAt: new Date(sentAt), trace: [] }) as unknown as ChatItem

describe('ghostLineOf', () => {
  it('says the latest message as plain words, unnamed for the chat’s own assistant', () => {
    expect(ghostLineOf([user('a', 'Hi', OPENED - 10), assistant('b', '**Here** is the plan\nmore', OPENED - 5)], OPENED))
      .toEqual({ preview: 'Here is the plan', speaker: undefined, fresh: false })
  })

  it('names who sent it, leaving out the quote a reply opens with', () => {
    expect(ghostLineOf([user('a', '> what was said\n\nSounds good', OPENED - 10, 'Maya')], OPENED)).toMatchObject({ preview: 'Sounds good', speaker: 'Maya' })
    expect(ghostLineOf([user('a', 'Mine', OPENED - 10)], OPENED)).toMatchObject({ speaker: 'You' })
  })

  it('is fresh once anything is said since it was opened, or sent and not read yet', () => {
    expect(ghostLineOf([user('a', 'Old', OPENED - 10)], OPENED).fresh).toBe(false)
    expect(ghostLineOf([user('a', 'Old', OPENED - 10), assistant('b', 'New', OPENED + 5)], OPENED).fresh).toBe(true)
    expect(ghostLineOf([user('a', 'Waiting to be read')], OPENED).fresh).toBe(true)
  })

  it('says nothing of a chat with no messages', () => {
    expect(ghostLineOf([], OPENED)).toEqual({ fresh: false })
  })
})
