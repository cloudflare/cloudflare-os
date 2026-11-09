// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

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
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ADMIN_WRITE_ERROR_CODES,
  createAdminWriteError,
  type AdminApi,
  type AdminPasskeyAssertion,
  type AdminPasskeyChallenge,
  type AdminSettingsView,
  type AdminWorkspaceAccess,
  type AdminWriteRequest,
  type AiChatAuthorInfo,
} from '@gadgets/workshop-shared/api'
import type * as PasskeyCeremony from '../../features/admin-writes/passkeyCeremony'

const mocks = vi.hoisted(() => {
  // Told when `authenticatedApi` is replaced, so that the page renders with the one that replaced it.
  const apiListeners = new Set<() => void>()
  return {
    authenticatedApi: { getAdminApi: vi.fn<() => Promise<unknown>>() },
    apiListeners,
    subscribeToApi: (listener: () => void) => {
      apiListeners.add(listener)
      return () => { apiListeners.delete(listener) }
    },
    currentUser: null as AiChatAuthorInfo | null,
    assertPasskey: vi.fn<typeof PasskeyCeremony.assertPasskey>(),
  }
})

vi.mock('../../AuthContext', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useAuthenticatedApi: () => ({
      authenticatedApi: useSyncExternalStore(mocks.subscribeToApi, () => mocks.authenticatedApi),
      currentUser: mocks.currentUser,
    }),
  }
})

vi.mock('../../features/admin-writes/passkeyCeremony', async (importOriginal) => ({
  ...(await importOriginal<typeof PasskeyCeremony>()),
  assertPasskey: mocks.assertPasskey,
}))

import { Button } from '@cloudflare/kumo'
import { PasskeyCeremonyError } from '../../features/admin-writes/passkeyCeremony'
import { WRITE_CONSEQUENCES } from '../../features/admin-writes/writeLabels'
import { formatFullTimestamp } from '../../utils/formatTimestamp'
import AdminWriteApprovalPage from './AdminWriteApprovalPage'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const REQUEST_ID = 'req-1'
const WORKSPACE_ID = 'ws-1'
const EXPIRES_AT = new Date('2026-01-15T12:10:00Z')

const CHALLENGE: AdminPasskeyChallenge = {
  challenge: 'approval',
  rpId: 'workshop.example',
  credentialIds: ['alices-laptop'],
  expiresAt: new Date('2026-01-15T12:05:00Z'),
}
const ASSERTION: AdminPasskeyAssertion = {
  credentialId: 'alices-laptop',
  clientDataJSON: 'client-data',
  authenticatorData: 'authenticator-data',
  signature: 'signature',
}

const writeRequest = (overrides: Partial<AdminWriteRequest> = {}): AdminWriteRequest => ({
  id: REQUEST_ID,
  workspaceId: WORKSPACE_ID,
  workspaceTitle: 'Quarterly numbers',
  workspaceOwner: 'owner@example.com',
  action: 'stopAgent',
  args: { chatId: 3 },
  reason: 'The agent is stuck in a loop.',
  requestedBy: 'bob',
  via: 'cli',
  requestedAt: new Date('2026-01-15T12:00:00Z'),
  expiresAt: EXPIRES_AT,
  approvalUrl: `https://workshop.example/admin/approve/${REQUEST_ID}`,
  state: 'pending',
  ...overrides,
})

// An AdminApi that holds one request as the server does: an approval or a denial shows in the
// next reading of it.
const fakeAdmin = (initial: AdminWriteRequest, access: AdminWorkspaceAccess = 'metadata') => {
  const held = { request: initial }
  return {
    held,
    getWorkspaceWrite: vi.fn<AdminApi['getWorkspaceWrite']>(async () => held.request),
    getSettings: vi.fn<() => Promise<Pick<AdminSettingsView, 'adminWorkspaceAccess'>>>(async () => ({
      adminWorkspaceAccess: { effective: access, chosen: access, max: access },
    })),
    beginWorkspaceWriteApproval: vi.fn<AdminApi['beginWorkspaceWriteApproval']>(async () => CHALLENGE),
    approveWorkspaceWrite: vi.fn<AdminApi['approveWorkspaceWrite']>(async () => {
      held.request = { ...held.request, state: 'applied', resolvedBy: 'alice' }
      return held.request
    }),
    denyWorkspaceWrite: vi.fn<AdminApi['denyWorkspaceWrite']>(async () => {
      held.request = { ...held.request, state: 'denied', resolvedBy: 'alice' }
    }),
    [Symbol.dispose]: vi.fn<() => void>(),
  }
}

type FakeAdmin = ReturnType<typeof fakeAdmin>

let container: HTMLDivElement | undefined
let root: Root | undefined

const unmount = async () => {
  await act(async () => root?.unmount())
  root = undefined
}

