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
  ADMIN_ACCESS_ERROR_CODES,
  ADMIN_GRANT_ERROR_CODES,
  createAdminAccessError,
  createAdminGrantError,
  MAX_ADMIN_GRANTS_LISTED,
  type AdminAccessGrant,
  type AdminApi,
  type AdminContentRequest,
  type AdminSettingsView,
  type AdminWorkspaceAccess,
  type AdminWorkspaceDescription,
} from '@gadgets/workshop-shared/api'

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
  }
})

vi.mock('../../AuthContext', async () => {
  const { useSyncExternalStore } = await import('react')
  return {
    useAuthenticatedApi: () => ({
      authenticatedApi: useSyncExternalStore(mocks.subscribeToApi, () => mocks.authenticatedApi),
      currentUser: { type: 'user', id: 'alice', name: 'Alice' },
    }),
  }
})

import { formatFullTimestamp } from '../../utils/formatTimestamp'
import AdminWorkspacePage from './AdminWorkspacePage'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const WORKSPACE_ID = 'ws-1'
const VIEW_EXPIRES_AT = new Date('2026-01-15T12:15:00Z')
const REASON_LABEL = 'Why are you looking at this workspace?'
const REQUEST_LABEL = 'Why do admins need to read this workspace’s content?'
const END_LABEL = 'Why are you ending this access?'

const ownerGrant = (overrides: Partial<AdminAccessGrant> = {}): AdminAccessGrant => ({
  id: 'grant-owner-1',
  level: 'content',
  source: 'owner',
  scope: 'workspace',
  grantedBy: { id: 'profile-olive', name: 'Olive Owner' },
  grantedAt: new Date('2026-01-15T10:00:00Z'),
  expiresAt: new Date('2026-01-18T10:00:00Z'),
  ...overrides,
})

const adminsGrant = (overrides: Partial<AdminAccessGrant> = {}): AdminAccessGrant => ({
  id: 'grant-admins-1',
  level: 'content',
  source: 'admins',
  scope: 'workspace',
  grantedBy: { id: 'profile-grace', name: 'Grace Approver' },
  requestedBy: 'bob@example.com',
  requestId: 'req-3',
  reason: 'The owner is away and their agent is leaking a token.',
  grantedAt: new Date('2026-01-14T09:00:00Z'),
  expiresAt: new Date('2026-01-17T09:00:00Z'),
  ...overrides,
})

const describedWith = (grants: AdminAccessGrant[], title = 'Quarterly numbers') => ({
  id: WORKSPACE_ID,
  title,
  owner: { type: 'user', id: 'profile-olive', name: 'Olive Owner' },
  access: 'metadata',
  grants,
  expiresAt: VIEW_EXPIRES_AT,
}) as AdminWorkspaceDescription

const contentRequest = (reason: string): AdminContentRequest => ({
  id: 'req-9',
  workspaceId: WORKSPACE_ID,
  workspaceTitle: 'Quarterly numbers',
  workspaceOwner: 'olive@example.com',
  reason,
  requestedBy: 'alice',
  via: 'api',
  requestedAt: new Date('2026-01-15T12:00:00Z'),
  expiresAt: new Date('2026-01-16T12:00:00Z'),
  state: 'pending',
})

// A view as inspectWorkspace() hands it over: the promise of one, on which describe() is called
// before the open has answered, and which is disposed in the view's place.
const fakeView = (described: () => Promise<AdminWorkspaceDescription>) => ({
  describe: vi.fn<() => Promise<AdminWorkspaceDescription>>(described),
  [Symbol.dispose]: vi.fn<() => void>(),
})

