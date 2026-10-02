// @vitest-environment jsdom

import { createElement, type Dispatch, type SetStateAction } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useResolveAction } from './useResolveAction'
import { makeTestRoot } from './action-test-harness'

type TestToast = {
  actions?: Array<{ children: unknown, onClick: () => Promise<void> | void }>
}

const testState = vi.hoisted(() => ({
  addToast: vi.fn<(toast: TestToast) => string>(),
  closeToast: vi.fn<(id?: string) => void>(),
}))

vi.mock('@cloudflare/kumo', () => ({
  useKumoToastManager: () => ({ add: testState.addToast, close: testState.closeToast }),
}))

afterEach(() => vi.restoreAllMocks())

describe('useResolveAction', () => {
  const view = makeTestRoot()
  afterEach(() => view.cleanup())

  it('guards overlapping attempts and discards stale retries on reconnect', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    testState.addToast.mockReturnValue('failure-toast')

    let finishRetry!: () => void
    const retry = new Promise<void>(resolve => { finishRetry = resolve })
    const approveAction = vi.fn<(id: number) => Promise<void>>()
      .mockRejectedValue(new Error('failed'))
      .mockRejectedValueOnce(new Error('failed'))
      .mockReturnValueOnce(retry)
    const overseer = { approveAction } as unknown as RpcStub<Overseer>
    const setProcessing = vi.fn<Dispatch<SetStateAction<Set<number>>>>()
    let resolveAction!: ReturnType<typeof useResolveAction>
    const Probe = ({ stub }: { stub: RpcStub<Overseer> }) => {
      resolveAction = useResolveAction(stub, setProcessing)
      return null
    }
    await view.render(createElement(Probe, { stub: overseer }))

    await resolveAction(42, 'approve')
    const failureToast = testState.addToast.mock.calls[0][0]

    const retrying = failureToast.actions![0].onClick()
    await failureToast.actions![0].onClick()
    await resolveAction(42, 'approve')
    expect(approveAction).toHaveBeenCalledTimes(2)
    expect(testState.closeToast).toHaveBeenCalledWith('failure-toast')

    finishRetry()
    await retrying

    await resolveAction(42, 'approve')
    const staleRetry = testState.addToast.mock.calls[1][0].actions![0].onClick
    testState.closeToast.mockClear()
    await view.render(createElement(Probe, { stub: {} as RpcStub<Overseer> }))
    expect(testState.closeToast).toHaveBeenCalledWith('failure-toast')
    await staleRetry()
    expect(approveAction).toHaveBeenCalledTimes(3)
    expect(testState.addToast).toHaveBeenCalledTimes(2)
  })
})
