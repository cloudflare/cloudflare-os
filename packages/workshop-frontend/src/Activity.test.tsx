// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ADMIN_AGENT_ACTIONS } from '@gadgets/workshop-shared/admin-agent'
import type {
  ActionLogEntry, ConnectedAccountsSubscriber, Overseer, PreApprovableAction,
} from '@gadgets/workshop-shared/api'
import type { AccountDescription, VendorDescription } from '@gadgets/workshop-shared/gatekeeper'

const addToast = vi.hoisted(() => vi.fn<(options: unknown) => void>())

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@cloudflare/kumo')
  const toasts = { add: addToast }
  return { ...actual, useKumoToastManager: () => toasts }
})
// Stubbed, but for the tests that turn a rule on and set `real`.
const alwaysApprove = vi.hoisted(() => ({ real: false }))
vi.mock('./useAlwaysApproveTag', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('./useAlwaysApproveTag')
  return {
    useAlwaysApproveTag: (...args: Parameters<typeof actual.useAlwaysApproveTag>) => alwaysApprove.real
      ? actual.useAlwaysApproveTag(...args)
      : {
          alwaysApproveTag: vi.fn<() => Promise<void>>(), isTagAutoApproved: () => false,
          forgetOptimisticTags: () => {},
        },
  }
})
const auth = vi.hoisted(() => ({ authenticatedApi: {} as Record<string, unknown> }))
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => auth }))

import {
  clickHookSwitch, deferred, entry, flushFrames, hookSwitch, makeOverseer, makeTestRoot, pushEntry,
  pushReviewDialog, settlePushReview,
} from './action-test-harness'
import Activity from './Activity'
import { KEEPS_APPLYING_COPY } from './components/AutoApproveConfirmDialog'
import {
  INCOMPLETE_DESCRIPTION_COPY, PUSH_DESCRIPTION_COPY,
} from './components/IncompleteDescriptionNotice'
import { RESTRICTED_APPROVAL_COPY } from './components/RestrictedApprovalNotice'

const view = makeTestRoot()

afterEach(() => {
  view.cleanup()
  vi.restoreAllMocks()
  alwaysApprove.real = false
})

const fields = [
  { label: 'To', kind: 'list', items: ['a@example.com'] },
  { label: 'Body', kind: 'text', value: 'Full body text' },
]

// Renders the review view with one complete pending request carrying `fields`.
async function renderReview(restricted: boolean) {
  const server = makeOverseer()
  await view.render(
    <Activity overseer={server.overseer} restricted={restricted} view="review" onViewChange={() => {}} />,
  )
  await server.resolveSubscription()
  await server.resolvePendingQuery({
    entries: [entry(1, {
      description: {
        title: 'Send email', description: 'Send an email.', implementsRevert: false,
        autoApprovable: false, descriptionIsComplete: true, fields,
      },
    })],
  })
  flushFrames()
}

// The box holding the Body field's value.
const bodyBox = () =>
  [...document.querySelectorAll('pre')].find(pre => pre.textContent === 'Full body text')

// The text a screen reader announces as the Approve button's description.
function approveDescribedBy(): string | null {
  const approve = [...document.querySelectorAll('button')].find(b => b.textContent === 'Approve')
  if (!approve) throw new Error('No Approve button rendered')
  const ids = approve.getAttribute('aria-describedby')
  if (ids === null) return null
  return ids.split(' ').map(id => {
    const el = document.getElementById(id)
    if (!el) throw new Error(`aria-describedby names a missing element: ${id}`)
    return el.textContent ?? ''
  }).join('\n')
}

