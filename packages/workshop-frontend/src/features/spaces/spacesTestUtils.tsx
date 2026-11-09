import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { vi } from 'vitest'
import { Toasty, TooltipProvider } from '@cloudflare/kumo'
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  type AnyRoute,
} from '@tanstack/react-router'
import type { RpcStub } from 'capnweb'
import type {
  AiChatAuthorInfo,
  AuthenticatedApi,
  ServerConfig,
  Space,
  SpaceInfo,
  SpaceMemberInfo,
  SpaceMemberRole,
  SpaceWorkspaceInfo,
  SubspaceInfo,
} from '@gadgets/workshop-shared/api'
import { AuthProvider } from '../../AuthContext'
import { FeatureFlagsProvider } from '../../FeatureFlagsContext'
import { ServerConfigContext } from '../../ServerConfigContext'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The signed-in user of every test. */
export const ME: AiChatAuthorInfo = { type: 'user', id: 'me@example.com', name: 'Me' }

/** The refusal a space gives a user it does not count as a member. */
export const notAMember = () => new Error('No such space, or you are not a member of it.')

/** The refusal the server gives a string that is not a space id. */
export const invalidSpaceId = () => new Error('Invalid space id.')

export const person = (id: string, name: string): AiChatAuthorInfo => ({ type: 'user', id, name })

export const member = (profile: AiChatAuthorInfo, role: SpaceMemberRole): SpaceMemberInfo => ({
  profile,
  role,
  added: new Date('2026-09-01T00:00:00Z'),
})

/** A team space as its info names it. `parent` is the id of the space it was created in, for a sub-space. */
export const teamSpace = (id: string, name: string, role: SpaceMemberRole = 'admin', parent?: string): SpaceInfo => ({
  id,
  name,
  kind: 'team',
  ...(parent === undefined ? {} : { parent }),
  role,
})

/** A sub-space as the space it is inside lists it. */
export const subspace = (id: string, name: string): SubspaceInfo => ({ id, name })

/** A user's personal space as they see it: they are its only member, and its admin. */
export const personalSpace = (owner: AiChatAuthorInfo): SpaceInfo => ({
  id: `home-${owner.id.split('@')[0]}`,
  name: owner.name,
  kind: 'personal',
  owner,
  role: 'admin',
})

type FakeApi = Partial<{ [K in keyof AuthenticatedApi]: unknown }>

/**
 * An `AuthenticatedApi` reduced to what the providers below call (the signed-in user, and the
 * `spaces` flag switched on unless `spacesFlag` says otherwise) plus the methods a test gives it.
 */
export function fakeApi(methods: FakeApi = {}, { spacesFlag = true } = {}): RpcStub<AuthenticatedApi> {
  return {
    whoami: async () => ME,
    amIAdmin: async () => false,
    getUiFeatureFlags: async () => ({ spaces: spacesFlag }),
    ...methods,
  } as unknown as RpcStub<AuthenticatedApi>
}

/** What a fake space holds besides its own members and its listing. */
export type FakeSpaceOptions = {
  /**
   * The role `ME` holds in the spaces this one is inside. With it `ME` is a member whatever
   * `members` says, and `getInfo()` reports the higher of the two roles and tells `info.parent`.
   * Without it `getInfo()` leaves `parent` out, as the server does for someone added only here.
   */
  inherited?: SpaceMemberRole
  /** The sub-spaces created directly in the space. */
  subspaces?: SubspaceInfo[]
}

const ROLE_RANK: Record<SpaceMemberRole, number> = { use: 0, build: 1, admin: 2 }

// The ids `createSubspace` gives out, each one once.
let subspacesCreated = 0

/**
 * A `Space` as `ME` holds it, over a member list the test can read back, a listing and the
 * sub-spaces created in it. The role `ME` holds is the higher of the one the member list gives
 * them and `options.inherited`, worked out on every call; with neither the space refuses them.
 * `setMemberRole` and `removeMember` apply the change and enforce no rule: a test that needs a
 * refusal replaces the method (`space.setMemberRole.mockRejectedValueOnce(...)`).
 */
