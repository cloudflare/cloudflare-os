// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps, type ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoute, RouterProvider, type AnyRoute } from '@tanstack/react-router'
import type {
  AiChatAuthorInfo,
  AuthenticatedApi,
  ConnectedAccountsSubscriber,
  GadgetMetadataWithTimestamps,
  Overseer,
  SpaceSyncJobInfo,
  SpaceWorkspaceInfo,
} from '@gadgets/workshop-shared/api'
import { Route as SpaceRoute } from '../../routes/spaces.$spaceKey'
import { Route as WorkspacesRoute } from '../../routes/workspaces'
import {
  ME,
  alerts,
  button,
  click,
  deferred,
  fakeApi,
  fakeSpace,
  hasButton,
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
} from './spacesTestUtils'
import type { StartSpaceSyncDialog as StartSpaceSyncDialogComponent } from './sync/StartSpaceSyncDialog'
import { VisitedSpace } from './VisitedSpace'

// The members dialog's avatars load when scrolled into view, which jsdom has no observer for.
vi.mock('../../components/PersonAvatar', () => ({
  PersonAvatar: () => <span data-testid="avatar" />,
}))

const seen = vi.hoisted(() => ({
  syncDialog: null as ComponentProps<typeof StartSpaceSyncDialogComponent> | null,
}))

// The sync dialog has its own tests; here it shows what it was opened with.
vi.mock('./sync/StartSpaceSyncDialog', () => ({
  StartSpaceSyncDialog: (props: ComponentProps<typeof StartSpaceSyncDialogComponent>) => {
    seen.syncDialog = props
    return <div data-sync-dialog={props.space.key} />
  },
}))

// The user's connected accounts, given to the subscription as the backend replays them: one that
// can sync a source into a space when `syncs`, and otherwise one that cannot.
const accountsSubscription = ({ syncs = false } = {}) => (subscriber: ConnectedAccountsSubscriber) => {
  subscriber.add(7, {
    displayName: 'Work docs',
    avatar: { url: 'https://docs.example.com/a' },
    ...(syncs && { providesSpaceSync: { blueprintId: 'document', importMethods: ['importSnapshot'] } }),
  }, { displayName: 'Docs Hub', url: 'https://docs.example.com/' }, [], true, 'docs')
  subscriber.ready()
  return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), { [Symbol.dispose]() {} })
}

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
 * user as a member. `listed` is what each space lists, in place of the above. `chrome` is
 * rendered beside the page, as the sidebar is. `session` is the same user's session again, as a
 * reconnect replaces it, with the methods it is given in place of its own.
 */
