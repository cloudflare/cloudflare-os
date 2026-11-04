// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useState, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActionLogEntry } from '@gadgets/workshop-shared/api'

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@cloudflare/kumo')
  // Render the confirm dialog inline, so its controls are in the DOM to click.
  const Pass = ({ children }: { children?: React.ReactNode }) => children ?? null
  const parts = new Proxy(Pass, { get: () => Pass })
  const toasts = { add: vi.fn<(options: unknown) => void>() }
  return { ...actual, Dialog: parts, useKumoToastManager: () => toasts }
})

import { entry, flushFrames, makeOverseer, makeTestRoot } from '../../action-test-harness'
import { INCOMPLETE_DESCRIPTION_COPY } from '../../components/IncompleteDescriptionNotice'
import { RESTRICTED_APPROVAL_COPY } from '../../components/RestrictedApprovalNotice'
import { ApprovalDock } from './ApprovalDock'

const view = makeTestRoot()

afterEach(() => {
  view.cleanup()
  vi.restoreAllMocks()
})

const longDescription = [
  'Send the following email to alice@example.com:',
  'Hi Alice, attached are the quarterly numbers you asked for.',
  'Regards, the workspace.',
].join('\n\n')

const email = (id: number, over: Partial<Record<string, unknown>> = {}) => entry(id, {
  description: {
    title: `Send email ${id}`, description: longDescription, implementsRevert: false, ...over,
  },
})

// Holds the paged-to request, as the Workshop does.
function Dock(props: Omit<ComponentProps<typeof ApprovalDock>, 'selectedActionId' | 'onSelect'>) {
  const [selectedActionId, setSelectedActionId] = useState<number | null>(null)
  return <ApprovalDock {...props} selectedActionId={selectedActionId} onSelect={setSelectedActionId} />
}

async function renderDock(entries: ActionLogEntry[], restricted = false) {
  const server = makeOverseer()
  const approveAction = vi.fn<(id: number, creation?: unknown) => Promise<void>>(async () => {})
  const rejectAction = vi.fn<(id: number) => Promise<void>>(async () => {})
  const setAutoApprovedActionKind = vi.fn<(gatekeeperId: number, kind: unknown) => Promise<void>>(
    async () => {})
  const onAutoApproveChange = vi.fn<() => void>()
  const onHide = vi.fn<() => void>()
  const onViewAll = vi.fn<() => void>()
  const onShowInChat = vi.fn<(action: ActionLogEntry) => void>()
  Object.assign(server.overseer as object, { approveAction, rejectAction, setAutoApprovedActionKind })
  await view.render(
    <Dock
      overseer={server.overseer}
      restricted={restricted}
      onAutoApproveChange={onAutoApproveChange}
      onHide={onHide}
      onViewAll={onViewAll}
      onShowInChat={onShowInChat}
    />,
  )
  await server.resolveSubscription()
  await server.resolvePendingQuery({ entries })
  flushFrames()
  return {
    server, approveAction, rejectAction, setAutoApprovedActionKind, onAutoApproveChange, onHide, onViewAll, onShowInChat,
  }
}

const button = (name: string) => {
  const found = [...document.querySelectorAll('button')]
    .find(b => b.textContent === name || b.getAttribute('aria-label') === name)
  if (!found) throw new Error(`No "${name}" button rendered`)
  return found
}

const alwaysApproveButtons = () =>
  [...document.querySelectorAll('button')].filter(b => b.textContent === 'Always approve')

const click = (name: string) => act(async () => button(name).click())

const shownTitle = () => document.querySelector('[aria-live="polite"] .font-medium')?.textContent

// The text a screen reader announces as the Approve button's description.
function approveDescribedBy(): string | null {
  const ids = button('Approve').getAttribute('aria-describedby')
  if (ids === null) return null
  return ids.split(' ').map(id => {
    const el = document.getElementById(id)
    if (!el) throw new Error(`aria-describedby names a missing element: ${id}`)
    return el.textContent ?? ''
  }).join('\n')
}

