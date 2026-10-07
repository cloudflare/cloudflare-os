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
const ATLAS = teamSpace('atlas', 'Atlas', 'use')
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

// What each space lists. Atlas lists the workspace Ada also shared with the user.
const LISTED: Record<string, SpaceWorkspaceInfo[]> = {
  atlas: [listedBy(ADA, 'w-brief', 'Brief')],
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
  let spaces = [PERSONAL, ATLAS, DESIGN, PLATFORM]
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

// The text of the elements this attribute of `element` points at.
const referencedText = (element: Element, attribute: string) =>
  (element.getAttribute(attribute) ?? '').split(' ')
    .map(id => document.getElementById(id)?.textContent ?? '').join(' ')

const cardItems = () => {
  const found = [...document.body.querySelectorAll('section')].find(section =>
    document.getElementById(section.getAttribute('aria-labelledby') ?? '')?.textContent === 'Team spaces')
  return [...(found?.querySelectorAll('li') ?? [])]
}

// The team spaces' cards on show, each as the name of its link and what the link says under it.
const cards = () => cardItems().map((card) => {
  const anchor = card.querySelector('a')!
  return [referencedText(anchor, 'aria-labelledby'), referencedText(anchor, 'aria-describedby')]
})

const cardLink = (name: string) => {
  const found = cardItems().map(card => card.querySelector('a')!)
    .find(anchor => referencedText(anchor, 'aria-labelledby') === name)
  if (!found) throw new Error(`No card named “${name}”`)
  return found
}

// The search results on show, each as the space its link is described as being in and its title.
const results = () =>
  [...(document.body.querySelector('ul[aria-label="Search results"]')?.children ?? [])].map(item => [
    referencedText(item.querySelector('a')!, 'aria-describedby'),
    item.querySelector('h3')?.textContent,
  ])

// What the row with this title says of its publication, where it says anything.
const publication = (title: string) =>
  rowOf(title).querySelector('[role="img"]')?.getAttribute('aria-label') ?? null

// The titles of every workspace row on show.
const rowTitles = () => [...document.body.querySelectorAll('h3')].map(title => title.textContent)

// The sidebar's link to a space's page: the one that is not on the page, in a section of it.
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
  const spaces = [PERSONAL, ATLAS, DESIGN, PLATFORM]
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
      expect(rowTitles()).toEqual(['Solo notes', 'Roadmap', 'Brief'])
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

      expect(publication('Solo notes')).toBeNull()
    })

    it('offers no move on a row', async () => {
      await renderPage({ spacesFlag: false })

      const actions = await rowActions('Solo notes')
      expect(actions).toContain('Share')
      expect(actions).not.toContain('Move to space')
    })

    it('searches the flat list, with no space named on a row', async () => {
      await renderPage({ spacesFlag: false })

      await type(searchField()!, 'o')
      expect(rowTitles()).toEqual(['Solo notes', 'Roadmap'])
      expect(document.body.querySelector('ul[aria-label="Search results"]')).toBeNull()
    })
  })

  describe('with the spaces flag on', () => {
    it('shows the personal space’s workspaces, then each team space as a card and none of its workspaces', async () => {
      const { openSpace } = await renderPage()

      expect(sections()).toEqual([
        ['Personal', ['Solo notes']],
        ['Team spaces', []],
      ])
      // Atlas lists the workspace Ada shared with the user, which its card counts.
      expect(cards()).toEqual([
        ['Atlas', 'Your role: Use · 1 workspace'],
        ['Design', 'Your role: Use · No workspaces yet'],
        ['Platform', 'Your role: Admin · 2 workspaces'],
      ])
      expect(rowTitles()).toEqual(['Solo notes'])
      // The user's own personal space is not opened: its section is their own records.
      expect(openSpace.mock.calls.map(([key]) => key)).toEqual(['atlas', 'design', 'platform'])
    })

    it('links each card to its space’s page', async () => {
      const { router } = await renderPage()

      expect(cardLink('Platform').getAttribute('href')).toBe('/spaces/platform')
      expect(cardLink('Atlas').getAttribute('href')).toBe('/spaces/atlas')

      await click(cardLink('Design'))
      await settle()
      expect(router.state.location.pathname).toBe('/spaces/design')
    })

    it('counts no workspace on a card before the space’s listing has been read', async () => {
      const listed = deferred<SpaceWorkspaceInfo[]>()
      const openSpace = (key: string) => {
        const info = [ATLAS, DESIGN, PLATFORM].find(space => space.key === key)!
        const space = fakeSpace(info, [member(ME, info.role)], LISTED[key])
        if (key === 'platform') space.listWorkspaces.mockImplementation(() => listed.promise)
        return space
      }
      await renderPage({ api: { openSpace } })

      // The user's own workspace in it is all that is known of it until then.
      expect(cards().at(-1)).toEqual(['Platform', 'Your role: Admin'])

      await act(async () => listed.resolve(LISTED.platform))
      await settle()
      expect(cards().at(-1)).toEqual(['Platform', 'Your role: Admin · 2 workspaces'])
    })

    it('links the personal space’s heading to its page, and offers a new workspace there and in no team space', async () => {
      await renderPage()

      expect(link('Personal').getAttribute('href')).toBe('/spaces/~me')
      expect(link('New workspace in Personal').getAttribute('href')).toBe('/')
      expect(document.body.querySelectorAll('a[aria-label^="New workspace in"]')).toHaveLength(1)
    })

    it('says which workspaces are published, and with what role', async () => {
      await renderPage({
        gadgets: [
          { ...mine('w-solo', 'Solo notes'), publicAccess: 'build' },
          mine('w-roadmap', 'Roadmap', 'platform'),
        ],
        api: {
          openSpace: (key: string) => {
            const info = [ATLAS, DESIGN, PLATFORM].find(space => space.key === key)!
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
      expect(publication('Solo notes')).toBe('Published to everyone signed in · can build')
      await type(searchField()!, 'a')
      expect(publication('Ada’s plan')).toBe('Published to everyone signed in · can use')
      expect(publication('Roadmap')).toBeNull()
    })

    it('says on every found row whose publication an unpublished workspace above it holds back which one does', async () => {
      await renderPage({
        gadgets: [
          { ...mine('w-roadmap', 'Roadmap', 'platform'), publicAccess: 'build' },
          { id: 'w-brief', title: 'Brief', created: DAY, lastActive: DAY, owner: ADA },
        ],
        api: {
          openSpace: (key: string) => {
            const info = [ATLAS, DESIGN, PLATFORM].find(space => space.key === key)!
            return fakeSpace(info, [member(ME, info.role)], key === 'platform'
              ? [
                  listedBy(ADA, 'w-handbook', 'Handbook'),
                  { ...listedBy(ME, 'w-roadmap', 'Roadmap'), parentId: 'w-handbook', published: 'build', hiddenBy: 'w-handbook' },
                  { ...listedBy(ADA, 'w-brief', 'Brief'), parentId: 'w-handbook', published: 'use', hiddenBy: 'w-handbook' },
                  { ...listedBy(ADA, 'w-plan', 'Ada’s plan'), parentId: 'w-handbook', published: 'use', hiddenBy: 'w-handbook' },
                ]
              : [])
          },
        },
      })

      // The user's own row, a row shared with them and another member's row alike.
      await type(searchField()!, 'r')
      const heldBack = "Published, but not visible until 'Handbook' is published"
      expect([publication('Roadmap'), publication('Brief')]).toEqual([heldBack, heldBack])
      await type(searchField()!, 'plan')
      expect(publication('Ada’s plan')).toBe(heldBack)
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
      expect(publication('Solo notes')).toBeNull()

      await rowActions('Solo notes')
      await chooseMenuItem('Share')
      await settle()
      await click(button('Access for anyone signed in to this deployment'))
      await chooseMenuItem('Can use')
      await settle()

      expect(overseer.setPublicAccess).toHaveBeenCalledExactlyOnceWith('use')
      expect(publication('Solo notes')).toBe('Published to everyone signed in · can use')
    })

    it('opens a space’s members from its card’s settings, without leaving the page', async () => {
      const { router } = await renderPage()

      await click(button('Space settings for Platform'))
      await settle()

      expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Members of Platform')
      expect(router.state.location.pathname).toBe('/workspaces')
    })

    it('hands focus back to the card’s settings, and reads the list of spaces again, when the members close', async () => {
      const { listSpaces } = await renderPage()
      const settings = button('Space settings for Platform')
      settings.focus()
      await click(settings)
      await settle()
      expect(listSpaces).toHaveBeenCalledOnce()

      await click(button('Close'))
      await settle()

      expect(document.body.querySelector('[role="dialog"]')).toBeNull()
      expect(document.activeElement).toBe(settings)
      // The user's role in the space may have changed in the dialog.
      expect(listSpaces).toHaveBeenCalledTimes(2)
    })

    it('closes the members of a space the user leaves, and drops its card and its sidebar link', async () => {
      let spaces = [PERSONAL, ATLAS, DESIGN, PLATFORM]
      const openSpace = (key: string) => {
        const info = [PERSONAL, ATLAS, DESIGN, PLATFORM].find(space => space.key === key)!
        const space = fakeSpace(info, [member(ME, info.role)], LISTED[key] ?? [])
        space.removeMember.mockImplementation(async () => {
          spaces = spaces.filter(listed => listed.key !== key)
        })
        return space
      }
      await renderPage({ api: { listSpaces: async () => spaces, openSpace }, chrome: SIDEBAR })
      expect(sidebarLinkTo('design')).not.toBeNull()

      const settings = button('Space settings for Design')
      settings.focus()
      await click(settings)
      await settle()
      await click(button('Leave space'))
      await click(button('Leave'))
      await settle()

      // The one dialog left is the toast that says what happened.
      expect([...document.body.querySelectorAll('[role="dialog"]')].map(dialog => dialog.textContent))
        .toEqual(['You left Design'])
      expect(cards().map(([name]) => name)).toEqual(['Atlas', 'Platform'])
      expect(sidebarLinkTo('design')).toBeNull()
      // The button the dialog was opened from went with the card, so the page's heading has the
      // focus.
      expect(document.activeElement).toBe(document.body.querySelector('h1'))
    })

    it('leaves focus where the user has put it by the time the list is read again after a leave', async () => {
      let spaces = [PERSONAL, ATLAS, DESIGN, PLATFORM]
      const readAgain = deferred<void>()
      const listSpaces = vi.fn<AuthenticatedApi['listSpaces']>()
        .mockImplementationOnce(async () => spaces)
        .mockImplementation(async () => {
          await readAgain.promise
          return spaces
        })
      const openSpace = (key: string) => {
        const info = [PERSONAL, ATLAS, DESIGN, PLATFORM].find(space => space.key === key)!
        const space = fakeSpace(info, [member(ME, info.role)], LISTED[key] ?? [])
        space.removeMember.mockImplementation(async () => {
          spaces = spaces.filter(listed => listed.key !== key)
        })
        return space
      }
      await renderPage({ api: { listSpaces, openSpace } })

      await click(button('Space settings for Design'))
      await settle()
      await click(button('Leave space'))
      await click(button('Leave'))
      await settle()
      const search = searchField()!
      search.focus()
      await act(async () => readAgain.resolve())
      await settle()

      expect(cards().map(([name]) => name)).toEqual(['Atlas', 'Platform'])
      expect(document.activeElement).toBe(search)
    })

    it('offers settings on every team space’s card, and no members for the user’s own personal space', async () => {
      await renderPage()

      expect(['Atlas', 'Design', 'Platform'].map(name => hasButton(`Space settings for ${name}`)))
        .toEqual([true, true, true])
      // A personal space has no members besides its owner.
      expect(hasButton('Space settings for Personal')).toBe(false)
      expect(hasButton('Members of Personal')).toBe(false)
    })

    it('leaves out of the team spaces another person’s personal space the user’s list still has', async () => {
      // The user's list has them as a member of Ada's personal space, which no longer has members
      // besides its owner, so it reads them as a visitor.
      const adas = personalSpace(ADA, 'use')
      const openSpace = (key: string) => {
        if (key === adas.key) {
          return fakeSpace(adas, [member(ADA, 'admin')], [{ ...listedBy(ADA, 'w-brief', 'Brief'), published: 'use' }])
        }
        const info = [ATLAS, DESIGN, PLATFORM].find(space => space.key === key)!
        return fakeSpace(info, [member(ME, info.role)], LISTED[key])
      }
      await renderPage({ api: { listSpaces: async () => [PERSONAL, adas, DESIGN, PLATFORM], openSpace } })

      expect(cards().map(([name]) => name)).toEqual(['Design', 'Platform'])
      expect(document.body.textContent).not.toContain('Ada’s personal space')
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

    it('keeps the rest of the page when one space’s listing fails, and reads it again for a search', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      let failing = true
      const openSpace = vi.fn<(key: string) => unknown>((key) => {
        const info = [ATLAS, DESIGN, PLATFORM].find(space => space.key === key)!
        const space = fakeSpace(info, [member(ME, info.role)], LISTED[key])
        if (key === 'platform' && failing) space.listWorkspaces.mockRejectedValue(new Error('boom'))
        return space
      })
      await renderPage({ api: { openSpace } })

      expect(cards()).toEqual([
        ['Atlas', 'Your role: Use · 1 workspace'],
        ['Design', 'Your role: Use · No workspaces yet'],
        ['Platform', 'Your role: Admin · Couldn’t load its workspaces'],
      ])
      expect(alerts()).toEqual([])

      await type(searchField()!, 'plan')
      expect(alerts()).toEqual(['Couldn’t search Platform.Try again'])
      expect(results()).toEqual([])
      expect(document.body.textContent).toContain('No workspaces found, but the results may be incomplete.')

      failing = false
      await click(button('Try again to search every space'))
      await settle()

      expect(alerts()).toEqual([])
      expect(results()).toEqual([['Platform', 'Ada’s plan']])
    })

    it('shows a listing being read again as busy until the read settles', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const again = deferred<SpaceWorkspaceInfo[]>()
      let platformReads = 0
      const openSpace = vi.fn<(key: string) => unknown>((key) => {
        const info = [ATLAS, DESIGN, PLATFORM].find(space => space.key === key)!
        const space = fakeSpace(info, [member(ME, info.role)], LISTED[key])
        if (key === 'platform') {
          space.listWorkspaces.mockImplementation(platformReads++ === 0
            ? async () => { throw new Error('boom') }
            : () => again.promise)
        }
        return space
      })
      await renderPage({ api: { openSpace } })
      await type(searchField()!, 'plan')

      await click(button('Try again to search every space'))
      await settle()
      expect(button('Try again to search every space').disabled).toBe(true)

      await act(async () => again.resolve(LISTED.platform))
      await settle()
      expect(alerts()).toEqual([])
      expect(results()).toEqual([['Platform', 'Ada’s plan']])
    })

    it('says a search is still waiting for a space’s listing', async () => {
      const listed = deferred<SpaceWorkspaceInfo[]>()
      const openSpace = (key: string) => {
        const info = [ATLAS, DESIGN, PLATFORM].find(space => space.key === key)!
        const space = fakeSpace(info, [member(ME, info.role)], LISTED[key])
        if (key === 'platform') space.listWorkspaces.mockImplementation(() => listed.promise)
        return space
      }
      await renderPage({ api: { openSpace } })

      await type(searchField()!, 'plan')
      const waiting = 'Loading the workspaces of your spaces…'
      expect(document.body.textContent).toContain(waiting)
      expect(document.body.textContent).not.toContain('No workspaces found')

      await act(async () => listed.resolve(LISTED.platform))
      await settle()
      expect(document.body.textContent).not.toContain(waiting)
      expect(results()).toEqual([['Platform', 'Ada’s plan']])
    })

    it('says so when the list of spaces cannot be loaded, and loads it again on request', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const listSpaces = vi.fn<AuthenticatedApi['listSpaces']>()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue([PERSONAL, ATLAS, DESIGN, PLATFORM])
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
      expect(sections().map(([name]) => name)).toEqual(['Personal', 'Team spaces'])
      expect(cards().map(([name]) => name)).toEqual(['Atlas', 'Design', 'Platform'])
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

      await act(async () => again.resolve([PERSONAL, ATLAS, DESIGN, PLATFORM]))
      await settle()
      expect(alerts()).toEqual([])
    })

    it('says on its card when a space no longer counts the user as a member', async () => {
      const openSpace = vi.fn<(key: string) => unknown>((key) => {
        const info = [ATLAS, DESIGN, PLATFORM].find(space => space.key === key)!
        return fakeSpace(info, key === 'design' ? [] : [member(ME, info.role)], LISTED[key])
      })
      await renderPage({ api: { openSpace } })

      expect(cards()[1]).toEqual(['Design', 'You are no longer a member of this space.'])
    })

    it('says so on its card when a space in the user’s list now shows them only the workspaces published in it', async () => {
      // The user's list still has them as Platform's admin; the space reads them as a visitor.
      const openSpace = vi.fn<(key: string) => unknown>((key) => {
        const info = [ATLAS, DESIGN, PLATFORM].find(space => space.key === key)!
        return fakeSpace(info, key === 'platform' ? [] : [member(ME, info.role)], key === 'platform'
          ? [listedBy(ME, 'w-roadmap', 'Roadmap'), { ...listedBy(ADA, 'w-plan', 'Ada’s plan'), published: 'use' }]
          : LISTED[key])
      })
      await renderPage({ api: { openSpace } })

      expect(cards().at(-1)).toEqual(['Platform', 'You are no longer a member of this space.'])
      // A search finds only the user's own workspace there, by their record of it.
      await type(searchField()!, 'a')
      expect(results()).toEqual([['Platform', 'Roadmap']])
    })

    it('lists what is shared with the user and no space shows under its own heading', async () => {
      await renderPage({
        gadgets: [...GADGETS, { id: 'w-memo', title: 'Memo', created: DAY, lastActive: DAY, owner: ADA }],
      })

      expect(sections().at(-1)).toEqual(['Shared with me', ['Memo']])
      expect(rowOf('Memo').textContent).toContain('Shared by Ada')
    })

    it('shows the user’s own workspace in a space that is not in their list under a heading of its own', async () => {
      // A workspace stays in a team space after its owner has left it.
      await renderPage({ gadgets: [...GADGETS, mine('w-old', 'Old plan', 'left-team')] })

      expect(sections().at(-1)).toEqual(['In other spaces', ['Old plan']])
      expect(sectionNamed('In other spaces').textContent)
        .toContain('Your workspaces in spaces that are not in your list.')
    })

    it('searches the workspaces of every space as one list, each naming its space, in place of the cards', async () => {
      await renderPage({
        gadgets: [...GADGETS, { id: 'w-memo', title: 'Memo plan', created: DAY, lastActive: DAY, owner: ADA }],
      })

      await type(searchField()!, 'PLAN')
      expect(results()).toEqual([
        ['Platform', 'Ada’s plan'],
        ['Shared with me', 'Memo plan'],
      ])
      expect(sections()).toEqual([])
      expect(cards()).toEqual([])

      await type(searchField()!, 'o')
      expect(results()).toEqual([
        ['Personal', 'Solo notes'],
        ['Platform', 'Roadmap'],
        ['Shared with me', 'Memo plan'],
      ])

      await type(searchField()!, 'nothing')
      expect(results()).toEqual([])
      expect(document.body.textContent).toContain('No workspaces found')
      expect(document.body.textContent).not.toContain('may be incomplete')

      // An emptied search shows the cards again.
      await type(searchField()!, '')
      expect(cards().map(([name]) => name)).toEqual(['Atlas', 'Design', 'Platform'])
    })

    it('links a search result to its address in its space once the space’s listing gives it one', async () => {
      await renderPage({
        api: {
          openSpace: (key: string) => {
            const info = [ATLAS, DESIGN, PLATFORM].find(space => space.key === key)!
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
      expect(rowOf('Solo notes').getAttribute('href')).toBe('/workspace/w-solo')

      await type(searchField()!, 'a')
      expect(rowOf('Roadmap').getAttribute('href')).toBe('/spaces/platform/roadmap')
      expect(rowOf('Ada’s plan').getAttribute('href')).toBe('/spaces/platform/adas-plan')
      // An entry with no slug keeps the workspace's own URL.
      expect(rowOf('Untitled Workspace').getAttribute('href')).toBe('/workspace/w-draft')
      // The address is changed from the space's own page.
      expect(await rowActions('Roadmap')).not.toContain('Change address')
    })

    it('shows another member’s workspace found by a search as a plain row that links to it', async () => {
      await renderPage()
      await type(searchField()!, 'a')

      const plain = rowOf('Ada’s plan')
      expect(plain.getAttribute('href')).toBe('/workspace/w-plan')
      expect(plain.textContent).toContain('Owned by Ada')
      expect(plain.textContent).toContain(`Created ${DAY.toLocaleDateString()}`)
      expect(plain.querySelector('button')).toBeNull()

      // The user's own workspaces keep the list's row, with its actions.
      expect(rowOf('Roadmap').querySelector('button')).not.toBeNull()
    })

    it('searches what a space lists when the user has no workspace of their own', async () => {
      await renderPage({ gadgets: [] })

      await type(searchField()!, 'plan')
      expect(results()).toEqual([['Platform', 'Ada’s plan']])
    })

    it('offers no search to a user with no workspace and no space but their personal one', async () => {
      await renderPage({ gadgets: [], api: { listSpaces: async () => [PERSONAL] } })

      expect(sections()).toEqual([['Personal', []]])
      expect(sectionNamed('Personal').textContent).toContain('No workspaces in your personal space yet.')
      expect(searchField()).toBeNull()
    })

    it('moves one of the user’s workspaces to the space chosen for it, which counts it on its card', async () => {
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
      expect(sections()[0]).toEqual(['Personal', []])
      expect(cards()[1]).toEqual(['Design', 'Your role: Use · 1 workspace'])
      // The row has left the page, and the search field has the focus the dialog held.
      expect(document.activeElement).toBe(searchField())
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
      expect(sections()[0]).toEqual(['Personal', []])
      expect(cards()[1]).toEqual(['Design', 'Your role: Use · 1 workspace'])
      const targets = [...document.body.querySelectorAll('[role="dialog"] label')]
        .map(label => label.textContent)
      expect(targets).toEqual(['Personal', 'Atlas', 'Design (current)', 'Platform'])

      // The row has left the page, so the search field takes the focus the dialog held.
      await click(button('Cancel'))
      await settle()
      expect(document.activeElement).toBe(searchField())
    })

    it('offers the move on the user’s own workspaces only', async () => {
      await renderPage({
        gadgets: [...GADGETS, { id: 'w-memo', title: 'Memo', created: DAY, lastActive: DAY, owner: ADA }],
      })

      const actions = await rowActions('Memo')
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
        api: { listSpaces: async () => [PERSONAL] },
      })

      expect(cards()).toEqual([])
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
      expect(cards().map(([name]) => name)).toContain('Platform')
    })

    it('keeps a space’s members open through a replaced session', async () => {
      const page = await renderPage()
      await click(button('Space settings for Platform'))
      await settle()

      const { answer } = await replaceSession(page)
      expect(document.body.querySelector('[role="dialog"]')).not.toBeNull()

      await answer()
      expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Members of Platform')
    })

    it('asks a session that replaces another about no space before its own flags arrive, then reads each listing once', async () => {
      const page = await renderPage()
      await click(button('Space settings for Platform'))
      await settle()

      const { answer, listSpaces, openSpace } = await replaceSession(page)
      expect(listSpaces).not.toHaveBeenCalled()
      expect(openSpace).not.toHaveBeenCalled()

      await answer()
      expect(listSpaces).toHaveBeenCalledOnce()
      // Each card's listing, and the open members dialog's space.
      expect(openSpace.mock.calls.map(([key]) => key).toSorted())
        .toEqual(['atlas', 'design', 'platform', 'platform'])
    })

    it('asks a session that replaces another, and has the flag off, about no space at all', async () => {
      const page = await renderPage()
      await click(button('Space settings for Platform'))
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
