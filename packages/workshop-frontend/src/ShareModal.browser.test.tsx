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
  AiChatAuthorInfo, AuthenticatedApi, CollaboratorInfo, ObserverBindingNeed, Overseer, ShareLinkInfo,
  WorkspaceMetadata,
} from '@gadgets/workshop-shared/api'
import ShareModal, { type ShareTarget } from './ShareModal'
import './styles.css'

const OWNER: AiChatAuthorInfo = { type: 'user', id: 'dan@cloudflare.com', name: 'Dan' }

// What a link to every gadget became once frozen to the gadgets its workspace then held.
const FROZEN_LINK: ShareLinkInfo = {
  linkId: 'link-frozen', note: 'Old link', created: new Date(), createdBy: OWNER, role: 'use',
  gadgets: [{ id: 0, title: 'Packing list' }, { id: 1, title: 'Budget tracker' }],
}

const BEA = {
  profile: { type: 'user', id: 'bea@cloudflare.com', name: 'Bea' },
  addedBy: [{ type: 'user', sharer: OWNER.id, created: new Date(), role: 'build' }],
  access: { role: 'build' },
} satisfies CollaboratorInfo

const CRM_REQUIREMENT: ObserverBindingNeed = {
  gatekeeperId: 8, vendorId: 'salesforce', resourceTitle: 'Pipeline dashboard', creationType: 'gatekeeper',
}
const AMBIENT_CRM_REQUIREMENT: ObserverBindingNeed = { ...CRM_REQUIREMENT, creationType: 'ambient' }

const DOC_REQUIREMENT: ObserverBindingNeed = {
  gatekeeperId: 7, vendorId: 'google', resourceTitle: 'Q3 planning', creationType: 'gatekeeper',
}

let root: Root | undefined
let container: HTMLElement | undefined
let previousViewport: { width: number, height: number } | undefined

const countButton = (count = 2) => page.getByRole('button', { name: new RegExp(`^${count} gadgets`) })
// Every test works on the dialog's Advanced page, where links other than the viewer's default
// link live, so the dialog is named for it.
const dialog = () => page.getByRole('dialog', { name: 'Advanced' })
const openAdvanced = () => userEvent.click(page.getByRole('button', { name: 'Advanced settings', exact: true }))

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

