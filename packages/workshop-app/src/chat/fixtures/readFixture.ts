import type { AiChatMessage } from '@gadgets/workshop-shared/api'

/** Turns a fixture written by `scripts/record-chat-fixture.ts` back into the messages it recorded. */
export const readFixture = (recorded: unknown): AiChatMessage[] =>
  JSON.parse(JSON.stringify(recorded), (_key, value) =>
    value !== null && typeof value === 'object' && typeof value.$date === 'string' ? new Date(value.$date) : value)
