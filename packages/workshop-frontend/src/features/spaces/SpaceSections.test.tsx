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
import {
  SidebarWorkspacesLists,
  SidebarWorkspacesProvider,
} from '../../components/AppShell/SidebarWorkspaces'
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
const ADAS = personalSpace(ADA, 'use')
const DESIGN = teamSpace('design', 'Design', 'use')
const PLATFORM = teamSpace('platform', 'Platform')

const DAY = new Date('2026-09-01T00:00:00Z')

const mine = (id: string, title: string, spaceKey?: string): GadgetMetadataWithTimestamps =>
  ({ id, title, created: DAY, lastActive: DAY, spaceKey })

const listedBy = (owner: AiChatAuthorInfo, id: string, title: string): SpaceWorkspaceInfo =>
  ({ id, title, owner, created: DAY })

const GADGETS: GadgetMetadataWithTimestamps[] = [
  mine('w-solo', 'Solo notes'),
  mine('w-roadmap', 'Roadmap', 'platform'),
  { id: 'w-brief', title: 'Brief', created: DAY, lastActive: DAY, owner: ADA },
]

// What each space lists. Ada's personal space lists the workspace she also shared with the user.
const LISTED: Record<string, SpaceWorkspaceInfo[]> = {
  [ADAS.key]: [listedBy(ADA, 'w-brief', 'Brief')],
  design: [],
  platform: [listedBy(ME, 'w-roadmap', 'Roadmap'), listedBy(ADA, 'w-plan', 'Ada’s plan')],
}

/**
 * The /workspaces page for a user with the spaces and workspaces above. `openSpace` answers with
 * a space the user is a member of; a test replaces it to make one space fail. `chrome` is
 * rendered beside the page, as the sidebar is.
 */
const renderPage = async ({ at = '/workspaces', spacesFlag = true, gadgets = GADGETS, api = {}, chrome }: {
  at?: string
  spacesFlag?: boolean
  gadgets?: GadgetMetadataWithTimestamps[]
  api?: Partial<{ [K in keyof AuthenticatedApi]: unknown }>
  chrome?: ReactNode
} = {}) => {
  let spaces = [PERSONAL, ADAS, DESIGN, PLATFORM]
  const listSpaces = vi.fn<AuthenticatedApi['listSpaces']>(async () => spaces)
  const openSpace = vi.fn<(key: string) => unknown>((key) => {
    const info = spaces.find(space => space.key === key)!
    return fakeSpace(info, [member(ME, info.role)], LISTED[key] ?? [])
  })
  const createSpace = vi.fn<(key: string, name: string) => Promise<unknown>>(async (key, name) => {
    spaces = [...spaces, teamSpace(key, name)]
    return openSpace(key)
  })
  const mounted = await mountRouted(
    fakeApi({
      listGadgets: async () => gadgets,
      listFeaturedBlueprints: async () => [],
      listSpaces,
      openSpace,
      createSpace,
      ...api,
    }, { spacesFlag }),
    {
      at,
      chrome,
      pages: root => [WorkspacesRoute.update({
        id: '/workspaces',
        path: '/workspaces',
        getParentRoute: () => root,
      } as never)],
    },
  )
  await settle()
  return { ...mounted, listSpaces, openSpace, createSpace }
}

const sectionNamed = (name: string) => {
  const found = [...document.body.querySelectorAll('section')].find(section =>
    document.getElementById(section.getAttribute('aria-labelledby') ?? '')?.textContent === name)
  if (!found) throw new Error(`No section named “${name}”`)
  return found
}

// Each section on show, as its name and the titles of its rows.
const sections = () => [...document.body.querySelectorAll('section')].map(section => [
  document.getElementById(section.getAttribute('aria-labelledby') ?? '')?.textContent,
  [...section.querySelectorAll('h3')].map(title => title.textContent),
])

const link = (name: string) => {
  const found = [...document.body.querySelectorAll('a')].find(anchor =>
    anchor.getAttribute('aria-label') === name || anchor.textContent?.trim() === name)
  if (!found) throw new Error(`No link named “${name}”`)
  return found
}

const rowOf = (title: string) => [...document.body.querySelectorAll('h3')]
  .find(heading => heading.textContent === title)!.closest('a')!