const renderModal = (
  link = FROZEN_LINK, initiallyOpen = true, metadata = {}, requirements: ObserverBindingNeed[] = [],
  { target = { kind: 'workspace' }, snapshot, remove = async () => {} }: {
    target?: ShareTarget
    snapshot?: object
    remove?: () => Promise<void>
  } = {},
) => {
  const overseer = {
    listCollaborators: async () => [BEA],
    listShareLinks: async () => [link],
    listObserverRequirements: async () => requirements,
    // The snapshot page's preview, left taking its snapshot unless the test gives one.
    getGadgetSnapshot: () => Object.assign(
      snapshot ? Promise.resolve(snapshot) : Promise.withResolvers<never>().promise,
      { [Symbol.dispose]: () => {} }),
    getGatekeeperById: () => ({ remove, [Symbol.dispose]() {} }),
  } as unknown as RpcStub<Overseer>
  const Harness = () => {
    const [open, setOpen] = useState(initiallyOpen)
    return <>
      <button type="button" onClick={() => setOpen(true)}>Open sharing</button>
      <ShareModal
        open={open}
        onClose={() => setOpen(false)}
        overseer={overseer}
        metadata={{ id: 'trip-planner', title: 'Trip planner', ...metadata } as WorkspaceMetadata}
        target={target}
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

// Assistive technology must reach a menu the way a pointer does: by role and name, painted on top.
const expectReachableMenuItem = async (role: 'menuitem' | 'menuitemradio', name: string) => {
  const item = page.getByRole(role, { name })
  await expect.element(item).toBeVisible()
  await expect.poll(() => isOnTop(item.element())).toBe(true)
  await userEvent.keyboard('{Escape}')
  await expect.element(item).not.toBeInTheDocument()
}

it('keeps the protected-resources pill readable in a narrow viewport', async () => {
  previousViewport = { width: window.innerWidth, height: window.innerHeight }
  await page.viewport(320, 640)
  renderModal(FROZEN_LINK, true, {}, [CRM_REQUIREMENT])
  const pill = page.getByRole('button', { name: /Protected resources/ })
  await expect.element(pill).toBeVisible()

  const label = page.getByText('Protected resources', { exact: true }).element() as HTMLElement
  expect(label.clientWidth).toBeGreaterThan(0)
  expect(label.scrollWidth).toBeLessThanOrEqual(label.clientWidth)
  for (const icon of pill.element().querySelectorAll('svg')) {
    expect(icon.getBoundingClientRect().width).toBeGreaterThanOrEqual(12)
  }
  // The footer reflows rather than pushing anything out of the dialog.
  const dialogBox = page.getByRole('dialog').element().getBoundingClientRect()
  for (const control of [pill, page.getByRole('button', { name: 'Copy link' })]) {
    const box = control.element().getBoundingClientRect()
    expect(box.left).toBeGreaterThanOrEqual(dialogBox.left)
    expect(box.right).toBeLessThanOrEqual(dialogBox.right)
  }
})

it('moves focus into a dialog page and back to the button that opened it', async () => {
  renderModal(FROZEN_LINK, true, {}, [CRM_REQUIREMENT])
  const back = page.getByRole('button', { name: 'Back to sharing' })
  for (const name of ['Advanced settings', /Protected resources/]) {
    const opener = page.getByRole('button', { name })
    await expect.element(opener).toBeVisible()
    ;(opener.element() as HTMLElement).focus()
    await userEvent.keyboard('{Enter}')
    await expect.element(back).toHaveFocus()
    await userEvent.keyboard('{Enter}')
    await expect.element(opener).toHaveFocus()
  }
})

it('moves focus into the snapshot page and back to its card', async () => {
  const viewLink: ShareLinkInfo = {
    linkId: 'link-view', created: new Date(), createdBy: OWNER, role: 'use', gadgetId: 0, mode: 'view',
  }
  renderModal(viewLink, true, {}, [], { target: { kind: 'gadget', gadgetId: 0, title: 'Packing list' } })
  const card = page.getByRole('button', { name: /Viewers can see a snapshot/ })
  await expect.element(card).toBeVisible()
  ;(card.element() as HTMLElement).focus()
  await userEvent.keyboard('{Enter}')
  await expect.element(page.getByRole('button', { name: 'Back to sharing' })).toHaveFocus()
  await userEvent.keyboard('{Enter}')
  await expect.element(card).toHaveFocus()
})

it('covers the window with the full-screen preview, keeps focus inside it, and puts the dialog back', async () => {
  const viewLink: ShareLinkInfo = {
    linkId: 'link-view', created: new Date(), createdBy: OWNER, role: 'use', gadgetId: 0, mode: 'view',
  }
  // A snapshot with no UI, so the preview holds no frame to tab into.
  const snapshot: object = {
    dup: () => snapshot,
    getUiBundle: async () => null,
    getExportFormats: async () => [],
    [Symbol.dispose]: () => {},
  }
  // A desktop window, where the dialog is centred by a translate that would confine the overlay.
  previousViewport = { width: window.innerWidth, height: window.innerHeight }
  await page.viewport(1280, 800)
  renderModal(viewLink, true, {}, [], { target: { kind: 'gadget', gadgetId: 0, title: 'Packing list' }, snapshot })
  await userEvent.click(page.getByRole('button', { name: /Viewers can see a snapshot/ }))
  await userEvent.click(page.getByRole('button', { name: 'Enter full screen' }))
  const overlay = page.getByRole('dialog', { name: 'Snapshot full screen' })
  await expect.element(overlay).toHaveFocus()
  const box = overlay.element().getBoundingClientRect()
  expect([box.left, box.top, box.width, box.height]).toEqual([0, 0, 1280, 800])

  for (let i = 0; i < 4; i++) {
    await userEvent.keyboard('{Tab}')
    expect(overlay.element().contains(document.activeElement)).toBe(true)
  }
  await userEvent.click(page.getByRole('button', { name: 'Exit full screen' }))
  await expect.element(page.getByRole('button', { name: 'Enter full screen' })).toHaveFocus()
  await expect.element(page.getByRole('button', { name: 'Ask agent to fix' })).toBeVisible()
  const dialogBox = page.getByRole('dialog', { name: 'Snapshot' }).element().getBoundingClientRect()
  expect(dialogBox.left + dialogBox.width / 2).toBe(640)
})

it('keeps keyboard focus in the connection list through confirming and deleting', async () => {
  renderModal(FROZEN_LINK, true, {}, [DOC_REQUIREMENT, CRM_REQUIREMENT])
  const pill = page.getByRole('button', { name: /Protected resources/ })
  await expect.element(pill).toBeVisible()
  ;(pill.element() as HTMLElement).focus()
  await userEvent.keyboard('{Enter}')

  const deleteDoc = page.getByRole('button', { name: 'Delete Q3 planning from workspace' })
  const cancel = page.getByRole('button', { name: 'Cancel' })
  await expect.element(deleteDoc).toBeVisible()
  ;(deleteDoc.element() as HTMLElement).focus()
  await userEvent.keyboard('{Enter}')
  await expect.element(cancel).toHaveFocus()
  await userEvent.keyboard('{Enter}')
  await expect.element(deleteDoc).toHaveFocus()

  // Deleting hands focus to the next row, and deleting the last row to the people field.
  await userEvent.keyboard('{Enter}')
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}')
  const confirmDoc = page.getByRole('button', { name: 'Delete Q3 planning', exact: true })
  await expect.element(confirmDoc).toHaveFocus()
  // The warning is read with the confirmation, which would otherwise not say what it risks.
  await expect.element(confirmDoc).toHaveAccessibleDescription(/visible to everyone in the workspace/)
  await userEvent.keyboard('{Enter}')
  const deleteCrm = page.getByRole('button', { name: 'Delete Pipeline dashboard from workspace' })
  await expect.element(deleteCrm).toHaveFocus()
  await userEvent.keyboard('{Enter}')
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}')
  await userEvent.keyboard('{Enter}')
  await expect.element(page.getByRole('searchbox')).toHaveFocus()
})

