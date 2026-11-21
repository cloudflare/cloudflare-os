// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Overseer, PreApprovableAction } from '@gadgets/workshop-shared/api'
import type { ActionKind } from '@gadgets/workshop-shared/gatekeeper'
import type { RpcStub } from 'capnweb'
import { useRuleCatalog, type RuleCatalogWants } from './useRuleCatalog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  vi.restoreAllMocks()
})

const NOTE: ActionKind = { tag: 'issue-report-note', label: 'Add an admins-only note to an issue report' }
const REPLY: ActionKind = {
  tag: 'issue-report-scoped-reply', label: 'Reply to a reporter from a session limited to their report',
}

/** The admin connection's two kinds, as the kernel lists them: a rule applies `applying` alone. */
function adminCatalog(applying: ActionKind[]): PreApprovableAction[] {
  return [NOTE, REPLY].map(actionKind => ({
    gatekeeperId: 7,
    resourceTitle: 'This deployment',
    vendorId: 'admin',
    actionKind,
    alreadyEnabled: false,
    ruleApplies: applying.includes(actionKind),
  }))
}

/** A workspace connection whose catalog reads are parked until a test lands or fails them. */
function connection() {
  const reads: Array<{
    resolve: (catalog: PreApprovableAction[]) => void
    reject: (error: unknown) => void
  }> = []
  const overseer = {
    listPreApprovableActions: () => new Promise<PreApprovableAction[]>((resolve, reject) => {
      reads.push({ resolve, reject })
    }),
  } as unknown as RpcStub<Overseer>
  return {
    overseer,
    get reads() { return reads.length },
    /** Lands the nth read, oldest first. */
    async land(index: number, catalog: PreApprovableAction[]) {
      await act(async () => { reads[index].resolve(catalog) })
    },
    /** Fails the nth read, as one gatekeeper that cannot start fails the whole catalog. */
    async fail(index: number) {
      await act(async () => { reads[index].reject(new Error('A gatekeeper did not start.')) })
    },
  }
}

const UNRESTRICTED: RuleCatalogWants = { vendors: false, restricted: false, applies: false }
const LATCHED: RuleCatalogWants = { vendors: false, restricted: true, applies: true }

async function mount(overseer: RpcStub<Overseer>, want: RuleCatalogWants) {
  let hook: ReturnType<typeof useRuleCatalog> | undefined
  const Probe = (props: { overseer: RpcStub<Overseer>, want: RuleCatalogWants }) => {
    hook = useRuleCatalog(props.overseer, props.want)
    return null
  }
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  const render = (nextOverseer: RpcStub<Overseer>, nextWant: RuleCatalogWants) =>
    act(async () => root!.render(<Probe overseer={nextOverseer} want={nextWant} />))
  await render(overseer, want)
  return {
    get current() { return hook! },
    render,
    reread: () => act(async () => hook!.reread()),
  }
}

