// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@cloudflare/kumo')
  // Render the popover inline (open or not) so its content is in the DOM to assert on.
  const Pass = ({ children }: { children?: React.ReactNode }) => children ?? null
  const parts = new Proxy(Pass, { get: () => Pass })
  const toasts = { add: vi.fn<(options: unknown) => void>() }
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
        descriptionIsComplete, fields,
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