describe('Activity review request fields', () => {
  it('shows the fields in full, named by the approve button, while restricted', async () => {
    await renderReview(true)
    expect(document.body.textContent).toContain('Full body text')
    expect(document.body.textContent).not.toContain('2 fields')
    const described = approveDescribedBy()
    expect(described).toContain('a@example.com')
    expect(described).toContain('Full body text')
  })

  it('offers no disclosure while restricted, since everything it would reveal is shown', async () => {
    await renderReview(true)
    expect(document.querySelector('[aria-expanded]')).toBeNull()
    expect(bodyBox()?.className).not.toContain('max-h-56')
  })

  it('collapses the fields to a count until expanded when not restricted', async () => {
    await renderReview(false)
    expect(document.body.textContent).toContain('2 fields')
    expect(document.body.textContent).not.toContain('Full body text')
    expect(document.querySelector('[aria-expanded="false"]')).not.toBeNull()
  })
})

describe('Activity rule offers in a restricted workspace', () => {
  const STATUS = ADMIN_AGENT_ACTIONS.issueReportStatus.kind
  const REPLY = ADMIN_AGENT_ACTIONS.issueReportScopedReply.kind
  const request = (id: number, title: string, actionKind: { tag: string, label: string },
      gatekeeperId = 7) => entry(id, {
    gatekeeperId,
    description: {
      title, description: '', implementsRevert: false, autoApprovable: true, actionKind,
    },
  })

  /**
   * Renders a restricted workspace's pane with `pending` waiting. The catalog lists the admin
   * connection as the kernel does, saying a rule applies a status and not a reply.
   */
  async function renderRestricted(pending: ActionLogEntry[], shown: 'review' | 'history' = 'review',
      answers: Partial<Overseer> = {}) {
    const server = makeOverseer()
    const listPreApprovableActions = vi.fn<() => Promise<PreApprovableAction[]>>(async () =>
      [STATUS, REPLY].map(actionKind => ({
        gatekeeperId: 7, resourceTitle: 'This deployment', vendorId: 'admin',
        actionKind, alreadyEnabled: false, ruleApplies: actionKind === STATUS,
      })))
    const setAutoApprovedActionKind = vi.fn<Overseer['setAutoApprovedActionKind']>(async () => {})
    Object.assign(server.overseer, { listPreApprovableActions, setAutoApprovedActionKind, ...answers })
    await view.render(
      <Activity overseer={server.overseer} restricted view={shown} onViewChange={() => {}} />,
    )
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: pending })
    flushFrames()
    // The catalog's answer, where one was asked for.
    await act(async () => {})
    return { listPreApprovableActions, setAutoApprovedActionKind }
  }

  const alwaysApproveButtons = () =>
    [...document.querySelectorAll('button')].filter(b => b.textContent === 'Always approve')

  it('offers a rule for a request whose kind the kernel applies, and for no other', async () => {
    alwaysApprove.real = true
    const server = await renderRestricted([
      request(1, 'Close report 12', STATUS),
      request(2, 'Tell the reporter it is fixed', REPLY),
    ])

    expect(server.listPreApprovableActions).toHaveBeenCalledTimes(1)
    expect(alwaysApproveButtons()).toHaveLength(1)

    await act(async () => alwaysApproveButtons()[0].click())
    // The rule is for every action of the kind, so the kind is what the approver is asked about.
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain(`Always approve “${STATUS.label}”?`)
    expect(dialog.textContent).not.toContain('Close report 12')

    await act(async () =>
      [...dialog.querySelectorAll('button')].find(b => b.textContent === 'Always approve')!.click())
    expect(server.setAutoApprovedActionKind).toHaveBeenCalledExactlyOnceWith(7, STATUS)
  })

  it('offers no rule that is already stored, to a request waiting behind an older one', async () => {
    // The drain stops at the reply, which waits for a person, so the status behind it is still
    // pending with its rule on. Offering that rule again would replace who enabled it.
    const stored = vi.fn<Overseer['listAutoApprovedActionKinds']>(async () =>
      [{ gatekeeperId: 7, actionKind: STATUS }])
    await renderRestricted([
      request(1, 'Tell the reporter it is fixed', REPLY),
      request(2, 'Close report 12', STATUS),
    ], 'review', { listAutoApprovedActionKinds: stored })

    expect(stored).toHaveBeenCalledTimes(1)
    expect(alwaysApproveButtons()).toHaveLength(0)
  })

  it('reads the stored rules again when one changes on another surface', async () => {
    const server = makeOverseer()
    const stored = vi.fn<Overseer['listAutoApprovedActionKinds']>(async () =>
      [{ gatekeeperId: 7, actionKind: STATUS }])
    Object.assign(server.overseer, { listAutoApprovedActionKinds: stored })
    const render = (reloadTrigger: number) => view.render(
      <Activity overseer={server.overseer} restricted={false} view="review" onViewChange={() => {}}
        autoApproval={{ reloadTrigger, changed: () => {} }} />,
    )
    await render(0)
    await server.resolveSubscription()
    // A request no rule can apply holds the one behind it, whose rule is on.
    await server.resolvePendingQuery({ entries: [
      entry(1, { gatekeeperId: 7, description: {
        title: 'Ask for a write', description: '', implementsRevert: false, autoApprovable: false,
      } }),
      request(2, 'Close report 12', STATUS),
    ] })
    flushFrames()
    await act(async () => {})
    expect(alwaysApproveButtons()).toHaveLength(0)

    // The rule is turned off in the Auto-approval tab, whose end of the channel says so.
    stored.mockResolvedValue([])
    await render(1)
    await act(async () => {})

    expect(stored).toHaveBeenCalledTimes(2)
    expect(alwaysApproveButtons()).toHaveLength(1)
  })

  it('offers no rule until the stored rules are read', async () => {
    const list = deferred<Awaited<ReturnType<Overseer['listAutoApprovedActionKinds']>>>()
    await renderRestricted([request(1, 'Close report 12', STATUS)], 'review',
      { listAutoApprovedActionKinds: () => list.promise })
    expect(alwaysApproveButtons()).toHaveLength(0)

    await list.resolve([])
    expect(alwaysApproveButtons()).toHaveLength(1)
  })

  it('takes back a confirmation whose rule another surface turned on meanwhile', async () => {
    const server = makeOverseer()
    const stored = vi.fn<Overseer['listAutoApprovedActionKinds']>(async () => [])
    const setAutoApprovedActionKind = vi.fn<Overseer['setAutoApprovedActionKind']>(async () => {})
    Object.assign(server.overseer, { listAutoApprovedActionKinds: stored, setAutoApprovedActionKind })
    const render = (reloadTrigger: number) => view.render(
      <Activity overseer={server.overseer} restricted={false} view="review" onViewChange={() => {}}
        autoApproval={{ reloadTrigger, changed: () => {} }} />,
    )
    await render(0)
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [request(1, 'Close report 12', STATUS)] })
    flushFrames()
    await act(async () => {})
    await act(async () => alwaysApproveButtons()[0].click())
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()

    // Confirming now would store the rule again, under this admin's name.
    stored.mockResolvedValue([{ gatekeeperId: 7, actionKind: STATUS }])
    await render(1)
    await act(async () => {})

    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(alwaysApproveButtons()).toHaveLength(0)
    expect(setAutoApprovedActionKind).not.toHaveBeenCalled()
  })

  it('does not read the catalog for requests no rule could apply under the latch', async () => {
    // The catalog starts every gatekeeper it lists: another vendor's restricted workspace must
    // not pay for that to be told no.
    const server = await renderRestricted([
      request(1, 'Append a slide', { tag: 'append', label: 'Append a slide' }, 1),
      request(2, 'Tell the reporter it is fixed', REPLY),
    ])

    expect(server.listPreApprovableActions).not.toHaveBeenCalled()
    expect(alwaysApproveButtons()).toHaveLength(0)
  })

  it('does not read the catalog while Needs review is not the view on show', async () => {
    const server = await renderRestricted([request(1, 'Close report 12', STATUS)], 'history')

    expect(server.listPreApprovableActions).not.toHaveBeenCalled()
  })

  it('asks the kernel again once a request is decided by hand', async () => {
    // A request still waiting with its rule on may be one the kernel stopped applying before
    // this client was told.
    const server = makeOverseer()
    const listPreApprovableActions = vi.fn<() => Promise<PreApprovableAction[]>>(async () => [{
      gatekeeperId: 7, resourceTitle: 'This deployment', vendorId: 'admin',
      actionKind: STATUS, alreadyEnabled: false, ruleApplies: true,
    }])
    Object.assign(server.overseer, { listPreApprovableActions })
    const changed = vi.fn<() => void>()
    const render = (reloadTrigger: number) => view.render(
      <Activity overseer={server.overseer} restricted view="review" onViewChange={() => {}}
        autoApproval={{ reloadTrigger, changed }} />,
    )
    await render(0)
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [
      request(1, 'Close report 12', STATUS), request(2, 'Close report 13', STATUS),
    ] })
    flushFrames()
    await act(async () => {})
    expect(alwaysApproveButtons()).toHaveLength(2)

    listPreApprovableActions.mockResolvedValue([])
    await act(async () =>
      [...document.querySelectorAll('button')].find(b => b.textContent === 'Approve')!.click())
    await server.settleDecision()
    expect(changed).toHaveBeenCalledTimes(1)

    // The channel's owner bumps the trigger, as it does for a rule that was changed.
    await render(1)
    await act(async () => {})

    expect(listPreApprovableActions).toHaveBeenCalledTimes(2)
    expect(alwaysApproveButtons()).toHaveLength(0)
  })

  const confirmation = () => document.querySelector('[role="dialog"]')

  it('closes an open confirmation once the kernel stops applying its kind', async () => {
    // Confirming could only store a rule that does nothing.
    const server = makeOverseer()
    const listPreApprovableActions = vi.fn<() => Promise<PreApprovableAction[]>>(async () => [{
      gatekeeperId: 7, resourceTitle: 'This deployment', vendorId: 'admin',
      actionKind: STATUS, alreadyEnabled: false, ruleApplies: true,
    }])
    Object.assign(server.overseer, { listPreApprovableActions })
    const render = (reloadTrigger: number) => view.render(
      <Activity overseer={server.overseer} restricted view="review" onViewChange={() => {}}
        autoApproval={{ reloadTrigger, changed: () => {} }} />,
    )
    await render(0)
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [request(1, 'Close report 12', STATUS)] })
    flushFrames()
    await act(async () => {})
    await act(async () => alwaysApproveButtons()[0].click())
    expect(confirmation()).not.toBeNull()

    // Another connection's restricted data was read meanwhile, and the answer is read again.
    listPreApprovableActions.mockResolvedValue([])
    await render(1)
    await act(async () => {})

    expect(listPreApprovableActions).toHaveBeenCalledTimes(2)
    expect(confirmation()).toBeNull()
  })

  it('stops offering a rule, and closes its confirmation, once the kernel says none applies',
      async () => {
    // Another connection's restricted data was read: the workspace's metadata says so, and
    // nobody has to decide a request or reload to be told it needs review.
    const server = makeOverseer()
    const listPreApprovableActions = vi.fn<() => Promise<PreApprovableAction[]>>(async () => [{
      gatekeeperId: 7, resourceTitle: 'This deployment', vendorId: 'admin',
      actionKind: STATUS, alreadyEnabled: false, ruleApplies: true,
    }])
    Object.assign(server.overseer, { listPreApprovableActions })
    const render = (rulesApply: boolean) => view.render(
      <Activity overseer={server.overseer} restricted rulesApplyWhileRestricted={rulesApply}
        view="review" onViewChange={() => {}} />,
    )
    await render(true)
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [request(1, 'Close report 12', STATUS)] })
    flushFrames()
    await act(async () => {})
    await act(async () => alwaysApproveButtons()[0].click())
    expect(confirmation()).not.toBeNull()

    await render(false)
    await act(async () => {})

    expect(confirmation()).toBeNull()
    expect(alwaysApproveButtons()).toHaveLength(0)
    expect(listPreApprovableActions).toHaveBeenCalledTimes(1)
  })

  it('closes a confirmation the latch overtook, without reading the catalog for it', async () => {
    const server = makeOverseer()
    const listPreApprovableActions = vi.fn<() => Promise<PreApprovableAction[]>>(async () => [])
    Object.assign(server.overseer, { listPreApprovableActions })
    const render = (restricted: boolean) => view.render(
      <Activity overseer={server.overseer} restricted={restricted} view="review"
        onViewChange={() => {}} />,
    )
    await render(false)
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [request(1, 'Tell the reporter it is fixed', REPLY)] })
    flushFrames()
    await act(async () => {})
    // Unrestricted, a rule applies every kind: a reply included.
    await act(async () => alwaysApproveButtons()[0].click())
    expect(confirmation()).not.toBeNull()

    await render(true)
    await act(async () => {})

    expect(confirmation()).toBeNull()
    expect(alwaysApproveButtons()).toHaveLength(0)
    expect(listPreApprovableActions).not.toHaveBeenCalled()
  })
})