export function fakeSpace(
  info: SpaceInfo,
  members: SpaceMemberInfo[],
  workspaces: SpaceWorkspaceInfo[] = [],
  options: FakeSpaceOptions = {},
) {
  let current = [...members]
  let inside = [...(options.subspaces ?? [])]
  const held = () => {
    const given = current.find(entry => entry.profile.id === ME.id)?.role
    const roles = [given, options.inherited].filter(role => role !== undefined)
    if (roles.length === 0) throw notAMember()
    return roles.reduce((highest, role) => (ROLE_RANK[role] > ROLE_RANK[highest] ? role : highest))
  }
  const space = {
    getInfo: vi.fn<Space['getInfo']>(async () => {
      const { parent, ...rest } = info
      return { ...rest, ...(options.inherited && parent !== undefined ? { parent } : {}), role: held() }
    }),
    listMembers: vi.fn<Space['listMembers']>(async () => {
      held()
      return [...current]
    }),
    listWorkspaces: vi.fn<Space['listWorkspaces']>(async () => {
      held()
      return workspaces
    }),
    listSubspaces: vi.fn<Space['listSubspaces']>(async () => {
      held()
      return inside.toSorted((a, b) => a.name.localeCompare(b.name))
    }),
    createSubspace: vi.fn<Space['createSubspace']>(async (name) => {
      if (held() === 'use') {
        throw new Error('Only an admin or a build member of this space can create a sub-space.')
      }
      subspacesCreated += 1
      const created = subspace(subspacesCreated.toString(16).padStart(64, '0'), name.trim())
      inside = [...inside, created]
      return created
    }),
    setMemberRole: vi.fn<Space['setMemberRole']>(async (username, role) => {
      const existing = current.find(entry => entry.profile.id === username)
      const updated = existing ? { ...existing, role } : member(person(username, username), role)
      current = existing
        ? current.map(entry => (entry === existing ? updated : entry))
        : [...current, updated]
      return updated
    }),
    removeMember: vi.fn<Space['removeMember']>(async (profileId) => {
      current = current.filter(entry => entry.profile.id !== profileId)
    }),
    [Symbol.dispose]: vi.fn<() => void>(),
  }
  return Object.assign(space, {
    stub: space as unknown as RpcStub<Space>,
    id: info.id,
    members: () => current,
    subspaces: () => inside,
  })
}

/**
 * `openSpace` over these spaces, by id: each is one object however often it is opened, and an
 * id that is none of them opens a space that refuses `ME`, as the server refuses an id that
 * names no space and a space above one the user was added to. The ids of these fakes are words,
 * so the server's other refusal, of a string that could not be a space id, is not modelled: a
 * test of it answers with `invalidSpaceId()` itself.
 */
export const openSpaceAmong = (spaces: ReturnType<typeof fakeSpace>[]) =>
  vi.fn<(id: string) => unknown>(id =>
    spaces.find(space => space.id === id) ?? fakeSpace(teamSpace(id, id), []))

const mounted: { root: Root; container: HTMLElement }[] = []

/**
 * Renders `ui` for the signed-in user of `api`, with user search off so names are taken as typed.
 * `rerender` takes the api to render under next, for a session that was replaced.
 */
export async function mount(ui: ReactNode, api: RpcStub<AuthenticatedApi>) {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  const render = (next: ReactNode, nextApi = api) => act(async () => root.render(
    <ServerConfigContext.Provider value={{ userSearchEnabled: false } as ServerConfig}>
      <AuthProvider authenticatedApi={nextApi} onLogout={() => {}}>
        <FeatureFlagsProvider>{next}</FeatureFlagsProvider>
      </AuthProvider>
    </ServerConfigContext.Provider>,
  ))
  await render(ui)
  return {
    rerender: render,
    unmount: () => act(async () => root.unmount()),
  }
}

/**
 * Renders a router that starts at `at`, for the signed-in user of `api`, inside what the app's
 * shell supplies (toasts, tooltips). `pages` are the routes under test, given the root to hang
 * from. The app's other pages that links here lead to are stand-ins that render nothing.
 * `chrome` is rendered beside the page, as the sidebar is.
 */
