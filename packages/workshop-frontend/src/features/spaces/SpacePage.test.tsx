// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RouterProvider } from '@tanstack/react-router'
import type {
  AiChatAuthorInfo,
  AuthenticatedApi,
  GadgetMetadataWithTimestamps,
  Overseer,
  SpaceInfo,
  SpaceWorkspaceInfo,
} from '@gadgets/workshop-shared/api'
import { Route as SpaceRoute } from '../../routes/spaces.$spaceKey'
import { Route as WorkspacesRoute } from '../../routes/workspaces'
import {
  ME,
  button,
  click,
  deferred,
  fakeApi,
  fakeSpace,
  hasButton,
  labeledInput,
  member,
  mountRouted,
  person,
  personalSpace,
  pressEscape,
  settle,
  teamSpace,
  type,
  unmountAll,
} from './spacesTestUtils'

// The members dialog's avatars load when scrolled into view, which jsdom has no observer for.
vi.mock('../../components/PersonAvatar', () => ({
  PersonAvatar: () => <span data-testid="avatar" />,
}))

const ADA = person('ada@example.com', 'Ada')
const PERSONAL = personalSpace(ME, 'admin')
const DESIGN = teamSpace('design', 'Design', 'use')
const PLATFORM = teamSpace('platform', 'Platform')
const SPACES = [PERSONAL, DESIGN, PLATFORM]

const DAY = new Date('2026-09-01T00:00:00Z')

const mine = (id: string, title: string, spaceKey?: string): GadgetMetadataWithTimestamps =>
  ({ id, title, created: DAY, lastActive: DAY, spaceKey })

const listedBy = (owner: AiChatAuthorInfo, id: string, title: string, slug?: string): SpaceWorkspaceInfo =>
  ({ id, title, owner, created: DAY, slug })

const GADGETS = [
  mine('w-solo', 'Solo notes'),
  mine('w-notes', 'Notes', 'design'),
  mine('w-roadmap', 'Roadmap', 'platform'),
]

// What each space lists. One of Ada's workspaces in Platform has no address yet.
const LISTED: Record<string, SpaceWorkspaceInfo[]> = {
  [PERSONAL.key]: [listedBy(ME, 'w-solo', 'Solo notes', 'solo-notes')],
  design: [listedBy(ME, 'w-notes', 'Notes', 'notes'), listedBy(ADA, 'w-brief', 'Brief', 'brief')],
  platform: [
    listedBy(ME, 'w-roadmap', 'Roadmap', 'roadmap'),
    listedBy(ADA, 'w-plan', 'Ada’s plan', 'adas-plan'),
    listedBy(ADA, 'w-draft', 'Untitled Workspace'),
  ],
}

type FakeApiMethods = Parameters<typeof fakeApi>[0]

/**
 * The app with the space page and the workspaces page, at `at`, for a user with the spaces and
 * workspaces above. Each space is one object however often it is opened, so a change made
 * through one open is what the next one reads. `strangerTo` is a space that does not count the
 * user as a member. `chrome` is rendered beside the page, as the sidebar is. `session` is the
 * same user's session again, as a reconnect replaces it, with the methods it is given in place
 * of its own.
 */
const renderAt = async (at: string, { spacesFlag = true, strangerTo, api, chrome }: {
  spacesFlag?: boolean
  strangerTo?: string
  api?: FakeApiMethods
  chrome?: ReactNode
} = {}) => {
  let spaces = SPACES
  const opened = new Map<string, ReturnType<typeof fakeSpace>>()
  const openSpace = vi.fn<(key: string) => unknown>((key) => {
    const info: SpaceInfo = spaces.find(space => space.key === key)!
    const space = opened.get(key)
      ?? fakeSpace(info, key === strangerTo ? [] : [member(ME, info.role)], LISTED[key])
    opened.set(key, space)
    return space
  })
  const listSpaces = vi.fn<AuthenticatedApi['listSpaces']>(async () => spaces)
  const session = (methods: FakeApiMethods = {}) => fakeApi({
    listGadgets: async () => GADGETS,
    listFeaturedBlueprints: async () => [],
    listSpaces,
    openSpace,
    createSpace: async (key: string, name: string) => {
      spaces = [...spaces, teamSpace(key, name)]
      return openSpace(key)
    },
    ...api,
    ...methods,
  }, { spacesFlag })
  const mounted = await mountRouted(session(), {
    at,
    chrome,
    pages: root => [
      SpaceRoute.update({
        id: '/spaces/$spaceKey',
        path: '/spaces/$spaceKey',
        getParentRoute: () => root,
      } as never),
      WorkspacesRoute.update({
        id: '/workspaces',
        path: '/workspaces',
        getParentRoute: () => root,
      } as never),
    ],
  })
  await settle()
  return { ...mounted, openSpace, listSpaces, session, space: (key: string) => opened.get(key)! }
}

