// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import {
  ACTION_ERROR_CODES,
  ACTION_ERROR_MESSAGES,
  createActionError,
  type ActionErrorCode,
  type Overseer,
} from '@gadgets/workshop-shared/api'
import { makeTestRoot } from './action-test-harness'
import { useResolveAction } from './useResolveAction'

const testState = vi.hoisted(() => ({
  addToast: vi.fn<(toast: unknown) => void>(),
}))

vi.mock('@cloudflare/kumo', () => ({
  useKumoToastManager: () => ({ add: testState.addToast }),
}))

type ResolveAction = (actionId: number, decision: 'approve' | 'deny') => Promise<void>

const view = makeTestRoot()
let resolveAction: ResolveAction
let processing = new Set<number>()

function Probe({ overseer, onResolved }: {
  overseer: RpcStub<Overseer>
  onResolved: (actionId: number, state: 'approved' | 'rejected') => void
}) {
  const [currentProcessing, setProcessing] = useState<Set<number>>(new Set())
  processing = currentProcessing
  resolveAction = useResolveAction(overseer, setProcessing, onResolved)
  return null
}

function failingOverseer(error: unknown): RpcStub<Overseer> {
  return {
    approveAction: async () => { throw error },
    rejectAction: async () => { throw error },
  } as unknown as RpcStub<Overseer>
}

describe('useResolveAction', () => {
  afterEach(() => {
    view.cleanup()
    testState.addToast.mockClear()
    vi.restoreAllMocks()
  })

  it.each([
    ACTION_ERROR_CODES.blocked,
    ACTION_ERROR_CODES.stopped,
  ])('maps %s to trusted copy instead of its diagnostic message', async (
    code: ActionErrorCode,
  ) => {
    const error = createActionError(code)
    error.message = `spoofed diagnostic for ${code}`
    const onResolved = vi.fn<() => void>()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await view.render(<Probe overseer={failingOverseer(error)} onResolved={onResolved} />)

    await act(async () => resolveAction(7, 'approve'))

    expect(testState.addToast).toHaveBeenCalledWith({
      title: ACTION_ERROR_MESSAGES[code],
      variant: 'error',
    })
    expect(onResolved).not.toHaveBeenCalled()
    expect(processing.has(7)).toBe(false)
  })

  it('does not expose diagnostics from unknown RPC failures', async () => {
    const onResolved = vi.fn<() => void>()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await view.render(
      <Probe
        overseer={failingOverseer(new Error('private upstream diagnostic'))}
        onResolved={onResolved}
      />,
    )

    await act(async () => resolveAction(9, 'approve'))

    expect(testState.addToast).toHaveBeenCalledWith({
      title: expect.not.stringContaining('private upstream diagnostic'),
      variant: 'error',
    })
    expect(onResolved).not.toHaveBeenCalled()
    expect(processing.has(9)).toBe(false)
  })
})
