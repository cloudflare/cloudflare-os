// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PendingChangesTray } from './PendingChangesTray'
import type { PendingChangeActions } from './PendingChangeGroupRow'
import type {
  PendingChange, PendingChangeGroup, RequestOrigin,
} from './pendingChangeGroups'
import type { BulkResolve } from './useBulkResolve'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const APPEND = { tag: 'append', label: 'Append a slide' }

let root: Root | undefined
afterEach(() => {
  act(() => root?.unmount())
  root = undefined
  vi.restoreAllMocks()
})

function request(id: number, over: {
  gatekeeperId?: number
  title?: string
  autoApprovable?: boolean
  actionKind?: { tag: string, label: string }
  creation?: true
  origin?: RequestOrigin
} = {}): PendingChange {
  return {
    id,
    gatekeeperId: over.gatekeeperId ?? 1,
    resourceTitle: 'Road trip 2026',
    createdAt: new Date(Date.now() - 60_000),
    state: 'pending',
    type: 'action',
    origin: over.origin ?? 'open-chat',
    ...(over.creation ? { creation: true } : {}),
    description: {
      title: over.title ?? `Write ${id}`,
      description: 'Appends a slide.',
      implementsRevert: false,
      autoApprovable: over.autoApprovable ?? false,
      ...('actionKind' in over ? { actionKind: over.actionKind } : { actionKind: APPEND }),
    },
  } as PendingChange
}

function group(entries: PendingChange[], over: Partial<PendingChangeGroup> = {}): PendingChangeGroup {
  return {
    gatekeeperId: entries[0].gatekeeperId,
    title: 'Road trip 2026',
    entries,
    hasCreation: entries.some(entry => entry.creation === true),
    ...over,
  }
}

const noBulk: BulkResolve = {
  run: async () => {},
  progress: null,
  failure: null,
  dismissFailure: () => {},
}

async function render(options: {
  groups: PendingChangeGroup[]
  enabledTags?: string[]
  restricted?: boolean
  ready?: boolean
  bulk?: BulkResolve
  actions?: Partial<PendingChangeActions>
}) {
  const calls: string[] = []
  const actions: PendingChangeActions = {
    processing: new Set<number>(),
    onApprove: entry => calls.push(`approve:${entry.id}`),
    onReject: entry => calls.push(`reject:${entry.id}`),
    onAlwaysApprove: entry => calls.push(`always:${entry.id}`),
    onManageRules: () => calls.push('manage'),
    ...options.actions,
  }
  const container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
  await act(async () => root!.render(
    <PendingChangesTray
      groups={options.groups}
      rules={{
        isEnabled: (_gatekeeperId, tag) => (options.enabledTags ?? []).includes(tag),
        restricted: options.restricted === true,
      }}
      ready={options.ready ?? true}
      vendorIdByGatekeeper={new Map()}
      vendorBranding={new Map()}
      actions={actions}
      bulk={options.bulk ?? noBulk}
    />,
  ))
  return { calls, container }
}

const buttons = () => [...document.querySelectorAll('button')]
const button = (text: string) => buttons().find(b => (b.textContent ?? '').trim() === text)
const click = async (target: HTMLButtonElement | undefined) => {
  if (!target) throw new Error('No such button')
  await act(async () => target.click())
}
const openGroup = () => click(buttons().find(b => b.hasAttribute('aria-expanded')))

