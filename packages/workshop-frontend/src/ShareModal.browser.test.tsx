/* eslint-disable react/react-in-jsx-scope */

// The share dialog in Chromium, with the app's styles: whether a popup paints above the dialog is
// a matter of real stacking, which jsdom does not model.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { page } from 'vitest/browser'
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

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

it("shows a link's gadgets above the dialog when its label is hovered", async () => {
  const overseer = {
    listCollaborators: async () => [],
    listShareLinks: async () => [FROZEN_LINK],
    listObserverRequirements: async () => [],
  } as unknown as RpcStub<Overseer>
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => root!.render(
    <TooltipProvider>
      <Toasty>
        <ShareModal
          open
          onClose={() => {}}
          overseer={overseer}
          metadata={{ id: 'trip-planner', title: 'Trip planner' } as WorkspaceMetadata}
          target={{ kind: 'workspace' }}
          currentUser={OWNER}
          authenticatedApi={{ getAvatar: async () => null } as unknown as RpcStub<AuthenticatedApi>}
        />
      </Toasty>
    </TooltipProvider>,
  ))

  await page.getByText('2 gadgets · Cannot edit').hover()
  const title = page.getByText('Packing list')
  await expect.element(title).toBeVisible()

  // Visible is not enough: a list painted underneath the opaque dialog is visible too. The title
  // has to be what is actually on top at its own position.
  const box = title.element().getBoundingClientRect()
  const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
  expect(title.element().contains(top)).toBe(true)
  await expect.element(page.getByText('Budget tracker')).toBeVisible()
})
