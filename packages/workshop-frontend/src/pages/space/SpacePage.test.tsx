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
  openSpaceAmong,
  person,
  personalSpace,
  pressEscape,
  settle,
  subspace,
  teamSpace,
  type,
  unmountAll,
  type FakeSpaceOptions,
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
// Sub-spaces, which the user's list of spaces does not have: Infra is inside Platform and Ops
// inside Infra; Archive is inside the personal space.
const INFRA = teamSpace(idOf('e'), 'Infra', 'admin', PLATFORM.id)
const OPS = teamSpace(idOf('f'), 'Ops', 'admin', INFRA.id)
const ARCHIVE = teamSpace(idOf('b'), 'Archive', 'admin', PERSONAL.id)
// A space as the space it is inside lists it.
const listedIn = (info: SpaceInfo) => subspace(info.id, info.name)
// Platform with Infra inside it, and Ops inside Infra, which the user reaches from Platform.
const NESTED: { others: SpaceInfo[]; inside: Record<string, FakeSpaceOptions> } = {
  others: [INFRA, OPS],
  inside: {
    [PLATFORM.id]: { subspaces: [listedIn(INFRA)] },
    [INFRA.id]: { inherited: 'admin', subspaces: [listedIn(OPS)] },
    [OPS.id]: { inherited: 'admin' },
  },
}

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
 * user as a member. `others` are spaces the user's list does not have, and `inside` is what a
 * space holds besides its members and its listing, by space id: its sub-spaces, and the role
 * the user holds above it, with which they are a member of it without having been added to it.
 * `chrome` is rendered beside the page, as the sidebar is. `session` is the same user's session
 * again, as a reconnect replaces it, with the methods it is given in place of its own.
 */