const heading = () => document.body.querySelector('h1')?.textContent

// A navigation renders the page it leads to some turns after it starts: waits, within a bound,
// for the page with this heading.
const pageNamed = async (name: string) => {
  for (let turn = 0; turn < 100 && heading() !== name; turn++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
  expect(heading()).toBe(name)
}

const searchField = () => document.body.querySelector<HTMLInputElement>('input[placeholder^="Search"]')!

const rowTitles = () => [...document.body.querySelectorAll('h3')].map(title => title.textContent)

const rowOf = (title: string) => [...document.body.querySelectorAll('h3')]
  .find(rowTitle => rowTitle.textContent === title)!.closest('a')!

const link = (name: string) => {
  const found = [...document.body.querySelectorAll('a')].find(anchor =>
    anchor.getAttribute('aria-label') === name)
  if (!found) throw new Error(`No link named “${name}”`)
  return found
}

// What the dialog on show says.
const moveDialog = () => document.body.querySelector('[role="dialog"]')?.textContent

const menuItems = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]

// What the menu of the row with this title offers. A row with no menu offers nothing.
const rowActions = async (title: string) => {
  const menu = rowOf(title).querySelector('button')
  if (!menu) return []
  await click(menu)
  const actions = menuItems().map(item => item.textContent?.trim())
  await pressEscape()
  return actions
}

const chooseAction = async (title: string, name: string) => {
  await click(rowOf(title).querySelector('button')!)
  await click(menuItems().find(item => item.textContent?.trim() === name)!)
}

// What the app shows at a URL no route matches.
const showsNotFound = () =>
  [...document.body.querySelectorAll('p')].some(paragraph => paragraph.textContent === 'Not Found')