describe('ApprovalDock', () => {
  it('renders nothing while no request is pending', async () => {
    await renderDock([])
    expect(document.querySelector('section')).toBeNull()
  })

  it('pages through the pending requests', async () => {
    await renderDock([email(1), email(2)])
    expect(document.body.textContent).toContain('1 of 2')
    expect(shownTitle()).toBe('Send email 1')
    expect(button('Previous request').disabled).toBe(true)

    await click('Next request')
    expect(document.body.textContent).toContain('2 of 2')
    expect(shownTitle()).toBe('Send email 2')
    expect(button('Next request').disabled).toBe(true)
  })

  it('hides itself, and opens the full list, from its footer', async () => {
    const { onHide, onViewAll } = await renderDock([email(1)])
    await click('Hide approvals')
    expect(onHide).toHaveBeenCalledOnce()
    await click('View all')
    expect(onViewAll).toHaveBeenCalledOnce()
  })

  it('shows the request in its chat, when it names one', async () => {
    const { onShowInChat } = await renderDock([email(1), entry(2, { chatId: 3 })])
    expect(document.querySelector('button[title="Show in chat"]')).toBeNull()

    await click('Next request')
    onShowInChat.mockClear()
    await act(async () => document.querySelector<HTMLButtonElement>('button[title="Show in chat"]')!.click())
    expect(onShowInChat).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 2, chatId: 3 }))
  })

  it('shows each request it pages to in its chat, and none that names no chat', async () => {
    const { onShowInChat } = await renderDock([entry(1, { chatId: 3 }), email(2), entry(3, { chatId: 5 })])
    await click('Next request')
    expect(onShowInChat).not.toHaveBeenCalled()
    await click('Next request')
    expect(onShowInChat).toHaveBeenLastCalledWith(expect.objectContaining({ id: 3, chatId: 5 }))
    await click('Previous request')
    await click('Previous request')
    expect(onShowInChat).toHaveBeenLastCalledWith(expect.objectContaining({ id: 1, chatId: 3 }))
    expect(onShowInChat).toHaveBeenCalledTimes(2)
  })

  it('approves and denies the request it shows', async () => {
    const { approveAction, rejectAction } = await renderDock([email(1), email(2)])
    await click('Next request')
    await click('Approve')
    expect(approveAction).toHaveBeenCalledWith(2, undefined)
    await click('Deny')
    expect(rejectAction).toHaveBeenCalledWith(2)
  })

  it('shows the request after the shown one once that is resolved', async () => {
    const { server } = await renderDock([email(1), email(2), email(3)])
    await click('Next request')
    expect(shownTitle()).toBe('Send email 2')

    await server.emit({ ...email(2), state: 'approved' })
    flushFrames()
    expect(document.body.textContent).toContain('2 of 2')
    expect(shownTitle()).toBe('Send email 3')
  })

  it('falls back to the last request once the last one shown is resolved', async () => {
    const { server } = await renderDock([email(1), email(2), email(3)])
    await click('Next request')
    await click('Next request')
    await server.emit({ ...email(3), state: 'rejected' })
    flushFrames()
    expect(document.body.textContent).toContain('2 of 2')
    expect(shownTitle()).toBe('Send email 2')
  })

  it('keeps the request text behind the disclosure when not restricted', async () => {
    await renderDock([email(1)])
    expect(document.body.textContent).not.toContain('Regards, the workspace.')
    expect(approveDescribedBy()).toBeNull()

    await click('Approval needed')
    expect(document.body.textContent).toContain('Regards, the workspace.')
    expect(document.body.textContent).toContain(INCOMPLETE_DESCRIPTION_COPY)
    expect(document.body.textContent).not.toContain(RESTRICTED_APPROVAL_COPY)
  })

  it('shows the notice and the full request, named by the controls, while restricted', async () => {
    const fields = [{ label: 'To', kind: 'list', items: ['a@example.com'] }]
    await renderDock([email(1, { fields })], true)
    expect(document.body.textContent).toContain(RESTRICTED_APPROVAL_COPY)
    expect(document.body.textContent).toContain('Regards, the workspace.')
    // No disclosure to close: the approver has to read all of it.
    expect([...document.querySelectorAll('button')].some(b => b.textContent === 'Approval needed'))
      .toBe(false)

    const described = approveDescribedBy()
    expect(described).toContain(RESTRICTED_APPROVAL_COPY)
    expect(described).toContain('Regards, the workspace.')
    expect(described).toContain('a@example.com')
    expect(described).toContain(INCOMPLETE_DESCRIPTION_COPY)
  })

  it('names no incomplete notice for a complete description while restricted', async () => {
    await renderDock([email(1, { descriptionIsComplete: true })], true)
    expect(approveDescribedBy()).not.toContain(INCOMPLETE_DESCRIPTION_COPY)
  })

  it('offers to always approve an auto-approvable action, once confirmed', async () => {
    const actionKind = { tag: 'createIssue', label: 'Create issue' }
    const { setAutoApprovedActionKind, onAutoApproveChange } = await renderDock([
      email(1, { actionKind, autoApprovable: true }),
    ].map(e => ({ ...e, gatekeeperId: 7 })))

    expect(alwaysApproveButtons()).toHaveLength(1)
    await click('Always approve')
    expect(setAutoApprovedActionKind).not.toHaveBeenCalled()
    // The dialog's own confirm button follows the dock's in DOM order.
    await act(async () => alwaysApproveButtons().at(-1)!.click())
    expect(setAutoApprovedActionKind).toHaveBeenCalledWith(7, actionKind)
    expect(onAutoApproveChange).toHaveBeenCalled()
    // The rule now covers the request, so the dock stops offering it.
    expect(alwaysApproveButtons()).toHaveLength(0)
  })

  it('offers no always-approve for an action its gatekeeper did not mark auto-approvable', async () => {
    await renderDock([{ ...email(1, { actionKind: { tag: 'createIssue', label: 'Create issue' } }), gatekeeperId: 7 }])
    expect(alwaysApproveButtons()).toHaveLength(0)
  })

  it('offers no always-approve while restricted', async () => {
    const actionKind = { tag: 'createIssue', label: 'Create issue' }
    await renderDock([{ ...email(1, { actionKind, autoApprovable: true }), gatekeeperId: 7 }], true)
    expect(alwaysApproveButtons()).toHaveLength(0)
  })
})