// What the menu of the row with this title offers, which is left open.
const rowActions = async (title: string) => {
  await click(rowOf(title).querySelector('button')!)
  return [...document.body.querySelectorAll('[role="menuitem"]')].map(item => item.textContent?.trim())
}

// The sidebar's link to a space's page: the one that is not the name of the space's section.
const sidebarLinkTo = (spaceKey: string) =>
  [...document.body.querySelectorAll<HTMLAnchorElement>(`a[href="/spaces/${spaceKey}"]`)]
    .find(anchor => !anchor.closest('section')) ?? null

const SIDEBAR = (
  <SidebarWorkspacesProvider>
    <SidebarWorkspacesLists />
  </SidebarWorkspacesProvider>
)

const chooseMenuItem = (name: string) =>
  click([...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    .find(item => item.textContent?.trim() === name)!)

// The move dialog's target of this name, by its label: what a pointer lands on.
const chooseTarget = (name: string) =>
  click([...document.body.querySelectorAll('label')].find(label => label.textContent === name)!)

const searchField = () => document.body.querySelector<HTMLInputElement>('input[placeholder^="Search"]')

// The page again under a session that replaces the one it was rendered for, as a reconnect
// does. The new session answers neither its flags nor its workspaces until `answer` is called.
const replaceSession = async ({ router, rerender }: Awaited<ReturnType<typeof renderPage>>) => {
  const flags = deferred<{ spaces: boolean }>()
  const gadgets = deferred<GadgetMetadataWithTimestamps[]>()
  const spaces = [PERSONAL, ADAS, DESIGN, PLATFORM]
  const listSpaces = vi.fn<AuthenticatedApi['listSpaces']>(async () => spaces)
  const openSpace = vi.fn<(key: string) => unknown>((key) => {
    const info = spaces.find(space => space.key === key)!
    return fakeSpace(info, [member(ME, info.role)], LISTED[key] ?? [])
  })
  await rerender(<RouterProvider router={router} />, fakeApi({
    getUiFeatureFlags: () => flags.promise,
    listGadgets: () => gadgets.promise,
    listFeaturedBlueprints: async () => [],
    listSpaces,
    openSpace,
  }))
  await settle()
  return {
    listSpaces,
    openSpace,
    answer: async ({ spacesFlag = true } = {}) => {
      await act(async () => {
        flags.resolve({ spaces: spacesFlag })
        gadgets.resolve(GADGETS)
      })
      await settle()
    },
  }
}

describe('the workspaces page', () => {
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  describe('with the spaces flag off', () => {
    it('is the flat list, with no section, no spaces entry point and no spaces call', async () => {
      const { listSpaces, openSpace } = await renderPage({ spacesFlag: false })

      expect(document.body.querySelectorAll('section')).toHaveLength(0)
      expect([...document.body.querySelectorAll('h3')].map(title => title.textContent))
        .toEqual(['Solo notes', 'Roadmap', 'Brief'])
      expect(hasButton('New space')).toBe(false)
      expect(link('Create workspace').getAttribute('href')).toBe('/')
      expect(listSpaces).not.toHaveBeenCalled()
      expect(openSpace).not.toHaveBeenCalled()
    })

    it('says nothing of publication on a row', async () => {
      await renderPage({
        spacesFlag: false,
        gadgets: [{ ...mine('w-solo', 'Solo notes'), publicAccess: 'build' }],
      })

      expect(rowOf('Solo notes').textContent).not.toContain('Published')
    })

    it('offers no move on a row', async () => {
      await renderPage({ spacesFlag: false })

      const actions = await rowActions('Solo notes')
      expect(actions).toContain('Share')
      expect(actions).not.toContain('Move to space')
    })
  })

  describe('with the spaces flag on', () => {
    it('lays the workspaces out under the user’s spaces, each one once', async () => {
      const { openSpace } = await renderPage()

      expect(sections()).toEqual([
        ['Personal', ['Solo notes']],
        ['Ada’s personal space', ['Brief']],
        ['Design', []],
        ['Platform', ['Roadmap', 'Ada’s plan']],
      ])
      expect(sectionNamed('Design').textContent).toContain('No workspaces in this space yet.')
      expect(sectionNamed('Platform').textContent).toContain('Your role: Admin')
      // The user's own personal space is not opened: its section is their own records.
      expect(openSpace.mock.calls.map(([key]) => key)).toEqual([ADAS.key, 'design', 'platform'])
    })

    it('says which workspaces are published, and with what role', async () => {
      await renderPage({
        gadgets: [
          { ...mine('w-solo', 'Solo notes'), publicAccess: 'build' },
          mine('w-roadmap', 'Roadmap', 'platform'),
        ],
        api: {
          openSpace: (key: string) => {
            const info = [ADAS, DESIGN, PLATFORM].find(space => space.key === key)!
            return fakeSpace(info, [member(ME, info.role)], key === 'platform'
              ? [
                  listedBy(ME, 'w-roadmap', 'Roadmap'),
                  { ...listedBy(ADA, 'w-plan', 'Ada’s plan'), published: 'use' },
                ]
              : [])
          },
        },
      })

      // The user's own by their record of it, another member's by the space's entry for it.
      expect(rowOf('Solo notes').textContent).toContain('Published · Can build')
      expect(rowOf('Ada’s plan').textContent).toContain('Published · Can use')
      expect(rowOf('Roadmap').textContent).not.toContain('Published')
    })

    it('marks a row published once its Share dialog has published the workspace', async () => {
      const overseer = {
        getMetadata: async () => mine('w-solo', 'Solo notes'),
        listCollaborators: async () => [],
        listShareLinks: async () => [],
        listObserverRequirements: async () => [],
        setPublicAccess: vi.fn<Overseer['setPublicAccess']>(async () => {}),
        [Symbol.dispose]: vi.fn<() => void>(),
      }
      await renderPage({ api: { openGadget: () => overseer } })
      expect(rowOf('Solo notes').textContent).not.toContain('Published')

      await rowActions('Solo notes')
      await chooseMenuItem('Share')
      await settle()
      await click(button('Access for anyone signed in to this deployment'))
      await chooseMenuItem('Can use')
      await settle()

      expect(overseer.setPublicAccess).toHaveBeenCalledExactlyOnceWith('use')
      expect(rowOf('Solo notes').textContent).toContain('Published · Can use')
    })

    it('links a row to its address in the space once the space’s listing gives it one', async () => {
      await renderPage({
        api: {
          openSpace: (key: string) => {
            const info = [ADAS, DESIGN, PLATFORM].find(space => space.key === key)!
            return fakeSpace(info, [member(ME, info.role)], key === 'platform'
              ? [
                  { ...listedBy(ME, 'w-roadmap', 'Roadmap'), slug: 'roadmap' },
                  { ...listedBy(ADA, 'w-plan', 'Ada’s plan'), slug: 'adas-plan' },
                  listedBy(ADA, 'w-draft', 'Untitled Workspace'),
                ]
              : LISTED[key])
          },
        },
      })

      expect(rowOf('Roadmap').getAttribute('href')).toBe('/spaces/platform/roadmap')
      expect(rowOf('Ada’s plan').getAttribute('href')).toBe('/spaces/platform/adas-plan')
      // An entry with no slug, and a row no listing was read for, keep the workspace's own URL.
      expect(rowOf('Untitled Workspace').getAttribute('href')).toBe('/workspace/w-draft')
      expect(rowOf('Solo notes').getAttribute('href')).toBe('/workspace/w-solo')
      // The address is changed from the space's own page.
      expect(await rowActions('Roadmap')).not.toContain('Change address')
    })

    it('links the name of a space’s section to the space’s page', async () => {
      await renderPage()

      expect(link('Platform').getAttribute('href')).toBe('/spaces/platform')
      expect(link('Ada’s personal space').getAttribute('href')).toBe('/spaces/~ada')
      expect(link('Personal').getAttribute('href')).toBe('/spaces/~me')
    })

    it('shows another member’s workspace as a plain row that links to it', async () => {
      await renderPage()

      const plain = rowOf('Ada’s plan')
      expect(plain.getAttribute('href')).toBe('/workspace/w-plan')
      expect(plain.textContent).toContain('Owned by Ada')
      expect(plain.textContent).toContain(`Created ${DAY.toLocaleDateString()}`)
      expect(plain.querySelector('button')).toBeNull()

      // The user's own and shared workspaces keep the list's row, with its actions.
      expect(rowOf('Roadmap').querySelector('button')).not.toBeNull()
      expect(rowOf('Brief').textContent).toContain('Shared by Ada')
    })

    it('opens a space’s members from its section', async () => {
      await renderPage()

      await click(button('Members of Platform'))
      await settle()

      expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Members of Platform')
    })

    it('hands focus back to the section’s button, and reads the list of spaces again, when the members close', async () => {
      const { listSpaces } = await renderPage()
      const members = button('Members of Platform')
      members.focus()
      await click(members)
      await settle()
      expect(listSpaces).toHaveBeenCalledOnce()

      await click(button('Close'))
      await settle()

      expect(document.body.querySelector('[role="dialog"]')).toBeNull()
      expect(document.activeElement).toBe(members)
      // The user's role in the space may have changed in the dialog.
      expect(listSpaces).toHaveBeenCalledTimes(2)
    })

    it('closes the members of a space the user leaves, and drops its section and its sidebar link', async () => {
      let spaces = [PERSONAL, ADAS, DESIGN, PLATFORM]
      const openSpace = (key: string) => {
        const info = [PERSONAL, ADAS, DESIGN, PLATFORM].find(space => space.key === key)!
        const space = fakeSpace(info, [member(ME, info.role)], LISTED[key] ?? [])
        space.removeMember.mockImplementation(async () => {
          spaces = spaces.filter(listed => listed.key !== key)
        })
        return space
      }
      await renderPage({ api: { listSpaces: async () => spaces, openSpace }, chrome: SIDEBAR })
      expect(sidebarLinkTo('design')).not.toBeNull()

      const members = button('Members of Design')
      members.focus()
      await click(members)
      await settle()
      await click(button('Leave space'))
      await click(button('Leave'))
      await settle()

      // The one dialog left is the toast that says what happened.
      expect([...document.body.querySelectorAll('[role="dialog"]')].map(dialog => dialog.textContent))
        .toEqual(['You left Design'])
      expect(sections().map(([name]) => name)).toEqual(['Personal', 'Ada’s personal space', 'Platform'])
      expect(sidebarLinkTo('design')).toBeNull()
      // The button the dialog was opened from went with the section, so the page's heading has
      // the focus.
      expect(document.activeElement).toBe(document.body.querySelector('h1'))
    })

    it('leaves focus where the user has put it by the time the list is read again after a leave', async () => {
      let spaces = [PERSONAL, ADAS, DESIGN, PLATFORM]
      const readAgain = deferred<void>()
      const listSpaces = vi.fn<AuthenticatedApi['listSpaces']>()
        .mockImplementationOnce(async () => spaces)
        .mockImplementation(async () => {
          await readAgain.promise
          return spaces
        })
      const openSpace = (key: string) => {
        const info = [PERSONAL, ADAS, DESIGN, PLATFORM].find(space => space.key === key)!
        const space = fakeSpace(info, [member(ME, info.role)], LISTED[key] ?? [])
        space.removeMember.mockImplementation(async () => {
          spaces = spaces.filter(listed => listed.key !== key)
        })
        return space
      }
      await renderPage({ api: { listSpaces, openSpace } })

      await click(button('Members of Design'))
      await settle()
      await click(button('Leave space'))
      await click(button('Leave'))
      await settle()
      const search = searchField()!
      search.focus()
      await act(async () => readAgain.resolve())
      await settle()

      expect(sections().map(([name]) => name)).toEqual(['Personal', 'Ada’s personal space', 'Platform'])
      expect(document.activeElement).toBe(search)
    })

    it('opens the user’s own personal space’s members from the Personal section', async () => {
      const { openSpace } = await renderPage()

      await click(button('Members of Personal'))
      await settle()

      expect(openSpace).toHaveBeenLastCalledWith(PERSONAL.key)
      expect(document.body.querySelector('[role="dialog"]')?.textContent)
        .toContain('Members of your personal space')
    })

    it('links a new workspace to the home page with the space it is for', async () => {
      await renderPage()

      expect(link('New workspace in Platform').getAttribute('href')).toBe('/?space=platform')
      expect(link('New workspace in Personal').getAttribute('href')).toBe('/')
      // Only its owner adds workspaces to a personal space.
      expect(sectionNamed('Ada’s personal space').querySelector('a[aria-label^="New workspace"]')).toBeNull()
    })

    it('creates a space from the page header, then lands on the space’s page', async () => {
      const { createSpace, listSpaces, router } = await renderPage()

      await click(button('New space'))
      await type(labeledInput('Name'), 'Field notes')
      await click(button('Create'))
      await settle()

      expect(createSpace).toHaveBeenCalledWith('field-notes', 'Field notes')
      expect(router.state.location.pathname).toBe('/spaces/field-notes')
      // Back returns to the list, and the list of spaces is read again for the sidebar.
      expect(router.history.length).toBe(2)
      expect(listSpaces).toHaveBeenCalledTimes(2)
    })

    it('hands focus back to the page header’s button when the new space is not created', async () => {
      await renderPage()
      const newSpace = button('New space')
      newSpace.focus()

      await click(newSpace)
      expect(document.activeElement).toBe(labeledInput('Name'))
      await pressEscape()
      await settle()

      expect(document.body.querySelector('[role="dialog"]')).toBeNull()
      expect(document.activeElement).toBe(newSpace)
    })

    it('keeps the rest of the page when one space’s listing fails, and reads it again on request', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      let failing = true
      const openSpace = vi.fn<(key: string) => unknown>((key) => {
        const info = [ADAS, DESIGN, PLATFORM].find(space => space.key === key)!
        const space = fakeSpace(info, [member(ME, info.role)], LISTED[key])
        if (key === 'platform' && failing) space.listWorkspaces.mockRejectedValue(new Error('boom'))
        return space
      })
      await renderPage({ api: { openSpace } })

      expect(sections()).toEqual([
        ['Personal', ['Solo notes']],
        ['Ada’s personal space', ['Brief']],
        ['Design', []],
        ['Platform', ['Roadmap']],
      ])
      expect(alerts()).toEqual(['Couldn’t load this space’s workspaces.Try again'])

      failing = false
      await click(button('Try again to load Platform'))
      await settle()

      expect(alerts()).toEqual([])
      expect(sections().at(-1)).toEqual(['Platform', ['Roadmap', 'Ada’s plan']])
    })

    it('shows a listing being read again as busy until the read settles', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const again = deferred<SpaceWorkspaceInfo[]>()
      let platformReads = 0
      const openSpace = vi.fn<(key: string) => unknown>((key) => {
        const info = [ADAS, DESIGN, PLATFORM].find(space => space.key === key)!
        const space = fakeSpace(info, [member(ME, info.role)], LISTED[key])
        if (key === 'platform') {
          space.listWorkspaces.mockImplementation(platformReads++ === 0
            ? async () => { throw new Error('boom') }
            : () => again.promise)
        }
        return space
      })
      await renderPage({ api: { openSpace } })

      await click(button('Try again to load Platform'))
      await settle()
      expect(button('Try again to load Platform').disabled).toBe(true)

      await act(async () => again.resolve(LISTED.platform))
      await settle()
      expect(alerts()).toEqual([])
      expect(sections().at(-1)).toEqual(['Platform', ['Roadmap', 'Ada’s plan']])
    })

    it('says so when the list of spaces cannot be loaded, and loads it again on request', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const listSpaces = vi.fn<AuthenticatedApi['listSpaces']>()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue([PERSONAL, ADAS, DESIGN, PLATFORM])
      await renderPage({ api: { listSpaces } })

      // The user's own list is still on show, with no space to lay it out under.
      expect(alerts()).toEqual(['Couldn’t load your spaces.Try again'])
      expect(sections()).toEqual([
        ['Personal', ['Solo notes']],
        ['In other spaces', ['Roadmap']],
        ['Shared with me', ['Brief']],
      ])

      await click(button('Try again'))
      await settle()

      expect(alerts()).toEqual([])
      expect(sections().map(([name]) => name))
        .toEqual(['Personal', 'Ada’s personal space', 'Design', 'Platform'])
    })

    it('shows the list of spaces being read again as busy until the read settles', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const again = deferred<SpaceInfo[]>()
      const listSpaces = vi.fn<AuthenticatedApi['listSpaces']>()
        .mockRejectedValueOnce(new Error('boom'))
        .mockImplementation(() => again.promise)
      await renderPage({ api: { listSpaces } })

      await click(button('Try again'))
      expect(button('Try again').disabled).toBe(true)

      await act(async () => again.resolve([PERSONAL, ADAS, DESIGN, PLATFORM]))
      await settle()
      expect(alerts()).toEqual([])
    })

    it('says so when a space no longer counts the user as a member', async () => {
      const openSpace = vi.fn<(key: string) => unknown>((key) => {
        const info = [ADAS, DESIGN, PLATFORM].find(space => space.key === key)!
        return fakeSpace(info, key === 'design' ? [] : [member(ME, info.role)], LISTED[key])
      })
      await renderPage({ api: { openSpace } })

      expect(alerts()).toEqual(['You are no longer a member of this space.'])
      expect(sectionNamed('Design').textContent).toContain('You are no longer a member of this space.')
    })

    it('says so when a space in the user’s list now shows them only the workspaces published in it', async () => {
      // The user's list still has them as Platform's admin; the space reads them as a visitor.
      const openSpace = vi.fn<(key: string) => unknown>((key) => {
        const info = [ADAS, DESIGN, PLATFORM].find(space => space.key === key)!
        return fakeSpace(info, key === 'platform' ? [] : [member(ME, info.role)], key === 'platform'
          ? [listedBy(ME, 'w-roadmap', 'Roadmap'), { ...listedBy(ADA, 'w-plan', 'Ada’s plan'), published: 'use' }]
          : LISTED[key])
      })
      await renderPage({ api: { openSpace } })

      expect(alerts()).toEqual(['You are no longer a member of this space.'])
      expect(sections().find(([name]) => name === 'Platform')).toEqual(['Platform', ['Roadmap']])
    })

    it('lists what is shared with the user and no space shows under its own heading', async () => {
      await renderPage({
        gadgets: [...GADGETS, { id: 'w-memo', title: 'Memo', created: DAY, lastActive: DAY, owner: ADA }],
      })

      expect(sections().at(-1)).toEqual(['Shared with me', ['Memo']])
    })

    it('shows the user’s own workspace in a space that is not in their list under a heading of its own', async () => {
      // A workspace stays in a team space after its owner has left it.
      await renderPage({ gadgets: [...GADGETS, mine('w-old', 'Old plan', 'left-team')] })

      expect(sections().at(-1)).toEqual(['In other spaces', ['Old plan']])
      expect(sectionNamed('In other spaces').textContent)
        .toContain('Your workspaces in spaces that are not in your list.')
    })

    it('searches every section, and shows only the sections with a match', async () => {
      await renderPage()

      const search = document.body.querySelector<HTMLInputElement>('input[placeholder^="Search"]')!
      await type(search, 'PLAN')
      expect(sections()).toEqual([['Platform', ['Ada’s plan']]])

      await type(search, 'nothing')
      expect(sections()).toEqual([])
      expect(document.body.textContent).toContain('No workspaces found')
    })

    it('searches what a space lists when the user has no workspace of their own', async () => {
      await renderPage({ gadgets: [] })

      await type(searchField()!, 'plan')
      expect(sections()).toEqual([['Platform', ['Ada’s plan']]])
    })

    it('offers no search to a user with no workspace and no space but their personal one', async () => {
      await renderPage({ gadgets: [], api: { listSpaces: async () => [PERSONAL] } })

      expect(sections()).toEqual([['Personal', []]])
      expect(searchField()).toBeNull()
    })

    it('moves one of the user’s workspaces to the space chosen for it', async () => {
      const overseer = {
        moveToSpace: vi.fn<Overseer['moveToSpace']>(async () => {}),
        [Symbol.dispose]: vi.fn<() => void>(),
      }
      await renderPage({ api: { openGadget: () => overseer } })

      await click(rowOf('Solo notes').querySelector('button')!)
      await chooseMenuItem('Move to space')
      await chooseTarget('Design')
      await click(button('Move'))
      await settle()

      expect(overseer.moveToSpace).toHaveBeenCalledWith('design')
      expect(sections().slice(0, 3)).toEqual([
        ['Personal', []],
        ['Ada’s personal space', ['Brief']],
        ['Design', ['Solo notes']],
      ])
      // The row is under another section now, and its menu there has the focus the dialog held.
      const menu = rowOf('Solo notes').querySelector('button')
      expect(sectionNamed('Design').contains(menu)).toBe(true)
      expect(document.activeElement).toBe(menu)
    })

    it('reads a workspace’s space again after a move that failed, and shows the workspace where it is recorded', async () => {
      vi.spyOn(console, 'debug').mockImplementation(() => {})
      let recorded = GADGETS
      const listGadgets = vi.fn<AuthenticatedApi['listGadgets']>(async () => recorded)
      const overseer = {
        // The record is pointed at the space, which then cannot be reached.
        moveToSpace: vi.fn<Overseer['moveToSpace']>(async (spaceKey) => {
          recorded = recorded.map(gadget =>
            (gadget.id === 'w-solo' ? { ...gadget, spaceKey: spaceKey ?? undefined } : gadget))
          throw new Error('Peer closed WebSocket')
        }),
        [Symbol.dispose]: vi.fn<() => void>(),
      }
      await renderPage({ api: { listGadgets, openGadget: () => overseer } })

      await click(rowOf('Solo notes').querySelector('button')!)
      await chooseMenuItem('Move to space')
      await chooseTarget('Design')
      await click(button('Move'))
      await settle()

      expect(alerts()).toEqual(['Couldn’t move the workspace. Try again.'])
      expect(listGadgets).toHaveBeenCalledTimes(2)
      expect(sections().slice(0, 3)).toEqual([
        ['Personal', []],
        ['Ada’s personal space', ['Brief']],
        ['Design', ['Solo notes']],
      ])
      const targets = [...document.body.querySelectorAll('[role="dialog"] label')]
        .map(label => label.textContent)
      expect(targets).toEqual(['Personal', 'Design (current)', 'Platform'])

      // The row is under another section now, and its menu there takes the focus the dialog held.
      await click(button('Cancel'))
      await settle()
      expect(document.activeElement).toBe(rowOf('Solo notes').querySelector('button'))
    })

    it('offers the move on the user’s own workspaces only', async () => {
      await renderPage()

      const actions = await rowActions('Brief')
      expect(actions).toContain('Share')
      expect(actions).not.toContain('Move to space')
    })

    it.each([
      // In the personal space, with no team space to move to.
      ['no', 'Solo notes', false],
      // In a team space the user has left, with the personal space to return to.
      ['the', 'Old plan', true],
    ])('offers %s move on a workspace of a user with no team space: %s', async (_which, title, offered) => {
      await renderPage({
        gadgets: [mine('w-solo', 'Solo notes'), mine('w-old', 'Old plan', 'left-team')],
        api: { listSpaces: async () => [PERSONAL, ADAS] },
      })

      const actions = await rowActions(title)
      expect(actions).toContain('Share')
      expect(actions.includes('Move to space')).toBe(offered)
    })

    it('keeps the new space being named through a replaced session', async () => {
      const page = await renderPage()
      await click(button('New space'))
      await type(labeledInput('Name'), 'Field notes')

      const { answer } = await replaceSession(page)
      expect(labeledInput('Name').value).toBe('Field notes')
      expect(hasButton('New space')).toBe(true)

      await answer()
      expect(labeledInput('Name').value).toBe('Field notes')
      expect(sections().map(([name]) => name)).toContain('Platform')
    })

    it('keeps a space’s members open through a replaced session', async () => {
      const page = await renderPage()
      await click(button('Members of Platform'))
      await settle()

      const { answer } = await replaceSession(page)
      expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()

      await answer()
      expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Members of Platform')
    })

    it('asks a session that replaces another about no space before its own flags arrive, then reads each listing once', async () => {
      const page = await renderPage()
      await click(button('Members of Platform'))
      await settle()

      const { answer, listSpaces, openSpace } = await replaceSession(page)
      expect(listSpaces).not.toHaveBeenCalled()
      expect(openSpace).not.toHaveBeenCalled()

      await answer()
      expect(listSpaces).toHaveBeenCalledOnce()
      // Each section's listing, and the open members dialog's space.
      expect(openSpace.mock.calls.map(([key]) => key).toSorted())
        .toEqual(['design', 'platform', 'platform', ADAS.key])
    })

    it('asks a session that replaces another, and has the flag off, about no space at all', async () => {
      const page = await renderPage()
      await click(button('Members of Platform'))
      await settle()

      const { answer, listSpaces, openSpace } = await replaceSession(page)
      await answer({ spacesFlag: false })

      expect(listSpaces).not.toHaveBeenCalled()
      expect(openSpace).not.toHaveBeenCalled()
      expect(document.body.querySelectorAll('section')).toHaveLength(0)
      expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    })
  })
})
