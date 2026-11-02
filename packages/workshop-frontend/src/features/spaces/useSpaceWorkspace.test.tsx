// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter, RouterProvider } from '@tanstack/react-router'
import type { RpcStub } from 'capnweb'
import type {
  AuthenticatedApi,
  PublicApi,
  SpaceWorkspaceInfo,
  SpaceWorkspaceResolution,
} from '@gadgets/workshop-shared/api'
import { RpcContext } from '../../RpcContext'
import { Route as RootRoute } from '../../routes/__root'
import { Route as SpaceWorkspaceRoute } from '../../routes/spaces.$spaceKey_.$slug'
import { Route as WorkspaceRoute } from '../../routes/workspace.$id'
import {
  ME,
  button,
  click,
  deferred,
  fakeApi,
  fakeSpace,
  member,
  mount,
  mountRouted,
  person,
  settle,
  teamSpace,
  unmountAll,
} from './spacesTestUtils'

// The editor is a marker that says which workspace it was given: the route is under test, not
// the editor it renders.
vi.mock('../../GadgetEditor', () => ({
  default: ({ workspaceId }: { workspaceId: string }) => <div data-testid="editor">{workspaceId}</div>,
}))
// The app chrome is a marker around what it frames, so a test can tell what is shown inside it.
vi.mock('../../components/AppShell/AppShell', () => ({
  default: ({ children }: { children: ReactNode }) => <div data-testid="app-shell">{children}</div>,
}))
vi.mock('../../components/billing/AccountSelectionModal', () => ({ default: () => null }))

// The session the app's own root route finds the user signed in under (see `pageInApp`).
const signedIn = vi.hoisted(() => ({ api: null as unknown }))
vi.mock('../../useAuth', () => ({
  CF_ACCESS_MODE: false,
  useAuth: () => ({
    isAuthenticated: true,
    authenticatedApi: signedIn.api,
    isLoading: false,
    error: null,
    login: () => {},
    logout: () => {},
  }),
}))

const DESIGN = teamSpace('design', 'Design', 'use')
const ROADMAP: SpaceWorkspaceInfo = {
  id: 'w-roadmap',
  title: 'Roadmap',
  owner: person('ada@example.com', 'Ada'),
  created: new Date('2026-09-01T00:00:00Z'),
  slug: 'roadmap',
}

// The space as a member holds it, listing the one workspace, which used to be at `plan`.
const designSpace = ({ asMember = true } = {}) => {
  const space = fakeSpace(DESIGN, asMember ? [member(ME, 'use')] : [], [ROADMAP])
  const resolveCurrent = space.resolveWorkspace.getMockImplementation()!
  space.resolveWorkspace.mockImplementation(async slug =>
    (slug === 'plan' ? { workspace: ROADMAP, canonical: false } : resolveCurrent(slug)))
  return space
}

/** The app with the slug route, at `at`. Every open of a space answers with `space`. */
const renderAt = async (at: string, { space = designSpace(), spacesFlag = true } = {}) => {
  const openSpace = vi.fn<(key: string) => unknown>(() => space)
  const listSpaces = vi.fn<AuthenticatedApi['listSpaces']>(async () => [DESIGN])
  const mounted = await mountRouted(fakeApi({ openSpace, listSpaces }, { spacesFlag }), {
    at,
    pages: root => [SpaceWorkspaceRoute.update({
      id: '/spaces/$spaceKey_/$slug',
      path: '/spaces/$spaceKey/$slug',
      getParentRoute: () => root,
    } as never)],
  })
  await settle()
  return { ...mounted, space, openSpace, listSpaces }
}

/**
 * What the app itself shows at `at`, under its own root route, to a signed-in user who is past
 * onboarding: the page's markup, frame included.
 */
const pageInApp = async (at: string, { spacesFlag = true } = {}) => {
  const api = fakeApi({
    isOnboardingCompleted: async () => true,
    openSpace: () => designSpace(),
  }, { spacesFlag })
  signedIn.api = api
  // jsdom does not implement it, and the router restores scroll on load.
  window.scrollTo = () => {}
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [at] }),
    routeTree: RootRoute.addChildren([
      SpaceWorkspaceRoute.update({
        id: '/spaces/$spaceKey_/$slug',
        path: '/spaces/$spaceKey/$slug',
        getParentRoute: () => RootRoute,
      } as never),
      WorkspaceRoute.update({
        id: '/workspace/$id',
        path: '/workspace/$id',
        getParentRoute: () => RootRoute,
      } as never),
    ]),
  })
  await router.load()
  await mount(
    <RpcContext.Provider value={{ stub: {} as RpcStub<PublicApi>, connectionLost: false }}>
      <RouterProvider router={router} />
    </RpcContext.Provider>,
    api,
  )
  await settle()
  // What was mounted, without the toasts the app's root portals beside it.
  const page = document.body.firstElementChild!.innerHTML
  unmountAll()
  return page
}

const editor = () => document.body.querySelector('[data-testid="editor"]')