it('keeps keyboard focus on the confirmation while a deletion is in flight', async () => {
  const removal = Promise.withResolvers<void>()
  let removals = 0
  renderModal(FROZEN_LINK, true, {}, [DOC_REQUIREMENT, CRM_REQUIREMENT], { remove: () => {
    removals++
    return removal.promise
  } })
  const pill = page.getByRole('button', { name: /Protected resources/ })
  await expect.element(pill).toBeVisible()
  ;(pill.element() as HTMLElement).focus()
  await userEvent.keyboard('{Enter}')
  const deleteDoc = page.getByRole('button', { name: 'Delete Q3 planning from workspace' })
  await expect.element(deleteDoc).toBeVisible()
  ;(deleteDoc.element() as HTMLElement).focus()
  await userEvent.keyboard('{Enter}')
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}')
  await userEvent.keyboard('{Enter}')

  const confirmDoc = page.getByRole('button', { name: 'Delete Q3 planning', exact: true })
  await expect.element(confirmDoc).toHaveAttribute('aria-disabled', 'true')
  await expect.element(confirmDoc).toHaveFocus()
  // Pressing it again while busy starts nothing.
  await userEvent.keyboard('{Enter}')
  removal.resolve()

  await expect.element(page.getByText('Connection deleted.')).toBeVisible()
  await expect.element(page.getByRole('button', { name: 'Delete Pipeline dashboard from workspace' })).toHaveFocus()
  expect(removals).toBe(1)
})

it('leaves focus where the user moved it when a slow deletion finishes', async () => {
  const removal = Promise.withResolvers<void>()
  renderModal(FROZEN_LINK, true, {}, [CRM_REQUIREMENT], { remove: () => removal.promise })
  const pill = page.getByRole('button', { name: /Protected resources/ })
  await expect.element(pill).toBeVisible()
  ;(pill.element() as HTMLElement).focus()
  await userEvent.keyboard('{Enter}')
  const deleteCrm = page.getByRole('button', { name: 'Delete Pipeline dashboard from workspace' })
  await expect.element(deleteCrm).toBeVisible()
  ;(deleteCrm.element() as HTMLElement).focus()
  await userEvent.keyboard('{Enter}')
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}')
  await userEvent.keyboard('{Enter}')

  const close = page.getByRole('button', { name: 'Close' })
  ;(close.element() as HTMLElement).focus()
  removal.resolve()

  await expect.element(page.getByText('Connection deleted.')).toBeVisible()
  await expect.element(close).toHaveFocus()
})

it('moves focus to the people field when the last deletion removes the control the user moved to', async () => {
  const removal = Promise.withResolvers<void>()
  renderModal(FROZEN_LINK, true, {}, [CRM_REQUIREMENT], { remove: () => removal.promise })
  const pill = page.getByRole('button', { name: /Protected resources/ })
  await expect.element(pill).toBeVisible()
  ;(pill.element() as HTMLElement).focus()
  await userEvent.keyboard('{Enter}')
  const deleteCrm = page.getByRole('button', { name: 'Delete Pipeline dashboard from workspace' })
  await expect.element(deleteCrm).toBeVisible()
  ;(deleteCrm.element() as HTMLElement).focus()
  await userEvent.keyboard('{Enter}')
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}')
  await userEvent.keyboard('{Enter}')

  // Back hands focus to the pill, which goes with the last connection.
  ;(page.getByRole('button', { name: 'Back to sharing' }).element() as HTMLElement).focus()
  await userEvent.keyboard('{Enter}')
  await expect.element(pill).toHaveFocus()
  removal.resolve()

  await expect.element(page.getByText('Connection deleted.')).toBeVisible()
  await expect.element(page.getByRole('searchbox')).toHaveFocus()
})

