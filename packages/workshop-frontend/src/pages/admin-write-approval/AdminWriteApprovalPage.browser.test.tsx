/* eslint-disable react/react-in-jsx-scope */

// The approval page in Chromium, with a virtual authenticator in place of the platform's: a real
// passkey ceremony behind the Approve button, and keyboard input and focus, which jsdom does not
// model. What the page shows of each request and each failure is tested in its jsdom suite.

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
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { cdp, page, userEvent } from 'vitest/browser'
import type {
  AdminApi, AdminPasskeyChallenge, AdminSettingsView, AdminWriteRequest,
} from '@gadgets/workshop-shared/api'

const mocks = vi.hoisted(() => ({
  authenticatedApi: { getAdminApi: vi.fn<() => Promise<unknown>>() },
}))

vi.mock('../../AuthContext', () => ({
  useAuthenticatedApi: () => ({
    authenticatedApi: mocks.authenticatedApi,
    currentUser: { type: 'user', id: 'alice@example.com', name: 'Alice' },
  }),
}))

import { createPasskey } from '../../features/admin-writes/passkeyCeremony'
import AdminWriteApprovalPage from './AdminWriteApprovalPage'

// The DevTools commands that put a virtual authenticator in place of the platform's. The Playwright
// provider types the whole session, but its types bring Node's into a program that is checked
// against a browser's alone, so the commands sent here are typed by hand. cdp() throws where the
// provider has no DevTools session, which fails the test with the provider's own message.
type WebAuthnSession = {
  send(method: 'WebAuthn.enable' | 'WebAuthn.disable'): Promise<unknown>
  send(method: 'WebAuthn.addVirtualAuthenticator', params: { options: Record<string, unknown> })
    : Promise<{ authenticatorId: string }>
  send(method: 'WebAuthn.removeVirtualAuthenticator', params: { authenticatorId: string }): Promise<unknown>
}
const webAuthn = () => cdp() as WebAuthnSession

let authenticatorId: string | undefined
let root: Root | undefined
let container: HTMLElement | undefined

// An authenticator that holds resident keys and verifies its user without a prompt.
beforeEach(async () => {
  await webAuthn().send('WebAuthn.enable')
  ;({ authenticatorId } = await webAuthn().send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  }))
})

afterEach(async () => {
  act(() => root?.unmount())
  container?.remove()
  if (authenticatorId !== undefined) {
    await webAuthn().send('WebAuthn.removeVirtualAuthenticator', { authenticatorId })
    authenticatorId = undefined
  }
  await webAuthn().send('WebAuthn.disable')
})

const REQUEST_ID = 'req-1'

// Thirty-two bytes each, as the unpadded base64url a browser writes them back in.
const ENROLMENT_CHALLENGE = 'ZW5yb2xtZW50LWNoYWxsZW5nZS0wMTIzNDU2Nzg5YWI'
const APPROVAL_CHALLENGE = 'YXBwcm92YWwtY2hhbGxlbmdlLTAxMjM0NTY3ODlhYmM'

const challengeFor = (challenge: string, credentialIds: string[]): AdminPasskeyChallenge => ({
  challenge,
  rpId: location.hostname,
  credentialIds,
  expiresAt: new Date(Date.now() + 60_000),
})

const clientDataOf = (base64Url: string): { type: string; challenge: string; origin: string } =>
  JSON.parse(new TextDecoder().decode(
    Uint8Array.from(atob(base64Url.replaceAll('-', '+').replaceAll('_', '/')), (char) => char.charCodeAt(0))))

