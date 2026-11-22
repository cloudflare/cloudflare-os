// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionLogEntry, Overseer } from '@gadgets/workshop-shared/api'

const addToast = vi.hoisted(() => vi.fn<(options: unknown) => void>())

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@cloudflare/kumo')
  const toasts = { add: addToast }
  return { ...actual, useKumoToastManager: () => toasts }
})
const auth = vi.hoisted(() => ({ authenticatedApi: {} as Record<string, unknown> }))
vi.mock('./AuthContext', () => ({ useAuthenticatedApi: () => auth }))

import {
  clickHookSwitch, deferred, entry, flushFrames, hookSwitch, makeOverseer, makeTestRoot,
} from './action-test-harness'
import Activity from './Activity'

const view = makeTestRoot()

afterEach(() => {
  view.cleanup()
  vi.restoreAllMocks()
})

const fields = [
  { label: 'To', kind: 'list', items: ['a@example.com'] },
  { label: 'Body', kind: 'text', value: 'Full body text' },
]

// Renders the review view with one complete pending request carrying `fields`, held by staging.
async function renderReview(restricted: boolean) {
  const server = makeOverseer()
  await view.render(
    <Activity overseer={server.overseer} restricted={restricted} view="review" onViewChange={() => {}}
      chats={[]} onOpenChat={() => {}} />,
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

// The text a screen reader announces as the Deny button's description.
function denyDescribedBy(): string | null {
  const deny = [...document.querySelectorAll('button')].find(b => b.textContent === 'Deny')
  if (!deny) throw new Error('No Deny button rendered')
  const ids = deny.getAttribute('aria-describedby')
  if (ids === null) return null
  return ids.split(' ').map(id => {
    const el = document.getElementById(id)
    if (!el) throw new Error(`aria-describedby names a missing element: ${id}`)
    return el.textContent ?? ''
  }).join('\n')
}

describe('Activity review request fields', () => {
  it('shows the fields in full, named by the deny button, while restricted', async () => {
    await renderReview(true)
    expect(document.body.textContent).toContain('Full body text')
    expect(document.body.textContent).not.toContain('2 fields')
    const described = denyDescribedBy()
    expect(described).toContain('a@example.com')
    expect(described).toContain('Full body text')
  })

  it('offers no disclosure while restricted, since everything it would reveal is shown', async () => {
    await renderReview(true)
    // (The held-changes bar's Discard opens a confirmation, which is no disclosure.)
    expect(document.querySelector('[aria-expanded]:not([aria-haspopup])')).toBeNull()
    expect(bodyBox()?.className).not.toContain('max-h-56')
  })

  it('collapses the fields to a count until expanded when not restricted', async () => {
    await renderReview(false)
    expect(document.body.textContent).toContain('2 fields')
    expect(document.body.textContent).not.toContain('Full body text')
    expect(document.querySelector('[aria-expanded="false"]')).not.toBeNull()
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
      <Activity overseer={server.overseer} restricted={false} view="history" onViewChange={() => {}}
        chats={[]} onOpenChat={() => {}} />,
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

describe('Activity review', () => {
  const chats = [
    { id: 4, title: 'Plan the trip', requests: 2, codeChanges: true, holding: true, awaitingDecision: false },
  ]

  async function renderBranchReview(entries: ActionLogEntry[], onOpenChat = vi.fn<(id: number) => void>()) {
    const server = makeOverseer()
    await view.render(
      <Activity overseer={server.overseer} view="review" onViewChange={() => {}}
        chats={chats} onOpenChat={onOpenChat} />,
    )
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries })
    flushFrames()
    return { server, onOpenChat }
  }

  const buttons = () => [...document.querySelectorAll('button')]
  const labelled = (label: string) => buttons().filter(b => b.textContent?.trim() === label)

  it("lists each chat with changes, which opens it, rather than the chat's requests", async () => {
    const { onOpenChat } = await renderBranchReview([entry(1, { chatId: 4 })])
    expect(document.body.textContent).toContain('1 with changes to review')
    expect(document.body.textContent).toContain('2 requests to apply · code changes · holding')
    // A chat's request is accepted with the chat, so it is neither listed nor decided here.
    expect(document.body.textContent).not.toContain('Action 1')
    expect(labelled('Approve')).toHaveLength(0)

    await act(async () => buttons().find(b => b.textContent?.includes('Plan the trip'))!.click())
    expect(onOpenChat).toHaveBeenCalledExactlyOnceWith(4)
  })

  it('shows what staging holds, with per-request Deny but no Approve, and its failure', async () => {
    const { server } = await renderBranchReview([
      entry(1, { applyError: { message: 'Quota exceeded.', retryable: true } }),
      entry(2),
      entry(3, { chatId: 4 }),
    ])
    expect(document.body.textContent).toContain('2 with changes to review')
    expect(document.body.textContent).toContain('Held changes · 2 requests to apply')
    expect(document.querySelector('[role="alert"]')?.textContent)
      .toBe('Could not apply: Quota exceeded. Accept the held changes to try again.')
    expect(labelled('Deny')).toHaveLength(2)
    expect(labelled('Approve')).toHaveLength(0)

    await act(async () => labelled('Deny')[1].click())
    expect(server.decisionCalls).toEqual(['reject:2'])
  })

  it('accepts what staging holds as a whole', async () => {
    const acceptStagedActions = vi.fn<Overseer['acceptStagedActions']>(async () => ({ outcome: 'applied' }))
    const server = makeOverseer()
    Object.assign(server.overseer, { acceptStagedActions })
    await view.render(
      <Activity overseer={server.overseer} view="review" onViewChange={() => {}}
        chats={[]} onOpenChat={() => {}} />,
    )
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [entry(1), entry(3), entry(5, { chatId: 4 })] })
    await act(async () => buttons().find(b => b.textContent?.includes('Accept changes'))!.click())
    // Bounded by the highest held request shown, so nothing that arrived since applies with it.
    expect(acceptStagedActions).toHaveBeenCalledExactlyOnceWith(3)
  })

  it('offers saving an unsaved resource whose chat was accepted, and Deny on what was accepted on it', async () => {
    const accepted = { by: { type: 'user', id: 'alice', name: 'Alice' }, at: new Date(0), autoApproved: false }
    const { server } = await renderBranchReview([
      entry(1, { gatekeeperId: 7, chatId: 4, creation: true, accepted }),
      entry(2, { gatekeeperId: 7, chatId: 4, accepted }),
      // Still the chat's, so neither saved nor listed here.
      entry(3, { gatekeeperId: 8, chatId: 4, creation: true }),
    ])
    expect(document.body.textContent).toContain('2 with changes to review')
    expect(document.body.textContent).toContain('Accepted by Alice · applies when the resource is saved')
    // Neither is up for review in the held changes.
    expect(document.body.textContent).not.toContain('Held changes')
    expect(document.body.textContent).not.toContain('Action 3')
    expect(labelled('Save to account')).toHaveLength(1)

    await act(async () => labelled('Deny')[1].click())
    expect(server.decisionCalls).toEqual(['reject:2'])
  })

  it("has nothing to review with no chat changes and nothing held, whatever a chat's requests", async () => {
    const server = makeOverseer()
    await view.render(
      <Activity overseer={server.overseer} view="review" onViewChange={() => {}}
        chats={[]} onOpenChat={() => {}} />,
    )
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [entry(1, { chatId: 4 })] })
    expect(document.body.textContent).toContain('Nothing to review')
  })
})