// The page under a router, which its links need, beside a stub of the admin page they lead to.
const renderPage = async (admin: FakeAdmin | null | Promise<FakeAdmin | null>) => {
  mocks.authenticatedApi.getAdminApi.mockReturnValue(Promise.resolve(admin))
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
}

const renderRequest = async (overrides: Partial<AdminWriteRequest> = {}, access?: AdminWorkspaceAccess) => {
  const admin = fakeAdmin(writeRequest(overrides), access)
  await renderPage(admin)
  return admin
}

// What a reconnect does to the page: it is handed another API, whose admin capability is `admin`.
const reconnect = (admin: FakeAdmin) => act(async () => {
  mocks.authenticatedApi = { getAdminApi: vi.fn<() => Promise<unknown>>().mockResolvedValue(admin) }
  for (const listener of mocks.apiListeners) listener()
})

// A pending request whose time passes while the page shows it. The page's clock finds that out
// when it next ticks, here five seconds after the time passed.
const renderRequestRunningOut = async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-01-15T12:09:50Z'))
  const admin = await renderRequest()
  await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })
  return admin
}

const text = () => document.body.textContent ?? ''

// The request's description under `label`, or undefined when its list has no such row.
const description = (label: string) => [...document.querySelectorAll('dt')]
  .find((term) => term.textContent === label)?.nextElementSibling ?? undefined
const row = (label: string) => description(label)?.textContent ?? undefined

// The time the request runs out, as its Expires row marks it up.
const expiry = () => description('Expires')?.querySelector('time') ?? undefined

const loader = () => document.querySelector('[role="status"][aria-label="Loading the write request"]')

const findButton = (name: string) => [...document.querySelectorAll('button')]
  .find((element) => element.textContent?.trim() === name)
const button = (name: string) => {
  const element = findButton(name)
  if (!element) throw new Error(`no button ${name}`)
  return element
}
const click = (element: HTMLElement) => act(async () => { element.click() })

// What a browser does to a control with focus that an operation disables. jsdom leaves focus on
// such a control and won't blur it either, so focus leaves by way of a button that takes it and
// goes.
const dropFocus = () => act(async () => {
  const elsewhere = document.body.appendChild(document.createElement('button'))
  elsewhere.focus()
  elsewhere.blur()
  elsewhere.remove()
})

const link = (name: string) => [...document.querySelectorAll('a')]
  .find((element) => element.textContent?.trim() === name)

const outcome = () => document.querySelector<HTMLElement>('[role="status"]')

// How an element is styled: its classes and its inline style.
const styling = (element: Element | null | undefined) => (
  { classes: element?.className, style: element?.getAttribute('style') })

// How Kumo styles a button of this variant.
const kumoButtonStyling = async (variant: 'primary' | 'destructive') => {
  const host = document.body.appendChild(document.createElement('div'))
  const reference = createRoot(host)
  await act(async () => reference.render(<Button variant={variant}>Reference</Button>))
  const found = styling(host.querySelector('button'))
  await act(async () => reference.unmount())
  host.remove()
  return found
}
const alertText = () => document.querySelector('[role="alert"]')?.textContent ?? undefined

const INSPECT_ADVICE = 'inspect the workspace to see what an id names before you approve'
const AUDIT_LINK = 'This workspace in the audit log'
const UNDONE = 'This cannot be undone.'

beforeEach(() => {
  mocks.currentUser = { type: 'user', id: 'alice', name: 'Alice' }
  mocks.assertPasskey.mockReset().mockResolvedValue(ASSERTION)
  vi.stubGlobal('scrollTo', vi.fn<() => void>())
  // An unexpected failure is logged as well as shown.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  await unmount()
  container?.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  mocks.authenticatedApi.getAdminApi.mockReset()
})