describe('PendingChangesTray', () => {
  it('counts the requests waiting and offers to resolve them together', async () => {
    await render({ groups: [group([request(1), request(2)])] })

    expect(document.body.textContent).toContain('2 requests waiting')
    expect(document.body.textContent).toContain('nothing applied yet')
    expect(button('Apply all 2')).toBeDefined()
    expect(button('Discard all')).toBeDefined()
  })

  it('offers no bulk resolve while the workspace is restricted', async () => {
    await render({ groups: [group([request(1), request(2)])], restricted: true })

    // RESTRICTED_APPROVAL_COPY asks the approver to read every request in full, and the latch
    // already refuses every auto-approval rule; bulk apply would be the first path around both.
    expect(button('Apply all 2')).toBeUndefined()
    expect(button('Discard all')).toBeUndefined()
    expect(document.body.textContent).toContain('every request is reviewed on its own')
  })

  it('leaves a connection with a pending creation out of bulk resolve', async () => {
    const creating = group([request(1, { creation: true }), request(2)])
    const ordinary = group([request(3, { gatekeeperId: 2 }), request(4, { gatekeeperId: 2 })],
      { gatekeeperId: 2, title: 'Team calendar' })
    await render({ groups: [creating, ordinary] })

    // Nothing queued behind a creation can apply until an account is chosen for it, so only the
    // other connection's requests are counted.
    expect(document.body.textContent).toContain('4 requests waiting')
    expect(button('Apply all 2')).toBeDefined()
  })

  it('explains a creation inside its group rather than silently refusing', async () => {
    await render({ groups: [group([request(1, { creation: true }), request(2)])] })
    await openGroup()

    expect(document.body.textContent).toContain('Approve its creation first')
  })

  it('offers "Always approve" only where a rule would apply the request', async () => {
    await render({ groups: [group([
      request(1, { autoApprovable: true, title: 'Auto-approvable' }),
      request(2, { autoApprovable: false, title: 'Manual only' }),
    ])] })
    await openGroup()

    expect(buttons().filter(b => b.textContent === 'Always approve')).toHaveLength(1)
  })

  it('stops offering "Always approve" once a rule covers the kind', async () => {
    await render({
      groups: [group([request(1, { autoApprovable: true })])],
      enabledTags: ['append'],
    })
    await openGroup()

    // The old chat surface inferred "still pending" meant "no rule", which is wrong: the drain
    // stops at the first manual gate and leaves covered requests queued behind it.
    expect(button('Always approve')).toBeUndefined()
    expect(document.body.textContent).toContain('Standing rule enabled')
  })

  it('keeps a covered request decidable, since the drain can give up on it', async () => {
    // A drain whose apply fails stops there for good and leaves the request pending. Alone in
    // the tray it has no bulk footer, and the transcript defers to the tray, so a row with no
    // controls would leave it decidable nowhere in the chat.
    const { calls } = await render({
      groups: [group([request(1, { autoApprovable: true })])],
      enabledTags: ['append'],
    })
    await openGroup()

    await click(button('Approve'))
    expect(calls).toEqual(['approve:1'])
  })

  it('names what is holding up an auto-approved request', async () => {
    const gate = request(1, { autoApprovable: false, title: 'Needs a person' })
    const covered = request(2, { autoApprovable: true })
    await render({ groups: [group([gate, covered])], enabledTags: ['append'] })
    await openGroup()

    expect(document.body.textContent).toContain('waiting on "Needs a person" above it')
  })

  it('links to where a standing rule is turned off', async () => {
    const { calls } = await render({
      groups: [group([request(1, { autoApprovable: true })])],
      enabledTags: ['append'],
    })
    await openGroup()
    await click(button('Manage rule'))

    expect(calls).toEqual(['manage'])
  })

  it('reports a bulk run that stopped part-way', async () => {
    await render({
      groups: [group([request(1), request(2), request(3)])],
      bulk: {
        ...noBulk,
        failure: {
          decision: 'approve', applied: 1, total: 3, title: 'Write 2', reason: 'The provider failed.',
        },
      },
    })

    const alert = document.querySelector('[role="alert"]')
    expect(alert?.textContent).toContain('Applied 1 of 3')
    expect(alert?.textContent).toContain('The provider failed.')
  })

  it('keeps a stopped run\'s message once nothing is left waiting, until it is dismissed', async () => {
    let dismissed = 0
    await render({
      groups: [],
      bulk: {
        ...noBulk,
        failure: {
          decision: 'deny', applied: 1, total: 2,
          reason: '"Write 1" was applied before it could be discarded, so the rest were left alone.',
        },
        dismissFailure: () => { dismissed++ },
      },
    })

    expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain('"Write 1" was applied before it could be discarded')
    // Only the message: no count, no bulk controls, nothing to open.
    expect(document.body.textContent).not.toContain('waiting')
    expect(buttons().map(b => (b.textContent ?? '').trim())).toEqual(['Dismiss'])
    await click(button('Dismiss'))
    expect(dismissed).toBe(1)
  })

  it('marks the requests this conversation did not ask for', async () => {
    // A hook, a scheduled task or another chat queued it; nothing on screen explains it.
    await render({ groups: [group([request(1), request(2, { origin: 'elsewhere' })])] })

    expect(document.body.textContent).toContain('1 from elsewhere')
    await openGroup()
    expect([...document.querySelectorAll('p')]
      .filter(p => p.textContent?.trim() === 'Asked elsewhere in this workspace'))
      .toHaveLength(1)
  })

  it('says so plainly when the whole queue came from elsewhere', async () => {
    await render({ groups: [group([
      request(1, { origin: 'elsewhere' }),
      request(2, { origin: 'elsewhere' }),
    ])] })

    expect(document.body.textContent).toContain('asked elsewhere in this workspace')
    // Once on the group's row, rather than the same sentence under every request inside it.
    expect(buttons().find(b => b.hasAttribute('aria-expanded'))?.textContent)
      .toContain('Asked elsewhere')
    await openGroup()
    expect([...document.querySelectorAll('p')]
      .filter(p => p.textContent?.trim() === 'Asked elsewhere in this workspace'))
      .toHaveLength(0)
  })

  it('offers no bulk resolve until the pending set has finished loading', async () => {
    // It pages in, so a group can still be missing its oldest requests: applying the batch now
    // would apply a later request over ones nobody has seen yet.
    await render({ groups: [group([request(1), request(2)])], ready: false })

    expect(button('Apply all 2')).toBeUndefined()
    await openGroup()
    expect(button('Apply all 2')).toBeUndefined()
  })

  it('disables a single request\'s decisions while a bulk run is in flight', async () => {
    await render({
      groups: [group([request(1), request(2)])],
      bulk: { ...noBulk, progress: { decision: 'approve', done: 0, total: 2 } },
    })
    await openGroup()

    // A decision taken mid-run would interleave with it, which is the out-of-order apply the
    // run is sequential to avoid.
    expect(buttons().filter(b => b.textContent === 'Approve').every(b => b.disabled)).toBe(true)
    expect(buttons().filter(b => b.textContent === 'Deny').every(b => b.disabled)).toBe(true)
  })

  it('warns when one connection is close to filling its queue', async () => {
    const many = Array.from({ length: 40 }, (_, i) => request(i + 1))
    await render({ groups: [group(many)] })

    expect(document.body.textContent).toContain('holding 40 unresolved requests')
  })
})
