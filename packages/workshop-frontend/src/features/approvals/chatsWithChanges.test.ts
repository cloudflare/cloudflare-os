import { describe, expect, it } from 'vitest'
import type { AiChatMetadata } from '@gadgets/workshop-shared/api'
import { chatsWithChanges } from './chatsWithChanges'

const chat = (id: number, over: Partial<AiChatMetadata> = {}): AiChatMetadata =>
  ({ id, title: `Chat ${id}`, started: new Date(), lastActive: new Date(), ...over })

describe('chatsWithChanges', () => {
  it('lists the chats with requests or code changes waiting, and only those', () => {
    const listed = chatsWithChanges([
      chat(1, { pendingActions: 2, mode: 'fork' }),
      chat(2),
      chat(3, { proposedChangeWorkpieces: [7], awaitingDecision: true }),
      // Fork on its own is not a change waiting to be accepted.
      chat(4, { mode: 'fork', proposedChangeWorkpieces: [] }),
    ])
    expect(listed).toEqual([
      { id: 1, title: 'Chat 1', requests: 2, codeChanges: false, holding: true, awaitingDecision: false },
      { id: 3, title: 'Chat 3', requests: 0, codeChanges: true, holding: false, awaitingDecision: true },
    ])
  })
})
