/* eslint-disable react/react-in-jsx-scope */

// The admin's page for a workspace in Chromium, for what jsdom does not model: where focus starts
// and goes, keyboard input, the clipboard and how a grant's row lays out at a phone's width. What
// the page shows of each workspace, grant and failure is tested in its jsdom suite.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent, type Locator } from 'vitest/browser'
import {
  ADMIN_ACCESS_ERROR_CODES,
  createAdminAccessError,
  type AdminAccessGrant,
  type AdminApi,
  type AdminSettingsView,
  type AdminWorkspaceDescription,
  type AdminContentRequest,
} from '@gadgets/workshop-shared/api'
import '../../styles.css'

const mocks = vi.hoisted(() => ({
  authenticatedApi: { getAdminApi: vi.fn<() => Promise<unknown>>() },
}))

vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: mocks.authenticatedApi,
    currentUser: { type: 'user', id: 'alice@example.com', name: 'Alice' },
  }),
}))

import AdminWorkspacePage from './AdminWorkspacePage'

const WORKSPACE_ID = 'ws-1'
const REASON_LABEL = 'Why are you looking at this workspace?'
const REQUEST_LABEL = 'Why do admins need to read this workspace’s content?'
const END_LABEL = 'Why are you ending this access?'
// As long as an id gets: longer than a phone is wide in the face it is shown in.
const LONG_GRANT_ID = 'grant-0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef'

const adminsGrant = (id: string): AdminAccessGrant => ({
  id,
  level: 'content',
  source: 'admins',
  scope: 'workspace',
  grantedBy: { id: 'profile-grace', name: 'Grace Approver' },
  requestedBy: 'bob@example.com',
  requestId: 'req-3',
  reason: 'The owner is away and their agent is leaking a token.',
  grantedAt: new Date(Date.now() - 3_600_000),
  expiresAt: new Date(Date.now() + 71 * 3_600_000),
})

const ownerGrant: AdminAccessGrant = {
  id: 'grant-owner-1',
  level: 'content',
  source: 'owner',
  scope: 'workspace',
  grantedBy: { id: 'profile-olive', name: 'Olive Owner' },
  grantedAt: new Date(Date.now() - 7_200_000),
  expiresAt: new Date(Date.now() + 70 * 3_600_000),
}

// An AdminApi over one workspace, which holds its grants as the server does: a grant ended is gone
// from the next description.
const fakeAdmin = (grants: AdminAccessGrant[]) => {
  const held = { grants }
  const describe = vi.fn<() => Promise<AdminWorkspaceDescription>>(async () => ({
    id: WORKSPACE_ID,
    title: 'Quarterly numbers',
    owner: { type: 'user', id: 'profile-olive', name: 'Olive Owner' },
    access: 'metadata',
    grants: held.grants,
    expiresAt: new Date(Date.now() + 900_000),
  }) as AdminWorkspaceDescription)
  return {
    /** What every view the page opens answers describe() with. */
    describe,
    getSettings: async (): Promise<Pick<AdminSettingsView, 'adminWorkspaceAccess'>> => ({
      adminWorkspaceAccess: { effective: 'content', chosen: 'content', max: 'content' },
    }),
    // The promise of a view, as the page holds it: it calls describe() on it and disposes it.
    inspectWorkspace: vi.fn<(...args: Parameters<AdminApi['inspectWorkspace']>) => unknown>(
      () => ({ describe, [Symbol.dispose]: () => {} })),
    endWorkspaceGrant: vi.fn<AdminApi['endWorkspaceGrant']>(async (_workspaceId, grantId) => {
      held.grants = held.grants.filter((grant) => grant.id !== grantId)
    }),
    requestContentAccess: vi.fn<AdminApi['requestContentAccess']>(
      async (workspaceId, reason): Promise<AdminContentRequest> => ({
        id: 'req-9',
        workspaceId,
        workspaceTitle: 'Quarterly numbers',
        workspaceOwner: 'olive@example.com',
        reason,
        requestedBy: 'alice@example.com',
        via: 'api',
        requestedAt: new Date(),
        expiresAt: new Date(Date.now() + 86_400_000),
        state: 'pending',
      })),
    [Symbol.dispose]: () => {},
  }
}