describe('Activity rule offers in a workspace that holds no restricted data', () => {
  const request = (id: number, title: string, actionKind: { tag: string, label: string }) =>
    entry(id, {
      gatekeeperId: 7,
      description: {
        title, description: '', implementsRevert: false, autoApprovable: true, actionKind,
      },
    })

  // The confirmation "Always approve" opens on the one pending request of `actionKind`.
  async function confirmationFor(actionKind: { tag: string, label: string }) {
    const server = makeOverseer()
    await view.render(
      <Activity overseer={server.overseer} restricted={false} view="review" onViewChange={() => {}} />,
    )
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [request(1, 'A request', actionKind)] })
    flushFrames()
    await act(async () => {})
    await act(async () =>
      [...document.querySelectorAll('button')].find(b => b.textContent === 'Always approve')!.click())
    return document.querySelector('[role="dialog"]')!.textContent ?? ''
  }

  it.each(['issueReportNote', 'issueReportStatus', 'issueReportAssignment'] as const)(
      'says a rule for %s keeps applying once the workspace has read sensitive data', async kind => {
    expect(await confirmationFor(ADMIN_AGENT_ACTIONS[kind].kind)).toContain(KEEPS_APPLYING_COPY)
  })

  it('says it of no kind whose rule stops applying there', async () => {
    expect(await confirmationFor(ADMIN_AGENT_ACTIONS.issueReportScopedReply.kind))
      .not.toContain('keeps applying')
    view.cleanup()
    expect(await confirmationFor({ tag: 'append', label: 'Append a slide' }))
      .not.toContain('keeps applying')
    })
  })