describe('what the approval page shows of a request', () => {
  it('shows the workspace, its owner, the action, the arguments, the reason and the requester', async () => {
    await renderRequest()

    expect(row('Workspace')).toBe(`Quarterly numbers${WORKSPACE_ID}`)
    expect(row('Owner')).toBe('owner@example.com')
    expect(row('Action')).toBe('Stop the agent')
    expect(row('Chat')).toBe('3')
    expect(row('Reason')).toContain('The agent is stuck in a loop.')
    expect(row('Requested by')).toBe('bob through the CLI')
    expect(text()).toContain('You are approving as alice.')
  })

  it('calls a workspace without a title untitled, and says a request came through the API', async () => {
    await renderRequest({ workspaceTitle: '', via: 'api' })

    expect(row('Workspace')).toBe(`Untitled${WORKSPACE_ID}`)
    expect(row('Requested by')).toBe('bob through the API')
  })

  it('shows the reason as the text it is, never as Markdown', async () => {
    const reason = 'See **this** and [the runbook](https://example.com/runbook).\nSecond line.'
    await renderRequest({ reason })

    expect(row('Reason')).toContain(reason)
    expect(document.querySelector('dd strong')).toBeNull()
    expect(document.querySelector('dd a')).toBeNull()
  })

  it.each(['deleteChat', 'deleteWorkspace'] as const)(
    'says beside the reason of a %s who will read it', async (action) => {
      await renderRequest({ action, args: action === 'deleteChat' ? { chatId: 3 } : {} })

      expect(row('Reason')).toContain('to its owner and everyone invited to the workspace')
      expect(row('Reason')).toContain('People who were only given a gadget do not see it.')
    })

  it('says a rejection that names no connection covers every connection', async () => {
    await renderRequest({ action: 'rejectPendingActions', args: {} })

    expect(row('Connection')).toBe('Every connection')
  })

  it('says ids are shown as requested, advises an inspection and links the workspace’s audit records', async () => {
    await renderRequest({ action: 'deleteGadget', args: { gadgetId: 5 } })

    expect(row('Gadget')).toBe('5')
    expect(text()).toContain('shown by the ids the request names')
    expect(text()).toContain(INSPECT_ADVICE)
    const href = link(AUDIT_LINK)?.getAttribute('href') ?? ''
    expect(href.startsWith('/admin?')).toBe(true)
    expect(new URLSearchParams(href.slice(href.indexOf('?'))).get('tab')).toBe('audit')
    expect(new URLSearchParams(href.slice(href.indexOf('?'))).get('workspace')).toBe(WORKSPACE_ID)
  })

  // The level enforced decides, whichever of the two it is the lower of.
  it.each<[string, AdminSettingsView['adminWorkspaceAccess']]>([
    ['the deployment allows none', { effective: 'off', chosen: 'full', max: 'off' }],
    ['an admin turned it off', { effective: 'off', chosen: 'off', max: 'full' }],
  ])('says ids cannot be checked where inspection is off (%s), and still links the audit records', async (
    _why, adminWorkspaceAccess,
  ) => {
    const admin = fakeAdmin(writeRequest({ action: 'deleteGadget', args: { gadgetId: 5 } }))
    admin.getSettings.mockResolvedValue({ adminWorkspaceAccess })
    await renderPage(admin)

    expect(text()).toContain('shown by the ids the request names')
    expect(text()).toContain('what an id names cannot be checked here before you approve')
    expect(text()).not.toContain('inspect the workspace')
    const href = link(AUDIT_LINK)?.getAttribute('href') ?? ''
    expect(new URLSearchParams(href.slice(href.indexOf('?'))).get('workspace')).toBe(WORKSPACE_ID)
  })

  it('says nothing of ids for a request that names none', async () => {
    await renderRequest({ action: 'restartWorkspace', args: {} })

    expect(text()).not.toContain('shown by the ids the request names')
    expect(link(AUDIT_LINK)).toBeUndefined()
  })

  it('gives the time a pending request expires, and how long is left until then', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-15T12:02:30Z'))
    await renderRequest()

    expect(expiry()?.dateTime).toBe('2026-01-15T12:10:00.000Z')
    expect(expiry()?.textContent).toBe(formatFullTimestamp(EXPIRES_AT))
    expect(row('Expires')).toBe(`${formatFullTimestamp(EXPIRES_AT)} (in 8 min)`)
  })

  it('counts down the time left while the request is pending, without reading it again', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-15T12:02:30Z'))
    const admin = await renderRequest()
    expect(row('Expires')).toContain('in 8 min')

    await act(async () => { await vi.advanceTimersByTimeAsync(45_000) })

    expect(row('Expires')).toContain('in 7 min')

    await act(async () => { await vi.advanceTimersByTimeAsync(7 * 60_000 - 20_000) })

    expect(row('Expires')).toContain('in 1 min')
    expect(admin.getWorkspaceWrite).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(15_000) })

    expect(row('Expires')).toContain('any moment now')
  })

  it('warns that a destructive write cannot be undone, and only such a write', async () => {
    await renderRequest({ action: 'deleteWorkspace', args: {} })
    expect(text()).toContain(UNDONE)
    await unmount()

    await renderRequest({ action: 'stopAgent', args: { chatId: 3 } })
    expect(text()).not.toContain(UNDONE)
    await unmount()

    await renderRequest({ action: 'revertGadget', args: { gadgetId: 5, commitId: 'a'.repeat(40) } })
    expect(text()).not.toContain(UNDONE)
  })

  it('styles the approval of a destructive write as destructive, and only such a write’s', async () => {
    await renderRequest({ action: 'deleteWorkspace', args: {} })
    const destructive = styling(button('Approve with passkey'))
    await unmount()
    await renderRequest({ action: 'stopAgent', args: { chatId: 3 } })
    const harmless = styling(button('Approve with passkey'))

    expect(destructive).toEqual(await kumoButtonStyling('destructive'))
    expect(harmless).toEqual(await kumoButtonStyling('primary'))
    expect(destructive).not.toEqual(harmless)
  })

  it.each<[AdminWriteRequest['action'], AdminWriteRequest['args'], string]>([
    ['retryAgent', { chatId: 3 }, 'so the owner pays for it'],
    ['addCollaborator', { username: 'carol', grant: 'workspace' }, 'as if the owner had added them'],
    ['deleteWorkspace', {}, 'only the audit log keeps who deleted it and why'],
    ['rejectPendingActions', {}, 'that connection is removed, with everything queued on it'],
  ])('says what approving a %s brings about', async (action, args, consequence) => {
    await renderRequest({ action, args })

    expect(text()).toContain(consequence)
  })

  it('states no consequence for a write that has none to state', async () => {
    await renderRequest()

    for (const consequence of Object.values(WRITE_CONSEQUENCES)) expect(text()).not.toContain(consequence)
  })
})

