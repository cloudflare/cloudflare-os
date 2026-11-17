/* eslint-disable react/react-in-jsx-scope */

// The share dialog in Chromium, with the app's styles: whether a popup paints above the dialog is
// a matter of real stacking, which jsdom does not model.

import { useState } from 'react'
import { flushSync } from 'react-dom'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { cdp, page, userEvent } from 'vitest/browser'
import { TooltipProvider, Toasty } from '@cloudflare/kumo'
import type { RpcStub } from 'capnweb'
import type {
  AiChatAuthorInfo, AuthenticatedApi, Overseer, ShareLinkInfo, WorkspaceMetadata,
} from '@gadgets/workshop-shared/api'
import ShareModal from './ShareModal'
import './styles.css'

const OWNER: AiChatAuthorInfo = { type: 'user', id: 'dan@cloudflare.com', name: 'Dan' }

// What a link to every gadget became once frozen to the gadgets its workspace then held.
const FROZEN_LINK: ShareLinkInfo = {
  linkId: 'link-frozen', note: 'Old link', created: new Date(), createdBy: OWNER, role: 'use',
  gadgets: [{ id: 0, title: 'Packing list' }, { id: 1, title: 'Budget tracker' }],
}

let root: Root | undefined
let container: HTMLElement | undefined
let previousViewport: { width: number, height: number } | undefined

const countButton = (count = 2) => page.getByRole('button', { name: new RegExp(`^${count} gadgets`) })
const dialog = () => page.getByRole('dialog', { name: 'Invite to “Trip planner”' })

// Importing Playwright's CDP augmentation would add Node globals to the browser TS project.
const sendCdp = async (method: string, params: object) => {
  const session = cdp()
  if (!('send' in session) || typeof session.send !== 'function') {
    throw new Error('Native touch coverage requires Chromium CDP.')
  }
  await session.send(method, params)
}

afterEach(async () => {
  root?.unmount()
  container?.remove()
  await sendCdp('Emulation.setTouchEmulationEnabled', { enabled: false })
  if (previousViewport) {
    await page.viewport(previousViewport.width, previousViewport.height)
    previousViewport = undefined
  }
})

const renderModal = (link = FROZEN_LINK, initiallyOpen = true) => {
  const overseer = {
    listCollaborators: async () => [],
    listShareLinks: async () => [link],
    listObserverRequirements: async () => [],
  } as unknown as RpcStub<Overseer>
  const Harness = () => {
    const [open, setOpen] = useState(initiallyOpen)
    return <>
      <button type="button" onClick={() => setOpen(true)}>Open sharing</button>
      <ShareModal
        open={open}
        onClose={() => setOpen(false)}
        overseer={overseer}
        metadata={{ id: 'trip-planner', title: 'Trip planner' } as WorkspaceMetadata}
        target={{ kind: 'workspace' }}
        currentUser={OWNER}
        authenticatedApi={{ getAvatar: async () => null } as unknown as RpcStub<AuthenticatedApi>}
      />
    </>
  }
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  flushSync(() => root!.render(
    <TooltipProvider><Toasty><Harness /></Toasty></TooltipProvider>,
  ))
}

const isOnTop = (element: Element) => {
  const box = element.getBoundingClientRect()
  return element.contains(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2))
}