const renderAt = async (at: string, { spacesFlag = true, strangerTo, listed = LISTED, api, chrome }: {
  spacesFlag?: boolean
  strangerTo?: string
  listed?: Record<string, SpaceWorkspaceInfo[]>
  api?: FakeApiMethods
  chrome?: ReactNode
} = {}) => {
  let spaces = SPACES
  const opened = new Map<string, ReturnType<typeof fakeSpace>>()
  const openSpace = vi.fn<(key: string) => unknown>((key) => {
    const info = spaces.find(space => space.key === key)!
    const space = opened.get(key)
      ?? fakeSpace(info, key === strangerTo ? [] : [member(ME, info.role)], listed[key])
    opened.set(key, space)
    return space
  })
  const listSpaces = vi.fn<AuthenticatedApi['listSpaces']>(async () => spaces)
  const session = (methods: FakeApiMethods = {}) => fakeApi({
    subscribeConnectedAccounts: accountsSubscription(),
    listSpaceSyncJobs: async () => [],
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

// What a row's published indicator says, as its accessible name, or nothing when it has none.
const publishedLabel = (row: HTMLElement) =>
  row.querySelector('[role="img"][aria-label^="Published"]')?.getAttribute('aria-label') ?? undefined

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
    expect(unlisted.textContent).toContain(
      'Its other members do not see them and cannot open them through the space.')
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
    // A personal space has no members besides its owner.
    expect(hasButton('Members of Personal')).toBe(false)
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

  it('says the user is no longer a member when the listing is read again as a visitor’s', async () => {
    const { space } = await renderAt('/spaces/design', {
      listed: {
        ...LISTED,
        design: [listedBy(ME, 'w-notes', 'Notes', 'notes'), { ...listedBy(ADA, 'w-brief', 'Brief', 'brief'), published: 'use' }],
      },
    })

    // An admin removes the user while they change an address, which reads the listing again.
    await chooseAction('Notes', 'Change address')
    await space('design').removeMember(ME.id)
    await type(labeledInput('Address'), 'my-notes')
    await click(button('Save'))
    await settle()

    expect(alerts()).toEqual(['You are no longer a member of this space.'])
    expect(rowTitles()).toEqual(['Notes'])
    expect(document.body.textContent).not.toContain('Not listed by this space')
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

  it('says which of the workspaces it lists are published, and with what role', async () => {
    await renderAt('/spaces/design', {
      listed: {
        design: [
          { ...listedBy(ME, 'w-notes', 'Notes', 'notes'), published: 'build' },
          { ...listedBy(ADA, 'w-brief', 'Brief', 'brief'), published: 'use' },
          listedBy(ADA, 'w-draft', 'Draft', 'draft'),
        ],
      },
      api: { listGadgets: async () => [{ ...mine('w-notes', 'Notes', 'design'), publicAccess: 'build' as const }] },
    })

    expect(publishedLabel(rowOf('Notes'))).toBe('Published to everyone signed in · can build')
    expect(publishedLabel(rowOf('Brief'))).toBe('Published to everyone signed in · can use')
    expect(publishedLabel(rowOf('Draft'))).toBeUndefined()
  })

  describe('for a visitor, who is not a member of the space', () => {
    // Design lists one published workspace at an address, one published that has no address yet,
    // and one that is not published.
    const PUBLISHING: Record<string, SpaceWorkspaceInfo[]> = {
      design: [
        { ...listedBy(ADA, 'w-brief', 'Brief', 'brief'), published: 'use' },
        { ...listedBy(ADA, 'w-handbook', 'Handbook'), published: 'build' },
        listedBy(ADA, 'w-draft', 'Draft', 'draft'),
      ],
    }

    it('shows the space’s name and the published workspaces it lists as plain rows, and says that is what they are', async () => {
      await renderAt('/spaces/design', { strangerTo: 'design', listed: PUBLISHING })

      expect(heading()).toBe('Design')
      expect(document.body.textContent).toContain(
        'These are workspaces of this space that their owners have published to everyone signed in to this deployment.')
      expect(rowTitles()).toEqual(['Brief', 'Handbook'])
      expect(rowOf('Brief').getAttribute('href')).toBe('/spaces/design/brief')
      expect(rowOf('Brief').textContent).toContain('Owned by Ada')
      expect(publishedLabel(rowOf('Brief'))).toBe('Published to everyone signed in · can use')
      expect(rowOf('Handbook').getAttribute('href')).toBe('/workspace/w-handbook')
      expect(publishedLabel(rowOf('Handbook'))).toBe('Published to everyone signed in · can build')
    })

    it('offers nothing that is a member’s', async () => {
      const { space } = await renderAt('/spaces/design', { strangerTo: 'design', listed: PUBLISHING })

      expect(document.body.textContent).not.toContain('Your role')
      expect(hasButton('Members of Design')).toBe(false)
      expect([...document.body.querySelectorAll('a')].map(anchor => anchor.getAttribute('aria-label')))
        .not.toContain('New workspace in Design')
      expect(searchField()).toBeNull()
      // No row has a menu: a visitor changes no address.
      expect(rowOf('Brief').querySelector('button')).toBeNull()
      expect(rowOf('Handbook').querySelector('button')).toBeNull()
      // The space is asked for nothing it refuses a visitor but its members, once.
      expect(space('design').listMembers).toHaveBeenCalledOnce()
    })

    it('shows only what is published of a listing read while the user was still a member', async () => {
      const { space } = await renderAt('/spaces/design', { listed: PUBLISHING })
      expect(rowTitles()).toContain('Draft')

      // An admin removes the user, and the page learns of it from the members dialog.
      await click(button('Members of Design'))
      await settle()
      await space('design').removeMember(ME.id)
      await pressEscape()
      await settle()

      expect(heading()).toBe('Design')
      expect(rowTitles()).toEqual(['Brief', 'Handbook'])
      expect(hasButton('Members of Design')).toBe(false)
    })

    it('names another person’s personal space as theirs, and shows what they published in it', async () => {
      const adas = fakeSpace({ ...personalSpace(ADA, 'admin'), role: undefined }, [member(ADA, 'admin')], [
        { ...listedBy(ADA, 'w-brief', 'Brief', 'brief'), published: 'use' },
        listedBy(ADA, 'w-draft', 'Draft', 'draft'),
      ])
      await renderAt('/spaces/~ada', { api: { openSpace: () => adas } })

      expect(heading()).toBe('Ada’s personal space')
      expect(rowTitles()).toEqual(['Brief'])
      expect(rowOf('Brief').getAttribute('href')).toBe('/spaces/~ada/brief')
      expect(hasButton('Members of Ada’s personal space')).toBe(false)
      expect([...document.body.querySelectorAll('a')].map(anchor => anchor.getAttribute('aria-label')))
        .not.toContain('New workspace in Ada’s personal space')
    })

    it('is not found once the space no longer lists anything published', async () => {
      const design = fakeSpace(DESIGN, [], PUBLISHING.design)
      // The publications were withdrawn between the space's two answers.
      design.listWorkspaces.mockRejectedValue(notAMember())
      await renderAt('/spaces/design', { api: { openSpace: () => design } })

      expect(showsNotFound()).toBe(true)
      expect(heading()).toBeUndefined()
    })
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

const tab = (name: string) => [...document.body.querySelectorAll<HTMLElement>('[role="tab"]')]
  .find(candidate => candidate.textContent === name)
const treeLabel = () => document.body.querySelector('[data-hierarchical-list]')?.getAttribute('aria-label')
// The items of the space's tree, which is the first list: the Unlisted group's list follows it.
const treeRows = () => [...document.body.querySelector('[data-hierarchical-list]')
  ?.querySelectorAll<HTMLElement>('[data-hierarchical-list-item]') ?? []]
  .map(item => item.dataset.itemId)
const unlistedTitles = () => [...document.body.querySelectorAll('aside section')]
  .find(section => section.querySelector('h2')?.textContent === 'Unlisted')
  ?.querySelectorAll('[data-hierarchical-list-row]')
const draggableRows = () => [...document.body.querySelectorAll<HTMLElement>('[data-hierarchical-list-row]')]
  .filter(row => row.draggable)

describe('the List / Tree toggle', () => {
  afterEach(() => {
    unmountAll()
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('switches the workspaces page to the personal space’s tree, and back to the list', async () => {
    await renderAt('/workspaces')
    expect(tab('List')?.getAttribute('aria-selected')).toBe('true')
    expect(treeLabel()).toBeUndefined()

    await click(tab('Tree')!)
    await settle()
    expect(treeLabel()).toBe('Workspaces in Personal')
    expect(treeRows()).toEqual(['w-solo'])
    expect(searchField()).toBeNull()

    await click(tab('List')!)
    await settle()
    expect(treeLabel()).toBeUndefined()
    expect(rowTitles()).toContain('Solo notes')
  })

  it('remembers the choice for the user, on every page that offers it', async () => {
    await renderAt('/workspaces')
    await click(tab('Tree')!)
    unmountAll()

    await renderAt('/workspaces')
    expect(treeLabel()).toBe('Workspaces in Personal')
    unmountAll()

    await renderAt('/spaces/design')
    expect(tab('Tree')?.getAttribute('aria-selected')).toBe('true')
    expect(treeLabel()).toBe('Workspaces in Design')
    expect(treeRows()).toEqual(['w-notes', 'w-brief'])
  })

  it('lets a member of a space move what the space lets them move in its tree', async () => {
    await renderAt('/spaces/design')
    await click(tab('Tree')!)
    await settle()

    // In Design the user's role is 'use', and only Notes is theirs.
    expect(draggableRows().map(row => row.closest<HTMLElement>('[data-hierarchical-list-item]')?.dataset.itemId))
      .toEqual(['w-notes'])
  })

  it('shows apart, in a space’s tree, the user’s own workspaces grouped there that it does not list', async () => {
    await renderAt('/spaces/design', {
      api: { listGadgets: async () => [...GADGETS, mine('w-payroll', 'Payroll notes', 'design')] },
    })
    await click(tab('Tree')!)
    await settle()

    expect(treeRows()).toEqual(['w-notes', 'w-brief'])
    // Notes is listed, Solo notes and Roadmap are grouped in other spaces.
    expect([...unlistedTitles() ?? []].map(item => item.textContent)).toEqual(['Payroll notes'])
  })

  it('gives a visitor the visible part of the space’s tree, read-only', async () => {
    const listed = {
      design: [
        { ...listedBy(ADA, 'w-brief', 'Brief', 'brief'), published: 'use' as const },
        { ...listedBy(ADA, 'w-draft', 'Draft', 'draft') },
        { ...listedBy(ADA, 'w-hidden', 'Hidden', 'hidden'), parentId: 'w-draft', published: 'use' as const, hiddenBy: 'w-draft' },
      ],
    }
    await renderAt('/spaces/design', { strangerTo: 'design', listed })
    await click(tab('Tree')!)
    await settle()

    expect(treeLabel()).toBe('Workspaces in Design')
    expect(treeRows()).toEqual(['w-brief'])
    expect(draggableRows()).toEqual([])
  })

  it('is not offered while the flag is off, even to a user who chose the tree while it was on', async () => {
    localStorage.setItem(`space-view:${ME.id}`, 'tree')
    await renderAt('/workspaces', { spacesFlag: false })

    expect(tab('Tree')).toBeUndefined()
    expect(treeLabel()).toBeUndefined()
    expect(rowTitles()).toContain('Solo notes')
  })
})

describe('a visited space’s tree', () => {
  afterEach(() => {
    unmountAll()
    localStorage.clear()
    vi.restoreAllMocks()
  })

  it('leaves out a published entry under an unpublished one, even from a listing read as a member', async () => {
    const listing = {
      status: 'ready' as const,
      asMember: true,
      workspaces: [
        { ...listedBy(ADA, 'w-brief', 'Brief', 'brief'), published: 'use' as const },
        { ...listedBy(ADA, 'w-draft', 'Draft', 'draft') },
        { ...listedBy(ADA, 'w-hidden', 'Hidden', 'hidden'), parentId: 'w-draft', published: 'use' as const, hiddenBy: 'w-draft' },
      ],
    }
    const Page = () => (
      <VisitedSpace space={{ key: 'design', kind: 'team' }} label="Design" listing={listing} onListingReload={async () => {}} />
    )
    await mountRouted(fakeApi(), {
      at: '/spaces/design',
      pages: (root: AnyRoute) => [createRoute({ getParentRoute: () => root, path: '/spaces/$spaceKey', component: Page })],
    })
    await click(tab('Tree')!)
    await settle()

    expect(treeRows()).toEqual(['w-brief'])
  })
})

const syncJob = (jobId: string, status: SpaceSyncJobInfo['status']): SpaceSyncJobInfo => ({
  jobId,
  accountId: 7,
  vendorId: 'docs',
  spaceKey: 'design',
  blueprintId: 'document',
  publication: 'build',
  status,
  progress: { done: 2, warnings: [] },
  created: DAY,
  ...(status !== 'running' && { finished: DAY }),
})

// A workspace previewed in the tree stays loading.
const pendingWorkspace = () => ({ subscribeToMetadata: () => new Promise(() => {}), [Symbol.dispose]() {} })

// `jobs` are the user's syncs into the space at each read.
const renderSyncing = async (at: string, { syncs = true, jobs = () => [] as SpaceSyncJobInfo[], api, ...options }: {
  syncs?: boolean
  jobs?: () => SpaceSyncJobInfo[]
  listed?: Record<string, SpaceWorkspaceInfo[]>
  spacesFlag?: boolean
  api?: FakeApiMethods
} = {}) => {
  const listSpaceSyncJobs = vi.fn<(spaceKey?: string) => Promise<SpaceSyncJobInfo[]>>(async () => jobs())
  const subscribeConnectedAccounts = vi.fn<ReturnType<typeof accountsSubscription>>(accountsSubscription({ syncs }))
  const rendered = await renderAt(at, {
    ...options,
    api: { listSpaceSyncJobs, subscribeConnectedAccounts, openGadget: pendingWorkspace, ...api },
  })
  return { ...rendered, listSpaceSyncJobs, subscribeConnectedAccounts }
}

const syncProgress = () => document.body.querySelector('section[aria-label^="Sync from Docs Hub"]')

describe('syncing into a space', () => {
  afterEach(() => {
    unmountAll()
    localStorage.clear()
    seen.syncDialog = null
    vi.restoreAllMocks()
  })

  it('offers a member with an account that can sync a sync into the space, beside its name', async () => {
    await renderSyncing('/spaces/design')

    expect(button('Sync from Docs Hub into Design').textContent).toBe('Sync from Docs Hub')
  })

  it('offers the owner of a personal space a sync into it', async () => {
    await renderSyncing(`/spaces/${PERSONAL.key}`)

    expect(hasButton('Sync from Docs Hub into Personal')).toBe(true)
  })

  it('offers no sync, and reads no jobs, without an account that can sync', async () => {
    const { listSpaceSyncJobs } = await renderSyncing('/spaces/design', { syncs: false, jobs: () => [syncJob('j1', 'running')] })

    expect(heading()).toBe('Design')
    expect(hasButton('Sync from Docs Hub into Design')).toBe(false)
    expect(syncProgress()).toBeNull()
    expect(listSpaceSyncJobs).not.toHaveBeenCalled()
  })

  it('offers no sync to a member of someone else’s personal space, which only its owner adds to', async () => {
    const adas = personalSpace(ADA, 'build')
    const space = fakeSpace(adas, [member(ME, 'build')], [listedBy(ADA, 'w-trip', 'Trip', 'trip')])
    const { listSpaceSyncJobs } = await renderSyncing(`/spaces/${adas.key}`, { api: { openSpace: () => space } })

    expect(heading()).toBe('Ada’s personal space')
    expect(hasButton('Sync from Docs Hub into Ada’s personal space')).toBe(false)
    expect(listSpaceSyncJobs).not.toHaveBeenCalled()
  })

  it('opens the dialog for the space, at the top from the list and under the entry selected in the tree', async () => {
    await renderSyncing('/spaces/design?selected=w-brief')

    await click(button('Sync from Docs Hub into Design'))
    expect(seen.syncDialog?.space).toEqual({ key: 'design', name: 'Design' })
    expect(seen.syncDialog?.listing.map(entry => entry.id)).toEqual(['w-notes', 'w-brief'])
    expect(seen.syncDialog?.defaultParentId).toBeUndefined()
    await act(async () => seen.syncDialog!.onClose())

    await click(tab('Tree')!)
    await settle()
    await click(button('Sync from Docs Hub into Design'))
    expect(seen.syncDialog?.defaultParentId).toBe('w-brief')
  })

  it('reads the jobs again once a sync has started, and shows its progress under the header', async () => {
    let jobs: SpaceSyncJobInfo[] = []
    const { listSpaceSyncJobs } = await renderSyncing('/spaces/design', { jobs: () => jobs })
    expect(listSpaceSyncJobs.mock.calls).toEqual([['design']])
    await click(button('Sync from Docs Hub into Design'))

    jobs = [syncJob('j1', 'running')]
    await act(async () => { seen.syncDialog!.onStarted(syncJob('j1', 'running')) })
    await settle()

    expect(document.body.querySelector('[data-sync-dialog]')).toBeNull()
    expect(listSpaceSyncJobs).toHaveBeenCalledTimes(2)
    expect(syncProgress()?.textContent).toContain('Running')
    expect(syncProgress()?.textContent).toContain('2 items synced so far')
  })

  it('reads the space’s workspaces again once a sync it follows has ended', async () => {
    let jobs = [syncJob('j1', 'running')]
    const { space } = await renderSyncing('/spaces/design', { jobs: () => jobs })
    const reads = space('design').listWorkspaces.mock.calls.length

    // The running sync is read again when the page is shown again, and has ended by then.
    jobs = [syncJob('j1', 'done')]
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await settle()

    expect(space('design').listWorkspaces.mock.calls.length).toBe(reads + 1)
    expect(syncProgress()?.textContent).toContain('Done')
  })

  it('makes no sync call while the flag is off', async () => {
    const { listSpaceSyncJobs, subscribeConnectedAccounts } = await renderSyncing('/workspaces', { spacesFlag: false })

    expect(hasButton('Sync from Docs Hub into Personal')).toBe(false)
    expect(listSpaceSyncJobs).not.toHaveBeenCalled()
    expect(subscribeConnectedAccounts).not.toHaveBeenCalled()
  })
})
