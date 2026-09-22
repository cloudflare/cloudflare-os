import type { Dispatch, SetStateAction } from 'react'
import type { RpcStub } from 'capnweb'
import type { Overseer } from '@gadgets/workshop-shared/api'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { actionErrorDiagnostics, useResolveAction } from './useResolveAction'

type TestToast = {
  timeout?: number
  actions?: Array<{ children: unknown, onClick: () => Promise<void> }>
}

const testState = vi.hoisted(() => ({
  addToast: vi.fn<(toast: TestToast) => string>(),
  closeToast: vi.fn<(id?: string) => void>(),
}))

vi.mock('react', () => ({
  useCallback: <T,>(callback: T) => callback,
  useRef: <T,>(current: T) => ({ current }),
}))
vi.mock('@cloudflare/kumo', () => ({
  useKumoToastManager: () => ({ add: testState.addToast, close: testState.closeToast }),
}))

afterEach(() => vi.restoreAllMocks())

describe('actionErrorDiagnostics', () => {
  it('includes standard error fields, but not attached request data', () => {
    const error = Object.assign(new Error('gatekeeper failed'), { requestBody: 'secret' })
    const diagnostics = JSON.parse(actionErrorDiagnostics(error, {
      actionId: 42,
      decision: 'approve',
    }))

    expect(diagnostics).toMatchObject({
      operation: 'approve-action',
      actionId: 42,
      error: { type: 'Error', message: 'gatekeeper failed' },
    })
    expect(diagnostics.error.stack).toContain('gatekeeper failed')
    expect(JSON.stringify(diagnostics)).not.toContain('secret')
  })
})

describe('useResolveAction', () => {
  it('keeps recovery actions available and prevents an overlapping retry', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    testState.addToast.mockReturnValue('failure-toast')

    let finishRetry!: () => void
    const retry = new Promise<void>(resolve => { finishRetry = resolve })
    const approveAction = vi.fn<(id: number) => Promise<void>>()
      .mockRejectedValueOnce(new Error('failed'))
      .mockReturnValueOnce(retry)
    const overseer = { approveAction } as unknown as RpcStub<Overseer>
    const setProcessing = vi.fn<Dispatch<SetStateAction<Set<number>>>>()
    const resolveAction = useResolveAction(overseer, setProcessing)

    await resolveAction(42, 'approve')
    const failureToast = testState.addToast.mock.calls[0][0]
    expect(failureToast.timeout).toBe(0)

    const retrying = failureToast.actions![0].onClick()
    await resolveAction(42, 'approve')
    expect(approveAction).toHaveBeenCalledTimes(2)
    expect(testState.closeToast).toHaveBeenCalledWith('failure-toast')

    finishRetry()
    await retrying
  })
})
