// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RouterProvider } from '@tanstack/react-router'
import type {
  AiChatAuthorInfo,
  AuthenticatedApi,
  BlueprintPublicInfo,
  WorkspaceMetadataWithTimestamps,
  Overseer,
  SpaceInfo,
  SpaceWorkspaceInfo,
} from '@gadgets/workshop-shared/api'
import { Route as SpaceRoute } from '../../routes/spaces.$spaceId'
import { Route as WorkspacesRoute } from '../../routes/workspaces'
import {
  ME,
  alerts,
  button,
  chooseOption,
  click,
  deferred,
  fakeApi,
  fakeSpace,
  hasButton,
  invalidSpaceId,
  labeledInput,
  member,
  mountRouted,
  notAMember,
  person,
  personalSpace,
  pressEscape,
  settle,
  teamSpace,
  type,
  unmountAll,
} from '../../features/spaces/spacesTestUtils'

// The members dialog's avatars load when scrolled into view, which jsdom has no observer for.
vi.mock('../../components/PersonAvatar', () => ({
  PersonAvatar: () => <span data-testid="avatar" />,
}))

const ADA = person('ada@example.com', 'Ada')
// Ids of the shape the server makes, which the route asks about; any other it does not.
const idOf = (digit: string) => digit.repeat(64)
const PERSONAL = { ...personalSpace(ME), id: idOf('1') }
const DESIGN = teamSpace(idOf('d'), 'Design', 'use')
const PLATFORM = teamSpace(idOf('a'), 'Platform')
// The id of the space the suite's `createSpace` makes.
const CREATED_ID = idOf('c')
const SPACES = [PERSONAL, DESIGN, PLATFORM]

const DAY = new Date('2026-09-01T00:00:00Z')

const mine = (id: string, title: string, spaceId?: string): WorkspaceMetadataWithTimestamps =>
  ({ id, title, created: DAY, lastActive: DAY, spaceId })

const listedBy = (owner: AiChatAuthorInfo, id: string, title: string): SpaceWorkspaceInfo =>
  ({ id, title, owner, created: DAY })

const GADGETS = [
  mine('w-solo', 'Solo notes'),
  mine('w-notes', 'Notes', DESIGN.id),
  mine('w-roadmap', 'Roadmap', PLATFORM.id),
]