// Whether each of these was last called after the one before it.
const calledInOrder = (...fns: { mock: { invocationCallOrder: number[] } }[]) => {
  const order = fns.map(({ mock }) => mock.invocationCallOrder.at(-1) ?? Number.NaN)
  return order.every((at, index) => index === 0 || at > order[index - 1])
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settle) => { resolve = settle })
  return { promise, resolve }
}

describe('approving a request', () => {
  it('has the passkey answer the request’s challenge, sends the answer and shows what came of it', async () => {
    const admin = await renderRequest()

    await click(button('Approve with passkey'))

    expect(admin.beginWorkspaceWriteApproval).toHaveBeenCalledExactlyOnceWith(REQUEST_ID)
    expect(mocks.assertPasskey).toHaveBeenCalledExactlyOnceWith(CHALLENGE)
    expect(admin.approveWorkspaceWrite).toHaveBeenCalledExactlyOnceWith(REQUEST_ID, ASSERTION)
    expect(calledInOrder(admin.beginWorkspaceWriteApproval, mocks.assertPasskey, admin.approveWorkspaceWrite)).toBe(true)
    expect(outcome()?.textContent).toBe('Applied')
    expect(findButton('Approve with passkey')).toBeUndefined()
    expect(findButton('Deny')).toBeUndefined()
    expect(document.activeElement).toBe(outcome())
  })

  it('shows what the workspace reported of an applied write', async () => {
    const admin = await renderRequest({ action: 'rejectPendingActions', args: {} })
    admin.approveWorkspaceWrite.mockImplementation(async () => (
      { ...admin.held.request, state: 'applied', resolvedBy: 'alice', outcome: 'Rejected 3 actions.' }))

    await click(button('Approve with passkey'))

    expect(outcome()?.textContent).toBe('AppliedRejected 3 actions.')
  })

  it('shows why an approved write failed', async () => {
    const admin = await renderRequest()
    admin.approveWorkspaceWrite.mockImplementation(async () => (
      { ...admin.held.request, state: 'failed', resolvedBy: 'alice', error: 'The chat no longer exists.' }))

    await click(button('Approve with passkey'))

    expect(outcome()?.textContent).toBe('FailedThe chat no longer exists.')
    expect(findButton('Approve with passkey')).toBeUndefined()
  })

  it('disables both buttons while an approval runs', async () => {
    const admin = await renderRequest()
    const challenge = deferred<AdminPasskeyChallenge>()
    admin.beginWorkspaceWriteApproval.mockReturnValue(challenge.promise)

    await click(button('Approve with passkey'))

    expect(button('Approve with passkey').disabled).toBe(true)
    expect(button('Deny').disabled).toBe(true)

    await act(async () => { challenge.resolve(CHALLENGE) })

    expect(outcome()?.textContent).toBe('Applied')
  })

  it('sends an admin without a passkey to the Access tab to enrol one', async () => {
    const admin = await renderRequest()
    admin.beginWorkspaceWriteApproval.mockRejectedValue(createAdminWriteError(ADMIN_WRITE_ERROR_CODES.passkeyRequired))

    await click(button('Approve with passkey'))

    expect(alertText()).toContain('Enrol a passkey first')
    expect(link('Enrol a passkey first')?.getAttribute('href')).toBe('/admin?tab=access')
    expect(mocks.assertPasskey).not.toHaveBeenCalled()
    expect(button('Approve with passkey').disabled).toBe(false)
  })

  it('says a refused confirmation was not accepted, and starts over on the next try', async () => {
    const admin = await renderRequest()
    admin.approveWorkspaceWrite.mockRejectedValueOnce(createAdminWriteError(ADMIN_WRITE_ERROR_CODES.passkeyRefused))

    await click(button('Approve with passkey'))

    expect(alertText()).toBe('The passkey confirmation was not accepted. Try again.')
    expect(outcome()?.textContent).toBe('')

    // The refusal was of that attempt, so it is gone while the next one runs.
    const challenge = deferred<AdminPasskeyChallenge>()
    admin.beginWorkspaceWriteApproval.mockReturnValueOnce(challenge.promise)
    await click(button('Approve with passkey'))

    expect(admin.beginWorkspaceWriteApproval).toHaveBeenCalledTimes(2)
    expect(button('Approve with passkey').disabled).toBe(true)
    expect(alertText()).toBeUndefined()

    await act(async () => { challenge.resolve(CHALLENGE) })

    expect(alertText()).toBeUndefined()
    expect(outcome()?.textContent).toBe('Applied')
  })

  it('leaves the page as it was when the passkey prompt is dismissed', async () => {
    const admin = await renderRequest()
    mocks.assertPasskey.mockRejectedValue(new PasskeyCeremonyError('cancelled'))

    await click(button('Approve with passkey'))

    expect(admin.approveWorkspaceWrite).not.toHaveBeenCalled()
    expect(button('Approve with passkey').disabled).toBe(false)
    expect(button('Deny').disabled).toBe(false)
    expect(alertText()).toBeUndefined()
    expect(outcome()?.textContent).toBe('')
  })

  it('gives focus back to the button once a dismissed prompt leaves the request pending', async () => {
    await renderRequest()
    let dismiss!: (err: unknown) => void
    mocks.assertPasskey.mockReturnValue(new Promise((_resolve, reject) => { dismiss = reject }))
    const approve = button('Approve with passkey')
    await act(async () => { approve.focus() })

    await click(approve)
    await dropFocus()
    expect(approve.disabled).toBe(true)
    expect(document.activeElement).toBe(document.body)

    await act(async () => { dismiss(new PasskeyCeremonyError('cancelled')) })

    expect(document.activeElement).toBe(button('Approve with passkey'))
  })

  it('leaves focus where the admin moved it while the prompt was open', async () => {
    await renderRequest()
    let dismiss!: (err: unknown) => void
    mocks.assertPasskey.mockReturnValue(new Promise((_resolve, reject) => { dismiss = reject }))
    const approve = button('Approve with passkey')
    await act(async () => { approve.focus() })

    await click(approve)
    await act(async () => { link(AUDIT_LINK)?.focus() })
    expect(document.activeElement).toBe(link(AUDIT_LINK))

    await act(async () => { dismiss(new PasskeyCeremonyError('cancelled')) })

    expect(button('Approve with passkey').disabled).toBe(false)
    expect(document.activeElement).toBe(link(AUDIT_LINK))
  })

  it('says so where the browser cannot use passkeys', async () => {
    const admin = await renderRequest()
    mocks.assertPasskey.mockRejectedValue(new PasskeyCeremonyError('unsupported'))

    await click(button('Approve with passkey'))

    expect(alertText()).toBe('This browser cannot use passkeys here.')
    expect(admin.approveWorkspaceWrite).not.toHaveBeenCalled()
  })

  it('reads the request again when it turns out to be no longer pending', async () => {
    const admin = await renderRequest()
    admin.beginWorkspaceWriteApproval.mockImplementation(async () => {
      admin.held.request = { ...admin.held.request, state: 'expired' }
      throw createAdminWriteError(ADMIN_WRITE_ERROR_CODES.requestNotPending)
    })

    await click(button('Approve with passkey'))

    expect(admin.getWorkspaceWrite).toHaveBeenCalledTimes(2)
    expect(outcome()?.textContent).toBe('Expired')
    expect(findButton('Approve with passkey')).toBeUndefined()
    expect(alertText()).toBeUndefined()
    expect(document.activeElement).toBe(outcome())
  })

  it('shows the server’s account of any other refusal', async () => {
    const admin = await renderRequest()
    admin.approveWorkspaceWrite.mockRejectedValue(createAdminWriteError(ADMIN_WRITE_ERROR_CODES.workspaceChanged))

    await click(button('Approve with passkey'))

    expect(alertText()).toContain('no longer belongs to the owner the request named')
    expect(button('Approve with passkey').disabled).toBe(false)
  })

  it('says the approval could not be made when the failure has no account worth showing', async () => {
    const admin = await renderRequest()
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    admin.approveWorkspaceWrite.mockRejectedValue(new Error('Peer closed WebSocket'))

    await click(button('Approve with passkey'))

    expect(alertText()).toBe('Couldn’t approve the write.')
  })

  it('says no longer that the approval failed once the request is found applied', async () => {
    const admin = await renderRequest()
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    // The connection drops after the server applied the write, so its answer never arrives.
    admin.approveWorkspaceWrite.mockImplementation(async () => {
      admin.held.request = { ...admin.held.request, state: 'applied', resolvedBy: 'alice' }
      throw new Error('Peer closed WebSocket')
    })
    await click(button('Approve with passkey'))
    expect(alertText()).toBe('Couldn’t approve the write.')

    await reconnect(fakeAdmin(admin.held.request))

    expect(outcome()?.textContent).toBe('Applied')
    expect(findButton('Approve with passkey')).toBeUndefined()
    expect(alertText()).toBeUndefined()
  })
})