// CDP supplies native touch input; mouse clicks would also hover the trigger and could hide a
// touch-only failure. Its coordinates are in the outer page, not Vitest's test iframe.
const touch = async (element: Element) => {
  const box = element.getBoundingClientRect()
  let x = box.left + box.width / 2
  let y = box.top + box.height / 2
  let frame: Window = window
  while (frame.frameElement) {
    const frameBox = frame.frameElement.getBoundingClientRect()
    x = frameBox.left + x * frameBox.width / frame.innerWidth
    y = frameBox.top + y * frameBox.height / frame.innerHeight
    frame = frame.parent
  }
  await sendCdp('Emulation.setTouchEmulationEnabled', { enabled: true })
  await sendCdp('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
  await sendCdp('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
}

it("shows a link's gadgets above the dialog when its label is hovered", async () => {
  renderModal()

  await userEvent.hover(page.getByText('2 gadgets · Cannot edit'))
  const title = page.getByText('Packing list')
  await expect.element(title).toBeVisible()

  // Visible is not enough: a list painted underneath the opaque dialog is visible too. The title
  // has to be what is actually on top at its own position.
  await expect.poll(() => isOnTop(title.element())).toBe(true)
  await expect.element(page.getByText('Budget tracker')).toBeVisible()
})

it('opens after mounting closed and exposes the gadget list to keyboard and assistive technology', async () => {
  renderModal(FROZEN_LINK, false)
  await expect.element(dialog()).not.toBeInTheDocument()
  await userEvent.click(page.getByRole('button', { name: 'Open sharing' }))
  await expect.element(countButton()).toBeVisible()

  for (let presses = 0; presses < 15 && document.activeElement !== countButton().element(); presses++) {
    await userEvent.tab()
  }
  await expect.element(countButton()).toHaveFocus()
  for (const name of ['Packing list', 'Budget tracker']) {
    const title = page.getByText(name, { exact: true })
    await expect.element(title).toBeVisible()
    expect(title.element().closest('[aria-hidden="true"], [inert]')).toBeNull()
    await expect.poll(() => isOnTop(title.element())).toBe(true)
  }

  await userEvent.tab()
  await expect.element(page.getByRole('tooltip')).not.toBeInTheDocument()
  await userEvent.tab({ shift: true })
  await expect.element(countButton()).toHaveFocus()
  await expect.element(page.getByText('Packing list')).toBeVisible()
  await userEvent.keyboard('{Escape}')
  await expect.element(page.getByRole('tooltip')).not.toBeInTheDocument()
  await expect.element(dialog()).toBeVisible()
})

it.each(['click', 'touch'] as const)('toggles the gadget list with %s and dismisses it outside without closing sharing', async (method) => {
  renderModal()
  await expect.element(countButton()).toBeVisible()
  const heading = page.getByRole('heading', { name: 'Invite to “Trip planner”' })
  await userEvent.hover(heading)
  await expect.element(page.getByRole('tooltip')).not.toBeInTheDocument()
  const activate = (element: Element) => method === 'touch' ? touch(element) : userEvent.click(element)

  await activate(countButton().element())
  await expect.element(page.getByText('Packing list')).toBeVisible()
  await expect.element(page.getByText('Budget tracker')).toBeVisible()
  await activate(countButton().element())
  await expect.element(page.getByRole('tooltip')).not.toBeInTheDocument()

  await activate(countButton().element())
  await expect.element(page.getByText('Packing list')).toBeVisible()
  await activate(heading.element())
  await expect.element(page.getByRole('tooltip')).not.toBeInTheDocument()
  await expect.element(dialog()).toBeVisible()
})

it('keeps fifty gadgets inside a small viewport and scrolls the list to the last gadget', async () => {
  previousViewport = { width: window.innerWidth, height: window.innerHeight }
  await page.viewport(640, 480)
  renderModal({
    ...FROZEN_LINK,
    gadgets: Array.from({ length: 50 }, (_, id) => ({ id, title: `Gadget ${String(id + 1).padStart(2, '0')}` })),
  })
  await expect.element(countButton(50)).toBeVisible()
  await userEvent.click(countButton(50))
  const popup = page.getByRole('tooltip')
  const first = page.getByText('Gadget 01', { exact: true })
  const last = page.getByText('Gadget 50', { exact: true })
  await expect.element(first).toBeVisible()
  await expect.poll(() => isOnTop(first.element())).toBe(true)
  await expect.poll(() => popup.element().getBoundingClientRect().top).toBeGreaterThanOrEqual(0)
  await expect.poll(() => popup.element().getBoundingClientRect().bottom).toBeLessThanOrEqual(window.innerHeight)
  const bounds = popup.element().getBoundingClientRect()
  expect(bounds.left).toBeGreaterThanOrEqual(0)
  expect(bounds.right).toBeLessThanOrEqual(window.innerWidth)
  expect(last.element().getBoundingClientRect().top).toBeGreaterThan(bounds.bottom)

  await userEvent.wheel(first, { delta: { y: 10_000 } })

  await expect.poll(() => isOnTop(last.element())).toBe(true)
  const lastBox = last.element().getBoundingClientRect()
  const scrolledBounds = popup.element().getBoundingClientRect()
  expect(lastBox.top).toBeGreaterThanOrEqual(scrolledBounds.top)
  expect(lastBox.bottom).toBeLessThanOrEqual(scrolledBounds.bottom)
  expect(scrolledBounds.bottom).toBeLessThanOrEqual(window.innerHeight)
})