it('stays on the sharing view when a refresh lists a connection after the last was deleted', async () => {
  const requirements = [CRM_REQUIREMENT]
  renderModal(FROZEN_LINK, true, {}, requirements)
  const pill = page.getByRole('button', { name: /Protected resources/ })
  await expect.element(pill).toBeVisible()
  await userEvent.click(pill)
  await userEvent.click(page.getByRole('button', { name: 'Delete Pipeline dashboard from workspace' }))
  await userEvent.click(page.getByRole('button', { name: 'Delete Pipeline dashboard', exact: true }))
  const people = page.getByRole('searchbox')
  await expect.element(people).toHaveFocus()
  await userEvent.keyboard('be')

  // Another view of the workspace adds a connection, which the next focus refresh lists.
  requirements.splice(0, 1, DOC_REQUIREMENT)
  window.dispatchEvent(new Event('focus'))

  await expect.element(pill).toBeVisible()
  await expect.element(people).toBeVisible()
  await expect.element(people).toHaveFocus()
  await expect.element(people).toHaveValue('be')
})

it('leaves focus on another row when a slow deletion finishes', async () => {
  const removal = Promise.withResolvers<void>()
  renderModal(FROZEN_LINK, true, {}, [DOC_REQUIREMENT, AMBIENT_CRM_REQUIREMENT], { remove: () => removal.promise })
  const pill = page.getByRole('button', { name: /Protected resources/ })
  await expect.element(pill).toBeVisible()
  ;(pill.element() as HTMLElement).focus()
  await userEvent.keyboard('{Enter}')
  const deleteDoc = page.getByRole('button', { name: 'Delete Q3 planning from workspace' })
  await expect.element(deleteDoc).toBeVisible()
  ;(deleteDoc.element() as HTMLElement).focus()
  await userEvent.keyboard('{Enter}')
  await userEvent.keyboard('{Shift>}{Tab}{/Shift}')
  await userEvent.keyboard('{Enter}')

  const ambient = page.getByRole('button', { name: 'Pipeline dashboard can’t be deleted' })
  ;(ambient.element() as HTMLElement).focus()
  removal.resolve()

  await expect.element(page.getByText('Connection deleted.')).toBeVisible()
  await expect.element(ambient).toHaveFocus()
})

it('keeps a deletion pending when the page is left and reopened before it settles', async () => {
  const removal = Promise.withResolvers<void>()
  let removals = 0
  renderModal(FROZEN_LINK, true, {}, [DOC_REQUIREMENT, CRM_REQUIREMENT], { remove: () => {
    removals++
    return removal.promise
  } })
  const pill = page.getByRole('button', { name: /Protected resources/ })
  await expect.element(pill).toBeVisible()
  await userEvent.click(pill)
  await userEvent.click(page.getByRole('button', { name: 'Delete Q3 planning from workspace' }))
  await userEvent.click(page.getByRole('button', { name: 'Delete Q3 planning', exact: true }))

  await userEvent.click(page.getByRole('button', { name: 'Back to sharing' }))
  await userEvent.click(pill)
  await expect.element(page.getByRole('button', { name: 'Delete Q3 planning from workspace' })).toBeDisabled()
  removal.resolve()

  await expect.element(page.getByText('Connection deleted.')).toBeVisible()
  await expect.element(page.getByRole('button', { name: 'Delete Pipeline dashboard from workspace' })).toBeEnabled()
  expect(removals).toBe(1)
})

