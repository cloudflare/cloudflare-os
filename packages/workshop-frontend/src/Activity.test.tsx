// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@cloudflare/kumo', async (importOriginal) => {
  const actual = await importOriginal() as typeof import('@cloudflare/kumo')
  const toasts = { add: vi.fn<(options: unknown) => void>() }
  return { ...actual, useKumoToastManager: () => toasts }
})
vi.mock('./useAlwaysApproveTag', () => ({
  useAlwaysApproveTag: () => ({ alwaysApproveTag: vi.fn<() => Promise<void>>(), isTagAutoApproved: () => false }),
}))

import { entry, flushFrames, makeOverseer, makeTestRoot } from './action-test-harness'
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
        descriptionIsComplete: true, fields,
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
