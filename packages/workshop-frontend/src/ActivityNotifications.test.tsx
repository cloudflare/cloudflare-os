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
async function renderPending(restricted?: boolean): Promise<HTMLElement> {
  const server = makeOverseer()
  await view.render(
    <ActivityNotifications overseer={server.overseer} onViewActivity={() => {}} restricted={restricted} />,
  )
  await server.resolveSubscription()
  await server.resolvePendingQuery({
    entries: [entry(1, {
      description: { title: 'Send email', description: longDescription, implementsRevert: false },
    })],
  })
  flushFrames()
  const description = [...document.querySelectorAll('span')]
      .find(span => span.textContent === longDescription)
  if (!description) throw new Error('The pending request description was not rendered')
  return description
}

describe('ActivityNotifications', () => {
  it('shows the review notice and the untruncated request while restricted', async () => {
    const description = await renderPending(true)
    expect(document.body.textContent).toContain(RESTRICTED_APPROVAL_COPY)
    expect(description.classList.contains('line-clamp-2')).toBe(false)
  })

  it('clamps the request and shows no notice when not restricted', async () => {
    const description = await renderPending()
    expect(document.body.textContent).not.toContain(RESTRICTED_APPROVAL_COPY)
    expect(description.classList.contains('line-clamp-2')).toBe(true)
  })
})