it('scrolls a confirmation it focuses whole into the page’s panel', async () => {
  previousViewport = { width: window.innerWidth, height: window.innerHeight }
  await page.viewport(320, 640)
  const requirements = Array.from({ length: 12 }, (_, index): ObserverBindingNeed =>
    ({ ...CRM_REQUIREMENT, gatekeeperId: 100 + index, resourceTitle: `Dashboard ${index}` }))
  renderModal(FROZEN_LINK, true, {}, requirements)
  await userEvent.click(page.getByRole('button', { name: /Protected resources/ }))
  await expect.element(page.getByRole('button', { name: 'Delete Dashboard 11 from workspace' })).toBeInTheDocument()

  // The first row past the panel's bottom edge, scrolled to end exactly at it, so the warning
  // grows it past that edge.
  const list = page.getByRole('list').element()
  const panel = list.parentElement!
  const row = [...list.querySelectorAll('li')]
    .find(candidate => candidate.getBoundingClientRect().bottom > panel.getBoundingClientRect().bottom)!
  panel.scrollTop += row.getBoundingClientRect().bottom - panel.getBoundingClientRect().bottom
  expect(row.getBoundingClientRect().bottom).toBeCloseTo(panel.getBoundingClientRect().bottom, 0)
  const deleteButton = row.querySelector<HTMLElement>('[data-resource-control]')!
  deleteButton.focus()
  await userEvent.keyboard('{Enter}')

  const cancel = page.getByRole('button', { name: 'Cancel' })
  await expect.element(cancel).toHaveFocus()
  const panelBox = panel.getBoundingClientRect()
  const rowBox = cancel.element().closest('li')!.getBoundingClientRect()
  expect(rowBox.top).toBeGreaterThanOrEqual(panelBox.top)
  expect(rowBox.bottom).toBeLessThanOrEqual(panelBox.bottom)
})

it.each(['click', 'touch'] as const)('shows why an ambient connection can’t be deleted on %s', async (method) => {
  renderModal(FROZEN_LINK, true, {}, [AMBIENT_CRM_REQUIREMENT])
  const pill = page.getByRole('button', { name: /Protected resources/ })
  await expect.element(pill).toBeVisible()
  await userEvent.click(pill)
  const ambient = page.getByRole('button', { name: 'Pipeline dashboard can’t be deleted' })
  await expect.element(ambient).toBeVisible()
  await userEvent.hover(page.getByRole('heading', { name: 'Protected resources' }))
  const activate = (element: Element) => method === 'touch' ? touch(element) : userEvent.click(element)

  await activate(ambient.element())
  const status = page.getByText('Always included')
  await expect.element(status).toBeVisible()
  await expect.poll(() => isOnTop(status.element())).toBe(true)
  await expect.element(ambient).toHaveAccessibleDescription('Always included')
  await activate(ambient.element())
  await expect.element(status).not.toBeInTheDocument()
})

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

it('keeps the access menus in the dialog’s accessibility tree and above it', async () => {
  renderModal()
  await userEvent.click(page.getByRole('button', { name: 'Anyone with your link: Requires invite' }))
  await expectReachableMenuItem('menuitemradio', 'Can join')

  await userEvent.click(page.getByRole('button', { name: 'Bea: Member' }))
  await expectReachableMenuItem('menuitem', 'Remove Bea')
  // The dialog survives the menu's Escape.
  await expect.element(page.getByRole('dialog')).toBeVisible()
})

it('puts a warning card exactly the size of the link row in its place once links are off', async () => {
  renderModal()
  const linkTitle = page.getByText('Anyone with your link')
  await expect.element(linkTitle).toBeVisible()
  const linkRow = linkTitle.element().closest('.group')!
  const rowHeight = linkRow.getBoundingClientRect().height
  root!.unmount()
  container!.remove()

  renderModal(FROZEN_LINK, true, { containsRestrictedData: true, ownerInvitesOnly: true })
  const card = page.getByRole('note', { name: 'Share links are off' })
  await expect.element(card).toBeVisible()
  expect(page.getByText('Anyone with your link').query()).toBeNull()
  // To the nearest pixel: fractional heights can round apart, but a second line added 4px.
  expect(card.element().getBoundingClientRect().height).toBeCloseTo(rowHeight, 0)
})

it("shows a link's gadgets above the dialog when its label is hovered", async () => {
  renderModal()
  await openAdvanced()

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
  await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  await userEvent.click(page.getByRole('button', { name: 'Open sharing' }))
  await openAdvanced()
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
  await openAdvanced()
  await expect.element(countButton()).toBeVisible()
  const heading = page.getByRole('heading', { name: 'Advanced' })
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
  await openAdvanced()
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
  // Within a pixel: fractional layout rounds the two boxes independently.
  expect(lastBox.top).toBeGreaterThanOrEqual(scrolledBounds.top - 1)
  expect(lastBox.bottom).toBeLessThanOrEqual(scrolledBounds.bottom + 1)
  expect(scrolledBounds.bottom).toBeLessThanOrEqual(window.innerHeight)
})