describe('denying a request', () => {
  it('denies it, reads it again and shows who denied it', async () => {
    const admin = await renderRequest()

    await click(button('Deny'))

    expect(admin.denyWorkspaceWrite).toHaveBeenCalledExactlyOnceWith(REQUEST_ID)
    expect(admin.getWorkspaceWrite).toHaveBeenCalledTimes(2)
    expect(calledInOrder(admin.denyWorkspaceWrite, admin.getWorkspaceWrite)).toBe(true)
    expect(admin.beginWorkspaceWriteApproval).not.toHaveBeenCalled()
    expect(outcome()?.textContent).toBe('Denied by alice')
    expect(findButton('Approve with passkey')).toBeUndefined()
    expect(findButton('Deny')).toBeUndefined()
    expect(document.activeElement).toBe(outcome())
  })

  it('disables both buttons while a denial runs', async () => {
    const admin = await renderRequest()
    const denied = deferred<void>()
    admin.denyWorkspaceWrite.mockReturnValue(denied.promise)

    await click(button('Deny'))

    expect(button('Approve with passkey').disabled).toBe(true)
    expect(button('Deny').disabled).toBe(true)

    admin.held.request = { ...admin.held.request, state: 'denied', resolvedBy: 'alice' }
    await act(async () => { denied.resolve() })

    expect(outcome()?.textContent).toBe('Denied by alice')
  })

  it('says the request is no longer pending when it cannot be read after the denial', async () => {
    const admin = await renderRequest()
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    admin.getWorkspaceWrite.mockRejectedValue(new Error('Peer closed WebSocket'))

    await click(button('Deny'))

    expect(admin.denyWorkspaceWrite).toHaveBeenCalledOnce()
    expect(alertText()).toContain('This request is no longer pending')
    expect(alertText()).not.toContain('deny')

    await reconnect(fakeAdmin(admin.held.request))

    expect(outcome()?.textContent).toBe('Denied by alice')
    expect(alertText()).toBeUndefined()
  })

  it('says the denial could not be made when the failure has no account worth showing', async () => {
    const admin = await renderRequest()
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    admin.denyWorkspaceWrite.mockRejectedValue(new Error('Peer closed WebSocket'))

    await click(button('Deny'))

    expect(alertText()).toBe('Couldn’t deny the write.')
    expect(button('Deny').disabled).toBe(false)
  })

  it('shows why a denial was refused', async () => {
    const admin = await renderRequest()
    admin.denyWorkspaceWrite.mockRejectedValue(new Error('The audit log could not be written.'))

    await click(button('Deny'))

    expect(alertText()).toBe('The audit log could not be written.')
    expect(button('Deny').disabled).toBe(false)
    expect(outcome()?.textContent).toBe('')
  })
})