export async function mountRouted(api: RpcStub<AuthenticatedApi>, { at, pages = () => [], chrome }: {
  at: string
  pages?: (root: AnyRoute) => AnyRoute[]
  chrome?: ReactNode
}) {
  // jsdom does not implement it, and the router scrolls the window to the top on a navigation.
  window.scrollTo = () => {}

  const root = createRootRoute({
    component: () => (
      <TooltipProvider>
        <Toasty>
          {chrome}
          <Outlet />
        </Toasty>
      </TooltipProvider>
    ),
  })
  const standIn = (path: string) => createRoute({ getParentRoute: () => root, path, component: () => null })
  const under = pages(root)
  const taken = new Set(under.map(route => (route.options as { path?: string }).path))
  const router = createRouter({
    history: createMemoryHistory({ initialEntries: [at] }),
    routeTree: root.addChildren([
      ...under,
      ...['/', '/workspaces', '/workspace/$id', '/spaces/$spaceId']
        .filter(path => !taken.has(path)).map(standIn),
    ]),
  })
  await router.load()
  const mountedRouter = await mount(<RouterProvider router={router} />, api)
  await settle()
  return { router, ...mountedRouter }
}

/** Unmounts everything `mount` rendered. Call from `afterEach`. */
export function unmountAll() {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount())
    container.remove()
  }
  document.body.innerHTML = ''
}

/** Lets pending promises and the state updates they cause settle. */
export const settle = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })

/** A call the test answers when it chooses to: `promise` is what the call returns. */
export function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((settled) => { resolve = settled })
  return { promise, resolve }
}

/** Escape, pressed wherever focus is: what dismisses an open dialog. */
export const pressEscape = () => act(async () => {
  (document.activeElement ?? document.body).dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
})

export function button(label: string): HTMLButtonElement {
  const found = [...document.body.querySelectorAll('button')].find(candidate =>
    candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label)
  if (!found) throw new Error(`No button labelled “${label}”`)
  return found
}

export const hasButton = (label: string) =>
  [...document.body.querySelectorAll('button')].some(candidate =>
    candidate.textContent?.trim() === label || candidate.getAttribute('aria-label') === label)

export function labeledInput(label: string): HTMLInputElement {
  const labelElement = [...document.body.querySelectorAll('label')]
    .find(element => element.textContent?.startsWith(label))
  const input = labelElement && document.getElementById(labelElement.htmlFor)
  if (!(input instanceof HTMLInputElement)) throw new Error(`No input labelled “${label}”`)
  return input
}

export const type = (input: HTMLInputElement, value: string) => act(async () => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
})

export const click = (element: HTMLElement) => act(async () => { element.click() })

/** The text of every alert on screen. */
export const alerts = () =>
  [...document.body.querySelectorAll('[role="alert"]')].map(element => element.textContent?.trim())

/** The options of the list that the select named `label` opens, which is left open. */
export async function selectOptions(label: string): Promise<HTMLElement[]> {
  const select = button(label)
  if (select.getAttribute('aria-expanded') !== 'true') await click(select)
  const list = document.getElementById(select.getAttribute('aria-controls') ?? '')
  return [...(list?.querySelectorAll<HTMLElement>('[role="option"]') ?? [])]
}

/**
 * Chooses an option of the select named `label`, by keyboard. The option turns Enter into a click
 * it builds as a PointerEvent, which jsdom lacks, so the window has a stand-in for as long as the
 * choice takes.
 */
export async function chooseOption(label: string, text: string) {
  const option = (await selectOptions(label)).find(candidate => candidate.textContent === text)
  if (!option) throw new Error(`No “${text}” option in “${label}”`)
  const view: { PointerEvent?: typeof MouseEvent } = window
  view.PointerEvent = MouseEvent
  try {
    await act(async () => { option.focus() })
    await act(async () => {
      option.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    })
  } finally {
    delete view.PointerEvent
  }
}