// An AdminApi over one workspace, which holds its grants as the server does: a grant ended is gone
// from the next description.
const fakeAdmin = ({ grants = [], access = 'content' }: {
  grants?: AdminAccessGrant[]
  access?: AdminWorkspaceAccess
} = {}) => {
  const held = { grants }
  const views: ReturnType<typeof fakeView>[] = []
  return {
    held,
    views,
    getSettings: vi.fn<() => Promise<Pick<AdminSettingsView, 'adminWorkspaceAccess'>>>(
      async () => ({ adminWorkspaceAccess: { effective: access, chosen: access, max: access } })),
    inspectWorkspace: vi.fn<(...args: Parameters<AdminApi['inspectWorkspace']>) => ReturnType<typeof fakeView>>(() => {
      const view = fakeView(async () => describedWith(held.grants))
      views.push(view)
      return view
    }),
    endWorkspaceGrant: vi.fn<AdminApi['endWorkspaceGrant']>(async (_workspaceId, grantId) => {
      held.grants = held.grants.filter((grant) => grant.id !== grantId)
    }),
    requestContentAccess: vi.fn<AdminApi['requestContentAccess']>(
      async (_workspaceId, reason) => contentRequest(reason)),
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
const renderPage = async (admin: FakeAdmin | null) => {
  mocks.authenticatedApi.getAdminApi.mockReturnValue(Promise.resolve(admin))
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
  return admin
}

const text = () => document.body.textContent ?? ''
const alerts = () => [...document.body.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent)

// A button by its accessible name, on the page or in the dialog it opens.
const findButton = (name: string) => [...document.body.querySelectorAll('button')]
  .find((element) => (element.getAttribute('aria-label') ?? element.textContent?.trim()) === name)
const button = (name: string) => {
  const element = findButton(name)
  if (!element) throw new Error(`no button ${name}`)
  return element
}
const click = (element: HTMLElement) => act(async () => { element.click() })

const field = (label: string) => {
  const control = [...document.body.querySelectorAll('label')]
    .find((element) => element.textContent?.startsWith(label))?.control
  if (!(control instanceof HTMLInputElement)) throw new Error(`no field ${label}`)
  return control
}
const type = (label: string, value: string) => act(async () => {
  const element = field(label)
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(element, value)
  element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
})

// Opens the workspace for `reason`, as an admin does.
const openWorkspace = async (reason = 'Ticket 42: the agent is stuck') => {
  await type(REASON_LABEL, reason)
  await click(button('Open'))
}

const renderOpened = async (options: Parameters<typeof fakeAdmin>[0] = {}) => {
  const admin = fakeAdmin(options)
  await renderPage(admin)
  await openWorkspace()
  return admin
}

// The grants listed, each as its row.
const grantRows = () => [...document.body.querySelectorAll<HTMLElement>('ul > li')]
// What a row, or the workspace's own list, says under `term`.
const detail = (within: Element, term: string) => [...within.querySelectorAll('dt')]
  .find((dt) => dt.textContent === term)?.nextElementSibling?.textContent ?? null
const rowOf = (grantId: string) => {
  const row = grantRows().find((each) => detail(each, 'Grant') === grantId)
  if (!row) throw new Error(`no row for grant ${grantId}`)
  return row
}

const dialog = () => document.body.querySelector('[role="dialog"]')

const link = (name: string) => [...document.querySelectorAll('a')]
  .find((element) => element.textContent?.trim() === name)

const BOUND_NOTE = `Showing ${MAX_ADMIN_GRANTS_LISTED} live grants.`

beforeEach(() => {
  vi.stubGlobal('scrollTo', vi.fn<() => void>())
  // An unexpected failure is logged as well as shown.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  await unmount()
  container?.remove()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  mocks.authenticatedApi.getAdminApi.mockReset()
})

describe('opening a workspace', () => {
  it('needs a reason, and says so', async () => {
    const admin = await renderPage(fakeAdmin())

    expect(button('Open').disabled).toBe(true)
    const described = field(REASON_LABEL).getAttribute('aria-describedby')?.split(' ')
      .map((id) => document.getElementById(id)?.textContent).join(' ')
    expect(described).toContain('A reason is required.')

    await type(REASON_LABEL, '   ')
    expect(button('Open').disabled).toBe(true)
    expect(admin?.inspectWorkspace).not.toHaveBeenCalled()

    await type(REASON_LABEL, 'Ticket 42')
    expect(button('Open').disabled).toBe(false)
  })

  it('opens a metadata view for the reason typed, trimmed, and asks it what the workspace is', async () => {
    const admin = await renderOpened()

    // No options: a view is opened for metadata unless content is asked for, and this page never asks.
    expect(admin.inspectWorkspace.mock.calls).toEqual([[WORKSPACE_ID, 'Ticket 42: the agent is stuck']])
    expect(admin.views[0].describe).toHaveBeenCalledOnce()
    const workspace = document.querySelector('dl')!
    expect(detail(workspace, 'Workspace')).toBe(`Quarterly numbers${WORKSPACE_ID}`)
    expect(detail(workspace, 'Owner')).toBe('Olive Ownerprofile-olive')
    expect(detail(workspace, 'View expires')).toBe(formatFullTimestamp(VIEW_EXPIRES_AT))
    expect(document.querySelector('dl time')?.getAttribute('datetime')).toBe(VIEW_EXPIRES_AT.toISOString())
  })

  it('shows nothing of the workspace before it is opened', async () => {
    const admin = await renderPage(fakeAdmin({ grants: [adminsGrant()] }))

    expect(admin?.inspectWorkspace).not.toHaveBeenCalled()
    expect(text()).not.toContain('Access grants')
    expect(text()).not.toContain('grant-admins-1')
  })

  it('calls a workspace without a title untitled', async () => {
    const admin = fakeAdmin()
    admin.inspectWorkspace.mockImplementation(() => fakeView(async () => describedWith([], '')))
    await renderPage(admin)
    await openWorkspace()

    expect(detail(document.querySelector('dl')!, 'Workspace')).toBe(`Untitled${WORKSPACE_ID}`)
  })

  it.each([
    ADMIN_ACCESS_ERROR_CODES.accessOff,
    ADMIN_ACCESS_ERROR_CODES.workspaceNotFound,
    ADMIN_ACCESS_ERROR_CODES.notAdmin,
  ])('shows the server’s message for an open refused %s, and disposes the view it never got', async (code) => {
    const refusal = createAdminAccessError(code)
    const refused = fakeView(() => Promise.reject(refusal))
    const admin = fakeAdmin()
    admin.inspectWorkspace.mockReturnValue(refused)
    await renderPage(admin)

    await openWorkspace()

    expect(alerts()).toEqual([refusal.message])
    expect(refused[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(text()).not.toContain('Access grants')
    // A refusal the server names is the admin's to act on, not a fault to log.
    expect(console.error).not.toHaveBeenCalled()
    expect(button('Open').disabled).toBe(false)
  })

  it('shows the server’s account of any other failure, and logs it', async () => {
    const admin = fakeAdmin()
    admin.inspectWorkspace.mockReturnValue(fakeView(() => Promise.reject(new Error('The workspace is overloaded'))))
    await renderPage(admin)

    await openWorkspace()

    expect(alerts()).toEqual(['The workspace is overloaded'])
    expect(console.error).toHaveBeenCalled()
  })

  it('drops a refusal once the workspace opens, and disposes the view an open replaces', async () => {
    const admin = fakeAdmin()
    admin.inspectWorkspace.mockReturnValueOnce(
      fakeView(() => Promise.reject(createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.accessOff))))
    await renderPage(admin)
    await openWorkspace()
    expect(alerts()).toHaveLength(1)

    await click(button('Open'))
    expect(alerts()).toEqual([])
    expect(text()).toContain('Access grants')

    await click(button('Open'))
    expect(admin.views).toHaveLength(2)
    expect(admin.views[0][Symbol.dispose]).toHaveBeenCalledOnce()
    expect(admin.views[1][Symbol.dispose]).not.toHaveBeenCalled()
  })

  it('links the workspace’s records in the audit log, and says content is read elsewhere', async () => {
    await renderPage(fakeAdmin())

    expect(link('This workspace in the audit log')?.getAttribute('href'))
      .toBe(`/admin?tab=audit&workspace=${WORKSPACE_ID}`)
    expect(text()).toContain('This page shows no content')
  })
})

describe('the admin view’s lifetime', () => {
  it('disposes the view and the admin capability when the page is left', async () => {
    const admin = await renderOpened()

    await unmount()

    expect(admin.views[0][Symbol.dispose]).toHaveBeenCalledOnce()
    expect(admin[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('disposes a view that arrives after the page is left', async () => {
    let answer!: (description: AdminWorkspaceDescription) => void
    const late = fakeView(() => new Promise((resolve) => { answer = resolve }))
    const admin = fakeAdmin()
    admin.inspectWorkspace.mockReturnValue(late)
    await renderPage(admin)
    await openWorkspace()

    await unmount()
    await act(async () => { answer(describedWith([])) })

    expect(late[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('closes a view opened over a session that a reconnect has replaced', async () => {
    const admin = await renderOpened({ grants: [adminsGrant()] })
    expect(text()).toContain('grant-admins-1')
    const next = fakeAdmin()

    await act(async () => {
      mocks.authenticatedApi = { getAdminApi: vi.fn<() => Promise<unknown>>().mockResolvedValue(next) }
      for (const listener of mocks.apiListeners) listener()
    })

    expect(admin.views[0][Symbol.dispose]).toHaveBeenCalledOnce()
    expect(admin[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(text()).not.toContain('grant-admins-1')
    expect(next.inspectWorkspace).not.toHaveBeenCalled()
  })

  it('tells a visitor who is not an admin that they have no access', async () => {
    await renderPage(null)

    expect(text()).toContain("You don't have access to this page.")
    expect(findButton('Open')).toBeUndefined()
    expect(findButton('Request content access')).toBeUndefined()
  })

  it('keeps the workspace and its grants within reach when the settings cannot be read', async () => {
    const admin = fakeAdmin({ grants: [adminsGrant()] })
    admin.getSettings.mockRejectedValue(new Error('The settings store is unavailable'))
    await renderPage(admin)

    // Only the content-request form needs the settings, and only it says they failed.
    expect(alerts()).toEqual(['Couldn’t read this deployment’s admin access level. The settings store is unavailable'])
    expect(button('Request content access').disabled).toBe(true)
    expect(field(REQUEST_LABEL).disabled).toBe(true)
    await openWorkspace()
    expect(rowOf('grant-admins-1').querySelector('button')?.textContent).toBe('End access')
  })

  it('opens a workspace while the settings are still being read, and asks for nothing until they are', async () => {
    const admin = fakeAdmin()
    admin.getSettings.mockReturnValue(new Promise(() => {}))
    await renderPage(admin)

    expect(field(REQUEST_LABEL).disabled).toBe(true)
    expect(alerts()).toEqual([])
    await openWorkspace()
    expect(text()).toContain('View expires')
  })
})

describe('an older backend', () => {
  it('shows the workspace when its description has no grants', async () => {
    const admin = fakeAdmin()
    admin.inspectWorkspace.mockImplementation(() => {
      const { grants: _grants, ...described } = describedWith([])
      const view = fakeView(async () => described as AdminWorkspaceDescription)
      admin.views.push(view)
      return view
    })
    await renderPage(admin)
    await openWorkspace()

    expect(text()).toContain('View expires')
    expect(grantRows()).toHaveLength(0)
  })
})

describe('the access grants', () => {
  it('shows each grant in a row of its own: its id, its source, who gave it and until when', async () => {
    const owner = ownerGrant()
    const admins = adminsGrant()
    await renderOpened({ grants: [admins, owner] })

    expect(grantRows()).toHaveLength(2)
    const ownerRow = rowOf('grant-owner-1')
    expect(detail(ownerRow, 'Source')).toBe('Owner')
    expect(detail(ownerRow, 'Given by')).toBe('Olive Ownerprofile-olive')
    expect(detail(ownerRow, 'Until')).toBe(formatFullTimestamp(owner.expiresAt))
    expect(ownerRow.querySelector('time')?.getAttribute('datetime')).toBe(owner.expiresAt.toISOString())
    // An owner asks nobody, and gives no reason.
    expect(detail(ownerRow, 'Asked for by')).toBeNull()
    expect(detail(ownerRow, 'Reason')).toBeNull()

    const adminsRow = rowOf('grant-admins-1')
    expect(detail(adminsRow, 'Source')).toBe('Second admin')
    expect(detail(adminsRow, 'Given by')).toBe('Grace Approverprofile-grace')
    expect(detail(adminsRow, 'Asked for by')).toBe('bob@example.com')
    expect(detail(adminsRow, 'Reason')).toBe('The owner is away and their agent is leaking a token.')
    expect(detail(adminsRow, 'Until')).toBe(formatFullTimestamp(admins.expiresAt))

    // Each id is in its own row and in no other.
    expect(ownerRow.textContent).not.toContain('grant-admins-1')
    expect(adminsRow.textContent).not.toContain('grant-owner-1')
  })

  it('shows a grant’s id whole, as plain text in a monospace face, and not as a control', async () => {
    const id = 'grant-0123456789abcdef0123456789abcdef0123456789abcdef'
    await renderOpened({ grants: [ownerGrant({ id })] })

    const shown = [...rowOf(id).querySelectorAll('dd span')].find((element) => element.textContent === id)
    expect(shown?.className).toContain('font-mono')
    expect(shown?.className).not.toContain('truncate')
    expect(shown?.closest('button, a, input')).toBeNull()
  })

  it('lists the grants in the order the workspace gives them, a second admin’s above a newer one of the owner’s', async () => {
    const newerOwner = ownerGrant({ id: 'grant-owner-newer', grantedAt: new Date('2026-01-15T11:00:00Z') })
    await renderOpened({ grants: [adminsGrant(), newerOwner, ownerGrant()] })

    expect(grantRows().map((row) => detail(row, 'Grant')))
      .toEqual(['grant-admins-1', 'grant-owner-newer', 'grant-owner-1'])
  })

  it('says when the workspace stores no live grant, and where the account-wide one and the audit log stand', async () => {
    await renderOpened()

    expect(text()).toContain('This workspace stores no live grant.')
    expect(text()).toContain('The owner’s grant for all of their workspaces is not listed here')
    expect(text()).toContain('An owner’s grant is not in the audit log either.')
    expect(text()).toContain('This list is where admins see it.')
    expect(text()).not.toContain(BOUND_NOTE)
  })

  it('says owner grants may be left out only when the list is as long as the workspace makes it', async () => {
    const full = [
      adminsGrant(),
      ...Array.from({ length: MAX_ADMIN_GRANTS_LISTED - 1 }, (_, index) => ownerGrant({ id: `grant-owner-${index}` })),
    ]
    const admin = await renderOpened({ grants: full.slice(1) })
    expect(grantRows()).toHaveLength(MAX_ADMIN_GRANTS_LISTED - 1)
    expect(text()).not.toContain(BOUND_NOTE)

    admin.held.grants = full
    await click(button('Open'))

    expect(grantRows()).toHaveLength(MAX_ADMIN_GRANTS_LISTED)
    expect(text()).toContain(
      'Showing 20 live grants. Every grant a second admin approved is listed; the workspace’s owner '
      + 'may have given more than the newest shown here.')
  })
})

const twoAdminsGrants = () => [
  adminsGrant(),
  adminsGrant({ id: 'grant-admins-2', requestedBy: 'carol@example.com' }),
  ownerGrant(),
]

describe('ending a grant', () => {
  it('offers End access on a grant a second admin approved, and never on the owner’s', async () => {
    await renderOpened({ grants: twoAdminsGrants() })

    expect(rowOf('grant-admins-1').querySelector('button')?.textContent).toBe('End access')
    expect(rowOf('grant-admins-2').querySelector('button')?.textContent).toBe('End access')
    expect(rowOf('grant-owner-1').querySelector('button')).toBeNull()
    // Each button is named by the grant it ends.
    expect(findButton('End access under grant grant-admins-2')).toBe(rowOf('grant-admins-2').querySelector('button'))
  })

  it('asks for a reason, ends that row’s grant for it, and lists the grants again', async () => {
    const admin = await renderOpened({ grants: twoAdminsGrants() })

    await click(button('End access under grant grant-admins-2'))
    expect(dialog()?.textContent).toContain('End this access?')
    expect(dialog()?.textContent).toContain('recorded in the audit log with your name and your reason')
    // The dialog's own button, which ends nothing without a reason.
    const confirm = () => [...dialog()!.querySelectorAll('button')].find((each) => each.textContent === 'End access')!
    expect(confirm().disabled).toBe(true)

    await type(END_LABEL, '  The owner is back and has given a grant.  ')
    await click(confirm())

    expect(admin.endWorkspaceGrant.mock.calls)
      .toEqual([[WORKSPACE_ID, 'grant-admins-2', 'The owner is back and has given a grant.']])
    expect(admin.views[0].describe).toHaveBeenCalledTimes(2)
    expect(grantRows().map((row) => detail(row, 'Grant'))).toEqual(['grant-admins-1', 'grant-owner-1'])
    expect(dialog()).toBeNull()
    // The same view is read again: nothing is opened for the reload.
    expect(admin.inspectWorkspace).toHaveBeenCalledOnce()
  })

  it('ends nothing when the dialog is cancelled, and asks afresh the next time', async () => {
    const admin = await renderOpened({ grants: twoAdminsGrants() })
    await click(button('End access under grant grant-admins-1'))
    await type(END_LABEL, 'A slip')

    await click(button('Cancel'))

    expect(dialog()).toBeNull()
    expect(admin.endWorkspaceGrant).not.toHaveBeenCalled()
    await click(button('End access under grant grant-admins-2'))
    expect(field(END_LABEL).value).toBe('')
  })

  it('shows in the dialog why the server refused, and keeps the grant listed', async () => {
    const admin = await renderOpened({ grants: twoAdminsGrants() })
    const refusal = createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.notAdmin)
    admin.endWorkspaceGrant.mockRejectedValue(refusal)
    await click(button('End access under grant grant-admins-1'))
    await type(END_LABEL, 'No longer needed')

    await click([...dialog()!.querySelectorAll('button')].find((each) => each.textContent === 'End access')!)

    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(refusal.message)
    expect(grantRows()).toHaveLength(3)
    expect(console.error).not.toHaveBeenCalled()
  })

  it('reads the workspace again when the grant has already ended, listing the one that replaced it', async () => {
    const admin = await renderOpened({ grants: twoAdminsGrants() })
    const refusal = createAdminGrantError(ADMIN_GRANT_ERROR_CODES.notFound)
    admin.endWorkspaceGrant.mockRejectedValue(refusal)
    await click(button('End access under grant grant-admins-1'))
    await type(END_LABEL, 'No longer needed')
    // Another admin approved a replacement, which ended the grant shown.
    admin.held.grants = [adminsGrant({ id: 'grant-admins-3' }), ownerGrant()]

    await click([...dialog()!.querySelectorAll('button')].find((each) => each.textContent === 'End access')!)

    expect(dialog()?.querySelector('[role="alert"]')?.textContent).toBe(refusal.message)
    expect(grantRows().map((row) => detail(row, 'Grant'))).toEqual(['grant-admins-3', 'grant-owner-1'])
    expect(admin.views[0].describe).toHaveBeenCalledTimes(2)
  })

  it('closes a view that no longer answers once the grant is ended, and says why', async () => {
    const admin = await renderOpened({ grants: twoAdminsGrants() })
    const expired = createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.viewExpired)
    admin.views[0].describe.mockRejectedValue(expired)
    await click(button('End access under grant grant-admins-1'))
    await type(END_LABEL, 'No longer needed')

    await click([...dialog()!.querySelectorAll('button')].find((each) => each.textContent === 'End access')!)

    expect(admin.endWorkspaceGrant).toHaveBeenCalledOnce()
    expect(dialog()).toBeNull()
    expect(alerts()).toEqual([expired.message])
    expect(text()).not.toContain('Access grants')
    expect(admin.views[0][Symbol.dispose]).toHaveBeenCalledOnce()
  })
})

describe('requesting content access', () => {
  it('asks for a grant with the reason typed and no arguments, without opening the workspace', async () => {
    const admin = await renderPage(fakeAdmin())
    expect(button('Request content access').disabled).toBe(true)

    await type(REQUEST_LABEL, '  The owner is away and their agent is leaking a token.  ')
    await click(button('Request content access'))

    expect(admin?.requestContentAccess.mock.calls).toEqual([
      [WORKSPACE_ID, 'The owner is away and their agent is leaking a token.'],
    ])
    expect(admin?.inspectWorkspace).not.toHaveBeenCalled()
    expect(text()).toContain('Another admin must approve this. You cannot approve your own request.')
    expect(document.querySelector('section time')?.getAttribute('datetime')).toBe('2026-01-16T12:00:00.000Z')
    expect(field(REQUEST_LABEL).value).toBe('')
  })

  it('keeps a reason edited while the request is sent, and clears one left as it was', async () => {
    const admin = fakeAdmin()
    let answer: (request: AdminContentRequest) => void = () => {}
    admin.requestContentAccess.mockImplementation((_workspaceId, reason) => new Promise(resolve => {
      answer = () => resolve(contentRequest(reason))
    }))
    await renderPage(admin)

    await type(REQUEST_LABEL, 'The owner is away.')
    await click(button('Request content access'))
    await type(REQUEST_LABEL, 'The owner is away, and their agent is leaking a token.')
    await act(async () => answer(contentRequest('')))

    expect(admin.requestContentAccess.mock.calls).toEqual([[WORKSPACE_ID, 'The owner is away.']])
    expect(field(REQUEST_LABEL).value).toBe('The owner is away, and their agent is leaking a token.')
  })

  it('leaves focus in the reason field the admin is still editing, and says the outcome in a live region', async () => {
    const admin = fakeAdmin()
    let answer: () => void = () => {}
    admin.requestContentAccess.mockImplementation((_workspaceId, reason) => new Promise(resolve => {
      answer = () => resolve(contentRequest(reason))
    }))
    await renderPage(admin)

    await type(REQUEST_LABEL, 'The owner is away.')
    await click(button('Request content access'))
    await act(async () => field(REQUEST_LABEL).focus())
    await type(REQUEST_LABEL, 'The owner is away, and more.')
    await act(async () => answer())

    expect(document.activeElement).toBe(field(REQUEST_LABEL))
    expect(document.querySelector('section [role="status"]')?.textContent)
      .toContain('Another admin must approve this.')
  })

  it('says the workspace’s owner is not told, and for how long content would be read', async () => {
    await renderPage(fakeAdmin())

    expect(text()).toContain('for 72 hours without its owner’s grant')
    expect(text()).toContain('The workspace’s owner is not told')
  })

  it('points to the admin panel’s pending approvals, where another admin decides', async () => {
    await renderPage(fakeAdmin())
    await type(REQUEST_LABEL, 'The owner is away')
    await click(button('Request content access'))

    const link = [...document.querySelectorAll('section a')].find((a) => a.textContent === 'pending approvals')
    expect(link?.getAttribute('href')).toBe('/admin?tab=audit#pending-approvals')
  })

  it.each([
    ['the level in force is Metadata', { access: 'metadata' }, 'its admin access level is not Content'],
    ['the level in force is Off', { access: 'off' }, 'its admin access level is not Content'],
  ] as const)('is disabled while %s, and says why', async (_what, options, why) => {
    const admin = await renderPage(fakeAdmin(options))

    expect(field(REQUEST_LABEL).disabled).toBe(true)
    expect(button('Request content access').disabled).toBe(true)
    expect(text()).toContain(why)
    expect(admin?.requestContentAccess).not.toHaveBeenCalled()
  })

  it('asks nothing of ADMIN_WORKSPACE_WRITES: a request for content is not a write', async () => {
    await renderPage(fakeAdmin())
    expect(text()).not.toContain('ADMIN_WORKSPACE_WRITES')
  })

  it('gives no reason where a request can be made', async () => {
    await renderPage(fakeAdmin())

    expect(field(REQUEST_LABEL).disabled).toBe(false)
    expect(text()).not.toContain('turned off on this deployment')
  })

  it.each([
    createAdminAccessError(ADMIN_ACCESS_ERROR_CODES.contentOff),
    createAdminGrantError(ADMIN_GRANT_ERROR_CODES.workspaceUnlisted),
    createAdminGrantError(ADMIN_GRANT_ERROR_CODES.requestPending),
    createAdminGrantError(ADMIN_GRANT_ERROR_CODES.tooManyRequests),
  ])('shows the server’s message for a request refused $code, and keeps the reason typed', async (refusal) => {
    const admin = fakeAdmin()
    admin.requestContentAccess.mockRejectedValue(refusal)
    await renderPage(admin)
    await type(REQUEST_LABEL, 'The owner is away')

    await click(button('Request content access'))

    expect(alerts()).toEqual([refusal.message])
    expect(field(REQUEST_LABEL).value).toBe('The owner is away')
    expect(text()).not.toContain('Another admin must approve this.')
    expect(console.error).not.toHaveBeenCalled()
  })
})
