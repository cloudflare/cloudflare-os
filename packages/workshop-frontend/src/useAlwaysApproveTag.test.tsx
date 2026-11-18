// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { RpcStub } from 'capnweb'

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...await importOriginal() as typeof import('@cloudflare/kumo'),
  useKumoToastManager: () => ({ add: () => {} }),
}))

const { useAlwaysApproveTag } = await import('./useAlwaysApproveTag')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  vi.restoreAllMocks()
})

const APPEND = { tag: 'append', label: 'Append a slide' }

async function mount(setRule: () => Promise<void>, onChanged: () => void) {
  const overseer = { setAutoApprovedActionKind: setRule } as unknown as RpcStub<Overseer>
  let hook: ReturnType<typeof useAlwaysApproveTag> | undefined
  const Probe = () => {
    hook = useAlwaysApproveTag(overseer, () => {}, onChanged)
    return null
  }
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(<Probe />))
  return { get current() { return hook! } }
}

describe('useAlwaysApproveTag', () => {
  it('tells the other surfaces once the rule is set', async () => {
    let changes = 0
    const hook = await mount(async () => {}, () => { changes++ })

    await act(async () => { await hook.current.alwaysApproveTag(1, 2, APPEND) })
    expect(changes).toBe(1)
  })

  it('tells them when setting it fails too, since the call may still have landed', async () => {
    // A dropped connection fails the call without saying whether the server took it, so the
    // rules are in a state nobody here knows and every surface should read them again.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    let changes = 0
    const hook = await mount(async () => { throw new Error('The connection dropped.') },
      () => { changes++ })

    let result!: boolean
    await act(async () => { result = await hook.current.alwaysApproveTag(1, 2, APPEND) })
    expect(result).toBe(false)
    expect(changes).toBe(1)
  })
})