// An AdminApi with one pending request, which an approval by the passkey `credentialId` applies.
const fakeAdmin = (credentialId: string) => {
  let request: AdminWriteRequest = {
    id: REQUEST_ID,
    workspaceId: 'ws-1',
    workspaceTitle: 'Quarterly numbers',
    workspaceOwner: 'owner@example.com',
    action: 'stopAgent',
    args: { chatId: 3 },
    reason: 'The agent is stuck in a loop.',
    requestedBy: 'bob@example.com',
    via: 'cli',
    requestedAt: new Date(),
    expiresAt: new Date(Date.now() + 600_000),
    approvalUrl: `${location.origin}/admin/approve/${REQUEST_ID}`,
    state: 'pending',
  }
  return {
    getWorkspaceWrite: async () => request,
    getSettings: async (): Promise<Pick<AdminSettingsView, 'adminWorkspaceAccess'>> => ({
      adminWorkspaceAccess: { effective: 'metadata', chosen: 'metadata', max: 'metadata' },
    }),
    beginWorkspaceWriteApproval: vi.fn<AdminApi['beginWorkspaceWriteApproval']>(
      async () => challengeFor(APPROVAL_CHALLENGE, [credentialId])),
    approveWorkspaceWrite: vi.fn<AdminApi['approveWorkspaceWrite']>(async () => {
      request = { ...request, state: 'applied', resolvedBy: 'alice@example.com' }
      return request
    }),
    [Symbol.dispose]: () => {},
  }
}

// Enrols a passkey on the virtual authenticator and shows the page of a request it can approve.
const renderPage = async () => {
  const registration = await createPasskey(
    challengeFor(ENROLMENT_CHALLENGE, []), { id: 'alice@example.com', name: 'Alice' }, 'Example OS')
  const admin = fakeAdmin(registration.credentialId)
  mocks.authenticatedApi.getAdminApi.mockResolvedValue(admin)
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const pageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: () => <AdminWriteApprovalPage requestId={REQUEST_ID} />,
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
  await expect.element(approveButton()).toBeVisible()
  return { admin, credentialId: registration.credentialId }
}

const approveButton = () => page.getByRole('button', { name: 'Approve with passkey' })
const denyButton = () => page.getByRole('button', { name: 'Deny' })
const outcome = () => page.getByRole('status')

/** Input as a user gives it, with the updates it causes applied before the next assertion. */
const input = (action: () => Promise<unknown>) => act(async () => { await action() })

it('approves with a passkey that signs the request’s challenge on this origin', async () => {
  const { admin, credentialId } = await renderPage()

  await input(() => userEvent.click(approveButton()))

  await expect.poll(() => admin.approveWorkspaceWrite.mock.calls.length).toBe(1)
  const [requestId, assertion] = admin.approveWorkspaceWrite.mock.calls[0]
  expect(requestId).toBe(REQUEST_ID)
  expect(assertion.credentialId).toBe(credentialId)
  expect(clientDataOf(assertion.clientDataJSON)).toMatchObject({
    type: 'webauthn.get', challenge: APPROVAL_CHALLENGE, origin: location.origin,
  })
  await expect.element(outcome()).toHaveTextContent('Applied')
  await expect.element(outcome()).toHaveFocus()
})

it('reaches Approve and then Deny by Tab, and approves on Enter', async () => {
  const { admin } = await renderPage()

  for (let presses = 0; presses < 10 && document.activeElement !== approveButton().element(); presses++) {
    await input(() => userEvent.tab())
  }
  await expect.element(approveButton()).toHaveFocus()
  await input(() => userEvent.tab())
  await expect.element(denyButton()).toHaveFocus()
  await input(() => userEvent.tab({ shift: true }))
  await expect.element(approveButton()).toHaveFocus()
  expect(admin.beginWorkspaceWriteApproval).not.toHaveBeenCalled()

  await input(() => userEvent.keyboard('{Enter}'))

  await expect.poll(() => admin.approveWorkspaceWrite.mock.calls.length).toBe(1)
  expect(admin.beginWorkspaceWriteApproval).toHaveBeenCalledExactlyOnceWith(REQUEST_ID)
  await expect.element(outcome()).toHaveTextContent('Applied')
  await expect.element(outcome()).toHaveFocus()
  await expect.element(approveButton()).not.toBeInTheDocument()
})
