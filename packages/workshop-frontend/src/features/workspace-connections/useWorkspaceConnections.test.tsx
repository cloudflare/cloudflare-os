// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AiChatMessage, Overseer, WorkspaceConnectionInfo } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'
import { deferred, entry, makeOverseer, makeTestRoot } from '../../action-test-harness'
import { changesWorkspaceConnections, useWorkspaceConnections, type WorkspaceConnections } from './useWorkspaceConnections'

vi.mock('../../errorReporting', () => ({ reportIssue: () => {} }))

const root = makeTestRoot()
afterEach(() => root.cleanup())
const connection = (target: number): WorkspaceConnectionInfo =>
  ({ target, resourceTitle: `Resource ${target}`, alwaysAvailable: false, awaitingApproval: false })
const ready = (...targets: number[]): WorkspaceConnections => ({ status: 'ready', connections: targets.map(connection) })

function setup() {
  const server = makeOverseer()
  const requests: Array<{
    promise: Promise<WorkspaceConnectionInfo[]>
    resolve: (value: WorkspaceConnectionInfo[]) => Promise<void>
    reject: (error: unknown) => Promise<void>
  }> = []
  Object.assign(server.overseer, {
    listConnections: () => {
      const reply = deferred<WorkspaceConnectionInfo[]>()
      requests.push(reply)
      return reply.promise
    },
  })
  return { server, requests }
}

describe('useWorkspaceConnections', () => {
  it('coalesces invalidation during a request and refreshes creation approval and rejection updates', async () => {
    const { server, requests } = setup()
    let state!: { connections: WorkspaceConnections | null; invalidate: () => void }
    const Probe = () => { state = useWorkspaceConnections(server.overseer); return null }
    await root.render(<Probe />)
    const invalidate = state.invalidate
    act(() => { invalidate(); invalidate() })
    await server.emit(entry(1, { gatekeeperId: 30, creation: true }))
    expect(requests).toHaveLength(1)
    await requests[0].resolve([connection(10)])
    expect(requests).toHaveLength(2)
    expect(state.connections).toEqual({ status: 'loading' })
    await requests[1].resolve([connection(10), connection(30)])
    expect(state.connections).toEqual(ready(10, 30))
    expect(state.invalidate).toBe(invalidate)

    await server.emit(entry(1, { gatekeeperId: 30, creation: true, state: 'approved' }))
    expect(requests).toHaveLength(3)
    await requests[2].resolve([connection(10), connection(30)])
    await server.emit(entry(2, { gatekeeperId: 40, creation: true, state: 'rejected' }))
    expect(requests).toHaveLength(4)
    await requests[3].resolve([connection(10), connection(30)])
    await server.emit(entry(3, { gatekeeperId: 10, state: 'approved' }))
    expect(requests).toHaveLength(4)
  })

  it('keeps connections across chat changes and discards stale workspace or reconnect replies', async () => {
    const first = setup()
    const second = setup()
    const rendered: Array<WorkspaceConnections | null> = []
    const Probe = ({ overseer, chatId }: { overseer: RpcStub<Overseer> | null; chatId: number }) => {
      const state = useWorkspaceConnections(overseer)
      rendered.push(state.connections)
      return <span>{chatId}</span>
    }
    await root.render(<Probe overseer={first.server.overseer} chatId={1} />)
    await first.requests[0].resolve([connection(10)])
    await root.render(<Probe overseer={first.server.overseer} chatId={2} />)
    expect(first.requests).toHaveLength(1)
    expect(rendered.at(-1)).toEqual(ready(10))
    await root.render(<Probe overseer={second.server.overseer} chatId={2} />)
    expect(rendered.at(-1)).toEqual({ status: 'loading' })
    await root.render(<Probe overseer={null} chatId={2} />)
    await second.requests[0].resolve([connection(20)])
    expect(rendered.at(-1)).toBeNull()
    await root.render(<Probe overseer={first.server.overseer} chatId={2} />)
    expect(rendered.at(-1)).toEqual({ status: 'loading' })
    await first.requests[1].resolve([connection(30)])
    expect(rendered.at(-1)).toEqual(ready(30))
  })

  it('refreshes on focus without publishing an invalidated in-flight list', async () => {
    const { server, requests } = setup()
    let state!: { connections: WorkspaceConnections | null; invalidate: () => void }
    const Probe = () => { state = useWorkspaceConnections(server.overseer); return null }
    await root.render(<Probe />)
    await requests[0].resolve([connection(10)])
    act(() => window.dispatchEvent(new Event('focus')))
    expect(requests).toHaveLength(2)
    // A removal completes while this list still contains the removed connection.
    act(() => state.invalidate())
    await requests[1].resolve([connection(10), connection(20)])
    expect(state.connections).toEqual(ready(10))
    expect(requests).toHaveLength(3)
    await requests[2].resolve([])
    expect(state.connections).toEqual(ready())
    root.unmount()
    act(() => window.dispatchEvent(new Event('focus')))
    expect(requests).toHaveLength(3)
  })

  it('distinguishes failure from an empty registry and can retry', async () => {
    const { server, requests } = setup()
    let state!: { connections: WorkspaceConnections | null; invalidate: () => void }
    const Probe = () => { state = useWorkspaceConnections(server.overseer); return null }
    await root.render(<Probe />)
    await requests[0].reject(new Error('Offline'))
    expect(state.connections).toEqual({ status: 'failed' })
    act(() => state.invalidate())
    await requests[1].resolve([])
    expect(state.connections).toEqual(ready())
  })
})

describe('changesWorkspaceConnections', () => {
  const created = { toolName: 'createExternalResource', input: {} }
  const capsule = { start: 0, length: 1, gatekeeperId: 10 }
  it.each([
    ['a created resource', { type: 'message', toolCalls: [{ ...created, output: { gatekeeperId: 10 } }] }, true],
    ['a creation still running', { type: 'message', toolCalls: [created] }, false],
    ['a failed creation', { type: 'message', toolCalls: [{ ...created, output: {}, error: 'No account' }] }, false],
    ['an unnamed pasted resource', { type: 'message', capsules: [capsule] }, true],
    ['an accepted unnamed connection request', { type: 'connectionRequest', state: 'accepted', gatekeeperId: 10 }, true],
    ['a pending connection request', { type: 'connectionRequest', state: 'pending' }, false],
    ['a plain reply', { type: 'message', text: 'Done.' }, false],
  ])('%s', (_, message, changes) => {
    expect(changesWorkspaceConnections({ chatId: 1, sequence: 1, ...message } as unknown as AiChatMessage)).toBe(changes)
  })
})