describe('a space’s page', () => {
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('shows the space’s name, the user’s role, its entry points and its workspaces', async () => {
    await renderAt('/spaces/platform')

    expect(heading()).toBe('Platform')
    expect(document.body.textContent).toContain('Your role: Admin')
    expect(hasButton('Members of Platform')).toBe(true)
    expect(link('New workspace in Platform').getAttribute('href')).toBe('/?space=platform')
    expect(rowTitles()).toEqual(['Roadmap', 'Ada’s plan', 'Untitled Workspace'])
  })

  it('shows the user’s own workspace as the list’s row and another member’s as a plain one, each at its address', async () => {
    await renderAt('/spaces/design')

    // The user's own, with the list's actions.
    expect(rowOf('Notes').getAttribute('href')).toBe('/spaces/design/notes')
    expect(await rowActions('Notes')).toEqual(expect.arrayContaining(['Rename', 'Share', 'Move to space']))

    // Another member's: what the space lists of it, and nothing to do to it.
    const plain = rowOf('Brief')
    expect(plain.getAttribute('href')).toBe('/spaces/design/brief')
    expect(plain.textContent).toContain('Owned by Ada')
    expect(plain.querySelector('button')).toBeNull()
  })

  it('shows apart, and says so, a workspace of the user’s own that the space does not list', async () => {
    await renderAt('/spaces/design', {
      api: { listGadgets: async () => [...GADGETS, mine('w-private', 'Private notes', 'design')] },
    })

    expect(rowTitles()).toEqual(['Notes', 'Brief', 'Private notes'])
    const unlisted = [...document.body.querySelectorAll('section')]
      .find(section => section.querySelector('h2')?.textContent === 'Not listed by this space')!
    expect(unlisted.textContent).toContain('Its other members do not see them.')
    expect([...unlisted.querySelectorAll('h3')].map(title => title.textContent)).toEqual(['Private notes'])
    expect(rowOf('Private notes').getAttribute('href')).toBe('/workspace/w-private')
  })

  it('links a workspace that has no address yet by its id', async () => {
    await renderAt('/spaces/platform')

    expect(rowOf('Untitled Workspace').getAttribute('href')).toBe('/workspace/w-draft')
  })

  it('shows the user’s own personal space, whose workspaces are at their addresses there', async () => {
    await renderAt(`/spaces/${PERSONAL.key}`)

    expect(heading()).toBe('Personal')
    expect(link('New workspace in Personal').getAttribute('href')).toBe('/')
    expect(rowTitles()).toEqual(['Solo notes'])
    expect(rowOf('Solo notes').getAttribute('href')).toBe(`/spaces/${PERSONAL.key}/solo-notes`)
  })

  it('offers an admin of the space a change of address on every workspace it lists', async () => {
    await renderAt('/spaces/platform')

    expect(await rowActions('Roadmap')).toContain('Change address')
    expect(await rowActions('Ada’s plan')).toEqual(['Change address'])
    expect(await rowActions('Untitled Workspace')).toEqual(['Change address'])
  })

  it('offers any other member a change of address on their own workspaces only', async () => {
    await renderAt('/spaces/design')

    expect(await rowActions('Notes')).toContain('Change address')
    expect(await rowActions('Brief')).toEqual([])
  })

  it('changes a workspace’s address from its row, and shows the row at the new one', async () => {
    const { space } = await renderAt('/spaces/platform')

    await chooseAction('Ada’s plan', 'Change address')
    expect(labeledInput('Address').value).toBe('adas-plan')
    await type(labeledInput('Address'), 'plan')
    await click(button('Save'))
    await settle()

    expect(space('platform').setWorkspaceSlug).toHaveBeenCalledExactlyOnceWith('w-plan', 'plan')
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(rowOf('Ada’s plan').getAttribute('href')).toBe('/spaces/platform/plan')
  })

  it('returns to the workspaces page, whose heading takes the focus, when the user leaves the space', async () => {
    const { router } = await renderAt('/spaces/design')

    const members = button('Members of Design')
    members.focus()
    await click(members)
    await settle()
    await click(button('Leave space'))
    await click(button('Leave'))
    await pageNamed('Workspaces')

    expect(router.state.location.pathname).toBe('/workspaces')
    expect([...document.body.querySelectorAll('[role="dialog"]')].map(dialog => dialog.textContent))
      .toEqual(['You left Design'])
    // The button the leave started from went with the space's page.
    expect(document.activeElement).toBe(document.body.querySelector('h1'))
  })

  it('gives its heading the focus of a user who arrives from creating the space', async () => {
    const { router } = await renderAt('/workspaces')

    await click(button('New space'))
    await type(labeledInput('Name'), 'Field notes')
    await click(button('Create'))
    await pageNamed('Field notes')

    // The dialog the space was named in, and the button that opened it, are gone.
    expect(router.state.location.pathname).toBe('/spaces/field-notes')
    expect(document.activeElement).toBe(document.body.querySelector('h1'))
  })

  it('leaves the focus of a user who arrives with it somewhere where it is', async () => {
    const { router } = await renderAt('/workspaces', { chrome: <button>Beside the page</button> })
    const beside = button('Beside the page')
    beside.focus()

    await act(async () => {
      await router.navigate({ to: '/spaces/$spaceKey', params: { spaceKey: 'design' } })
    })
    await pageNamed('Design')

    expect(document.activeElement).toBe(beside)
  })

  it('gives the search field the focus when a workspace moved to another space leaves the page', async () => {
    const overseer = {
      moveToSpace: vi.fn<Overseer['moveToSpace']>(async () => {}),
      [Symbol.dispose]: vi.fn<() => void>(),
    }
    await renderAt('/spaces/design', { api: { openGadget: () => overseer } })

    await chooseAction('Notes', 'Move to space')
    await click([...document.body.querySelectorAll('label')].find(label => label.textContent === 'Platform')!)
    await click(button('Move'))
    await settle()

    expect(overseer.moveToSpace).toHaveBeenCalledWith('platform')
    // The row went with the workspace, and with it the menu the move was chosen from.
    expect(rowTitles()).toEqual(['Brief'])
    expect(document.activeElement).toBe(searchField())
  })

  it('keeps the page, with what the user typed and opened in its list, through a replaced session', async () => {
    const { router, rerender, session } = await renderAt('/spaces/platform')
    await type(searchField(), 'Road')
    await chooseAction('Roadmap', 'Move to space')

    // The new session answers neither its flags nor its workspaces yet.
    const flags = deferred<{ spaces: boolean }>()
    const gadgets = deferred<GadgetMetadataWithTimestamps[]>()
    await rerender(<RouterProvider router={router} />, session({
      getUiFeatureFlags: () => flags.promise,
      listGadgets: () => gadgets.promise,
    }))
    await settle()
    expect(heading()).toBe('Platform')
    expect(moveDialog()).toContain('Roadmap')

    await act(async () => {
      flags.resolve({ spaces: true })
      gadgets.resolve(GADGETS)
    })
    await settle()
    expect(heading()).toBe('Platform')
    expect(moveDialog()).toContain('Roadmap')
    expect(searchField().value).toBe('Road')
  })

  it('is not found for a space that does not count the user as a member', async () => {
    await renderAt('/spaces/design', { strangerTo: 'design' })

    expect(showsNotFound()).toBe(true)
    expect(heading()).toBeUndefined()
  })

  it('is not found, and asks about no space, for a key that cannot name one', async () => {
    const { openSpace } = await renderAt('/spaces/Not%20A%20Key')

    expect(showsNotFound()).toBe(true)
    expect(openSpace).not.toHaveBeenCalled()
  })

  it('is not found, and makes no spaces call, while the flag is off', async () => {
    const { openSpace, listSpaces } = await renderAt('/spaces/platform', { spacesFlag: false })

    expect(showsNotFound()).toBe(true)
    expect(heading()).toBeUndefined()
    expect(openSpace).not.toHaveBeenCalled()
    expect(listSpaces).not.toHaveBeenCalled()
  })
})
