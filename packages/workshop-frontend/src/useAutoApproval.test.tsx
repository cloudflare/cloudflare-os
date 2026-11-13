// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Overseer, PreApprovableAction } from '@gadgets/workshop-shared/api'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'
import type { RpcStub } from 'capnweb'

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...await importOriginal() as typeof import('@cloudflare/kumo'),
  useKumoToastManager: () => ({ add: () => {} }),
}))

const { useAutoApproval } = await import('./useAutoApproval')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  vi.restoreAllMocks()
})

const APPEND: ActionKind = { tag: 'append', label: 'Append a slide' }
type Rule = { gatekeeperId: number, actionKind: ActionKind }

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

/**
 * Mounts the hook over an overseer whose two reads are parked, so a test can land them out of
 * order — which is the whole question `refresh` answers for its caller.
 */
async function mount() {
  const catalogReads: Array<Deferred<PreApprovableAction[]>> = []
  const ruleReads: Array<Deferred<Rule[]>> = []
  const overseer = {
    listPreApprovableActions: () => {
      const next = deferred<PreApprovableAction[]>()
      catalogReads.push(next)
      return next.promise
    },
    listAutoApprovedActionKinds: () => {
      const next = deferred<Rule[]>()
      ruleReads.push(next)
      return next.promise
    },
  } as unknown as RpcStub<Overseer>

  let hook: ReturnType<typeof useAutoApproval> | undefined
  const Probe = () => {
    hook = useAutoApproval(overseer)
    return null
  }
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(<Probe />))

  return {
    get current() { return hook! },
    /** Lands the nth read pair, oldest first, with the rules it found. */
    async land(index: number, rules: Rule[]) {
      await act(async () => {
        catalogReads[index].resolve([])
        ruleReads[index].resolve(rules)
      })
    },
    /** Fails the nth read pair's rule read, as a dropped connection would. */
    async fail(index: number) {
      await act(async () => {
        catalogReads[index].resolve([])
        ruleReads[index].reject(new Error('The connection dropped.'))
      })
    },
  }
}

describe('useAutoApproval', () => {
  it('reports a read that landed, so the caller can retire its optimistic overlay', async () => {
    // The chat surface shows "Always approve" as taken the moment it is clicked, and drops that
    // overlay once a read of the real list has replaced it. What `refresh` resolves to is the
    // only thing standing between the two.
    const harness = await mount()
    await harness.land(0, [])

    const refresh = harness.current.refresh()
    await harness.land(1, [{ gatekeeperId: 1, actionKind: APPEND }])

    await expect(refresh).resolves.toBe(true)
    expect(harness.current.entries).toEqual([
      { gatekeeperId: 1, resourceTitle: '', actionKind: APPEND, enabled: true, orphaned: true },
    ])
  })

  it('does not report a read another refresh overtook', async () => {
    // Two refreshes in flight, the older landing last. Its result is thrown away, so a caller
    // retiring the overlay on it would be retiring it against a list that never took effect.
    const harness = await mount()
    await harness.land(0, [])

    const older = harness.current.refresh()
    const newer = harness.current.refresh()
    await harness.land(2, [])
    await harness.land(1, [{ gatekeeperId: 1, actionKind: APPEND }])

    await expect(newer).resolves.toBe(true)
    await expect(older).resolves.toBe(false)
    // The newer read won: the rule the older one carried is nowhere.
    expect(harness.current.entries).toEqual([])
  })

  it('does not report a read that failed', async () => {
    // A failed read empties the lists, so every rule would read as off. Retiring the overlay
    // against that offers "Always approve" again for a rule the user has just enabled.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const harness = await mount()
    await harness.land(0, [])

    const refresh = harness.current.refresh()
    await harness.fail(1)

    await expect(refresh).resolves.toBe(false)
    expect(harness.current.loadError).toBe(true)
  })
})
