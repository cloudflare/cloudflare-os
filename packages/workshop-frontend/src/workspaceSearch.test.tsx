// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from '@tanstack/react-router'
import { afterEach, describe, expect, it } from 'vitest'
import { useWorkspaceSearchNavigate, validateWorkspaceSearch } from './workspaceSearch'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom doesn't implement scrolling; the router's hash scroll restoration calls it on mount.
window.scrollTo = () => {}

type NavigateSearch = ReturnType<typeof useWorkspaceSearchNavigate>

// Two routes that render the probe, with different shapes of params, and one that does not: the
// hook must stay on whichever of the first two rendered its caller.
const makeRouter = (initialEntry: string) => {
  const probe: { navigateSearch?: NavigateSearch } = {}
  const Probe = () => {
    const navigateSearch = useWorkspaceSearchNavigate()
    useEffect(() => {
      probe.navigateSearch = navigateSearch
    }, [navigateSearch])
    return null
  }
  const rootRoute = createRootRoute({ component: () => <Outlet /> })
  const routes = [
    createRoute({
      getParentRoute: () => rootRoute,
      path: '/workspace/$id',
      component: Probe,
      validateSearch: validateWorkspaceSearch,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: '/shelf/$shelf/$item',
      component: Probe,
      validateSearch: validateWorkspaceSearch,
    }),
    createRoute({ getParentRoute: () => rootRoute, path: '/elsewhere', component: () => null }),
  ]
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [initialEntry] }),
    routeTree: rootRoute.addChildren(routes),
  })
  return { router, probe }
}

describe('useWorkspaceSearchNavigate', () => {
  let container: HTMLDivElement | undefined
  let root: Root | undefined

  afterEach(async () => {
    await act(async () => root?.unmount())
    container?.remove()
  })

  const renderAt = async (initialEntry: string) => {
    const { router, probe } = makeRouter(initialEntry)
    container = document.createElement('div')
    document.body.append(container)
    root = createRoot(container)
    await act(async () => root!.render(<RouterProvider router={router} />))
    return { router, navigateSearch: () => probe.navigateSearch! }
  }

  it('changes the search of the rendering route, keeping its params and dropping the hash', async () => {
    const { router, navigateSearch } = await renderAt('/workspace/a%20b?chat=3&w=1#share=KEY')

    await act(async () => navigateSearch()({ search: prev => ({ ...prev, w: 4 }) }))
    expect(router.state.location.href).toBe('/workspace/a%20b?chat=3&w=4')
    expect(router.history.length).toBe(2)

    await act(async () => navigateSearch()({ search: {}, replace: true }))
    expect(router.state.location.href).toBe('/workspace/a%20b')
    expect(router.history.length).toBe(2)
  })

  it('stays on a route with other params', async () => {
    const { router, navigateSearch } = await renderAt('/shelf/x/y?chat=1')

    await act(async () => navigateSearch()({ search: prev => ({ ...prev, chat: undefined, w: 2 }) }))
    expect(router.state.location.href).toBe('/shelf/x/y?w=2')
  })

  it.each([
    ['another workspace', '/workspace/b?w=2', { w: 2, chat: 5 }],
    ['a route without the editor', '/elsewhere', { chat: 5 }],
  ])('returns a late call to the workspace it was made for, from %s', async (_, href, search) => {
    const { router, navigateSearch } = await renderAt('/workspace/a?chat=1')
    const fromA = navigateSearch()

    await act(async () => router.navigate({ href }))
    expect(router.state.location.href).toBe(href)

    await act(async () => fromA({ search: prev => ({ ...prev, chat: 5 }) }))
    expect(router.state.location.pathname).toBe('/workspace/a')
    expect(router.state.location.search).toEqual(search)
  })
})