describe('Activity push approval', () => {
  // Renders the review view with one pending push.
  async function renderPush(restricted: boolean) {
    const server = makeOverseer()
    await view.render(
      <Activity overseer={server.overseer} restricted={restricted} view="review" onViewChange={() => {}} />,
    )
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [pushEntry(1)] })
    flushFrames()
    return server
  }
  const DECISIONS = ['Always approve', 'Deny', 'Review commits', 'Approve']
  const decisionLabels = (within: ParentNode) => [...within.querySelectorAll('button')]
    .map(button => button.textContent ?? '').filter(label => DECISIONS.includes(label))
  const press = async (label: string, within: ParentNode) => {
    await act(async () =>
      [...within.querySelectorAll('button')].find(button => button.textContent === label)!.click())
    await settlePushReview()
  }
  const row = () => document.querySelector('article')!

  it('offers Review commits in place of Approve for a push in a restricted workspace', async () => {
    const server = await renderPush(true)
    expect(decisionLabels(row())).toEqual(['Deny', 'Review commits'])
    expect(row().textContent).toContain(RESTRICTED_APPROVAL_COPY)

    await press('Review commits', row())
    expect(server.decisionCalls).toEqual([])
    expect(decisionLabels(pushReviewDialog()!)).toEqual(['Deny', 'Approve'])

    await press('Approve', pushReviewDialog()!)
    expect(server.decisionCalls).toEqual(['approve:1'])
    expect(pushReviewDialog()).toBeNull()
  })

  it('offers both for a push in an unrestricted workspace, where the review decides nothing', async () => {
    const server = await renderPush(false)
    expect(decisionLabels(row())).toEqual(['Deny', 'Review commits', 'Approve'])

    await press('Review commits', row())
    expect(decisionLabels(pushReviewDialog()!)).toEqual([])
    expect(server.decisionCalls).toEqual([])

    await press('Approve', row())
    expect(server.decisionCalls).toEqual(['approve:1'])
  })

  it('points a push at the review of its commits instead of calling its description incomplete', async () => {
    await renderPush(false)
    expect(row().textContent).toContain(PUSH_DESCRIPTION_COPY)
    expect(row().textContent).not.toContain(INCOMPLETE_DESCRIPTION_COPY)
  })
})

