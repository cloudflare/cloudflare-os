/* eslint-disable react/react-in-jsx-scope */

// The header's "Needs review" popover with a push's review open over it, in Chromium: which of
// the two a click and Escape reach, and where focus goes back to, none of which jsdom models.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { Toasty } from '@cloudflare/kumo'
import { makeOverseer, pushEntry, pushReviewDialog } from './action-test-harness'
import ActivityNotifications from './ActivityNotifications'
import './styles.css'

// The harness holds animation frames for jsdom suites to release by hand; this one has real ones.
vi.unstubAllGlobals()

let host: HTMLDivElement | undefined, root: Root | undefined
afterEach(async () => {
  await act(async () => root?.unmount())
  host?.remove()
})

/** Input as a user gives it, with the updates it causes applied before the next assertion. */
const input = (action: () => Promise<unknown>) => act(async () => { await action() })

const TRIGGER = 'Activity — 1 request needs review'

/** The popover's panel while it is in the document, which outlasts its closing by a transition. */
const popover = () => document.querySelector<HTMLElement>('.themed-floating-shadow')

/** Whether the popover is open, as its trigger says the moment that changes. */
const popoverOpen = () =>
  document.querySelector(`button[aria-label="${TRIGGER}"]`)!.getAttribute('aria-expanded') === 'true'

const button = (within: ParentNode, label: string) => {
  const found = [...within.querySelectorAll('button')].find(candidate => candidate.textContent?.trim() === label)
  if (!found) throw new Error(`No "${label}" button`)
  return found
}

/**
 * Renders the popover's trigger at the end of a header row, with one push pending in a
 * restricted workspace, and opens the push's review from the popover.
 */
async function openReview() {
  const server = makeOverseer()
  host = document.body.appendChild(document.createElement('div'))
  root = createRoot(host)
  await act(async () => root!.render(
    <Toasty>
      <div style={{ display: 'flex', justifyContent: 'flex-end', padding: 8 }}>
        <ActivityNotifications overseer={server.overseer} onViewActivity={() => {}} restricted />
      </div>
      <button type="button" style={{ position: 'fixed', left: 8, bottom: 8 }}>Elsewhere</button>
    </Toasty>,
  ))
  await server.resolveSubscription()
  await server.resolvePendingQuery({ entries: [pushEntry(1)] })

  await input(() => userEvent.click(page.getByRole('button', { name: TRIGGER })))
  const panel = await vi.waitFor(() => {
    const found = popover()
    if (!found) throw new Error('The popover did not open')
    return found
  })
  await input(() => userEvent.click(button(panel, 'Review commits')))
  const dialog = await vi.waitFor(() => {
    const found = pushReviewDialog()
    if (!found?.contains(document.activeElement)) throw new Error('The review did not take focus')
    return found
  })
  return { server, panel, dialog }
}

it('keeps the popover open under the review, and gives Escape to one of them at a time', async () => {
  const { panel, dialog } = await openReview()

  // A click in the review lands outside the popover, which stays open under it all the same.
  await input(() => userEvent.click(
    [...dialog.querySelectorAll('button')].find(row => row.textContent?.includes('Subject of push 1'))!))
  expect(dialog.isConnected).toBe(true)
  expect(popoverOpen()).toBe(true)

  await input(() => userEvent.keyboard('{Escape}'))
  await vi.waitFor(() => expect(dialog.isConnected).toBe(false))
  // Back to the request, on the button that opened the review.
  expect(popoverOpen()).toBe(true)
  await vi.waitFor(() => expect(document.activeElement).toBe(button(panel, 'Review commits')))

  // With the review gone the popover answers Escape itself.
  await input(() => userEvent.keyboard('{Escape}'))
  expect(popoverOpen()).toBe(false)
  await vi.waitFor(() => expect(popover()).toBeNull())
})

it('closes on a click elsewhere once the review has been decided', async () => {
  const { server, dialog } = await openReview()

  await vi.waitFor(() => expect(button(dialog, 'Approve').disabled).toBe(false))
  await input(() => userEvent.click(button(dialog, 'Approve')))
  expect(server.decisionCalls).toEqual(['approve:1'])
  await vi.waitFor(() => expect(dialog.isConnected).toBe(false))
  expect(popoverOpen()).toBe(true)

  await input(() => userEvent.click(page.getByRole('button', { name: 'Elsewhere' })))
  expect(popoverOpen()).toBe(false)
  await vi.waitFor(() => expect(popover()).toBeNull())
})