// What each space lists.
const LISTED: Record<string, SpaceWorkspaceInfo[]> = {
  [PERSONAL.id]: [listedBy(ME, 'w-solo', 'Solo notes')],
  [DESIGN.id]: [listedBy(ME, 'w-notes', 'Notes'), listedBy(ADA, 'w-brief', 'Brief')],
  [PLATFORM.id]: [
    listedBy(ME, 'w-roadmap', 'Roadmap'),
    listedBy(ADA, 'w-plan', 'Ada’s plan'),
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
  const openSpace = vi.fn<(id: string) => unknown>((id) => {
    const info: SpaceInfo = spaces.find(space => space.id === id)!
    const space = opened.get(id)
      ?? fakeSpace(info, id === strangerTo ? [] : [member(ME, info.role)], LISTED[id])
    opened.set(id, space)
    return space
  })
  const listSpaces = vi.fn<AuthenticatedApi['listSpaces']>(async () => spaces)
  const session = (methods: FakeApiMethods = {}) => fakeApi({
    listWorkspaces: async () => GADGETS,
    listFeaturedBlueprints: async () => [],
    listSpaces,
    openSpace,
    createSpace: (name: string) => {
      spaces = [...spaces, teamSpace(CREATED_ID, name)]
      return openSpace(CREATED_ID)
    },
    ...api,
    ...methods,
  }, { spacesFlag })
  const mounted = await mountRouted(session(), {
    at,
    chrome,
    pages: root => [
      SpaceRoute.update({
        id: '/spaces/$spaceId',
        path: '/spaces/$spaceId',
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
  return { ...mounted, openSpace, listSpaces, session }
}

// One space the test holds, which every open answers: for a test that sets what the space's
// reads answer, or asks which of them were made.
const heldSpace = (info: SpaceInfo) => {
  const space = fakeSpace(info, [member(ME, info.role)], LISTED[info.id])
  return { space, openSpace: vi.fn<(id: string) => unknown>(() => space) }
}

// A read the test fails when it chooses to.
const failing = <T,>() => {
  let fail!: (reason: Error) => void
  const promise = new Promise<T>((_, reject) => { fail = reject })
  return { promise, fail }
}

const heading = () => document.body.querySelector('h1')?.textContent

const sectionHeadings = () => [...document.body.querySelectorAll('section h2')].map(title => title.textContent)

// A navigation renders the page it leads to some turns after it starts: waits, within a bound,
// for the page with this heading.
const pageNamed = async (name: string) => {
  for (let turn = 0; turn < 100 && heading() !== name; turn++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
  expect(heading()).toBe(name)
}

// Waits, within the same bound, for what a navigation leads to.
const shown = async (present: () => boolean) => {
  for (let turn = 0; turn < 100 && !present(); turn++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  }
  expect(present()).toBe(true)
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

// What each status line on show says.
const statuses = () =>
  [...document.body.querySelectorAll('[role="status"]')].map(status => status.textContent)

// What the dialog on show says.
const moveDialog = () => document.body.querySelector('[role="dialog"]')?.textContent

const menuItems = () => [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]

// What the menu of the row with this title offers.
const rowActions = async (title: string) => {
  await click(rowOf(title).querySelector('button')!)
  const actions = menuItems().map(item => item.textContent?.trim())
  await pressEscape()
  return actions
}

const chooseAction = async (title: string, name: string) => {
  await click(rowOf(title).querySelector('button')!)
  await click(menuItems().find(item => item.textContent?.trim() === name)!)
}

// A blueprint the deployment features, and whether the list offers the featured ones.
const FEATURED: BlueprintPublicInfo[] = [{
  id: 'starter',
  metadata: { title: 'Starter', description: '', author: ADA, created: DAY, version: 1, lastUpdated: DAY, bindings: {} },
}]
const offersBlueprints = () => document.body.textContent?.includes('Start from a featured blueprint.')

// What the app shows at a URL no route matches.
const showsNotFound = () =>
  [...document.body.querySelectorAll('p')].some(paragraph => paragraph.textContent === 'Not Found')

describe('a space’s page', () => {
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('shows the space’s name, the user’s role, its entry points and its workspaces', async () => {
    await renderAt(`/spaces/${PLATFORM.id}`)

    expect(heading()).toBe('Platform')
    expect(document.body.textContent).toContain('Your role: Admin')
    expect(hasButton('Members of Platform')).toBe(true)
    expect(link('New workspace in Platform').getAttribute('href')).toBe(`/?space=${PLATFORM.id}`)
    expect(rowTitles()).toEqual(['Roadmap', 'Ada’s plan', 'Untitled Workspace'])
  })

  it('shows the user’s own workspace as the list’s row and another member’s as a plain one, each linking to the workspace', async () => {
    await renderAt(`/spaces/${DESIGN.id}`)

    // The user's own, with the list's actions.
    expect(rowOf('Notes').getAttribute('href')).toBe('/workspace/w-notes')
    expect(await rowActions('Notes')).toEqual(expect.arrayContaining(['Rename', 'Invite to workspace', 'Move to space']))

    // Another member's: what the space lists of it, and nothing to do to it.
    const plain = rowOf('Brief')
    expect(plain.getAttribute('href')).toBe('/workspace/w-brief')
    expect(plain.textContent).toContain('Owned by Ada')
    expect(plain.querySelector('button')).toBeNull()
  })

  it('shows apart, and says so, a workspace of the user’s own that the space does not list', async () => {
    await renderAt(`/spaces/${DESIGN.id}`, {
      api: { listWorkspaces: async () => [...GADGETS, mine('w-private', 'Private notes', DESIGN.id)] },
    })

    expect(rowTitles()).toEqual(['Notes', 'Brief', 'Private notes'])
    const unlisted = [...document.body.querySelectorAll('section')]
      .find(section => section.querySelector('h2')?.textContent === 'Not listed by this space')!
    expect(unlisted.textContent).toContain(
      'Its other members do not see them and cannot open them through the space.')
    expect([...unlisted.querySelectorAll('h3')].map(title => title.textContent)).toEqual(['Private notes'])
    expect(rowOf('Private notes').getAttribute('href')).toBe('/workspace/w-private')
  })

  it('shows the user’s personal space as theirs alone', async () => {
    await renderAt(`/spaces/${PERSONAL.id}`)

    expect(heading()).toBe('Personal')
    // A personal space has no members besides its owner: no role to name, no members to open.
    expect(document.body.textContent).toContain('Your personal space. Only you are in it.')
    expect(document.body.textContent).not.toContain('Your role:')
    expect(hasButton('Members of Personal')).toBe(false)
    expect(link('New workspace in Personal').getAttribute('href')).toBe('/')
    expect(rowTitles()).toEqual(['Solo notes'])
  })

  it('shows every workspace of the user’s in their personal space together, and says nothing of other members', async () => {
    // The space's listing has no entry for the second one.
    await renderAt(`/spaces/${PERSONAL.id}`, {
      api: { listWorkspaces: async () => [...GADGETS, mine('w-journal', 'Journal')] },
    })

    expect(rowTitles()).toEqual(['Solo notes', 'Journal'])
    expect(sectionHeadings()).not.toContain('Not listed by this space')
    expect(document.body.textContent).not.toContain('other members')
  })

  it('says that the user’s personal space has no workspaces yet', async () => {
    await renderAt(`/spaces/${PERSONAL.id}`, {
      api: { listWorkspaces: async () => GADGETS.filter(gadget => gadget.spaceId) },
    })

    expect(rowTitles()).toEqual([])
    expect(document.body.textContent).toContain('No workspaces in your personal space yet.')
  })

  it('says that a team space has no workspaces yet once what it lists has been read, and not while it is being read', async () => {
    const platform = heldSpace(PLATFORM)
    const listing = deferred<SpaceWorkspaceInfo[]>()
    platform.space.listWorkspaces.mockReturnValueOnce(listing.promise)
    await renderAt(`/spaces/${PLATFORM.id}`, {
      api: {
        openSpace: platform.openSpace,
        listWorkspaces: async () => GADGETS.filter(gadget => gadget.spaceId !== PLATFORM.id),
      },
    })

    // The space may yet list a workspace of another member's.
    expect(statuses()).toEqual(['Loading this space’s workspaces…'])
    expect(document.body.textContent).not.toContain('No workspaces in this space yet.')

    await act(async () => { listing.resolve([]) })
    await settle()
    expect(statuses()).toEqual([])
    expect(rowTitles()).toEqual([])
    expect(document.body.textContent).toContain('No workspaces in this space yet.')
  })

  it('does not say that a team space has no workspaces when what it lists could not be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const platform = heldSpace(PLATFORM)
    platform.space.listWorkspaces.mockRejectedValue(new Error('boom'))
    await renderAt(`/spaces/${PLATFORM.id}`, {
      api: {
        openSpace: platform.openSpace,
        listWorkspaces: async () => GADGETS.filter(gadget => gadget.spaceId !== PLATFORM.id),
      },
    })

    expect(alerts()).toEqual(['Couldn’t load this space’s workspaces.Try again'])
    expect(rowTitles()).toEqual([])
    expect(document.body.textContent).not.toContain('No workspaces in this space yet.')
  })

  it.each([
    ['the user’s personal space', PERSONAL],
    ['a team space', PLATFORM],
  ])('says that no workspace was found, and not that the space has none, when a search of %s matches nothing', async (_kind, space) => {
    await renderAt(`/spaces/${space.id}`)

    await type(searchField(), 'zzz')

    expect(rowTitles()).toEqual([])
    expect(document.body.textContent).toContain('No workspaces found')
    expect(document.body.textContent).not.toContain('No workspaces in your personal space yet.')
    expect(document.body.textContent).not.toContain('No workspaces in this space yet.')
  })

  it('does not read what the user’s personal space lists', async () => {
    const personal = heldSpace(PERSONAL)
    await renderAt(`/spaces/${PERSONAL.id}`, { api: { openSpace: personal.openSpace } })

    expect(heading()).toBe('Personal')
    expect(personal.space.getInfo).toHaveBeenCalled()
    expect(personal.space.listMembers).toHaveBeenCalled()
    expect(personal.space.listWorkspaces).not.toHaveBeenCalled()
    expect(document.body.textContent).not.toContain('Loading this space’s workspaces')
  })

  it('reads what a team space lists', async () => {
    const platform = heldSpace(PLATFORM)
    await renderAt(`/spaces/${PLATFORM.id}`, { api: { openSpace: platform.openSpace } })

    expect(heading()).toBe('Platform')
    expect(platform.space.listWorkspaces).toHaveBeenCalled()
  })

  it('reads what a team space lists before its info answers, the list of spaces saying it is one', async () => {
    const platform = heldSpace(PLATFORM)
    const info = deferred<SpaceInfo>()
    platform.space.getInfo.mockReturnValueOnce(info.promise)
    await renderAt(`/spaces/${PLATFORM.id}`, { api: { openSpace: platform.openSpace } })

    expect(heading()).toBeUndefined()
    expect(platform.space.listWorkspaces).toHaveBeenCalled()

    await act(async () => { info.resolve(PLATFORM) })
    await settle()
    expect(rowTitles()).toEqual(['Roadmap', 'Ada’s plan', 'Untitled Workspace'])
  })

  it('reads what a team space lists when the list of spaces could not be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await renderAt(`/spaces/${PLATFORM.id}`, {
      api: { listSpaces: async () => { throw new Error('boom') } },
    })

    // The space's own info says it is a team space.
    expect(heading()).toBe('Platform')
    expect(rowTitles()).toEqual(['Roadmap', 'Ada’s plan', 'Untitled Workspace'])
  })

  it('returns to the workspaces page, whose heading takes the focus, when the user leaves the space', async () => {
    const { router } = await renderAt(`/spaces/${DESIGN.id}`)

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

  it('reads the space and the list of spaces again when the members close, the user’s role having changed there', async () => {
    const { listSpaces } = await renderAt(`/spaces/${PLATFORM.id}`)
    expect(document.body.textContent).toContain('Your role: Admin')

    await click(button('Members of Platform'))
    await settle()
    await chooseOption('Role of Me', 'Use')
    await settle()
    const listsRead = listSpaces.mock.calls.length
    await click(button('Close'))
    await settle()

    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.body.textContent).toContain('Your role: Use')
    expect(document.body.textContent).not.toContain('Your role: Admin')
    expect(listSpaces).toHaveBeenCalledTimes(listsRead + 1)
  })

  it('starts afresh for another space, showing nothing of the one it showed before', async () => {
    const platform = heldSpace(PLATFORM)
    const design = heldSpace(DESIGN)
    const info = deferred<SpaceInfo>()
    design.space.getInfo.mockReturnValue(info.promise)
    const { router } = await renderAt(`/spaces/${PLATFORM.id}`, {
      api: { openSpace: (id: string) => (id === DESIGN.id ? design.space : platform.space) },
    })
    await type(searchField(), 'Road')

    // As a space's link in the sidebar leads from one space's page to another's.
    await act(async () => {
      await router.navigate({ to: '/spaces/$spaceId', params: { spaceId: DESIGN.id } })
    })
    await shown(() => document.body.querySelector('[aria-label="Loading the space"]') !== null)
    expect(heading()).toBeUndefined()
    expect(document.body.textContent).not.toContain('Your role: Admin')

    await act(async () => { info.resolve(DESIGN) })
    await pageNamed('Design')
    expect(document.body.textContent).toContain('Your role: Use')
    expect(searchField().value).toBe('')
  })

  it('gives its heading the focus of a user who arrives from creating the space', async () => {
    const { router } = await renderAt('/workspaces')

    await click(button('New space'))
    await type(labeledInput('Name'), 'Field notes')
    await click(button('Create'))
    await pageNamed('Field notes')

    // The dialog the space was named in, and the button that opened it, are gone.
    expect(router.state.location.pathname).toBe(`/spaces/${CREATED_ID}`)
    expect(document.activeElement).toBe(document.body.querySelector('h1'))
  })

  it('leaves the focus of a user who arrives with it somewhere where it is', async () => {
    const { router } = await renderAt('/workspaces', { chrome: <button>Beside the page</button> })
    const beside = button('Beside the page')
    beside.focus()

    await act(async () => {
      await router.navigate({ to: '/spaces/$spaceId', params: { spaceId: DESIGN.id } })
    })
    await pageNamed('Design')

    expect(document.activeElement).toBe(beside)
  })

  it('gives the search field the focus when a workspace moved to another space leaves the page', async () => {
    const overseer = {
      moveToSpace: vi.fn<Overseer['moveToSpace']>(async () => {}),
      [Symbol.dispose]: vi.fn<() => void>(),
    }
    await renderAt(`/spaces/${DESIGN.id}`, { api: { openWorkspace: () => overseer } })

    await chooseAction('Notes', 'Move to space')
    await click([...document.body.querySelectorAll('label')].find(label => label.textContent === 'Platform')!)
    await click(button('Move'))
    await settle()

    expect(overseer.moveToSpace).toHaveBeenCalledWith(PLATFORM.id)
    // The row went with the workspace, and with it the menu the move was chosen from.
    expect(rowTitles()).toEqual(['Brief'])
    expect(document.activeElement).toBe(searchField())
  })

  it('keeps the page, with what the user typed and opened in its list, through a replaced session', async () => {
    const { router, rerender, session } = await renderAt(`/spaces/${PLATFORM.id}`)
    await type(searchField(), 'Road')
    await chooseAction('Roadmap', 'Move to space')

    // The new session answers neither its flags nor its workspaces yet.
    const flags = deferred<{ spaces: boolean }>()
    const gadgets = deferred<WorkspaceMetadataWithTimestamps[]>()
    await rerender(<RouterProvider router={router} />, session({
      getUiFeatureFlags: () => flags.promise,
      listWorkspaces: () => gadgets.promise,
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
    await renderAt(`/spaces/${DESIGN.id}`, { strangerTo: DESIGN.id })

    expect(showsNotFound()).toBe(true)
    expect(heading()).toBeUndefined()
  })

  it.each([
    ['a word', '/spaces/platform'],
    ['63 hex digits', `/spaces/${'a'.repeat(63)}`],
    ['64 characters, one of them no hex digit', `/spaces/${'a'.repeat(63)}g`],
  ])('is not found for a URL whose id cannot be a space id, and asks the server nothing about spaces: %s', async (_shape, at) => {
    // No sidebar is rendered here, so the route is all that could ask for the list of spaces.
    const { openSpace, listSpaces } = await renderAt(at)

    expect(showsNotFound()).toBe(true)
    expect(heading()).toBeUndefined()
    expect(openSpace).not.toHaveBeenCalled()
    expect(listSpaces).not.toHaveBeenCalled()
  })

  it('is not found for a URL whose id cannot be a space id before the session’s flags are known', async () => {
    const { openSpace, listSpaces } = await renderAt('/spaces/platform', {
      api: { getUiFeatureFlags: () => deferred<{ spaces: boolean }>().promise },
    })

    expect(showsNotFound()).toBe(true)
    expect(openSpace).not.toHaveBeenCalled()
    expect(listSpaces).not.toHaveBeenCalled()
  })

  it('shows nothing, and not that there is no such page, until the session’s flags are known', async () => {
    const flags = deferred<{ spaces: boolean }>()
    const { openSpace, listSpaces } = await renderAt(`/spaces/${PLATFORM.id}`, {
      api: { getUiFeatureFlags: () => flags.promise },
    })

    expect(showsNotFound()).toBe(false)
    expect(heading()).toBeUndefined()
    expect(openSpace).not.toHaveBeenCalled()
    expect(listSpaces).not.toHaveBeenCalled()

    await act(async () => { flags.resolve({ spaces: true }) })
    await pageNamed('Platform')
  })

  it('is not found for an id the server refuses as no space id', async () => {
    // An id of the right shape that is another namespace's, as a workspace's id is.
    const id = idOf('e')
    const refused = fakeSpace(teamSpace(id, 'X'), [])
    refused.getInfo.mockRejectedValue(invalidSpaceId())
    refused.listMembers.mockRejectedValue(invalidSpaceId())
    refused.listWorkspaces.mockRejectedValue(invalidSpaceId())
    const openSpace = vi.fn<(id: string) => unknown>(() => refused)
    await renderAt(`/spaces/${id}`, { api: { openSpace } })

    expect(showsNotFound()).toBe(true)
    expect(heading()).toBeUndefined()
    expect(new Set(openSpace.mock.calls.map(([asked]) => asked))).toEqual(new Set([id]))
  })

  it('leaves Try again enabled and marked busy while the space is read again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const platform = heldSpace(PLATFORM)
    const again = failing<SpaceInfo>()
    platform.space.getInfo
      .mockRejectedValueOnce(new Error('boom'))
      .mockReturnValueOnce(again.promise)
    await renderAt(`/spaces/${PLATFORM.id}`, { api: { openSpace: platform.openSpace } })
    expect(alerts()).toEqual(['Couldn’t load this space.Try again'])

    await click(button('Try again'))
    await settle()
    const busy = button('Try again')
    // Not disabled, which would take the focus from it.
    expect(busy.disabled).toBe(false)
    expect(busy.getAttribute('aria-disabled')).toBe('true')

    // A press while the read is under way starts no other. What the space lists is read through
    // an open of its own, so the opens are compared and not counted.
    const opens = platform.openSpace.mock.calls.length
    const reads = platform.space.getInfo.mock.calls.length
    await click(busy)
    await settle()
    expect(platform.openSpace.mock.calls.length).toBe(opens)
    expect(platform.space.getInfo.mock.calls.length).toBe(reads)

    await act(async () => { again.fail(new Error('boom')) })
    await settle()
    expect(alerts()).toEqual(['Couldn’t load this space.Try again'])
    expect(button('Try again').getAttribute('aria-disabled')).toBeNull()
  })

  it('gives the heading the focus when the space is read on another try', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const platform = heldSpace(PLATFORM)
    platform.space.getInfo.mockRejectedValueOnce(new Error('boom'))
    await renderAt(`/spaces/${PLATFORM.id}`, { api: { openSpace: platform.openSpace } })

    const tryAgain = button('Try again')
    tryAgain.focus()
    await click(tryAgain)
    await pageNamed('Platform')

    // The button went with the alert once the space was read.
    expect(alerts()).toEqual([])
    expect(document.activeElement).toBe(document.body.querySelector('h1'))
  })

  it('says so when what the space lists cannot be read, and reads it again from a button that stays enabled', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const platform = heldSpace(PLATFORM)
    const again = deferred<SpaceWorkspaceInfo[]>()
    platform.space.listWorkspaces
      .mockRejectedValueOnce(new Error('boom'))
      .mockReturnValueOnce(again.promise)
    await renderAt(`/spaces/${PLATFORM.id}`, { api: { openSpace: platform.openSpace } })

    expect(alerts()).toEqual(['Couldn’t load this space’s workspaces.Try again'])
    // The user's own workspace in the space is placed by their record of it.
    expect(rowTitles()).toEqual(['Roadmap'])

    const retry = button('Try again to load Platform')
    await click(retry)
    await settle()
    // Not disabled, which would take the focus from it.
    expect(retry.disabled).toBe(false)
    expect(retry.getAttribute('aria-disabled')).toBe('true')

    await act(async () => { again.resolve(LISTED[PLATFORM.id]) })
    await settle()
    expect(alerts()).toEqual([])
    expect(rowTitles()).toEqual(['Roadmap', 'Ada’s plan', 'Untitled Workspace'])
  })

  it('gives the search field the focus when the listing is read on another try', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const platform = heldSpace(PLATFORM)
    platform.space.listWorkspaces.mockRejectedValueOnce(new Error('boom'))
    await renderAt(`/spaces/${PLATFORM.id}`, { api: { openSpace: platform.openSpace } })

    const retry = button('Try again to load Platform')
    retry.focus()
    await click(retry)
    await settle()

    // The button went with the alert once the listing was read.
    expect(alerts()).toEqual([])
    expect(document.activeElement).toBe(searchField())
  })

  it('says that what a team space lists is being read until it has been', async () => {
    const platform = heldSpace(PLATFORM)
    const listing = deferred<SpaceWorkspaceInfo[]>()
    platform.space.listWorkspaces.mockReturnValueOnce(listing.promise)
    await renderAt(`/spaces/${PLATFORM.id}`, { api: { openSpace: platform.openSpace } })

    expect(statuses()).toEqual(['Loading this space’s workspaces…'])
    // The user's own workspace in the space is placed by their record of it.
    expect(rowTitles()).toEqual(['Roadmap'])

    await act(async () => { listing.resolve(LISTED[PLATFORM.id]) })
    await settle()
    expect(statuses()).toEqual([])
    expect(rowTitles()).toEqual(['Roadmap', 'Ada’s plan', 'Untitled Workspace'])
  })

  it('goes on saying that what the space lists could not be read, with its Try again, when a search matches no row', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const platform = heldSpace(PLATFORM)
    platform.space.listWorkspaces.mockRejectedValueOnce(new Error('boom'))
    await renderAt(`/spaces/${PLATFORM.id}`, { api: { openSpace: platform.openSpace } })

    // Another member's workspace, which only the listing would have.
    await type(searchField(), 'Ada')

    expect(rowTitles()).toEqual([])
    // What was searched lacks what the space lists.
    expect(document.body.textContent).toContain('No workspaces found, but the results may be incomplete.')
    expect(alerts()).toEqual(['Couldn’t load this space’s workspaces.Try again'])

    await click(button('Try again to load Platform'))
    await settle()
    expect(alerts()).toEqual([])
    expect(rowTitles()).toEqual(['Ada’s plan'])
    expect(document.body.textContent).not.toContain('No workspaces found')
  })

  it('says that what the space lists is being read, and not that nothing was found, when a search matches no row yet', async () => {
    const platform = heldSpace(PLATFORM)
    const listing = deferred<SpaceWorkspaceInfo[]>()
    platform.space.listWorkspaces.mockReturnValueOnce(listing.promise)
    await renderAt(`/spaces/${PLATFORM.id}`, { api: { openSpace: platform.openSpace } })

    await type(searchField(), 'Ada')
    expect(rowTitles()).toEqual([])
    expect(statuses()).toEqual(['Loading this space’s workspaces…'])
    expect(document.body.textContent).not.toContain('No workspaces found')

    await act(async () => { listing.resolve(LISTED[PLATFORM.id]) })
    await settle()
    expect(statuses()).toEqual([])
    expect(rowTitles()).toEqual(['Ada’s plan'])
  })

  it('says that the user is no longer a member under a search that matches no row', async () => {
    const platform = heldSpace(PLATFORM)
    platform.space.listWorkspaces.mockRejectedValue(notAMember())
    await renderAt(`/spaces/${PLATFORM.id}`, { api: { openSpace: platform.openSpace } })

    await type(searchField(), 'Ada')

    expect(document.body.textContent).toContain('No workspaces found')
    expect(alerts()).toEqual(['You are no longer a member of this space.'])
  })

  it('keeps Try again busy with the read it started while a search comes to match no row and is cleared', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const platform = heldSpace(PLATFORM)
    const again = deferred<SpaceWorkspaceInfo[]>()
    platform.space.listWorkspaces
      .mockRejectedValueOnce(new Error('boom'))
      .mockReturnValueOnce(again.promise)
    await renderAt(`/spaces/${PLATFORM.id}`, { api: { openSpace: platform.openSpace } })

    await click(button('Try again to load Platform'))
    await settle()
    await type(searchField(), 'zzz')
    expect(button('Try again to load Platform').getAttribute('aria-disabled')).toBe('true')
    await type(searchField(), '')
    const busy = button('Try again to load Platform')
    expect(busy.getAttribute('aria-disabled')).toBe('true')

    // A press while the read is under way starts no other.
    const reads = platform.space.listWorkspaces.mock.calls.length
    await click(busy)
    await settle()
    expect(platform.space.listWorkspaces.mock.calls.length).toBe(reads)

    await act(async () => { again.resolve(LISTED[PLATFORM.id]) })
    await settle()
    expect(alerts()).toEqual([])
    expect(rowTitles()).toEqual(['Roadmap', 'Ada’s plan', 'Untitled Workspace'])
  })

  it('says that the user is no longer a member when the space answers for itself and refuses to say what it lists', async () => {
    const platform = heldSpace(PLATFORM)
    platform.space.listWorkspaces.mockRejectedValue(notAMember())
    await renderAt(`/spaces/${PLATFORM.id}`, { api: { openSpace: platform.openSpace } })

    expect(heading()).toBe('Platform')
    expect(alerts()).toEqual(['You are no longer a member of this space.'])
    expect(hasButton('Try again to load Platform')).toBe(false)
    // The space was read once more for the refusal, and answered for itself again.
    expect(platform.space.getInfo).toHaveBeenCalledTimes(2)
  })

  it('is not found once the space has dropped the user, which its refusal to say what it lists is the first sign of', async () => {
    const platform = heldSpace(PLATFORM)
    const listing = failing<SpaceWorkspaceInfo[]>()
    platform.space.listWorkspaces.mockReturnValueOnce(listing.promise)
    await renderAt(`/spaces/${PLATFORM.id}`, { api: { openSpace: platform.openSpace } })
    expect(heading()).toBe('Platform')

    await platform.space.removeMember(ME.id)
    await act(async () => { listing.fail(notAMember()) })
    await settle()

    expect(showsNotFound()).toBe(true)
    expect(heading()).toBeUndefined()
  })

  describe('for a user with no workspace, on a deployment that features blueprints', () => {
    const api = { listWorkspaces: async () => [], listFeaturedBlueprints: async () => FEATURED }

    it('offers no blueprints on a team space’s page, where a workspace made from one would not land', async () => {
      const design = heldSpace(DESIGN)
      design.space.listWorkspaces.mockResolvedValueOnce([])
      await renderAt(`/spaces/${DESIGN.id}`, { api: { ...api, openSpace: design.openSpace } })
      await settle()

      expect(document.body.textContent).toContain('No workspaces in this space yet.')
      expect(offersBlueprints()).toBe(false)
    })

    it('offers the blueprints in place of the empty list of the personal space', async () => {
      await renderAt(`/spaces/${PERSONAL.id}`, { api })

      expect(document.body.textContent).toContain('No workspaces in your personal space yet.')
      expect(offersBlueprints()).toBe(true)
    })

    it('offers no blueprints under the workspaces a space lists', async () => {
      await renderAt(`/spaces/${PLATFORM.id}`, { api })

      expect(rowTitles()).toEqual(['Ada’s plan', 'Untitled Workspace'])
      expect(offersBlueprints()).toBe(false)
    })
  })

  it('is not found, and makes no spaces call, while the flag is off', async () => {
    // An id the route would ask about, so that it is the flag that stops the calls.
    const { openSpace, listSpaces } = await renderAt(`/spaces/${PLATFORM.id}`, { spacesFlag: false })

    expect(showsNotFound()).toBe(true)
    expect(heading()).toBeUndefined()
    expect(openSpace).not.toHaveBeenCalled()
    expect(listSpaces).not.toHaveBeenCalled()
  })
})
