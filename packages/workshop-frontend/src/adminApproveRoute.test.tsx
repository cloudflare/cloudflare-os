// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { FileRoutesById } from './routeTree.gen'

// What the route handed the page, one entry for each time it rendered, and which mounted page
// each rendering was of.
const rendered = vi.hoisted(() => [] as unknown[])
const mounts = vi.hoisted(() => ({ count: 0, rendered: [] as number[] }))

vi.mock('./pages/admin-write-approval/AdminWriteApprovalPage', () => ({
  default: (props: unknown) => {
    // State, so that it lasts as long as the page stays mounted and no longer.
    const [mount] = useState(() => ++mounts.count)
    rendered.push(props)
    mounts.rendered.push(mount)
    return <div data-testid="approval-page" />
  },
}))
vi.mock('./ServerConfigContext', () => ({ useSiteName: () => 'Example OS' }))

import { Route } from './routes/admin_.approve.$requestId'
await Route.options.component!.preload?.()

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom doesn't implement scrolling; the router's hash scroll restoration calls it on mount.
window.scrollTo = () => {}

// The id the generated tree gives the route: a sibling of /admin. A route file named so that the
// page nests under /admin would have the id '/admin/approve/$requestId', and this would not
// type-check.
const ROUTE_ID: keyof FileRoutesById = '/admin_/approve/$requestId'

// Hosts the real route module beside a stub /admin, wired the way routeTree.gen.ts wires it.
const makeRouter = (initialEntry: string) => {
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const adminRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/admin',
    component: () => <div data-testid="admin-page" />,
  })
  const approveRoute = Route.update({
    id: ROUTE_ID,
    path: '/admin/approve/$requestId',
    getParentRoute: () => rootRoute,
  } as never)
  return createRouter({
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    routeTree: rootRoute.addChildren([adminRoute, approveRoute]),
  })
}

const shown = (testId: string) => document.querySelector(`[data-testid="${testId}"]`) !== null

describe('the write approval route', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  const unmount = async () => {
    await act(async () => root?.unmount())
    root = undefined
  }

  afterEach(async () => {
    await unmount()
    container?.remove()
    rendered.length = 0
    mounts.rendered.length = 0
  })

  const renderAt = async (initialEntry: string) => {
    const router = makeRouter(initialEntry)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<RouterProvider router={router} />))
    return router
  }

  it('renders the approval page for the request the URL names, outside the admin page', async () => {
    await renderAt('/admin/approve/req-123')

    expect(shown('approval-page')).toBe(true)
    expect(shown('admin-page')).toBe(false)
    expect(rendered.at(-1)).toEqual({ requestId: 'req-123' })
    expect(document.title).toBe('Approve a write - Example OS')
  })

  it('renders a page of its own for another request once the URL names it', async () => {
    const router = await renderAt('/admin/approve/req-123')
    const first = mounts.rendered.at(-1)

    await act(async () => {
      await router.navigate({ to: '/admin/approve/$requestId', params: { requestId: 'req-456' } })
    })

    expect(shown('approval-page')).toBe(true)
    expect(rendered.at(-1)).toEqual({ requestId: 'req-456' })
    // A page kept mounted would show the first request's state under the second one's id.
    expect(mounts.rendered.at(-1)).not.toBe(first)
  })

  it('restores the document title when the page is left', async () => {
    document.title = 'Before'
    await renderAt('/admin/approve/req-123')
    expect(document.title).toBe('Approve a write - Example OS')

    await unmount()

    expect(document.title).toBe('Before')
  })
})