describe('a request that is no longer pending', () => {
  it.each<[Partial<AdminWriteRequest>, string]>([
    [{ state: 'expired' }, 'Expired'],
    [{ state: 'expired', error: 'The requester is no longer an admin.' }, 'ExpiredThe requester is no longer an admin.'],
    [{ state: 'denied', resolvedBy: 'carol' }, 'Denied by carol'],
    [{ state: 'applied', resolvedBy: 'carol' }, 'Applied'],
    [{ state: 'failed', resolvedBy: 'carol', error: 'The chat no longer exists.' }, 'FailedThe chat no longer exists.'],
  ])('shows what became of it and offers nothing to approve: %o', async (resolved, shown) => {
    await renderRequest({ action: 'deleteWorkspace', args: {}, ...resolved })

    expect(outcome()?.textContent).toBe(shown)
    expect(findButton('Approve with passkey')).toBeUndefined()
    expect(findButton('Deny')).toBeUndefined()
    expect(text()).not.toContain('You are approving as')
    expect(text()).not.toContain(UNDONE)
    expect(text()).not.toContain(WRITE_CONSEQUENCES.deleteWorkspace)
    // The time it expired, or would have, stays. No time is left to count.
    expect(expiry()?.dateTime).toBe('2026-01-15T12:10:00.000Z')
    expect(row('Expires')).toBe(formatFullTimestamp(EXPIRES_AT))
    // Focus follows a request this page saw resolved, not one it found so.
    expect(document.activeElement).toBe(document.body)
  })

  it('reads an approved request again until the workspace has answered', async () => {
    vi.useFakeTimers()
    const admin = await renderRequest({ state: 'approved', resolvedBy: 'carol' })

    expect(outcome()?.textContent).toBe('Approved by carol. The workspace is running it.')
    expect(findButton('Approve with passkey')).toBeUndefined()
    expect(admin.getWorkspaceWrite).toHaveBeenCalledTimes(1)

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })

    expect(admin.getWorkspaceWrite).toHaveBeenCalledTimes(2)
    expect(outcome()?.textContent).toBe('Approved by carol. The workspace is running it.')

    admin.held.request = { ...admin.held.request, state: 'applied', outcome: 'Deleted the workspace.' }
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })

    expect(outcome()?.textContent).toBe('AppliedDeleted the workspace.')

    await act(async () => { await vi.advanceTimersByTimeAsync(30_000) })

    expect(admin.getWorkspaceWrite).toHaveBeenCalledTimes(3)
  })

  it('keeps reading an approved request after a reading fails', async () => {
    vi.useFakeTimers()
    vi.spyOn(console, 'debug').mockImplementation(() => {})
    const admin = await renderRequest({ state: 'approved', resolvedBy: 'carol' })
    admin.getWorkspaceWrite.mockRejectedValueOnce(new Error('Peer closed WebSocket'))

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })

    expect(outcome()?.textContent).toBe('Approved by carol. The workspace is running it.')

    admin.held.request = { ...admin.held.request, state: 'failed', error: 'Its answer never arrived.' }
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })

    expect(outcome()?.textContent).toBe('FailedIts answer never arrived.')
  })

  it('waits for a reading that takes longer than the time between readings, and shows it', async () => {
    vi.useFakeTimers()
    const admin = await renderRequest({ state: 'approved', resolvedBy: 'carol' })
    admin.getWorkspaceWrite.mockImplementation(async () => {
      const found = admin.held.request
      await new Promise((resolve) => { setTimeout(resolve, 6_000) })
      return found
    })

    // A reading starts after 5 s and answers after 11 s. None starts in between.
    await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
    admin.held.request = { ...admin.held.request, state: 'applied' }
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })

    expect(admin.getWorkspaceWrite).toHaveBeenCalledTimes(2)
    expect(outcome()?.textContent).toBe('Approved by carol. The workspace is running it.')

    // The next starts after 15 s and answers after 21 s.
    await act(async () => { await vi.advanceTimersByTimeAsync(4_000) })

    expect(admin.getWorkspaceWrite).toHaveBeenCalledTimes(3)

    await act(async () => { await vi.advanceTimersByTimeAsync(6_000) })

    expect(outcome()?.textContent).toBe('Applied')
  })

  it('stops reading an approved request once the page is left', async () => {
    vi.useFakeTimers()
    const admin = await renderRequest({ state: 'approved', resolvedBy: 'carol' })

    await unmount()
    await vi.advanceTimersByTimeAsync(30_000)

    expect(admin.getWorkspaceWrite).toHaveBeenCalledTimes(1)
  })
})