describe('useRuleCatalog', () => {
  it('reads nothing where nothing is asked, and lets a rule apply every kind', async () => {
    const workspace = connection()
    const harness = await mount(workspace.overseer, UNRESTRICTED)

    expect(workspace.reads).toBe(0)
    expect(harness.current.ruleApplies(7, NOTE.tag)).toBe(true)
    expect(harness.current.ruleApplies(1, 'append')).toBe(true)
    expect(harness.current.vendorIdByGatekeeper.size).toBe(0)
  })

  it('reads the vendors once for a workspace connection', async () => {
    const workspace = connection()
    const want = { ...UNRESTRICTED, vendors: true }
    const harness = await mount(workspace.overseer, want)
    await workspace.land(0, adminCatalog([NOTE, REPLY]))
    await harness.render(workspace.overseer, { ...want })
    await harness.reread()

    expect(workspace.reads).toBe(1)
    expect(harness.current.vendorIdByGatekeeper.get(7)).toBe('admin')
  })

  it('reads nothing under the latch while no request a rule might apply is on show', async () => {
    // Always mounted, and the catalog starts every gatekeeper it lists: a restricted workspace
    // of any vendor must not pay for that.
    const workspace = connection()
    const harness = await mount(workspace.overseer, { ...LATCHED, applies: false })

    expect(workspace.reads).toBe(0)
    expect(harness.current.ruleApplies(7, NOTE.tag)).toBe(false)
  })

  it('answers under the latch what the kernel said of each kind', async () => {
    const workspace = connection()
    const harness = await mount(workspace.overseer, LATCHED)
    // No answer yet is no kind.
    expect(harness.current.ruleApplies(7, NOTE.tag)).toBe(false)

    await workspace.land(0, adminCatalog([NOTE]))
    await harness.render(workspace.overseer, { ...LATCHED })

    expect(workspace.reads).toBe(1)
    expect(harness.current.ruleApplies(7, NOTE.tag)).toBe(true)
    expect(harness.current.ruleApplies(7, REPLY.tag)).toBe(false)
    // The answer is for a connection: the same tag elsewhere was not said to apply.
    expect(harness.current.ruleApplies(8, NOTE.tag)).toBe(false)
  })

  it('does not take what was read before the latch for what a rule applies under it', async () => {
    const workspace = connection()
    const harness = await mount(workspace.overseer, { ...UNRESTRICTED, vendors: true })
    // Read while unrestricted, when the kernel says every kind applies.
    await workspace.land(0, adminCatalog([NOTE, REPLY]))

    await harness.render(workspace.overseer, { ...LATCHED, vendors: true })

    expect(harness.current.ruleApplies(7, NOTE.tag)).toBe(false)
    expect(harness.current.ruleApplies(7, REPLY.tag)).toBe(false)
    expect(workspace.reads).toBe(2)

    await workspace.land(1, adminCatalog([NOTE]))
    expect(harness.current.ruleApplies(7, NOTE.tag)).toBe(true)
    expect(harness.current.ruleApplies(7, REPLY.tag)).toBe(false)
    expect(workspace.reads).toBe(2)
  })

  it('drops a read the latch overtook', async () => {
    const workspace = connection()
    const harness = await mount(workspace.overseer, { ...UNRESTRICTED, vendors: true })
    await harness.render(workspace.overseer, { ...LATCHED, vendors: true })

    // Started before the latch: the kernel may have answered for the workspace as it was.
    await workspace.land(0, adminCatalog([NOTE, REPLY]))
    expect(harness.current.ruleApplies(7, REPLY.tag)).toBe(false)

    await workspace.land(1, adminCatalog([NOTE]))
    expect(harness.current.ruleApplies(7, NOTE.tag)).toBe(true)
    expect(harness.current.ruleApplies(7, REPLY.tag)).toBe(false)
  })

  it('answers no kind, at once and with no read, once the kernel says no rule applies', async () => {
    // Another connection's restricted data was read: the kernel holds what a rule applied, and
    // says so in the workspace's metadata.
    const workspace = connection()
    const want = { ...LATCHED, vendors: true, rulesApply: true }
    const harness = await mount(workspace.overseer, want)
    await workspace.land(0, adminCatalog([NOTE]))
    expect(harness.current.ruleApplies(7, NOTE.tag)).toBe(true)

    await harness.render(workspace.overseer, { ...want, rulesApply: false })

    expect(harness.current.ruleApplies(7, NOTE.tag)).toBe(false)
    expect(workspace.reads).toBe(1)
    // The logos it read stay, and a re-read is not made to be told no.
    expect(harness.current.vendorIdByGatekeeper.get(7)).toBe('admin')
    await harness.reread()
    expect(workspace.reads).toBe(1)
  })

  it('reads nothing under a latch the kernel says no rule applies under', async () => {
    const workspace = connection()
    const harness = await mount(workspace.overseer, { ...LATCHED, rulesApply: false })

    expect(workspace.reads).toBe(0)
    expect(harness.current.ruleApplies(7, NOTE.tag)).toBe(false)
  })

  it('reads again on reread() under the latch, keeping the vendors and the answer meanwhile', async () => {
    const workspace = connection()
    const harness = await mount(workspace.overseer, { ...LATCHED, vendors: true })
    await workspace.land(0, adminCatalog([NOTE]))

    await harness.reread()

    expect(workspace.reads).toBe(2)
    expect(harness.current.vendorIdByGatekeeper.get(7)).toBe('admin')
    // Still on show, so that a covered request does not read as uncovered for the length of a read.
    expect(harness.current.ruleApplies(7, NOTE.tag)).toBe(true)

    // Another connection's restricted data was read: the kernel applies nothing any more.
    await workspace.land(1, adminCatalog([]))
    expect(harness.current.ruleApplies(7, NOTE.tag)).toBe(false)
    expect(harness.current.vendorIdByGatekeeper.get(7)).toBe('admin')
  })

  it('answers no kind once the read that should replace an answer fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const workspace = connection()
    const harness = await mount(workspace.overseer, { ...LATCHED, vendors: true })
    await workspace.land(0, adminCatalog([NOTE]))

    await harness.reread()
    await workspace.fail(1)

    expect(harness.current.ruleApplies(7, NOTE.tag)).toBe(false)
    expect(harness.current.vendorIdByGatekeeper.get(7)).toBe('admin')
    expect(workspace.reads).toBe(2)
  })

  it('answers no kind after a failed read, and does not make it again on a re-render', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const workspace = connection()
    const harness = await mount(workspace.overseer, LATCHED)
    await workspace.fail(0)
    await harness.render(workspace.overseer, { ...LATCHED })

    expect(harness.current.ruleApplies(7, NOTE.tag)).toBe(false)
    expect(workspace.reads).toBe(1)

    // Asked again, it is read again.
    await harness.reread()
    expect(workspace.reads).toBe(2)
    await workspace.land(1, adminCatalog([NOTE]))
    expect(harness.current.ruleApplies(7, NOTE.tag)).toBe(true)
  })

  it('makes a failed read again once more is asked of the catalog', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const workspace = connection()
    // A restricted workspace whose tray holds another vendor's request: the logos alone.
    const logos = { vendors: true, restricted: true, applies: false }
    const harness = await mount(workspace.overseer, logos)
    await workspace.fail(0)
    await harness.render(workspace.overseer, { ...logos })
    expect(workspace.reads).toBe(1)

    // A request a rule might apply arrives: the answer was never read, so it is asked for.
    await harness.render(workspace.overseer, { ...logos, applies: true })
    expect(workspace.reads).toBe(2)

    await workspace.land(1, adminCatalog([NOTE]))
    expect(harness.current.ruleApplies(7, NOTE.tag)).toBe(true)
    expect(harness.current.vendorIdByGatekeeper.get(7)).toBe('admin')
    expect(workspace.reads).toBe(2)
  })

  it('makes a failed read again once the logos are asked for too', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const workspace = connection()
    const harness = await mount(workspace.overseer, LATCHED)
    await workspace.fail(0)

    await harness.render(workspace.overseer, { ...LATCHED, vendors: true })
    expect(workspace.reads).toBe(2)
  })

  it('reads through a new workspace connection, and answers nothing of the last one meanwhile', async () => {
    const first = connection()
    const harness = await mount(first.overseer, { ...LATCHED, vendors: true })
    await first.land(0, adminCatalog([NOTE]))

    const second = connection()
    await harness.render(second.overseer, { ...LATCHED, vendors: true })

    expect(second.reads).toBe(1)
    expect(harness.current.ruleApplies(7, NOTE.tag)).toBe(false)
    expect(harness.current.vendorIdByGatekeeper.size).toBe(0)

    await second.land(0, adminCatalog([NOTE]))
    expect(harness.current.ruleApplies(7, NOTE.tag)).toBe(true)
    expect(first.reads).toBe(1)
  })
})
