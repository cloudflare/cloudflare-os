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
} from '@gadgets/workshop-shared/api'
import { AuthProvider } from '../../AuthContext'
import { FeatureFlagsProvider } from '../../FeatureFlagsContext'
import { ServerConfigContext } from '../../ServerConfigContext'

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

/** The signed-in user of every test. */
export const ME: AiChatAuthorInfo = { type: 'user', id: 'me@example.com', name: 'Me' }

/** The refusal a space gives a user it does not count as a member. */
export const notAMember = () => new Error('No such space, or you are not a member of it.')

export const person = (id: string, name: string): AiChatAuthorInfo => ({ type: 'user', id, name })

export const member = (profile: AiChatAuthorInfo, role: SpaceMemberRole): SpaceMemberInfo => ({
  profile,
  role,
  added: new Date('2026-09-01T00:00:00Z'),
})

/** A space's info as it is produced for one of its members, whose role it has. */
export type MemberSpaceInfo = SpaceInfo & { role: SpaceMemberRole }

export const teamSpace = (key: string, name: string, role: SpaceMemberRole = 'admin'): MemberSpaceInfo => ({
  key,
  name,
  kind: 'team',
  role,
})

export const personalSpace = (owner: AiChatAuthorInfo, role: SpaceMemberRole): MemberSpaceInfo => ({
  key: `~${owner.id.split('@')[0]}`,
  name: owner.name,
  kind: 'personal',
  owner,
  role,
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

/**
 * A `Space` as `ME` holds it, over a member list the test can read back and a listing. While
 * `ME` is not in the member list they are a visitor: the space shows them its info with no role
 * and the published entries of its listing, refuses them its members, and refuses them
 * everything once no entry is published.
 * `setMemberRole`, `removeMember` and `setWorkspaceSlug` apply the change and enforce no rule: a
 * test that needs a refusal replaces the method (`space.setMemberRole.mockRejectedValueOnce(...)`).
 * A slug resolves to the entry that has it, as its current one; a test that needs a former slug
 * replaces `resolveWorkspace`.
 */
export function fakeSpace(info: SpaceInfo, members: SpaceMemberInfo[], workspaces: SpaceWorkspaceInfo[] = []) {
  let current = [...members]
  let listed = [...workspaces]
  const roleOf = (id: string) => current.find(entry => entry.profile.id === id)?.role
  // The entries the space shows `ME`.
  const shown = () => {
    if (roleOf(ME.id)) return listed
    const published = listed.filter(entry => entry.published !== undefined)
    if (published.length === 0) throw notAMember()
    return published
  }
  const space = {
    getInfo: vi.fn<Space['getInfo']>(async () => {
      shown()
      return { ...info, role: roleOf(ME.id) }
    }),
    listMembers: vi.fn<Space['listMembers']>(async () => {
      if (!roleOf(ME.id)) throw notAMember()
      return [...current]
    }),
    listWorkspaces: vi.fn<Space['listWorkspaces']>(async () => shown()),
    resolveWorkspace: vi.fn<Space['resolveWorkspace']>(async (slug) => {
      const workspace = shown().find(entry => entry.slug === slug)
      return workspace ? { workspace, canonical: true } : null
    }),
    setWorkspaceSlug: vi.fn<Space['setWorkspaceSlug']>(async (id, slug) => {
      const updated = { ...listed.find(entry => entry.id === id)!, slug }
      listed = listed.map(entry => (entry.id === id ? updated : entry))
      return updated
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
    members: () => current,
  })
}

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
      ...['/', '/workspaces', '/workspace/$id', '/spaces/$spaceKey', '/spaces/$spaceKey/$slug']
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

/** What the field says about itself: the text its `aria-describedby` points at. */
export const describedBy = (input: HTMLInputElement) =>
  (input.getAttribute('aria-describedby') ?? '').split(' ')
    .map(id => document.getElementById(id)?.textContent ?? '').join(' ')

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
