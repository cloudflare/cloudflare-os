// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Overseer } from '@gadgets/workshop-shared/api'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'
import type { RpcStub } from 'capnweb'

vi.mock('@cloudflare/kumo', async (importOriginal) => ({
  ...await importOriginal() as typeof import('@cloudflare/kumo'),
  useKumoToastManager: () => ({ add: () => {} }),
}))
vi.mock('./AuthContext', () => ({
  useAuthenticatedApi: () => ({ authenticatedApi: null, currentUser: null }),
}))

const { default: Activity } = await import('./Activity')
const { useAutoApprovalChannel } = await import('./features/approvals/autoApprovalChannel')

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
})

const APPEND: ActionKind = { tag: 'append', label: 'Append a slide' }

/**
 * Renders the rule list over an overseer that counts how often the rules are read, which is what
 * the panel's own reload is supposed to stop duplicating.
 */
async function mount() {
  let ruleReads = 0
  const enabled = new Set<string>()
  const overseer = {
    subscribeToActions: async () => ({ [Symbol.dispose]: () => {} }),
    listActions: async () => ({ entries: [], cursor: undefined }),
    listPreApprovableActions: async () => {
      ruleReads++
      return [{
        gatekeeperId: 1,
        resourceTitle: 'Road trip 2026',
        vendorId: 'slides',
        actionKind: APPEND,
        alreadyEnabled: enabled.has('append'),
      }]
    },
    listAutoApprovedActionKinds: async () => [],
    setAutoApprovedActionKind: async () => { enabled.add('append') },
    removeAutoApprovedActionKind: async () => { enabled.delete('append') },
    [Symbol.dispose]: () => {},
  } as unknown as RpcStub<Overseer>

  let outside: (() => void) | undefined
  let rerender: (() => void) | undefined
  const Host = () => {
    const [, tick] = useState(0)
    const channel = useAutoApprovalChannel()
    outside = channel.changed
    rerender = () => tick(n => n + 1)
    return (
      <Activity
        overseer={overseer}
        view="auto"
        onViewChange={() => {}}
        autoApproval={channel}
      />
    )
  }

  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(<Host />))
  await act(async () => { rerender!() })

  return {
    get ruleReads() { return ruleReads },
    /** A change made by another surface, which this panel has no other way to hear about. */
    async changeElsewhere() {
      await act(async () => outside!())
    },
    async toggle() {
      // Through the checkbox the switch forwards its clicks to, since jsdom has no PointerEvent
      // to forward them with.
      const checkbox = document.querySelector('[role="switch"]')?.nextElementSibling
      if (!(checkbox instanceof HTMLInputElement)) throw new Error('No rule switch')
      await act(async () => checkbox.click())
    },
    /** Starts this panel's change and settles another surface's within one act; the two still flush separately. */
    async toggleWithChangeElsewhere() {
      const checkbox = document.querySelector('[role="switch"]')?.nextElementSibling
      if (!(checkbox instanceof HTMLInputElement)) throw new Error('No rule switch')
      await act(async () => { checkbox.click(); outside!() })
    },
  }
}

describe('Activity auto-approval rules', () => {
  it('reads the rules once for a change it made, and again for one it did not', async () => {
    const panel = await mount()
    const atMount = panel.ruleReads
    expect(atMount).toBeGreaterThan(0)

    // `setEnabled` re-reads the list on its way out, and its report to the channel then bumps the
    // trigger for the other surfaces. Reacting to that bump here would read it again for no new
    // answer.
    await panel.toggle()
    expect(panel.ruleReads).toBe(atMount + 1)

    // A change made anywhere else still has to land here: this panel is the one place a standing
    // rule is turned off, so a stale list is the one thing it must not show.
    await panel.changeElsewhere()
    expect(panel.ruleReads).toBe(atMount + 2)
  })

  it('reads a change from elsewhere that overlaps one of its own', async () => {
    const panel = await mount()
    const atMount = panel.ruleReads

    await panel.toggleWithChangeElsewhere()

    // An interleaved completion, not a coalesced one: `act()` flushes each separately, so the
    // two land in different renders and a boolean flag in place of the counter would pass this
    // too. The coalesced case -- both in one React batch, the trigger advancing by two against a
    // single local completion -- is what the counter is for, and is reachable in a browser under
    // automatic batching but not under jsdom. This pins the interleaving; that case is uncovered.
    expect(panel.ruleReads).toBe(atMount + 2)
  })
})
