// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Overseer, PreApprovableAction } from '@gadgets/workshop-shared/api'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'
import type { RpcStub } from 'capnweb'
import type { RuleCatalogWants } from './useRuleCatalog'
import { useStandingRules } from './useStandingRules'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  vi.restoreAllMocks()
})

const APPEND: ActionKind = { tag: 'append', label: 'Append a slide' }
const NOTE: ActionKind = { tag: 'issue-report-note', label: 'Add an admins-only note to an issue report' }
const REPLY: ActionKind = {
  tag: 'issue-report-scoped-reply', label: 'Reply to a reporter from a session limited to their report',
}
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

// No tray and no latch, so no catalog: only the rule reads a test parks.
const NOTHING: RuleCatalogWants = { vendors: false, restricted: false, applies: false }

/**
 * Mounts the hook over an overseer whose rule reads are parked, so a test can land them out of
 * order — which is the whole question `refresh` answers for its caller. The catalog answers at
 * once with `catalog`, and `catalogReads` counts how often it was asked.
 */
async function mount(want: RuleCatalogWants = NOTHING, catalog: PreApprovableAction[] = []) {
  const ruleReads: Array<Deferred<Rule[]>> = []
  let catalogReads = 0
  const overseer = {
    listAutoApprovedActionKinds: () => {
      const next = deferred<Rule[]>()
      ruleReads.push(next)
      return next.promise
    },
    listPreApprovableActions: () => {
      catalogReads += 1
      return Promise.resolve(catalog)
    },
  } as unknown as RpcStub<Overseer>

  let hook: ReturnType<typeof useStandingRules> | undefined
  const Probe = () => {
    hook = useStandingRules(overseer, want)
    return null
  }
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(<Probe />))

  return {
    get current() { return hook! },
    get catalogReads() { return catalogReads },
    /** Lands the nth rule read, oldest first, with the rules it found. */
    async land(index: number, rules: Rule[]) {
      await act(async () => { ruleReads[index].resolve(rules) })
    },
    /** Fails the nth rule read, as a dropped connection would. */
    async fail(index: number) {
      await act(async () => { ruleReads[index].reject(new Error('The connection dropped.')) })
    },
  }
}

describe('useStandingRules', () => {
  it('reports a read that landed, so the caller can retire its optimistic overlay', async () => {
    // The chat shows "Always approve" as taken the moment it is clicked, and drops that overlay
    // once a read of the real list has replaced it. What `refresh` resolves to is the only thing
    // standing between the two.
    const harness = await mount()
    await harness.land(0, [])

    const refresh = harness.current.refresh()
    await harness.land(1, [{ gatekeeperId: 1, actionKind: APPEND }])

    await expect(refresh).resolves.toBe(true)
    expect([...harness.current.enabledRuleKeys]).toEqual(['1:append'])
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
    expect([...harness.current.enabledRuleKeys]).toEqual([])
  })

  it('does not report a read that failed', async () => {
    // A failed read empties the list, so every rule would read as off. Retiring the overlay
    // against that offers "Always approve" again for a rule the user has just enabled.
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const harness = await mount()
    await harness.land(0, [])

    const refresh = harness.current.refresh()
    await harness.fail(1)

    await expect(refresh).resolves.toBe(false)
    expect(harness.current.loadError).toBe(true)
  })

  it('serves the logos and what a rule applies from one read of the catalog', async () => {
    // The catalog starts every gatekeeper it lists, so the chat reads it once for both.
    const harness = await mount({ vendors: true, restricted: true, applies: true }, [{
      gatekeeperId: 7, resourceTitle: 'This deployment', vendorId: 'admin',
      actionKind: NOTE, alreadyEnabled: false, ruleApplies: true,
    }, {
      gatekeeperId: 7, resourceTitle: 'This deployment', vendorId: 'admin',
      actionKind: REPLY, alreadyEnabled: false, ruleApplies: false,
    }])
    await harness.land(0, [])

    expect(harness.catalogReads).toBe(1)
    expect(harness.current.vendorIdByGatekeeper.get(7)).toBe('admin')
    expect(harness.current.ruleApplies(7, NOTE.tag)).toBe(true)
    expect(harness.current.ruleApplies(7, REPLY.tag)).toBe(false)
  })

  it('reads the catalog again with the rule list under the latch', async () => {
    // A later read of another connection's restricted data ends what a rule applies, and only
    // a re-read says so.
    const harness = await mount({ vendors: true, restricted: true, applies: true })
    await harness.land(0, [])
    expect(harness.catalogReads).toBe(1)

    const refresh = harness.current.refresh()
    await harness.land(1, [])

    await expect(refresh).resolves.toBe(true)
    expect(harness.catalogReads).toBe(2)
  })

  it('leaves the catalog alone on a refresh where no latch is set', async () => {
    const harness = await mount({ vendors: true, restricted: false, applies: false })
    await harness.land(0, [])

    const refresh = harness.current.refresh()
    await harness.land(1, [])
    await refresh

    expect(harness.catalogReads).toBe(1)
  })
})
