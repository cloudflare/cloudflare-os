// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Overseer } from '@gadgets/workshop-shared/api'

const addToast = vi.hoisted(() => vi.fn<(options: unknown) => void>())

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@cloudflare/kumo')
  // Render the popover inline (open or not) so its content is in the DOM to assert on.
  const Pass = ({ children }: { children?: React.ReactNode }) => children ?? null
  const parts = new Proxy(Pass, { get: () => Pass })
  const toasts = { add: addToast }
  return { ...actual, Popover: parts, useKumoToastManager: () => toasts }
})

import { entry, flushFrames, makeOverseer, makeTestRoot } from './action-test-harness'
import ActivityNotifications from './ActivityNotifications'
import { INCOMPLETE_DESCRIPTION_COPY } from './components/IncompleteDescriptionNotice'
import { RESTRICTED_APPROVAL_COPY } from './components/RestrictedApprovalNotice'

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

// Renders the popover with one pending request and returns the span carrying its description.
async function renderPending(
  restricted?: boolean, descriptionIsComplete?: true, fields?: unknown[],
): Promise<HTMLElement> {
  const server = makeOverseer()
  await view.render(
    <ActivityNotifications overseer={server.overseer} onViewActivity={() => {}} restricted={restricted} />,
  )
  await server.resolveSubscription()
  await server.resolvePendingQuery({
    entries: [entry(1, {
      description: {
        title: 'Send email', description: longDescription, implementsRevert: false,
        autoApprovable: false, descriptionIsComplete, fields,
      },
    })],
  })
  flushFrames()
  const description = [...document.querySelectorAll('span')]
      .find(span => span.textContent === longDescription)
  if (!description) throw new Error('The pending request description was not rendered')
  return description
}

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

describe('ActivityNotifications', () => {
  it('shows the review notice and the untruncated request while restricted', async () => {
    const description = await renderPending(true)
    expect(document.body.textContent).toContain(RESTRICTED_APPROVAL_COPY)
    expect(description.classList.contains('line-clamp-2')).toBe(false)
    // The controls precede the review text in DOM order, so the buttons name it explicitly.
    const described = approveDescribedBy()
    expect(described).toContain(RESTRICTED_APPROVAL_COPY)
    expect(described).toContain('Regards, the workspace.')
    expect(described).toContain(INCOMPLETE_DESCRIPTION_COPY)
  })

  it('names only the restricted notice and request for a complete description', async () => {
    await renderPending(true, true)
    expect(approveDescribedBy()).not.toContain(INCOMPLETE_DESCRIPTION_COPY)
  })

  it('clamps the request and shows no notice when not restricted', async () => {
    const description = await renderPending()
    expect(document.body.textContent).not.toContain(RESTRICTED_APPROVAL_COPY)
    expect(description.classList.contains('line-clamp-2')).toBe(true)
    expect(approveDescribedBy()).toBeNull()
  })

  it('flags a request whose description is not marked complete', async () => {
    await renderPending()
    expect(document.body.textContent).toContain(INCOMPLETE_DESCRIPTION_COPY)
  })

  it('shows no incomplete notice when the description is complete', async () => {
    await renderPending(false, true)
    expect(document.body.textContent).not.toContain(INCOMPLETE_DESCRIPTION_COPY)
  })
})

describe('ActivityNotifications action fields', () => {
  it('counts a request\'s fields beside its prose, leaving the values to a fuller view', async () => {
    await renderPending(false, true, [
      { label: 'To', kind: 'list', items: ['a@example.com'] },
      { label: 'Body', kind: 'text', value: 'Full body text' },
    ])
    expect(document.body.textContent).toContain('2 fields')
    expect(document.body.textContent).not.toContain('Full body text')
  })

  it('shows the fields in full, named by the approve button, while restricted', async () => {
    await renderPending(true, true, [
      { label: 'To', kind: 'list', items: ['a@example.com'] },
      { label: 'Body', kind: 'text', value: 'Full body text' },
    ])
    expect(document.body.textContent).toContain('a@example.com')
    expect(document.body.textContent).toContain('Full body text')
    expect(document.body.textContent).not.toContain('2 fields')
    const described = approveDescribedBy()
    expect(described).toContain('a@example.com')
    expect(described).toContain('Full body text')
    const body = [...document.querySelectorAll('pre')].find(pre => pre.textContent === 'Full body text')
    expect(body?.className).not.toContain('max-h-56')
  })

  it('shows no count for a request without fields', async () => {
    await renderPending(false, true)
    expect(document.body.textContent).not.toMatch(/\d+ fields?/)
  })
})