describe('a pending request whose time has passed', () => {
  it('is read again until the server has ended it, and then offers nothing to approve', async () => {
    const admin = await renderRequestRunningOut()

    expect(row('Expires')).toContain('any moment now')
    expect(admin.getWorkspaceWrite).toHaveBeenCalledTimes(1)

    // The server's clock runs behind the page's, so it still holds the request pending.
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })

    expect(admin.getWorkspaceWrite).toHaveBeenCalledTimes(2)
    expect(button('Approve with passkey').disabled).toBe(false)

    admin.held.request = { ...admin.held.request, state: 'expired' }
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })

    expect(outcome()?.textContent).toBe('Expired')
    expect(row('Expires')).toBe(formatFullTimestamp(EXPIRES_AT))
    expect(findButton('Approve with passkey')).toBeUndefined()
    expect(findButton('Deny')).toBeUndefined()

    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })

    expect(admin.getWorkspaceWrite).toHaveBeenCalledTimes(3)
  })

  it('gives its ending the focus a button had', async () => {
    const admin = await renderRequestRunningOut()
    await act(async () => { button('Deny').focus() })

    admin.held.request = { ...admin.held.request, state: 'expired' }
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })

    expect(document.activeElement).toBe(outcome())
  })

  it('leaves focus where it is elsewhere on the page', async () => {
    const admin = await renderRequestRunningOut()
    await act(async () => { link(AUDIT_LINK)?.focus() })

    admin.held.request = { ...admin.held.request, state: 'expired' }
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })

    expect(outcome()?.textContent).toBe('Expired')
    expect(document.activeElement).toBe(link(AUDIT_LINK))
  })

  it('stops counting down and reading once the page is left', async () => {
    const admin = await renderRequestRunningOut()
    expect(vi.getTimerCount()).toBeGreaterThan(0)

    await unmount()

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(admin.getWorkspaceWrite).toHaveBeenCalledTimes(1)
  })

  it('shows a denial, not a reading of the request that began before it', async () => {
    const admin = await renderRequestRunningOut()
    const before = deferred<AdminWriteRequest>()
    admin.getWorkspaceWrite.mockReturnValueOnce(before.promise)
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000) })
    expect(admin.getWorkspaceWrite).toHaveBeenCalledTimes(2)

    await click(button('Deny'))

    expect(outcome()?.textContent).toBe('Denied by alice')

    await act(async () => { before.resolve(writeRequest()) })

    expect(outcome()?.textContent).toBe('Denied by alice')
    expect(findButton('Deny')).toBeUndefined()
  })
})

