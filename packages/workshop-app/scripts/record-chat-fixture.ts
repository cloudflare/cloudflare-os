// Saves a real chat's history as a JSON fixture for the chat mapping's tests. Development only.
//
//   node scripts/record-chat-fixture.ts --token <token>                       lists workspaces and chats
//   node scripts/record-chat-fixture.ts --token <token> <workspace> <chat>    writes src/chat/fixtures/<name>.json
//
// The token is `localStorage.authToken` of a signed-in tab. Options: --url ws://localhost:8787/api, --name recorded.
// Dates are stored as `{ "$date": … }` (see src/chat/fixtures/readFixture.ts) and attachment bytes
// are left out. Review what a recording contains before committing it.
import { mkdirSync, writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { newWebSocketRpcSession } from 'capnweb'
import type { AiChatMessage, PublicApi } from '@gadgets/workshop-shared/api'

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string', default: 'ws://localhost:8787/api' },
    token: { type: 'string' },
    name: { type: 'string', default: 'recorded' },
  },
})
if (!values.token) throw new Error('Pass --token: the value of localStorage.authToken in a signed-in tab.')

function toJson(this: Record<string, unknown>, key: string, value: unknown) {
  // `this[key]` is the value before `Date.prototype.toJSON` turned it into a string.
  const raw = this[key]
  if (raw instanceof Date) return { $date: raw.toISOString() }
  if (raw instanceof Uint8Array) return undefined
  return value
}

const publicApi = newWebSocketRpcSession<PublicApi>(values.url)
const api = publicApi.authenticate(values.token)

const [workspaceId, chat] = positionals
if (workspaceId === undefined || chat === undefined) {
  for (const { id, title } of await api.listWorkspaces()) {
    using overseer = api.openWorkspace(id)
    for (const { id: chatId, title: chatTitle } of await overseer.listChats()) {
      console.log(`${id} ${chatId}\t${title} / ${chatTitle}`)
    }
  }
} else {
  using overseer = api.openWorkspace(workspaceId)
  const messages: AiChatMessage[] = []
  let before: number | undefined
  do {
    const page = await overseer.getChatHistory(Number(chat), before, 200)
    messages.unshift(...page.messages)
    before = page.nextBeforeSequence
  } while (before !== undefined)

  const directory = new URL('../src/chat/fixtures/', import.meta.url)
  mkdirSync(directory, { recursive: true })
  writeFileSync(new URL(`${values.name}.json`, directory), `${JSON.stringify(messages, toJson, 2)}\n`)
  console.log(`Wrote ${messages.length} messages to src/chat/fixtures/${values.name}.json`)
}

publicApi[Symbol.dispose]()
