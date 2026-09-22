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

const view = makeTestRoot()

afterEach(() => {
  view.cleanup()
  vi.restoreAllMocks()
})

// Renders the popover with one pending request.
async function renderRequest(descriptionIsComplete?: true) {
  const server = makeOverseer()
  await view.render(
    <ActivityNotifications overseer={server.overseer} onViewActivity={() => {}} />,
  )
  await server.resolveSubscription()
  await server.resolvePendingQuery({
    entries: [entry(1, {
      description: {
        title: 'Send email', description: 'Send an email.', implementsRevert: false,
        descriptionIsComplete,
      },
    })],
  })
  flushFrames()
  expect(document.body.textContent).toContain('Send an email.')
}

describe('ActivityNotifications incomplete description notice', () => {
  it('flags a request whose description is not marked complete', async () => {
    await renderRequest()
    expect(document.body.textContent).toContain(INCOMPLETE_DESCRIPTION_COPY)
  })

  it('shows no notice when the description is complete', async () => {
    await renderRequest(true)
    expect(document.body.textContent).not.toContain(INCOMPLETE_DESCRIPTION_COPY)
  })
})