describe('ActivityNotifications approval', () => {
  // Which of the rendered requests (by title) offer Approve beside Deny.
  function approvableTitles(): string[] {
    return [...document.querySelectorAll('button')]
        .filter(button => button.textContent === 'Approve')
        .map(button => button.closest('.flex.items-start')?.querySelector('span')?.textContent ?? '')
  }

  async function renderRequests() {
    const server = makeOverseer()
    await view.render(<ActivityNotifications overseer={server.overseer} onViewActivity={() => {}} />)
    await server.resolveSubscription()
    const description = { description: '', implementsRevert: false, autoApprovable: true }
    await server.resolvePendingQuery({
      entries: [
        entry(1, { chatId: 4, description: { ...description, title: 'Chat write' } }),
        entry(2, { chatId: 4, description: { ...description, title: 'Awaited', awaitDecision: true } }),
        entry(3, { description: { ...description, title: 'Staged write' } }),
      ],
    })
    flushFrames()
  }

  it('offers Approve only where a request can apply without its chat being accepted', async () => {
    await renderRequests()
    expect(approvableTitles()).toEqual(['Awaited', 'Staged write'])
    expect([...document.querySelectorAll('button')]
        .filter(button => button.textContent === 'Deny')).toHaveLength(3)
  })

  it('says why a request failed, and offers no Approve once it cannot be retried', async () => {
    const server = makeOverseer()
    await view.render(<ActivityNotifications overseer={server.overseer} onViewActivity={() => {}} />)
    await server.resolveSubscription()
    const description = {
      title: 'Awaited', description: '', implementsRevert: false, autoApprovable: true,
      awaitDecision: true,
    }
    await server.resolvePendingQuery({
      entries: [entry(1, {
        chatId: 4, description,
        applyError: { message: 'Timed out.', retryable: false, outcomeUnknown: true },
      })],
    })
    flushFrames()
    expect(approvableTitles()).toEqual([])
    expect(document.querySelector('[role="alert"]')?.textContent).toBe(
      'Could not apply: Timed out. It may have been applied anyway. Check the resource before you deny it.')
  })

  it('offers no Approve for a change to an unsaved resource, only for saving it', async () => {
    const server = makeOverseer()
    await view.render(<ActivityNotifications overseer={server.overseer} onViewActivity={() => {}} />)
    await server.resolveSubscription()
    const description = { description: '', implementsRevert: false, autoApprovable: true }
    const by = { type: 'user' as const, id: 'ada', name: 'Ada' }
    const accepted = { by, at: new Date(0), autoApproved: false }
    await server.resolvePendingQuery({
      entries: [
        entry(1, {
          chatId: 4, gatekeeperId: 9, creation: true, accepted,
          description: { ...description, title: 'Create sheet' },
        }),
        entry(2, {
          chatId: 4, gatekeeperId: 9, accepted,
          description: { ...description, title: 'Accepted edit' },
        }),
        entry(3, { gatekeeperId: 9, description: { ...description, title: 'Gadget edit' } }),
      ],
    })
    flushFrames()
    expect(approvableTitles()).toEqual(['Create sheet'])
  })

  it("tells the approver why an approval failed, since the gatekeeper's message says what to do",
      async () => {
    const message = 'The previous Gmail send outcome is still unknown. Deny this request to clear it.'
    const server = makeOverseer()
    Object.assign(server.overseer, {
      approveAction: vi.fn<Overseer['approveAction']>(async () => { throw new Error(message) }),
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await view.render(<ActivityNotifications overseer={server.overseer} onViewActivity={() => {}} />)
    await server.resolveSubscription()
    await server.resolvePendingQuery({ entries: [entry(1)] })
    flushFrames()

    await act(async () =>
      [...document.querySelectorAll('button')].find(b => b.textContent === 'Approve')!.click())

    expect(addToast).toHaveBeenCalledWith(
      { title: 'Failed to approve action', description: message, variant: 'error' })
  })
})