describe('Activity creation approval', () => {
  it('creates the resource in the account the approver chooses, among their accounts for its vendor',
      async () => {
    auth.authenticatedApi = {
      listGatekeeperVendors: async () =>
        [{ id: 'test', description: { displayName: 'Test' }, supportedResources: [{
          id: 'thing', urlPattern: 'https://test.example/*', creatable: true,
        }] }],
      subscribeConnectedAccounts: (subscriber: ConnectedAccountsSubscriber) => {
        const accounts = [[1, 'test', 'work'], [2, 'test', 'home'], [3, 'other', 'elsewhere']] as const
        for (const [id, vendorId, uniqueName] of accounts) {
          subscriber.add(id, { uniqueName } as AccountDescription, {} as VendorDescription, [], true,
              vendorId)
        }
        subscriber.ready()
        return Object.assign(Promise.resolve({}), { [Symbol.dispose]: () => {} })
      },
    }
    const server = makeOverseer()
    const approveAction = vi.fn<Overseer['approveAction']>(async () => {})
    Object.assign(server.overseer, {
      approveAction,
      getGatekeeperById: async () => ({
        getCreationSpec: async () =>
          ({ type: 'gatekeeper', vendorId: 'test', typeUrlPattern: 'https://test.example/*' }),
        [Symbol.dispose]: () => {},
      }),
    })
    await view.render(
      <Activity overseer={server.overseer} restricted={false} view="review" onViewChange={() => {}} />,
    )
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [entry(1, { gatekeeperId: 7, creation: true })] })
    flushFrames()

    await act(async () =>
      [...document.querySelectorAll('button')].find(b => b.textContent === 'Approve')!.click())
    const dialog = document.querySelector('[role="dialog"]')!
    expect(dialog.textContent).toContain('work')
    expect(dialog.textContent).not.toContain('elsewhere')
    await act(async () =>
      [...dialog.querySelectorAll('button')].find(b => b.textContent?.startsWith('home'))!.click())
    await act(async () =>
      [...dialog.querySelectorAll('button')].find(b => b.textContent === 'Approve')!.click())

    expect(approveAction).toHaveBeenCalledWith(1, { accountId: 2 })
  })

  it("tells the approver why an approval failed, since the gatekeeper's message says what to do",
      async () => {
    const message = 'The previous Gmail send outcome is still unknown. Deny this request to clear it.'
    const server = makeOverseer()
    Object.assign(server.overseer, {
      approveAction: vi.fn<Overseer['approveAction']>(async () => { throw new Error(message) }),
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await view.render(
      <Activity overseer={server.overseer} restricted={false} view="review" onViewChange={() => {}} />)
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [entry(1)] })
    flushFrames()

    await act(async () =>
      [...document.querySelectorAll('button')].find(b => b.textContent === 'Approve')!.click())

    expect(addToast).toHaveBeenCalledWith(
      { title: 'Failed to approve action', description: message, variant: 'error' })
  })
})