let root: Root | undefined
let container: HTMLElement | undefined
let previousViewport: { width: number; height: number } | undefined

afterEach(async () => {
  act(() => root?.unmount())
  container?.remove()
  vi.restoreAllMocks()
  if (previousViewport) {
    await page.viewport(previousViewport.width, previousViewport.height)
    previousViewport = undefined
  }
})

const reasonField = () => page.getByRole('textbox', { name: REASON_LABEL })
const openButton = () => page.getByRole('button', { name: 'Open', exact: true })
const grantsHeading = () => page.getByRole('heading', { name: 'Access grants' })
const endAccessButton = (grantId: string) => page.getByRole('button', { name: `End access under grant ${grantId}` })
const endDialog = () => page.getByRole('dialog', { name: 'End this access?' })
const endReasonField = () => page.getByRole('textbox', { name: END_LABEL })
const requestField = () => page.getByRole('textbox', { name: REQUEST_LABEL })
const requestButton = () => page.getByRole('button', { name: 'Request content access' })
const pendingLink = () => page.getByRole('link', { name: 'pending approvals' })

/** Input as a user gives it, with the updates it causes applied before the next assertion. */
const input = (action: () => Promise<unknown>) => act(async () => { await action() })

// Presses Tab until `target` has focus.
const tabTo = async (target: Locator) => {
  for (let presses = 0; presses < 30 && document.activeElement !== target.element(); presses++) {
    await input(() => userEvent.tab())
  }
  await expect.element(target).toHaveFocus()
}

// Shows the page of a workspace that holds `grants`, not yet opened.
const renderPage = async (grants: AdminAccessGrant[] = []) => {
  const admin = fakeAdmin(grants)
  mocks.authenticatedApi.getAdminApi.mockResolvedValue(admin)
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const pageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <AdminWorkspacePage workspaceId={WORKSPACE_ID} />,
  })
  const adminRoute = createRoute({ getParentRoute: () => rootRoute, path: '/admin', component: () => null })
  const router = createRouter({
    routeTree: rootRoute.addChildren([pageRoute, adminRoute]),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => {
    await router.load()
    root!.render(<RouterProvider router={router} />)
  })
  await expect.element(reasonField()).toBeVisible()
  return admin
}

// Shows the page with the workspace opened, as an admin opens it.
const renderOpened = async (grants: AdminAccessGrant[]) => {
  const admin = await renderPage(grants)
  await input(() => userEvent.fill(reasonField(), 'Ticket 42'))
  await input(() => userEvent.keyboard('{Enter}'))
  await expect.element(grantsHeading()).toBeVisible()
  return admin
}

it('starts with focus in the labelled reason field, keeps Open disabled without a reason, and opens on Enter', async () => {
  const admin = await renderPage()

  await expect.element(reasonField()).toHaveFocus()
  await expect.element(page.getByText(REASON_LABEL)).toBeVisible()
  await expect.element(openButton()).toBeDisabled()
  await expect.element(reasonField()).toHaveAccessibleDescription(/A reason is required\./)

  // Enter in an empty field opens nothing.
  await input(() => userEvent.keyboard('{Enter}'))
  expect(admin.inspectWorkspace).not.toHaveBeenCalled()

  await input(() => userEvent.keyboard('Ticket 42'))
  await expect.element(openButton()).toBeEnabled()
  await input(() => userEvent.keyboard('{Enter}'))

  await expect.element(grantsHeading()).toBeVisible()
  expect(admin.inspectWorkspace.mock.calls).toEqual([[WORKSPACE_ID, 'Ticket 42']])
  await expect.element(reasonField()).toHaveFocus()
})

