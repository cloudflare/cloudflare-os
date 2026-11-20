// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterContextProvider,
} from '@tanstack/react-router'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import {
  ADMIN_GRANT_ERROR_CODES,
  createAdminGrantError,
  type AdminApi,
  type AdminContentRequest,
} from '@gadgets/workshop-shared/api'
import { PendingApprovalsCard } from './PendingApprovalsCard'

const testGlobal = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = testGlobal.IS_REACT_ACT_ENVIRONMENT
testGlobal.IS_REACT_ACT_ENVIRONMENT = true
afterAll(() => {
  if (previousActEnvironment === undefined) delete testGlobal.IS_REACT_ACT_ENVIRONMENT
  else testGlobal.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const request = (patch: Partial<AdminContentRequest> = {}): AdminContentRequest => ({
  id: 'req-1',
  workspaceId: 'ws-1',
  workspaceTitle: 'Quarterly numbers',
  workspaceOwner: 'olive@example.com',
  reason: 'The owner cannot be reached and their export is failing',
  requestedBy: 'grace',
  via: 'api',
  requestedAt: new Date('2026-01-15T12:00:00Z'),
  expiresAt: new Date('2026-01-16T12:00:00Z'),
  state: 'pending',
  ...patch,
})

// An AdminApi that lists `listed` until a decision, then what that decision left.
const fakeAdmin = (listed: AdminContentRequest[]) => {
  let held = listed
  return {
    listContentAccessRequests: vi.fn<() => Promise<AdminContentRequest[]>>(async () => held),
    approveContentAccess: vi.fn<(id: string) => Promise<AdminContentRequest>>(async (id) => {
      const approved = { ...held.find((r) => r.id === id)!, state: 'approved' as const, grantId: 'grant-1' }
      held = held.filter((r) => r.id !== id)
      return approved
    }),
    denyContentAccess: vi.fn<(id: string) => Promise<void>>(async (id) => {
      held = held.filter((r) => r.id !== id)
    }),
  }
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.restoreAllMocks()
})

const render = async (admin: ReturnType<typeof fakeAdmin>, userId = 'alice', refreshes = 0,
  onDecided?: () => void) => {
  const rootRoute = createRootRoute()
  const router = createRouter({
    routeTree: rootRoute.addChildren(['/', '/admin/workspace/$workspaceId']
      .map((path) => createRoute({ getParentRoute: () => rootRoute, path }))),
    history: createMemoryHistory({ initialEntries: ['/'] }),
  })
  await router.load()
  await act(async () => {
    root.render(
      <RouterContextProvider router={router}>
        <PendingApprovalsCard
          admin={admin as unknown as RpcStub<AdminApi>}
          userId={userId}
          refreshes={refreshes}
          onDecided={onDecided}
        />
      </RouterContextProvider>)
  })
}

const items = () => [...container.querySelectorAll('li')]
const button = (scope: Element, name: string) =>
  [...scope.querySelectorAll('button')].find((b) => b.textContent?.trim() === name)
const click = (element: Element | undefined) =>
  act(async () => { element!.dispatchEvent(new MouseEvent('click', { bubbles: true })) })

describe('PendingApprovalsCard', () => {
  it('lists again when refreshed, showing a request that arrived after an empty listing', async () => {
    const admin = fakeAdmin([])
    await render(admin)
    expect(container.textContent).toContain('No request is waiting.')

    admin.listContentAccessRequests.mockResolvedValue([request()])
    await render(admin, 'alice', 1)
    expect(admin.listContentAccessRequests).toHaveBeenCalledTimes(2)
    expect(items()).toHaveLength(1)
    expect(items()[0]!.textContent).toContain('Quarterly numbers')
  })

  it('lists the pending requests with their workspace, owner, reason, requester and end, and leaves the rest out', async () => {
    await render(fakeAdmin([request(), request({ id: 'req-2', state: 'denied' })]))

    expect(items()).toHaveLength(1)
    const item = items()[0]!
    expect(item.textContent).toContain('Quarterly numbers')
    expect(item.textContent).toContain('owned by olive@example.com')
    expect(item.textContent).toContain('The owner cannot be reached and their export is failing')
    expect(item.textContent).toContain('Asked for by grace')
    expect(item.querySelector('time')?.getAttribute('datetime')).toBe('2026-01-16T12:00:00.000Z')
    expect(item.querySelector('a')?.getAttribute('href')).toBe('/admin/workspace/ws-1')
    expect(button(item, 'Approve')).toBeDefined()
    expect(button(item, 'Deny')).toBeDefined()
  })

  it('says when no request is waiting', async () => {
    await render(fakeAdmin([]))
    expect(container.textContent).toContain('No request is waiting.')
  })

  it('offers an admin no approval of their own request, which they can withdraw, whatever its casing', async () => {
    const admin = fakeAdmin([request({ requestedBy: 'Alice' })])
    await render(admin, 'alice')

    const item = items()[0]!
    expect(button(item, 'Approve')).toBeUndefined()
    expect(item.textContent).toContain('Your request: waiting for another admin.')
    await click(button(item, 'Withdraw'))
    expect(admin.denyContentAccess.mock.calls).toEqual([['req-1']])
    expect(items()).toHaveLength(0)
  })

  it('approves another admin’s request, says so, and lists again', async () => {
    const admin = fakeAdmin([request()])
    await render(admin)

    await click(button(items()[0]!, 'Approve'))

    expect(admin.approveContentAccess.mock.calls).toEqual([['req-1']])
    expect(container.querySelector('[role="status"]')?.textContent)
      .toBe('Approved. Admins can read Quarterly numbers until the grant ends.')
    expect(admin.listContentAccessRequests).toHaveBeenCalledTimes(2)
    expect(items()).toHaveLength(0)
  })

  it('keeps its live region mounted before any decision, and tells the page of each decision', async () => {
    const admin = fakeAdmin([request(), request({ id: 'req-2' })])
    const onDecided = vi.fn<() => void>()
    await render(admin, 'alice', 0, onDecided)

    const region = container.querySelector('[role="status"]')
    expect(region).not.toBeNull()
    expect(region?.textContent).toBe('')
    await click(button(items()[0]!, 'Deny'))
    expect(container.querySelector('[role="status"]')).toBe(region)
    expect(onDecided).toHaveBeenCalledOnce()
  })

  it('shows the pending spinner on the decision pressed, and only there', async () => {
    const admin = fakeAdmin([request()])
    admin.denyContentAccess.mockImplementationOnce(() => new Promise(() => {}))
    await render(admin)

    await click(button(items()[0]!, 'Deny'))

    // Kumo's spinner, which a loading button shows before its label.
    const busy = (name: string) => button(items()[0]!, name)?.querySelector('[aria-label="Loading"]') != null
    expect(busy('Deny')).toBe(true)
    expect(busy('Approve')).toBe(false)
  })

  it('takes a decided request out at once, so it can’t be decided again before the list is read', async () => {
    const admin = fakeAdmin([request(), request({ id: 'req-2', workspaceTitle: 'Second' })])
    await render(admin)
    admin.listContentAccessRequests.mockImplementationOnce(() => new Promise(() => {}))

    await click(button(items()[0]!, 'Approve'))

    expect(items()).toHaveLength(1)
    expect(items()[0]!.textContent).toContain('Second')
    expect(container.querySelector('[role="status"]')?.textContent)
      .toBe('Approved. Admins can read Quarterly numbers until the grant ends.')
  })

  it('moves focus once the list is read again, past a request another admin decided meanwhile', async () => {
    const admin = fakeAdmin([request(), request({ id: 'req-2' }), request({ id: 'req-3', workspaceTitle: 'Third' })])
    await render(admin)
    let reread: (requests: AdminContentRequest[]) => void = () => {}
    admin.listContentAccessRequests.mockImplementationOnce(() => new Promise((resolve) => { reread = resolve }))

    const deny = button(items()[0]!, 'Deny')!
    await act(async () => deny.focus())
    await click(deny)
    // Another admin decided req-2 meanwhile: the read that answers lists only req-3.
    await act(async () => reread([request({ id: 'req-3', workspaceTitle: 'Third' })]))

    expect(items()).toHaveLength(1)
    expect(document.activeElement).toBe(button(items()[0]!, 'Approve'))
  })

  it('scrolls itself into view when it mounts under a link to it', async () => {
    const scrolled = vi.fn<() => void>()
    Element.prototype.scrollIntoView = scrolled
    window.history.replaceState(null, '', '#pending-approvals')
    try {
      await render(fakeAdmin([request()]))
      expect(scrolled).toHaveBeenCalledOnce()
      expect(scrolled.mock.contexts[0]).toBe(container.querySelector('#pending-approvals'))
    } finally {
      window.history.replaceState(null, '', '#')
    }
    scrolled.mockClear()
    await render(fakeAdmin([request()]))
    expect(scrolled).not.toHaveBeenCalled()
  })

  it('says a denial and a withdrawal in its live region', async () => {
    const admin = fakeAdmin([request({ id: 'req-1' }), request({ id: 'req-2', requestedBy: 'alice', workspaceTitle: 'Mine' })])
    await render(admin)

    await click(button(items()[0]!, 'Deny'))
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Denied: Quarterly numbers.')
    await click(button(items()[0]!, 'Withdraw'))
    expect(container.querySelector('[role="status"]')?.textContent).toBe('Withdrawn: Mine.')
  })

  it('moves focus a decision took to the request now in its place, or to the heading', async () => {
    const admin = fakeAdmin([request({ id: 'req-1' }), request({ id: 'req-2', workspaceTitle: 'Second' })])
    await render(admin)

    const deny = button(items()[0]!, 'Deny')!
    await act(async () => deny.focus())
    await click(deny)
    expect(items()).toHaveLength(1)
    expect(document.activeElement).toBe(button(items()[0]!, 'Approve'))

    await click(document.activeElement as HTMLElement)
    expect(items()).toHaveLength(0)
    expect(document.activeElement?.textContent).toBe('Pending approvals')
  })

  it('leaves focus on a workspace link that survives the reload', async () => {
    const admin = fakeAdmin([request({ id: 'req-1' }), request({ id: 'req-2', workspaceTitle: 'Second' })])
    await render(admin)

    let answer: () => void = () => {}
    admin.approveContentAccess.mockImplementationOnce((id) => new Promise((resolve) => {
      answer = () => resolve({ ...request({ id }), state: 'approved', grantId: 'grant-1' })
    }))
    await click(button(items()[0]!, 'Approve'))
    const link = items()[1]!.querySelector('a')!
    await act(async () => link.focus())
    await act(async () => answer())

    expect(items()).toHaveLength(2)
    expect(document.activeElement).toBe(link)
  })

  it('leaves focus that went elsewhere where it is', async () => {
    const admin = fakeAdmin([request()])
    const elsewhere = document.body.appendChild(document.createElement('button'))
    await render(admin)

    const approve = button(items()[0]!, 'Approve')!
    admin.approveContentAccess.mockImplementationOnce(async (id) => {
      elsewhere.focus()
      return { ...request({ id }), state: 'approved', grantId: 'grant-1' }
    })
    await click(approve)
    expect(document.activeElement).toBe(elsewhere)
    elsewhere.remove()
  })

  it('shows the server’s refusal beside the request it was for, and why a workspace gave no grant', async () => {
    const admin = fakeAdmin([request(), request({ id: 'req-2', workspaceId: 'ws-2' })])
    const refusal = createAdminGrantError(ADMIN_GRANT_ERROR_CODES.requestNotPending)
    admin.approveContentAccess.mockRejectedValueOnce(refusal)
    admin.approveContentAccess.mockResolvedValueOnce(
      request({ id: 'req-2', state: 'failed', error: 'Workspace not found.' }))
    await render(admin)

    await click(button(items()[0]!, 'Approve'))
    expect(items()[0]!.querySelector('[role="alert"]')?.textContent).toBe(refusal.message)
    expect(console.error).not.toHaveBeenCalled()

    await click(button(items()[1]!, 'Approve'))
    expect(items()[1]!.querySelector('[role="alert"]')?.textContent).toBe('Workspace not found.')
  })

  it('still says why a workspace gave no grant once the failed request has left the list', async () => {
    const admin = fakeAdmin([request(), request({ id: 'req-2', workspaceId: 'ws-2', workspaceTitle: 'Roadmap' })])
    // As the server does: the request is failed, and no longer listed as pending.
    admin.approveContentAccess.mockImplementationOnce(async () => {
      admin.listContentAccessRequests.mockResolvedValue([request()])
      return request({ id: 'req-2', workspaceTitle: 'Roadmap', state: 'failed', error: 'Workspace not found.' })
    })
    await render(admin)

    await click(button(items()[1]!, 'Approve'))

    expect(admin.listContentAccessRequests).toHaveBeenCalledTimes(2)
    expect(items()).toHaveLength(1)
    expect([...document.querySelectorAll('[role="alert"]')].map((alert) => alert.textContent))
      .toEqual(['Roadmap: Workspace not found.'])
  })
})