// What the route shows for an address with nothing there: the not-found, inside the app chrome.
const showsNotFound = () => [...document.body.querySelectorAll('[data-testid="app-shell"] p')]
  .some(paragraph => paragraph.textContent === 'Not Found')

describe('a workspace’s address in a space', () => {
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('opens the workspace the slug addresses in the editor, and lets the space go', async () => {
    const { router, space, openSpace } = await renderAt('/spaces/design/roadmap?chat=2')

    expect(editor()?.textContent).toBe('w-roadmap')
    expect(document.body.querySelector('[data-testid="app-shell"]')).toBeNull()
    expect(openSpace).toHaveBeenCalledExactlyOnceWith('design')
    expect(space.resolveWorkspace).toHaveBeenCalledExactlyOnceWith('roadmap')
    expect(space[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(router.state.location.href).toBe('/spaces/design/roadmap?chat=2')
  })

  it('replaces an address the workspace used to have with its current one, keeping the search and the hash', async () => {
    const { router, space, openSpace } = await renderAt('/spaces/design/plan?chat=2&w=0#fullscreen')

    expect(router.state.location.href).toBe('/spaces/design/roadmap?chat=2&w=0#fullscreen')
    // The old address is not left behind for Back to return to.
    expect(router.history.length).toBe(1)
    expect(editor()?.textContent).toBe('w-roadmap')
    expect(space[Symbol.dispose]).toHaveBeenCalledTimes(openSpace.mock.calls.length)
  })

  it('shows an address with nothing there as the app shows a URL no route matches, in its chrome', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unmatched = await pageInApp('/no/such/page')
    expect(unmatched).toContain('<div data-testid="app-shell"><p>Not Found</p></div>')

    expect(await pageInApp('/spaces/design/missing')).toBe(unmatched)
    expect(await pageInApp('/spaces/design/roadmap', { spacesFlag: false })).toBe(unmatched)
  })

  it('shows the editor at an address as the app shows it at the workspace’s id, fullscreen', async () => {
    const atId = await pageInApp('/workspace/w-roadmap')
    expect(atId).toContain('<main class="h-full min-h-0"><div data-testid="editor">w-roadmap</div></main>')
    expect(atId).not.toContain('app-shell')

    expect(await pageInApp('/spaces/design/roadmap')).toBe(atId)
  })

  it.each([
    ['no workspace of the space has or had the slug', designSpace()],
    ['the space refuses the user', designSpace({ asMember: false })],
  ])('is not found when %s, and lets the space go', async (_why, space) => {
    await renderAt('/spaces/design/missing', { space })

    expect(showsNotFound()).toBe(true)
    expect(editor()).toBeNull()
    expect(space[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('is not found, and asks about no space, for a key that cannot name one', async () => {
    const { openSpace } = await renderAt('/spaces/Not%20A%20Key/roadmap')

    expect(showsNotFound()).toBe(true)
    expect(openSpace).not.toHaveBeenCalled()
  })

  it('is not found, and makes no spaces call, while the flag is off', async () => {
    const { openSpace, listSpaces } = await renderAt('/spaces/design/roadmap', { spacesFlag: false })

    expect(showsNotFound()).toBe(true)
    expect(editor()).toBeNull()
    expect(openSpace).not.toHaveBeenCalled()
    expect(listSpaces).not.toHaveBeenCalled()
  })

  it('says so when the space could not be asked, and asks again on request', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const space = designSpace()
    space.resolveWorkspace.mockRejectedValueOnce(new Error('boom'))
    await renderAt('/spaces/design/roadmap', { space })

    expect(document.body.textContent).toContain('We couldn\'t load this workspace')
    expect(showsNotFound()).toBe(false)

    await click(button('Try again'))
    await settle()

    expect(editor()?.textContent).toBe('w-roadmap')
  })

  it.each<[string, SpaceWorkspaceResolution | null]>([
    ['the same workspace', { workspace: ROADMAP, canonical: true }],
    // The workspace was moved or deleted, or may no longer be listed.
    ['nothing', null],
    ['the workspace at another address', { workspace: { ...ROADMAP, slug: 'road-map' }, canonical: false }],
  ])('keeps the editor up, where it is, through a session in which the address leads to %s', async (_what, resolution) => {
    const { router, rerender } = await renderAt('/spaces/design/roadmap?chat=3')
    const opened = editor()
    const flags = deferred<{ spaces: boolean }>()
    const space = designSpace()
    space.resolveWorkspace.mockResolvedValue(resolution)

    await rerender(<RouterProvider router={router} />, fakeApi({
      getUiFeatureFlags: () => flags.promise,
      openSpace: () => space,
    }))
    await settle()
    // The new session has not said whether the flag is on.
    expect(editor()).toBe(opened)

    await act(async () => flags.resolve({ spaces: true }))
    await settle()
    expect(editor()).toBe(opened)
    expect(router.state.location.href).toBe('/spaces/design/roadmap?chat=3')
  })
})