it('ends a grant by keyboard: Escape calls nothing and gives focus back, Enter ends it for the reason typed', async () => {
  const admin = await renderOpened([adminsGrant('grant-admins-1'), ownerGrant])
  const endAccess = endAccessButton('grant-admins-1')

  await tabTo(endAccess)
  await input(() => userEvent.keyboard('{Enter}'))

  await expect.element(endDialog()).toBeVisible()
  await expect.element(endReasonField()).toHaveFocus()

  await input(() => userEvent.keyboard('A slip{Escape}'))

  await expect.element(endDialog()).not.toBeInTheDocument()
  expect(admin.endWorkspaceGrant).not.toHaveBeenCalled()
  await expect.element(endAccess).toHaveFocus()

  await input(() => userEvent.keyboard('{Enter}'))
  await expect.element(endReasonField()).toHaveFocus()
  // The reason abandoned with Escape is not kept.
  await expect.element(endReasonField()).toHaveValue('')
  await input(() => userEvent.keyboard('The owner is back{Enter}'))

  await expect.element(endDialog()).not.toBeInTheDocument()
  expect(admin.endWorkspaceGrant.mock.calls).toEqual([[WORKSPACE_ID, 'grant-admins-1', 'The owner is back']])
  await expect.element(endAccess).not.toBeInTheDocument()
  await expect.element(page.getByText('grant-owner-1')).toBeVisible()
  // The button that had focus went with its grant, so the list's heading takes it.
  await expect.element(grantsHeading()).toHaveFocus()
})

it('gives focus to the reason field when the view stops answering once a grant is ended', async () => {
  const admin = await renderOpened([adminsGrant('grant-admins-1')])
  const expired = createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.viewExpired)
  admin.describe.mockRejectedValueOnce(expired)

  await tabTo(endAccessButton('grant-admins-1'))
  await input(() => userEvent.keyboard('{Enter}'))
  await expect.element(endReasonField()).toHaveFocus()
  await input(() => userEvent.keyboard('The owner is back{Enter}'))

  // The grants and the dialog that had focus went with the view.
  await expect.element(endDialog()).not.toBeInTheDocument()
  await expect.element(grantsHeading()).not.toBeInTheDocument()
  await expect.element(page.getByRole('alert')).toHaveTextContent(expired.message)
  await expect.element(reasonField()).toHaveFocus()

  // The reason is still in the field, so Enter opens the workspace again.
  await input(() => userEvent.keyboard('{Enter}'))
  await expect.element(grantsHeading()).toBeVisible()
  expect(admin.inspectWorkspace).toHaveBeenCalledTimes(2)
})

it('gives focus to what a request needs next when its button is pressed, with the pending approvals one Tab on', async () => {
  const admin = await renderPage()
  await input(() => userEvent.fill(requestField(), 'The owner is away'))
  await tabTo(requestButton())
  await input(() => userEvent.keyboard('{Enter}'))

  const outcome = page.getByText('Another admin must approve this. You cannot approve your own request.')
  await expect.element(outcome).toHaveFocus()
  expect(admin.requestContentAccess.mock.calls).toEqual([[WORKSPACE_ID, 'The owner is away']])
  // The reason went with the request, which leaves the button disabled.
  await expect.element(requestButton()).toBeDisabled()

  await input(() => userEvent.tab())
  await expect.element(pendingLink()).toHaveFocus()
})

it('wraps a grant’s row at a phone’s width, with its id whole and inside the page', async () => {
  previousViewport = { width: window.innerWidth, height: window.innerHeight }
  await page.viewport(360, 740)
  await renderOpened([adminsGrant(LONG_GRANT_ID)])

  const id = page.getByText(LONG_GRANT_ID, { exact: true }).element()
  const row = id.closest('li')!
  expect(row.textContent).toContain(LONG_GRANT_ID)
  const shown = id.getBoundingClientRect()
  // The id wraps onto more lines than one, within its row and the page, and none of it is cut off.
  expect(shown.height).toBeGreaterThan(parseFloat(getComputedStyle(id).lineHeight) * 1.5)
  expect(shown.left).toBeGreaterThanOrEqual(row.getBoundingClientRect().left)
  expect(shown.right).toBeLessThanOrEqual(row.getBoundingClientRect().right)
  expect(row.getBoundingClientRect().right).toBeLessThanOrEqual(window.innerWidth)
  expect(getComputedStyle(id).textOverflow).not.toBe('ellipsis')
  expect(id.scrollWidth).toBeLessThanOrEqual(id.clientWidth + 1)
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth)
})
