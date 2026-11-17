// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_AGENT_ACTIONS } from '@gadgets/workshop-shared/admin-agent'
import type { Overseer, PreApprovableAction } from '@gadgets/workshop-shared/api'
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
        ruleApplies: true,
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

const NOTE: ActionKind = ADMIN_AGENT_ACTIONS.issueReportNote.kind
const REPLY: ActionKind = ADMIN_AGENT_ACTIONS.issueReportScopedReply.kind
const WONT_APPLY = "Won't apply: this workspace has read sensitive data, so this kind of action " +
  'always requires manual approval.'

/**
 * Renders the rule list of a workspace, restricted unless told otherwise. The catalog lists the
 * admin connection, which no gadget binds, as the kernel does: a rule applies every kind until
 * the workspace is restricted, and then its note and not its reply.
 * `stored` are the tags with a rule on; `listed` the kinds the connection still offers.
 */
async function mountAdminRules(
  stored: string[], listed: ActionKind[] = [NOTE, REPLY], restricted = true,
) {
  const enabled = new Set(stored)
  let latched = restricted
  let exempt = true
  let catalogReads = 0
  const kinds = new Map([NOTE, REPLY].map(kind => [kind.tag, kind]))
  const overseer = {
    subscribeToActions: async () => ({ [Symbol.dispose]: () => {} }),
    listActions: async () => ({ entries: [], cursor: undefined }),
    listPreApprovableActions: async (): Promise<PreApprovableAction[]> => {
      catalogReads++
      return listed.map(actionKind => ({
        gatekeeperId: 7,
        resourceTitle: 'This deployment',
        vendorId: 'instanceadmin',
        actionKind,
        alreadyEnabled: enabled.has(actionKind.tag),
        ruleApplies: !latched || (exempt && actionKind === NOTE),
      }))
    },
    listAutoApprovedActionKinds: async () =>
      [...enabled].map(tag => ({ gatekeeperId: 7, actionKind: kinds.get(tag)! })),
    setAutoApprovedActionKind: async (_gatekeeperId: number, kind: ActionKind) => {
      enabled.add(kind.tag)
    },
    removeAutoApprovedActionKind: async (_gatekeeperId: number, tag: string) => {
      enabled.delete(tag)
    },
    [Symbol.dispose]: () => {},
  } as unknown as RpcStub<Overseer>

  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  /**
   * Renders the tab, with the kernel answering for the workspace as `restricted` says it is and,
   * under the latch, as `rulesApply` says: whether only the admin connection's reads marked it.
   */
  const render = (nextRestricted: boolean, rulesApply = true) => {
    latched = nextRestricted
    exempt = rulesApply
    return act(async () => root!.render(
      <Activity overseer={overseer} restricted={nextRestricted}
        rulesApplyWhileRestricted={nextRestricted && rulesApply} view="auto"
        onViewChange={() => {}} />,
    ))
  }
  await render(restricted)

  /** The row of a kind: its sentence, and its switch through the checkbox it forwards clicks to. */
  const row = (kind: ActionKind) => {
    const toggle = [...document.querySelectorAll('[role="switch"]')]
      .find(element => element.getAttribute('aria-label')?.endsWith(`for ${kind.label}`))
    const checkbox = toggle?.nextElementSibling
    if (!toggle || !(checkbox instanceof HTMLInputElement)) throw new Error(`No row for ${kind.tag}`)
    return {
      text: toggle.parentElement?.textContent ?? '',
      on: toggle.getAttribute('aria-checked') === 'true',
      disabled: checkbox.disabled,
      toggle: () => act(async () => checkbox.click()),
    }
  }
  return { row, enabled, render, get catalogReads() { return catalogReads } }
}

describe('Activity auto-approval rules in a restricted workspace', () => {
  it('lets a rule be turned on for a kind the kernel applies, and not for one it holds', async () => {
    const panel = await mountAdminRules([])

    expect(panel.row(NOTE).text).toContain('Waits for your approval')
    expect(panel.row(NOTE).disabled).toBe(false)
    expect(panel.row(REPLY).text).toContain(WONT_APPLY)
    expect(panel.row(REPLY).disabled).toBe(true)

    await panel.row(NOTE).toggle()

    expect([...panel.enabled]).toEqual([NOTE.tag])
    expect(panel.row(NOTE).on).toBe(true)
    expect(panel.row(NOTE).text).toContain('Applied without asking')
    expect(panel.row(NOTE).text).not.toContain("Won't apply")
  })

  it('keeps a rule that applies nothing revocable', async () => {
    const panel = await mountAdminRules([REPLY.tag])

    expect(panel.row(REPLY).on).toBe(true)
    expect(panel.row(REPLY).text).toContain(WONT_APPLY)
    expect(panel.row(REPLY).disabled).toBe(false)

    await panel.row(REPLY).toggle()

    expect([...panel.enabled]).toEqual([])
    expect(panel.row(REPLY).on).toBe(false)
    expect(panel.row(REPLY).disabled).toBe(true)
  })

  it('does not say what the kernel never said of a rule its connection no longer offers', async () => {
    // The catalog is where the kernel answers, and it no longer lists this kind.
    const panel = await mountAdminRules([NOTE.tag], [REPLY])

    expect(panel.row(NOTE).text).toContain('This connection no longer offers this action.')
    expect(panel.row(NOTE).text).not.toContain('the rule still applies')
    expect(panel.row(NOTE).text).not.toContain("Won't apply")
    expect(panel.row(NOTE).disabled).toBe(false)

    await panel.row(NOTE).toggle()

    expect([...panel.enabled]).toEqual([])
  })

  it('says a rule its connection no longer offers still applies where no latch is set', async () => {
    const panel = await mountAdminRules([NOTE.tag], [REPLY], false)

    expect(panel.row(NOTE).text)
      .toContain('This connection no longer offers this action; the rule still applies.')
  })

  it('reads what a rule applies again when the latch sets while the tab is open', async () => {
    // What the catalog said before the latch was said of another workspace: every kind applied.
    const panel = await mountAdminRules([], [NOTE, REPLY], false)
    expect(panel.catalogReads).toBe(1)
    expect(panel.row(REPLY).text).not.toContain("Won't apply")
    expect(panel.row(REPLY).disabled).toBe(false)

    await panel.render(true)

    expect(panel.catalogReads).toBe(2)
    expect(panel.row(REPLY).text).toContain(WONT_APPLY)
    expect(panel.row(REPLY).disabled).toBe(true)
    expect(panel.row(NOTE).text).toContain('Waits for your approval')
    expect(panel.row(NOTE).disabled).toBe(false)
  })

  it('reads what a rule applies again when another connection\'s restricted read ends it', async () => {
    const panel = await mountAdminRules([NOTE.tag])
    expect(panel.catalogReads).toBe(1)
    expect(panel.row(NOTE).text).toContain('Applied without asking')

    // The workspace's metadata says no rule applies anything any more.
    await panel.render(true, false)

    expect(panel.catalogReads).toBe(2)
    expect(panel.row(NOTE).on).toBe(true)
    expect(panel.row(NOTE).text).toContain(WONT_APPLY)
    // Stored, so still revocable.
    expect(panel.row(NOTE).disabled).toBe(false)
  })
})