describe('loading a request', () => {
  it('tells a visitor who is not an admin that they have no access', async () => {
    await renderPage(null)

    expect(text()).toContain("You don't have access to this page.")
    expect(findButton('Approve with passkey')).toBeUndefined()
  })

  it('asks for the request and the settings together', async () => {
    const admin = fakeAdmin(writeRequest())
    const found = deferred<AdminWriteRequest>()
    admin.getWorkspaceWrite.mockReturnValue(found.promise)

    await renderPage(admin)

    expect(admin.getWorkspaceWrite).toHaveBeenCalledExactlyOnceWith(REQUEST_ID)
    expect(admin.getSettings).toHaveBeenCalledOnce()
    expect(row('Action')).toBeUndefined()
    expect(loader()).not.toBeNull()

    await act(async () => { found.resolve(writeRequest()) })

    expect(row('Action')).toBe('Stop the agent')
    expect(loader()).toBeNull()
  })

  it('shows nothing of a request read over a session that a reconnect has replaced', async () => {
    const before = fakeAdmin(writeRequest())
    const found = deferred<AdminWriteRequest>()
    before.getWorkspaceWrite.mockReturnValue(found.promise)
    await renderPage(before)

    await reconnect(fakeAdmin(writeRequest({ state: 'denied', resolvedBy: 'carol' })))

    expect(before[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(outcome()?.textContent).toBe('Denied by carol')

    await act(async () => { found.resolve(writeRequest()) })

    expect(outcome()?.textContent).toBe('Denied by carol')
    expect(findButton('Approve with passkey')).toBeUndefined()
  })

  it.each([true, false])(
    'names the environment variable while writes are off (settings answered: %s)', async (settingsAnswer) => {
      const admin = fakeAdmin(writeRequest())
      admin.getWorkspaceWrite.mockRejectedValue(createAdminWriteError(ADMIN_WRITE_ERROR_CODES.writesOff))
      if (!settingsAnswer) admin.getSettings.mockRejectedValue(new Error('The settings could not be read.'))

      await renderPage(admin)

      expect(text()).toContain('turned off on this deployment')
      expect(text()).toContain('ADMIN_WORKSPACE_WRITES')
      expect(alertText()).toBeUndefined()
    })

  it('says there is no such request, and links the audit log', async () => {
    const admin = fakeAdmin(writeRequest())
    admin.getWorkspaceWrite.mockRejectedValue(createAdminWriteError(ADMIN_WRITE_ERROR_CODES.requestNotFound))

    await renderPage(admin)

    expect(text()).toContain('No such write request.')
    expect(link('audit log')?.getAttribute('href')).toBe('/admin?tab=audit')
  })

  it('shows no request whose access level it could not read', async () => {
    const admin = fakeAdmin(writeRequest({ action: 'deleteGadget', args: { gadgetId: 5 } }))
    admin.getSettings.mockRejectedValue(new Error('The settings could not be read.'))

    await renderPage(admin)

    expect(alertText()).toBe('Couldn’t load the write request. The settings could not be read.')
    expect(row('Action')).toBeUndefined()
    expect(findButton('Approve with passkey')).toBeUndefined()
    expect(text()).not.toContain('inspect the workspace')
  })

  it('shows a request that could not be read as a failed load', async () => {
    const admin = fakeAdmin(writeRequest())
    admin.getWorkspaceWrite.mockRejectedValue(new Error('The request store could not be read.'))

    await renderPage(admin)

    expect(alertText()).toBe('Couldn’t load the write request. The request store could not be read.')
  })

  it('disposes the admin capability when the page is left', async () => {
    const admin = await renderRequest()
    expect(admin[Symbol.dispose]).not.toHaveBeenCalled()

    await unmount()

    expect(admin[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('disposes an admin capability that arrives after the page is left', async () => {
    const admin = fakeAdmin(writeRequest())
    const minted = deferred<FakeAdmin | null>()
    await renderPage(minted.promise)

    await unmount()
    await act(async () => { minted.resolve(admin) })

    expect(admin[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(admin.getWorkspaceWrite).not.toHaveBeenCalled()
  })
})