const renderAt = async (at: string, { spacesFlag = true, strangerTo, others = [], inside = {}, api, chrome }: {
  spacesFlag?: boolean
  strangerTo?: string
  others?: SpaceInfo[]
  inside?: Record<string, FakeSpaceOptions>
  api?: FakeApiMethods
  chrome?: ReactNode
} = {}) => {
  let spaces = SPACES
  const opened = new Map<string, ReturnType<typeof fakeSpace>>()
  const openSpace = vi.fn<(id: string) => unknown>((id) => {
    const info: SpaceInfo = [...spaces, ...others].find(space => space.id === id)!
    const added = id !== strangerTo && !inside[id]?.inherited
    const space = opened.get(id)
      ?? fakeSpace(info, added ? [member(ME, info.role)] : [], LISTED[id], inside[id])
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
  return { ...mounted, openSpace, listSpaces, session, opened }
}

// One space the test holds, which every open answers: for a test that sets what the space's
// reads answer, or asks which of them were made.
const heldSpace = (info: SpaceInfo, options?: FakeSpaceOptions) => {
  const space = fakeSpace(info, [member(ME, info.role)], LISTED[info.id], options)
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

// Answers a read as the app sees it answered: not under `act`, so React renders what the answer
// set in a later task than the one the answer arrived in. Waits, within a bound, for `settled`.
const answerOutsideAct = async (answer: () => void, settled: () => boolean) => {
  const react = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  react.IS_REACT_ACT_ENVIRONMENT = false
  try {
    answer()
    for (let turn = 0; turn < 100 && !settled(); turn++) {
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  } finally {
    react.IS_REACT_ACT_ENVIRONMENT = true
  }
}

const searchField = () => document.body.querySelector<HTMLInputElement>('input[placeholder^="Search"]')!

// The list of the sub-spaces of the space called `label`, when the page shows one.
const subspaceList = (label: string) =>
  document.body.querySelector(`ul[aria-label="Sub-spaces of ${label}"]`)

// Each sub-space card of the space called `label`, as its name and where it leads.
const subspaceCards = (label: string) => [...(subspaceList(label)?.querySelectorAll('li a') ?? [])]
  .map(card => [card.textContent, card.getAttribute('href')])

const rowTitles = () => [...document.body.querySelectorAll('h3')].map(title => title.textContent)

const rowOf = (title: string) => [...document.body.querySelectorAll('h3')]
  .find(rowTitle => rowTitle.textContent === title)!.closest('a')!

const link = (name: string) => {
  const found = [...document.body.querySelectorAll('a')].find(anchor =>
    anchor.getAttribute('aria-label') === name)
  if (!found) throw new Error(`No link named “${name}”`)
  return found
}

// The page's way up, when it shows one.
const breadcrumb = () => document.body.querySelector('nav[aria-label="Breadcrumb"]')

// Each link of the way up, as its text and where it leads.
const crumbs = () => [...(breadcrumb()?.querySelectorAll('a') ?? [])]
  .map(crumb => [crumb.textContent, crumb.getAttribute('href')])

// Whether the page offers a space inside any space.
const offersNewSpace = () => [...document.body.querySelectorAll('button')].some(candidate =>
  candidate.textContent?.trim() === 'New space' || candidate.getAttribute('aria-label')?.startsWith('New space in'))

// The title of the dialog on show.
const dialogTitle = () =>
  document.getElementById(openDialog()?.getAttribute('aria-labelledby') ?? '')?.textContent

// Platform, held by the test, and every space created inside it, which the user reaches with
// the role they hold in Platform. Any other id opens a space that refuses the user.
const platformWithCreations = () => {
  const platform = fakeSpace(PLATFORM, [member(ME, PLATFORM.role)], LISTED[PLATFORM.id])
  const created = new Map<string, ReturnType<typeof fakeSpace>>()
  const openSpace = vi.fn<(id: string) => unknown>((id) => {
    if (id === PLATFORM.id) return platform
    const listed = platform.subspaces().find(inside => inside.id === id)
    if (!listed) return fakeSpace(teamSpace(id, id), [])
    const space = created.get(id)
      ?? fakeSpace(teamSpace(id, listed.name, 'admin', PLATFORM.id), [], [], { inherited: 'admin' })
    created.set(id, space)
    return space
  })
  return { platform, openSpace }
}

// Platform as above, whose first creation makes the sub-space and gets no answer, as when the
// connection is lost under it.
const platformLosingAnAnswer = () => {
  vi.spyOn(console, 'debug').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const held = platformWithCreations()
  const create = held.platform.createSubspace.getMockImplementation()!
  held.platform.createSubspace.mockImplementationOnce(async (name) => {
    await create(name)
    throw new Error('Peer closed WebSocket')
  })
  return held
}

const NO_ANSWER = 'Couldn’t create the space. Try again.'

const DEPTH_LIMIT = 'A space can be nested at most 5 levels deep.'

// What each status line on show says.
const statuses = () =>
  [...document.body.querySelectorAll('[role="status"]')].map(status => status.textContent)

// The dialog on show.
const openDialog = () => document.body.querySelector('[role="dialog"]')

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

// Archive, a sub-space of the user's personal space, which lists a workspace of another
// member's, whom the user added to it.
const archiveSpace = () =>
  fakeSpace(ARCHIVE, [], [listedBy(ADA, 'w-brief', 'Brief')], { inherited: 'admin' })

// Archive's page, for a user with no workspace and no space in their list but their personal one.
const renderArchive = async (archive = archiveSpace()) => {
  await renderAt(`/spaces/${ARCHIVE.id}`, {
    api: {
      listSpaces: async () => [PERSONAL],
      listWorkspaces: async () => [],
      openSpace: openSpaceAmong([archive]),
    },
  })
  expect(heading()).toBe('Archive')
}

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

  it('offers the move on the personal space’s page to a user with no team space when the space has a sub-space, and not when it has none', async () => {
    await renderAt(`/spaces/${PERSONAL.id}`, { api: { listSpaces: async () => [PERSONAL] } })
    expect(await rowActions('Solo notes')).not.toContain('Move to space')
    unmountAll()

    await renderAt(`/spaces/${PERSONAL.id}`, {
      api: { listSpaces: async () => [PERSONAL] },
      others: [ARCHIVE],
      inside: { [PERSONAL.id]: { subspaces: [listedIn(ARCHIVE)] } },
    })
    expect(await rowActions('Solo notes')).toContain('Move to space')
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

  it('reads a team space’s sub-spaces with what it lists, on one open, and its info once', async () => {
    const platform = heldSpace(PLATFORM, { subspaces: [listedIn(INFRA)] })
    await renderAt(`/spaces/${PLATFORM.id}`, { api: { openSpace: platform.openSpace } })

    expect(subspaceCards('Platform')).toHaveLength(1)
    // One open for the space's info and members, one for what is in it.
    expect(platform.openSpace).toHaveBeenCalledTimes(2)
    expect(platform.space.getInfo).toHaveBeenCalledOnce()
    expect(platform.space.listWorkspaces).toHaveBeenCalledOnce()
    expect(platform.space.listSubspaces).toHaveBeenCalledOnce()
  })

  it('shows the sub-spaces directly inside a team space as cards above its workspaces, each linking to its page', async () => {
    const { openSpace } = await renderAt(`/spaces/${PLATFORM.id}`, NESTED)

    expect(subspaceCards('Platform')).toEqual([['Infra', `/spaces/${INFRA.id}`]])
    const firstRow = document.body.querySelector('h3')!
    expect(firstRow.textContent).toBe('Roadmap')
    expect(subspaceList('Platform')!.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
    // Only what is directly inside the space, and nothing is asked of a sub-space to show its card.
    expect(document.body.textContent).not.toContain('Ops')
    expect(openSpace.mock.calls.map(([id]) => id)).toEqual([PLATFORM.id, PLATFORM.id])
  })

  it('shows the sub-spaces of the user’s personal space on its page', async () => {
    await renderAt(`/spaces/${PERSONAL.id}`, {
      others: [ARCHIVE],
      inside: { [PERSONAL.id]: { subspaces: [listedIn(ARCHIVE)] } },
    })

    expect(subspaceCards('Personal')).toEqual([['Archive', `/spaces/${ARCHIVE.id}`]])
    const firstRow = document.body.querySelector('h3')!
    expect(firstRow.textContent).toBe('Solo notes')
    expect(subspaceList('Personal')!.compareDocumentPosition(firstRow) & Node.DOCUMENT_POSITION_FOLLOWING)
      .toBeTruthy()
  })

  it.each([
    ['a team space', PLATFORM],
    ['the personal space', PERSONAL],
  ])('shows no sub-space section for %s with none', async (_, space) => {
    const { opened } = await renderAt(`/spaces/${space.id}`)

    expect(opened.get(space.id)!.listSubspaces).toHaveBeenCalledOnce()
    expect(document.body.querySelector('ul[aria-label^="Sub-spaces of"]')).toBeNull()
    expect(sectionHeadings()).toEqual([])
    expect(alerts()).toEqual([])
  })

  it('goes to a sub-space’s page from its card, which starts afresh', async () => {
    await renderAt(`/spaces/${PLATFORM.id}`, NESTED)
    expect(rowTitles()).toContain('Roadmap')

    await click(subspaceList('Platform')!.querySelector('a')!)
    await pageNamed('Infra')
    await settle()

    expect(rowTitles()).toEqual([])
    expect(subspaceList('Platform')).toBeNull()
    // The page of the sub-space shows what is inside that one.
    expect(subspaceCards('Infra')).toEqual([['Ops', `/spaces/${OPS.id}`]])
  })

  it('opens a sub-space’s members from its card, and the page’s own from the header', async () => {
    const { opened } = await renderAt(`/spaces/${PLATFORM.id}`, NESTED)

    await click(button('Members of Infra'))
    await settle()
    expect(openDialog()?.textContent).toContain('Members of Infra')
    expect(openDialog()?.textContent).not.toContain('Members of Platform')
    const reads = opened.get(PLATFORM.id)!.getInfo.mock.calls.length

    await click(button('Close'))
    await settle()
    expect(openDialog()).toBeNull()
    // The page's space is read again when a dialog it opened closes.
    expect(opened.get(PLATFORM.id)!.getInfo).toHaveBeenCalledTimes(reads + 1)
    expect(heading()).toBe('Platform')

    await click(button('Members of Platform'))
    await settle()
    expect(openDialog()?.textContent).toContain('Members of Platform')
    expect(openDialog()?.textContent).not.toContain('Members of Infra')
  })

  it('hands the focus back to the card’s button when a sub-space’s members close', async () => {
    await renderAt(`/spaces/${PLATFORM.id}`, NESTED)
    const members = button('Members of Infra')
    members.focus()
    await click(members)
    await settle()

    await click(button('Close'))
    await settle()

    expect(openDialog()).toBeNull()
    expect(document.activeElement).toBe(members)
  })

  it('gives the page’s heading the focus when a sub-space’s members close over cards a replaced session rendered again', async () => {
    const { router, rerender, session } = await renderAt(`/spaces/${PLATFORM.id}`, NESTED)
    const members = button('Members of Infra')
    members.focus()
    await click(members)
    await settle()
    await rerender(<RouterProvider router={router} />, session())
    await settle()
    // The list was rendered again under the open dialog: the card is another element.
    expect(members.isConnected).toBe(false)
    expect(hasButton('Members of Infra')).toBe(true)

    await click(button('Close'))
    await settle()

    expect(openDialog()).toBeNull()
    expect(document.activeElement).toBe(document.body.querySelector('h1'))
  })

  it('gives Try again the focus when a sub-space’s members close over a read of the space that still fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { router, rerender, session, opened } = await renderAt(`/spaces/${PLATFORM.id}`, NESTED)
    await click(button('Members of Infra'))
    await settle()

    // The session that replaces the first cannot read the space, and neither can the read made
    // when the dialog closes: the header is gone, and the card the dialog was opened from.
    opened.get(PLATFORM.id)!.getInfo.mockRejectedValue(new Error('boom'))
    await rerender(<RouterProvider router={router} />, session())
    await settle()
    expect(heading()).toBeUndefined()
    expect(openDialog()?.textContent).toContain('Members of Infra')

    await click(button('Close'))
    await settle()

    expect(openDialog()).toBeNull()
    expect(document.activeElement).toBe(button('Try again'))
  })

  it('gives Try again the focus when the read of the space made as the members close fails, and takes away the header the focus was back in', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const platform = heldSpace(PLATFORM)
    await renderAt(`/spaces/${PLATFORM.id}`, { api: { openSpace: platform.openSpace } })
    const members = button('Members of Platform')
    members.focus()
    await click(members)
    await settle()

    const read = failing<SpaceInfo>()
    platform.space.getInfo.mockReturnValueOnce(read.promise)
    await click(button('Close'))
    await settle()
    // The list of spaces has been read again and the space has not: the header is still there,
    // and its button has the focus back.
    expect(openDialog()).toBeNull()
    expect(heading()).toBe('Platform')
    expect(document.activeElement).toBe(members)

    await answerOutsideAct(
      () => read.fail(new Error('boom')),
      () => hasButton('Try again') && document.activeElement === button('Try again'),
    )

    // The button went with the header only now, in the render that followed the read.
    expect(heading()).toBeUndefined()
    expect(document.activeElement).toBe(button('Try again'))
  })

  it('stays on the page, and says nothing of leaving it, when the user leaves a sub-space from its card', async () => {
    // The user was also added to Infra itself, which is what they leave: Platform still has them.
    const platform = fakeSpace(PLATFORM, [member(ME, 'admin')], LISTED[PLATFORM.id], { subspaces: [listedIn(INFRA)] })
    const infra = fakeSpace(INFRA, [member(ME, 'use')], [], { inherited: 'admin' })
    const { router } = await renderAt(`/spaces/${PLATFORM.id}`, {
      api: { openSpace: openSpaceAmong([platform, infra]) },
    })

    await click(button('Members of Infra'))
    await settle()
    await click(button('Leave space'))
    await click(button('Leave'))
    await settle()

    expect(infra.removeMember).toHaveBeenCalledExactlyOnceWith(ME.id)
    expect(router.state.location.pathname).toBe(`/spaces/${PLATFORM.id}`)
    expect(heading()).toBe('Platform')
    expect(document.body.textContent).not.toContain('You left Platform')
  })

  it('stays on the page, and says nothing of leaving it, when the sub-space the user left from its card no longer counts them as a member', async () => {
    // Infra counts the user for the role it gave them alone, as when the space above has
    // dropped them since the page read it: once they leave, Infra refuses them.
    const platform = fakeSpace(PLATFORM, [member(ME, 'admin')], LISTED[PLATFORM.id], { subspaces: [listedIn(INFRA)] })
    const infra = fakeSpace(INFRA, [member(ME, 'use')])
    const { router } = await renderAt(`/spaces/${PLATFORM.id}`, {
      api: { openSpace: openSpaceAmong([platform, infra]) },
    })

    await click(button('Members of Infra'))
    await settle()
    await click(button('Leave space'))
    await click(button('Leave'))
    await settle()

    expect(infra.removeMember).toHaveBeenCalledExactlyOnceWith(ME.id)
    expect(openDialog()).toBeNull()
    // The page is Platform's, which the user has not left.
    expect(router.state.location.pathname).toBe(`/spaces/${PLATFORM.id}`)
    expect(heading()).toBe('Platform')
    expect(document.body.textContent).not.toContain('You left')
  })

  it('hides the sub-space cards while the list is searched', async () => {
    await renderAt(`/spaces/${PLATFORM.id}`, NESTED)
    expect(subspaceList('Platform')).not.toBeNull()

    await type(searchField(), 'Road')
    expect(rowTitles()).toEqual(['Roadmap'])
    expect(subspaceList('Platform')).toBeNull()
    expect(hasButton('Members of Infra')).toBe(false)

    await type(searchField(), '')
    expect(subspaceList('Platform')).not.toBeNull()
  })

  it('asks nothing more of a space that refuses the user and is not in their list', async () => {
    const elsewhere = fakeSpace(teamSpace(idOf('9'), 'Elsewhere'), [])
    const openSpace = vi.fn<(id: string) => unknown>(() => elsewhere)
    await renderAt(`/spaces/${idOf('9')}`, { api: { openSpace } })

    expect(showsNotFound()).toBe(true)
    expect(openSpace).toHaveBeenCalledExactlyOnceWith(idOf('9'))
    expect(elsewhere.listSubspaces).not.toHaveBeenCalled()
    expect(elsewhere.listWorkspaces).not.toHaveBeenCalled()
  })

  it('says once that a team space could not be read, and shows its sub-spaces with its workspaces on another try', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const platform = heldSpace(PLATFORM, { subspaces: [listedIn(INFRA)] })
    platform.space.listSubspaces.mockRejectedValueOnce(new Error('boom'))
    await renderAt(`/spaces/${PLATFORM.id}`, { api: { openSpace: platform.openSpace } })

    expect(alerts()).toEqual(['Couldn’t load this space’s workspaces.Try again'])
    expect(subspaceList('Platform')).toBeNull()
    expect(rowTitles()).toEqual(['Roadmap'])

    await click(button('Try again to load Platform'))
    await settle()

    expect(alerts()).toEqual([])
    expect(subspaceCards('Platform')).toEqual([['Infra', `/spaces/${INFRA.id}`]])
    expect(rowTitles()).toEqual(['Roadmap', 'Ada’s plan', 'Untitled Workspace'])
  })

  it('says that the personal space’s sub-spaces could not be read, and gives the first card’s link the focus once another try shows them', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const personal = heldSpace(PERSONAL, { subspaces: [listedIn(ARCHIVE)] })
    personal.space.listSubspaces.mockRejectedValueOnce(new Error('boom'))
    await renderAt(`/spaces/${PERSONAL.id}`, { api: { openSpace: personal.openSpace } })

    expect(alerts()).toEqual(['Couldn’t load the sub-spaces of Personal.Try again'])
    // The user's workspaces are their own records, which the failure leaves as they are.
    expect(rowTitles()).toEqual(['Solo notes'])

    const retry = button('Try again to load the sub-spaces of Personal')
    retry.focus()
    await click(retry)
    await settle()

    expect(alerts()).toEqual([])
    const first = subspaceList('Personal')!.querySelector('a')!
    expect(first.textContent).toBe('Archive')
    // The card's link, and not the search field the page also has.
    expect(document.activeElement).toBe(first)
  })

  it('gives the search field the focus when another try finds that the personal space has no sub-space', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const personal = heldSpace(PERSONAL)
    personal.space.listSubspaces.mockRejectedValueOnce(new Error('boom'))
    await renderAt(`/spaces/${PERSONAL.id}`, { api: { openSpace: personal.openSpace } })

    const retry = button('Try again to load the sub-spaces of Personal')
    retry.focus()
    await click(retry)
    await settle()

    // The button went with the alert, and nothing of the cards took its place.
    expect(alerts()).toEqual([])
    expect(subspaceList('Personal')).toBeNull()
    expect(searchField()).not.toBeNull()
    expect(document.activeElement).toBe(searchField())
  })

  it('gives New space the focus when another try finds no sub-space and the personal space’s page has no search field', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const personal = heldSpace(PERSONAL)
    personal.space.listSubspaces.mockRejectedValueOnce(new Error('boom'))
    // A user with no workspace has no search field on this page for the focus to go to.
    await renderAt(`/spaces/${PERSONAL.id}`, {
      api: { openSpace: personal.openSpace, listWorkspaces: async () => [] },
    })
    expect(searchField()).toBeNull()

    const retry = button('Try again to load the sub-spaces of Personal')
    retry.focus()
    await click(retry)
    await settle()

    expect(alerts()).toEqual([])
    expect(subspaceList('Personal')).toBeNull()
    expect(document.activeElement).toBe(button('New space in Personal'))
  })

  it('says that no workspace was found, and nothing of incomplete results, when a search of the personal space matches nothing and its sub-spaces could not be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const personal = heldSpace(PERSONAL)
    personal.space.listSubspaces.mockRejectedValue(new Error('boom'))
    await renderAt(`/spaces/${PERSONAL.id}`, { api: { openSpace: personal.openSpace } })
    expect(alerts()).toEqual(['Couldn’t load the sub-spaces of Personal.Try again'])

    await type(searchField(), 'zzz')

    // Every workspace of this page was searched: they are the user's own records.
    expect(document.body.textContent).toContain('No workspaces found')
    expect(document.body.textContent).not.toContain('the results may be incomplete')
  })

  describe('for a user with no workspace and no team space in their list, on a sub-space of their personal space', () => {
    it('offers a search of what a team space lists to a user with no workspace and no team space in their list', async () => {
      await renderArchive()

      expect(searchField()).not.toBeNull()
      await type(searchField(), 'bri')
      expect(rowTitles()).toEqual(['Brief'])

      await type(searchField(), 'zzz')
      expect(rowTitles()).toEqual([])
      expect(document.body.textContent).toContain('No workspaces found')
    })

    it('gives the search field of such a page the focus when what the space lists is read on another try', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const archive = archiveSpace()
      archive.listWorkspaces.mockRejectedValueOnce(new Error('boom'))
      await renderArchive(archive)
      expect(alerts()).toEqual(['Couldn’t load this space’s workspaces.Try again'])

      const retry = button('Try again to load Archive')
      retry.focus()
      await click(retry)
      await settle()

      expect(alerts()).toEqual([])
      expect(rowTitles()).toEqual(['Brief'])
      expect(searchField()).not.toBeNull()
      expect(document.activeElement).toBe(searchField())
    })
  })

  it('offers no search on the personal space’s page to a user with no workspace', async () => {
    // The user's list has team spaces, whose workspaces are not this page's to show.
    await renderAt(`/spaces/${PERSONAL.id}`, { api: { listWorkspaces: async () => [] } })

    expect(heading()).toBe('Personal')
    expect(searchField()).toBeNull()
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

  it('says under the name the role the space reports, where the user’s list has a lower one', async () => {
    // The user's list has them as a `use` member of Design; they are an admin of a space above it.
    const { space, openSpace } = heldSpace(DESIGN, { inherited: 'admin' })
    const info = deferred<SpaceInfo>()
    space.getInfo.mockReturnValueOnce(info.promise)
    await renderAt(`/spaces/${DESIGN.id}`, { api: { openSpace } })

    // Nothing says a role before the space has: the list's is not shown meanwhile.
    expect(document.body.textContent).not.toContain('Your role')

    await act(async () => { info.resolve({ ...DESIGN, role: 'admin' }) })
    await pageNamed('Design')
    expect(document.body.textContent).toContain('Your role: Admin')
    expect(document.body.textContent).not.toContain('Your role: Use')
  })

  it('shows the way up when the space reports a parent: a link to each space above that the user can open, outermost first', async () => {
    await renderAt(`/spaces/${OPS.id}`, NESTED)

    expect(heading()).toBe('Ops')
    expect(crumbs()).toEqual([
      ['Platform', `/spaces/${PLATFORM.id}`],
      ['Infra', `/spaces/${INFRA.id}`],
    ])
    // The way up comes before the name.
    const title = document.body.querySelector('h1')!
    expect(breadcrumb()!.compareDocumentPosition(title) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it.each<[string, SpaceInfo, { others?: SpaceInfo[] }]>([
    ['a team space that is inside no other', PLATFORM, {}],
    // The user was added to Infra itself and holds no role in Platform, which Infra is inside.
    ['a sub-space the user was only added to', INFRA, { others: [INFRA] }],
  ])('shows no way up, and opens no other space, for a space that reports no parent: %s', async (_case, space, options) => {
    const { openSpace } = await renderAt(`/spaces/${space.id}`, options)

    expect(heading()).toBe(space.name)
    expect(breadcrumb()).toBeNull()
    // No line is kept for a way up either: the name is the first thing in the header.
    expect(document.body.querySelector('header')!.firstElementChild!.firstElementChild)
      .toBe(document.body.querySelector('h1'))
    expect(new Set(openSpace.mock.calls.map(([id]) => id))).toEqual(new Set([space.id]))
  })

  it('shows the way up as far as the server lets the user open it', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    // Infra names Platform as the space it is inside, and Platform has dropped the user since.
    const { openSpace } = await renderAt(`/spaces/${OPS.id}`, { ...NESTED, strangerTo: PLATFORM.id })

    expect(crumbs()).toEqual([['Infra', `/spaces/${INFRA.id}`]])
    expect(openSpace).toHaveBeenCalledWith(PLATFORM.id)
    // Nothing says that there is more above.
    expect(document.body.querySelector('header')!.textContent).not.toContain('…')
    expect(breadcrumb()!.querySelectorAll('li')).toHaveLength(1)
    expect(logged).not.toHaveBeenCalled()
  })

  it('calls the user’s personal space Personal in the way up', async () => {
    await renderAt(`/spaces/${ARCHIVE.id}`, { others: [ARCHIVE], inside: { [ARCHIVE.id]: { inherited: 'admin' } } })

    expect(heading()).toBe('Archive')
    expect(crumbs()).toEqual([['Personal', `/spaces/${PERSONAL.id}`]])
  })

  it('goes to the space above from its crumb', async () => {
    const { router } = await renderAt(`/spaces/${OPS.id}`, NESTED)

    await click(breadcrumb()!.querySelectorAll('a')[1])
    await pageNamed('Infra')

    expect(router.state.location.pathname).toBe(`/spaces/${INFRA.id}`)
    expect(crumbs()).toEqual([['Platform', `/spaces/${PLATFORM.id}`]])
  })

  it.each(['admin', 'build'] as const)('offers a member whose role is %s a new space inside the space, named for it', async (role) => {
    const lab = teamSpace(idOf('9'), 'Lab', role)
    await renderAt(`/spaces/${lab.id}`, { others: [lab] })

    expect(heading()).toBe('Lab')
    expect(button('New space in Lab').textContent).toBe('New space')
    // Between the space's members and a workspace in it.
    const entries = [...document.body.querySelectorAll('header button, header a')]
      .map(entry => entry.getAttribute('aria-label'))
    expect(entries).toEqual(['Members of Lab', 'New space in Lab', 'New workspace in Lab'])
  })

  it('offers a use member no new space', async () => {
    await renderAt(`/spaces/${DESIGN.id}`)

    expect(document.body.textContent).toContain('Your role: Use')
    expect(offersNewSpace()).toBe(false)
    expect(hasButton('Members of Design')).toBe(true)
  })

  it('goes by the role the space reports: a member given use there who is an admin above is offered a new space', async () => {
    const { openSpace } = heldSpace(DESIGN, { inherited: 'admin' })
    await renderAt(`/spaces/${DESIGN.id}`, { api: { openSpace } })

    expect(hasButton('New space in Design')).toBe(true)
  })

  it('offers the owner of a personal space a new space inside it', async () => {
    await renderAt(`/spaces/${PERSONAL.id}`)

    await click(button('New space in Personal'))

    expect(dialogTitle()).toBe('New space in Personal')
  })

  it('creates a sub-space from a name alone and goes to its page, whose heading takes the focus', async () => {
    const { platform, openSpace } = platformWithCreations()
    const { router, listSpaces } = await renderAt(`/spaces/${PLATFORM.id}`, { api: { openSpace } })

    await click(button('New space in Platform'))
    expect(dialogTitle()).toBe('New space in Platform')
    expect([...openDialog()!.querySelectorAll('input, textarea, select')]).toEqual([labeledInput('Name')])
    await type(labeledInput('Name'), '  Field notes ')
    await click(button('Create'))
    await pageNamed('Field notes')

    expect(platform.createSubspace).toHaveBeenCalledExactlyOnceWith('Field notes')
    expect(router.state.location.pathname).toBe(`/spaces/${platform.subspaces()[0].id}`)
    expect(openDialog()).toBeNull()
    expect(crumbs()).toEqual([['Platform', `/spaces/${PLATFORM.id}`]])
    expect(document.activeElement).toBe(document.body.querySelector('h1'))
    // A sub-space joins nobody's list of spaces, which is not read again.
    expect(listSpaces).toHaveBeenCalledOnce()
  })

  it('hands the focus back to New space when the space inside this one is not created', async () => {
    await renderAt(`/spaces/${PLATFORM.id}`)
    const newSpace = button('New space in Platform')
    newSpace.focus()

    await click(newSpace)
    expect(document.activeElement).toBe(labeledInput('Name'))
    await pressEscape()
    await settle()

    expect(openDialog()).toBeNull()
    expect(document.activeElement).toBe(newSpace)
  })

  it('keeps the space being named inside a space through a replaced session', async () => {
    const { router, rerender, session } = await renderAt(`/spaces/${PLATFORM.id}`)
    await click(button('New space in Platform'))
    await type(labeledInput('Name'), 'Field notes')

    // The new session answers neither its flags nor its workspaces yet.
    const flags = deferred<{ spaces: boolean }>()
    const gadgets = deferred<WorkspaceMetadataWithTimestamps[]>()
    await rerender(<RouterProvider router={router} />, session({
      getUiFeatureFlags: () => flags.promise,
      listWorkspaces: () => gadgets.promise,
    }))
    await settle()
    expect(labeledInput('Name').value).toBe('Field notes')
    expect(hasButton('New space in Platform')).toBe(true)

    await act(async () => {
      flags.resolve({ spaces: true })
      gadgets.resolve(GADGETS)
    })
    await settle()
    expect(labeledInput('Name').value).toBe('Field notes')
    expect(dialogTitle()).toBe('New space in Platform')
  })

  it('keeps the space being named inside a space over a read of the space that failed, and still creates it', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { platform, openSpace } = platformWithCreations()
    const { router, rerender, session } = await renderAt(`/spaces/${PLATFORM.id}`, { api: { openSpace } })
    await click(button('New space in Platform'))
    await type(labeledInput('Name'), 'Field notes')

    // The session that replaces the first cannot read the space.
    platform.getInfo.mockRejectedValueOnce(new Error('boom'))
    await rerender(<RouterProvider router={router} />, session())
    await settle()
    expect(alerts()).toEqual(['Couldn’t load this space.Try again'])
    expect(heading()).toBeUndefined()
    expect(dialogTitle()).toBe('New space in Platform')
    expect(labeledInput('Name').value).toBe('Field notes')

    await click(button('Create'))
    await pageNamed('Field notes')
    expect(platform.createSubspace).toHaveBeenCalledExactlyOnceWith('Field notes')
    expect(openDialog()).toBeNull()
  })

  it('gives Try again the focus when the space being named is dismissed over a read of the space that failed', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { platform, openSpace } = platformWithCreations()
    const { router, rerender, session } = await renderAt(`/spaces/${PLATFORM.id}`, { api: { openSpace } })
    await click(button('New space in Platform'))

    // The session that replaces the first cannot read the space: the header goes, and the
    // button the dialog was opened from with it.
    platform.getInfo.mockRejectedValueOnce(new Error('boom'))
    await rerender(<RouterProvider router={router} />, session())
    await settle()
    expect(hasButton('New space in Platform')).toBe(false)
    expect(dialogTitle()).toBe('New space in Platform')

    await pressEscape()
    await settle()

    expect(openDialog()).toBeNull()
    expect(document.activeElement).toBe(button('Try again'))
  })

  it('takes the space being named away with the page of a space that refuses the user, and does not bring it back', async () => {
    const { router, rerender, session } = await renderAt(`/spaces/${PLATFORM.id}`)
    await click(button('New space in Platform'))
    await type(labeledInput('Name'), 'Field notes')

    // The session that replaces the first finds that the space has dropped the user.
    await rerender(<RouterProvider router={router} />, session({ openSpace: () => fakeSpace(PLATFORM, []) }))
    await shown(showsNotFound)
    expect(openDialog()).toBeNull()

    // The one after it finds them a member again.
    await rerender(<RouterProvider router={router} />, session())
    await pageNamed('Platform')
    expect(openDialog()).toBeNull()
  })

  it('goes to the sub-space a creation with no answer made, and makes no second one, when it is created again', async () => {
    const { platform, openSpace } = platformLosingAnAnswer()
    const { router } = await renderAt(`/spaces/${PLATFORM.id}`, { api: { openSpace } })

    await click(button('New space in Platform'))
    await type(labeledInput('Name'), 'Field notes')
    await click(button('Create'))
    await settle()
    expect(alerts()).toEqual([NO_ANSWER])
    await click(button('Create'))
    await pageNamed('Field notes')

    expect(platform.createSubspace).toHaveBeenCalledOnce()
    expect(platform.subspaces()).toHaveLength(1)
    expect(router.state.location.pathname).toBe(`/spaces/${platform.subspaces()[0].id}`)
  })

  it('shows the card of the sub-space a creation with no answer made once the dialog is closed', async () => {
    const { platform, openSpace } = platformLosingAnAnswer()
    await renderAt(`/spaces/${PLATFORM.id}`, { api: { openSpace } })

    await click(button('New space in Platform'))
    await type(labeledInput('Name'), 'Field notes')
    await click(button('Create'))
    await settle()
    expect(subspaceCards('Platform')).toEqual([])
    await click(button('Cancel'))
    await settle()

    expect(openDialog()).toBeNull()
    expect(subspaceCards('Platform')).toEqual([['Field notes', `/spaces/${platform.subspaces()[0].id}`]])
  })

  it('shows the server’s refusal at the depth limit in the dialog, and stays on the page', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { space, openSpace } = heldSpace(PLATFORM)
    space.createSubspace.mockRejectedValueOnce(new Error(DEPTH_LIMIT))
    const { router } = await renderAt(`/spaces/${PLATFORM.id}`, { api: { openSpace } })

    await click(button('New space in Platform'))
    await type(labeledInput('Name'), 'Field notes')
    await click(button('Create'))
    await settle()

    expect(alerts()).toEqual([DEPTH_LIMIT])
    expect(dialogTitle()).toBe('New space in Platform')
    expect(router.state.location.pathname).toBe(`/spaces/${PLATFORM.id}`)
    expect(heading()).toBe('Platform')
  })

  it('is not found, and makes no spaces call, while the flag is off', async () => {
    // An id the route would ask about, so that it is the flag that stops the calls.
    const { openSpace, listSpaces } = await renderAt(`/spaces/${PLATFORM.id}`, { spacesFlag: false })

    expect(showsNotFound()).toBe(true)
    expect(heading()).toBeUndefined()
    expect(breadcrumb()).toBeNull()
    expect(offersNewSpace()).toBe(false)
    expect(openSpace).not.toHaveBeenCalled()
    expect(listSpaces).not.toHaveBeenCalled()
  })
})
