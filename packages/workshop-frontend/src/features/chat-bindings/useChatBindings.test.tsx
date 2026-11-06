// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiChatMessage, ChatBindingInfo } from '@gadgets/workshop-shared/api'
import { deferred, entry, makeOverseer, makeTestRoot } from '../../action-test-harness'
import { addsChatBinding, useChatBindings, type ChatBindings } from './useChatBindings'

vi.mock('../../errorReporting', () => ({ reportIssue: () => {} }))

const root = makeTestRoot()
afterEach(() => root.cleanup())

const binding = (target: number): ChatBindingInfo =>
  ({ name: `b${target}`, target, resourceTitle: `Resource ${target}`, created: false, changed: false, alwaysAvailable: false })

const ready = (...targets: number[]): ChatBindings => ({ status: 'ready', bindings: targets.map(binding) })

function setup() {
  const server = makeOverseer()
  const requests: Array<{ chatId: number; resolve: (bindings: ChatBindingInfo[]) => Promise<void> }> = []
  Object.assign(server.overseer, {
    listChatBindings: (chatId: number) => {
      const reply = deferred<ChatBindingInfo[]>()
      requests.push({ chatId, resolve: reply.resolve })
      return reply.promise
    },
  })
  const rendered: Array<ChatBindings | null> = []
  let invalidate = () => {}
  const Probe = ({ chatId }: { chatId: number }) => {
    const state = useChatBindings(server.overseer, chatId)
    rendered.push(state.chatBindings)
    invalidate = state.invalidate
    return null
  }
  return {
    server,
    requests,
    rendered,
    select: (chatId: number) => root.render(<Probe chatId={chatId} />),
    invalidate: () => act(() => invalidate()),
  }
}

describe('useChatBindings', () => {
  it('answers changes during a request with one refetch once it settles, and shows that', async () => {
    const { server, requests, rendered, select, invalidate } = setup()
    await select(1)

    invalidate()
    await server.emit(entry(1, { gatekeeperId: 30, creation: true }))
    invalidate()
    expect(requests).toHaveLength(1)

    await requests[0].resolve([binding(10)])
    expect(requests).toHaveLength(2)

    await requests[1].resolve([binding(10), binding(30)])
    expect(requests).toHaveLength(2)
    expect(rendered.at(-1)).toEqual(ready(10, 30))
  })

  it('refetches after the first approval through a listed connection, or any creation', async () => {
    const { server, requests, select } = setup()
    await select(1)
    await requests[0].resolve([binding(10), { ...binding(11), changed: true }])

    await server.emit(entry(1, { gatekeeperId: 20, state: 'approved' }))
    await server.emit(entry(2, { gatekeeperId: 10, type: 'observation' }))
    await server.emit(entry(3, { gatekeeperId: 10 }))
    await server.emit(entry(4, { gatekeeperId: 10, state: 'rejected' }))
    await server.emit(entry(5, { gatekeeperId: 11, state: 'approved' }))
    expect(requests).toHaveLength(1)

    await server.emit(entry(6, { gatekeeperId: 10, state: 'approved' }))
    expect(requests).toHaveLength(2)
    await requests[1].resolve([binding(10)])

    await server.emit(entry(7, { gatekeeperId: 30, creation: true }))
    expect(requests).toHaveLength(3)
  })

  it('never shows a result for a chat that is no longer selected', async () => {
    const { requests, rendered, select, invalidate } = setup()
    await select(1)
    await requests[0].resolve([binding(10)])
    invalidate()

    const switchedAt = rendered.length
    await select(2)
    await requests[1].resolve([binding(10), binding(11)])
    await requests[2].resolve([binding(20)])

    expect(requests.map(request => request.chatId)).toEqual([1, 1, 2])
    expect(rendered.slice(switchedAt, -1).every(state => state?.status === 'loading')).toBe(true)
    expect(rendered.at(-1)).toEqual(ready(20))
  })
})

// The messages that bind the chat a resource before its turn ends, so the rail refetches on them.
describe('addsChatBinding', () => {
  const created = { toolName: 'createExternalResource', input: { bindingName: 'SHEET' } }
  const capsule = { start: 0, length: 1, gatekeeperId: 10 }
  it.each([
    ['a created resource', { type: 'message', toolCalls: [{ ...created, output: { gatekeeperId: 10 } }] }, true],
    ['a creation still running', { type: 'message', toolCalls: [created] }, false],
    ['a failed creation', { type: 'message', toolCalls: [{ ...created, output: {}, error: 'No account' }] }, false],
    ['a named pasted resource', { type: 'message', capsules: [{ ...capsule, bindingName: 'DOC' }] }, true],
    ['a pasted resource not yet named', { type: 'message', capsules: [capsule] }, false],
    ['an accepted, named connection request',
      { type: 'connectionRequest', state: 'accepted', gatekeeperId: 10, bindingName: 'REPO' }, true],
    ['a pending connection request', { type: 'connectionRequest', state: 'pending', bindingName: 'REPO' }, false],
    ['a plain reply', { type: 'message', text: 'Done.' }, false],
  ])('%s', (_, message, adds) => {
    expect(addsChatBinding({ chatId: 1, sequence: 1, ...message } as unknown as AiChatMessage)).toBe(adds)
  })
})