describe('Activity hook toggles', () => {
  const TITLE = 'Watch acme/widgets on GitHub'
  const refusal = "GitHub refused to add a webhook to acme/widgets: only the repository's admins can."
  const bound = (enabled: boolean) => entry(1, {
    type: 'bindHook', state: 'approved', hookId: 7, enabled,
    description: { title: TITLE, description: 'Call this hook with each issue event.' },
  })

  beforeEach(() => {
    addToast.mockClear()
    // Each failure is logged as well as shown.
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  /** The history log with the hook's record expanded, whose enable/disable calls the test answers. */
  async function renderHookRecord(enabled = false) {
    const server = makeOverseer()
    const enableHook = vi.fn<(id: number) => Promise<void>>(async () => {})
    const disableHook = vi.fn<(id: number) => Promise<void>>(async () => {})
    Object.assign(server.overseer as object, { enableHook, disableHook })
    await view.render(
      <Activity overseer={server.overseer} restricted={false} view="history" onViewChange={() => {}} />,
    )
    await server.resolveSubscription()
    await server.resolvePage({ entries: [bound(enabled)] })
    flushFrames()
    const row = [...document.querySelectorAll('button[aria-expanded]')]
      .find(button => button.textContent?.includes(TITLE))
    if (!(row instanceof HTMLElement)) throw new Error('No hook row rendered')
    await act(async () => row.click())
    return { server, enableHook, disableHook }
  }

  const isOn = () => hookSwitch(TITLE).getAttribute('aria-checked') === 'true'

  it('turns a hook on and off, showing each change once the log records it', async () => {
    const { server, enableHook, disableHook } = await renderHookRecord()
    expect(hookSwitch(TITLE).getAttribute('role')).toBe('switch')

    await clickHookSwitch(TITLE)
    expect(enableHook).toHaveBeenCalledExactlyOnceWith(7)
    // The switch shows the record, which the server's update of it changes.
    expect(isOn()).toBe(false)
    await server.emit(bound(true))
    expect(isOn()).toBe(true)

    await clickHookSwitch(TITLE)
    expect(disableHook).toHaveBeenCalledExactlyOnceWith(7)
    await server.emit(bound(false))
    expect(isOn()).toBe(false)
    expect(addToast).not.toHaveBeenCalled()
  })

  it.each([
    ['enabled', false, 'enableHook', new Error(refusal), refusal],
    ['enabled', false, 'enableHook', new Error('Peer closed WebSocket: 1006 '), undefined],
    ['disabled', true, 'disableHook', new Error(refusal), refusal],
    ['disabled', true, 'disableHook', new Error('Peer closed WebSocket: 1006 '), undefined],
  ] as const)(
    'says why a hook could not be %s, though not a dropped connection’s transport message, and leaves it as it was',
    async (done, enabled, method, failure, description) => {
      const calls = await renderHookRecord(enabled)
      calls[method].mockRejectedValueOnce(failure)

      await clickHookSwitch(TITLE)

      expect(addToast).toHaveBeenCalledExactlyOnceWith({
        title: `Failed to ${done === 'enabled' ? 'enable' : 'disable'} hook`, description, variant: 'error',
      })
      expect(isOn()).toBe(enabled)
    })

  it('holds the switch busy while a change is in flight, and lets a failed one be retried', async () => {
    const { server, enableHook, disableHook } = await renderHookRecord()
    const first = deferred()
    enableHook.mockReturnValueOnce(first.promise)

    await clickHookSwitch(TITLE)
    expect(hookSwitch(TITLE).getAttribute('aria-disabled')).toBe('true')
    expect(hookSwitch(TITLE).getAttribute('aria-busy')).toBe('true')
    await clickHookSwitch(TITLE)
    expect(enableHook).toHaveBeenCalledOnce()
    expect(disableHook).not.toHaveBeenCalled()

    await first.reject(new Error(refusal))
    expect(isOn()).toBe(false)
    expect(hookSwitch(TITLE).hasAttribute('aria-disabled')).toBe(false)
    expect(hookSwitch(TITLE).hasAttribute('aria-busy')).toBe(false)

    await clickHookSwitch(TITLE)
    expect(enableHook).toHaveBeenCalledTimes(2)
    await server.emit(bound(true))
    expect(isOn()).toBe(true)
  })
})
