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
  notAMember,
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
const PERSONAL = personalSpace(ME)
const ATLAS = teamSpace('atlas', 'Atlas', 'use')
const DESIGN = teamSpace('design', 'Design', 'use')
const PLATFORM = teamSpace('platform', 'Platform')

const DAY = new Date('2026-09-01T00:00:00Z')

const mine = (id: string, title: string, spaceId?: string): WorkspaceMetadataWithTimestamps =>
  ({ id, title, created: DAY, lastActive: DAY, spaceId })

const listedBy = (owner: AiChatAuthorInfo, id: string, title: string): SpaceWorkspaceInfo =>
  ({ id, title, owner, created: DAY })

const GADGETS: WorkspaceMetadataWithTimestamps[] = [
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
  gadgets?: WorkspaceMetadataWithTimestamps[]
  api?: Partial<{ [K in keyof AuthenticatedApi]: unknown }>
  chrome?: ReactNode
} = {}) => {
  let spaces: SpaceInfo[] = [PERSONAL, ATLAS, DESIGN, PLATFORM]
  const listSpaces = vi.fn<AuthenticatedApi['listSpaces']>(async () => spaces)
  const openSpace = vi.fn<(id: string) => unknown>((id) => {
    const info = spaces.find(space => space.id === id)!
    return fakeSpace(info, [member(ME, info.role)], LISTED[id] ?? [])
  })
  const createSpace = vi.fn<(name: string) => unknown>((name) => {
    const id = `created-${spaces.length}`
    spaces = [...spaces, teamSpace(id, name)]
    return openSpace(id)
  })
  const mounted = await mountRouted(
    fakeApi({
      listWorkspaces: async () => gadgets,
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

// The text of the element that `attribute` of `element` names.
const referenced = (element: Element, attribute: string) =>
  document.getElementById(element.getAttribute(attribute) ?? '')?.textContent

const cardLinks = () => [...document.body.querySelectorAll('section')]
  .filter(section => referenced(section, 'aria-labelledby') === 'Team spaces')
  .flatMap(section => [...section.querySelectorAll<HTMLAnchorElement>('li > a')])

// Each card under the heading 'Team spaces', as the name and the details its link carries.
const cards = () => cardLinks().map(anchor =>
  [referenced(anchor, 'aria-labelledby'), referenced(anchor, 'aria-describedby')])

const cardLink = (name: string) => {
  const found = cardLinks().find(anchor => referenced(anchor, 'aria-labelledby') === name)
  if (!found) throw new Error(`No card named “${name}”`)
  return found
}

// What stands in for the page's sections and cards while the list of spaces is being read.
const spacesSkeleton = () =>
  document.body.querySelector('[role="status"][aria-label="Loading your spaces"]')

// Each search result, as its caption and the title of its row.
const results = () => [...document.body.querySelectorAll('ul[aria-label="Search results"] > li')]
  .map(result => [result.querySelector('p')?.textContent, result.querySelector('h3')?.textContent])

// The line a search shows in place of results when no workspace matches it.
const nothingFound = () => [...document.body.querySelectorAll('div')]
  .find(element => element.childElementCount === 0 && element.textContent?.startsWith('No workspaces found'))
  ?.textContent

// A button busy with the call its press started stays enabled, so that it keeps the focus.
const isBusy = (control: HTMLButtonElement) =>
  !control.disabled && control.getAttribute('aria-disabled') === 'true'

const link = (name: string) => {
  const found = [...document.body.querySelectorAll('a')].find(anchor =>
    anchor.getAttribute('aria-label') === name || anchor.textContent?.trim() === name)
  if (!found) throw new Error(`No link named “${name}”`)
  return found
}

const rowOf = (title: string) => [...document.body.querySelectorAll('h3')]
  .find(heading => heading.textContent === title)!.closest('a')!

// What the row with this title is described by.
const described = (title: string) => referenced(rowOf(title), 'aria-describedby')

// What the menu of the row with this title offers, which is left open.
const rowActions = async (title: string) => {
  await click(rowOf(title).querySelector('button')!)
  return [...document.body.querySelectorAll('[role="menuitem"]')].map(item => item.textContent?.trim())
}

// The sidebar's link to a space's page: the one that is not in a section of the page.
const sidebarLinkTo = (spaceId: string) =>
  [...document.body.querySelectorAll<HTMLAnchorElement>(`a[href="/spaces/${spaceId}"]`)]
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

// A blueprint the deployment features, and whether the list offers the featured ones.
const FEATURED: BlueprintPublicInfo[] = [{
  id: 'starter',
  metadata: { title: 'Starter', description: '', author: ADA, created: DAY, version: 1, lastUpdated: DAY, bindings: {} },
}]
const offersBlueprints = () => document.body.textContent?.includes('Start from a featured blueprint.')

// The page again under a session that replaces the one it was rendered for, as a reconnect
// does. The new session answers neither its flags nor its workspaces until `answer` is called.
const replaceSession = async ({ router, rerender }: Awaited<ReturnType<typeof renderPage>>) => {
  const flags = deferred<{ spaces: boolean }>()
  const gadgets = deferred<WorkspaceMetadataWithTimestamps[]>()
  const spaces = [PERSONAL, ATLAS, DESIGN, PLATFORM]
  const listSpaces = vi.fn<AuthenticatedApi['listSpaces']>(async () => spaces)
  const openSpace = vi.fn<(id: string) => unknown>((id) => {
    const info = spaces.find(space => space.id === id)!
    return fakeSpace(info, [member(ME, info.role)], LISTED[id] ?? [])
  })
  await rerender(<RouterProvider router={router} />, fakeApi({
    getUiFeatureFlags: () => flags.promise,
    listWorkspaces: () => gadgets.promise,
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

// The page with `plan` being searched for, for a user whose space Platform fails to list its
// workspaces once, then answers each read with what the test gives `answer`.
const renderWithFailedListing = async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  let again = deferred<SpaceWorkspaceInfo[] | Error>()
  let reads = 0
  const openSpace = vi.fn<(id: string) => unknown>((id) => {
    const info = [ATLAS, DESIGN, PLATFORM].find(space => space.id === id)!
    const space = fakeSpace(info, [member(ME, info.role)], LISTED[id])
    if (id === 'platform') {
      space.listWorkspaces.mockImplementation(async () => {
        if (reads++ === 0) throw new Error('boom')
        const answer = await again.promise
        if (answer instanceof Error) throw answer
        return answer
      })
    }
    return space
  })
  await renderPage({ api: { openSpace } })
  await type(searchField()!, 'plan')
  return {
    answer: async (answer: SpaceWorkspaceInfo[] | Error) => {
      const { resolve } = again
      again = deferred()
      await act(async () => resolve(answer))
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
      expect(document.body.querySelectorAll('a[aria-describedby]')).toHaveLength(0)
      // The heading cannot take the focus, so a user who arrives with it nowhere keeps it there.
      expect(document.body.querySelector('h1')!.hasAttribute('tabindex')).toBe(false)
      expect(document.activeElement).toBe(document.body)
    })

    it('offers no move on a row', async () => {
      await renderPage({ spacesFlag: false })

      const actions = await rowActions('Solo notes')
      expect(actions).toContain('Invite to workspace')
      expect(actions).not.toContain('Move to space')
    })
  })

  describe('with the spaces flag on', () => {
    it('shows the personal space’s workspaces as rows and each team space as a card', async () => {
      const { openSpace } = await renderPage()

      expect(sections()).toEqual([['Personal', ['Solo notes']], ['Team spaces', []]])
      expect(cards()).toEqual([
        ['Atlas', 'Your role: Use · 1 workspace'],
        ['Design', 'Your role: Use · No workspaces yet'],
        ['Platform', 'Your role: Admin · 2 workspaces'],
      ])
      // What a team space shows is on its own page: none of it is a row here.
      expect([...document.body.querySelectorAll('h3')].map(title => title.textContent))
        .toEqual(['Solo notes'])
      // The user's own personal space is not opened: its section is their own records.
      expect(openSpace.mock.calls.map(([id]) => id)).toEqual(['atlas', 'design', 'platform'])
    })

    it('links each card, and the personal section’s name, to the space’s page', async () => {
      await renderPage()

      expect(cardLink('Platform').getAttribute('href')).toBe('/spaces/platform')
      expect(cardLink('Atlas').getAttribute('href')).toBe('/spaces/atlas')
      expect(link('Personal').getAttribute('href')).toBe('/spaces/home-me')
    })

    it('opens a space’s members from its card', async () => {
      await renderPage()

      await click(button('Members of Platform'))
      await settle()

      expect(document.body.querySelector('[role="dialog"]')?.textContent).toContain('Members of Platform')
    })

    it('hands focus back to the card’s button, and reads the list of spaces again, when the members close', async () => {
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

    it('gives the page’s heading the focus when the members close on a space that has dropped the user', async () => {
      let spaces = [PERSONAL, ATLAS, DESIGN, PLATFORM]
      await renderPage({ api: { listSpaces: async () => spaces } })
      const members = button('Members of Platform')
      members.focus()
      await click(members)
      await settle()

      // Another admin removes the user while the dialog is open.
      spaces = spaces.filter(space => space.id !== 'platform')
      await click(button('Close'))
      await settle()

      expect(document.body.querySelector('[role="dialog"]')).toBeNull()
      expect(cards().map(([name]) => name)).toEqual(['Atlas', 'Design'])
      // The button the dialog hands focus back to went with the card.
      expect(document.activeElement).toBe(document.body.querySelector('h1'))
    })

    it('gives the page’s heading the focus when the members close over cards a replaced session rendered again', async () => {
      const page = await renderPage()
      const members = button('Members of Platform')
      members.focus()
      await click(members)
      await settle()
      const { answer } = await replaceSession(page)
      await answer()
      // The list was rendered again under the open dialog: the card is another element.
      expect(members.isConnected).toBe(false)
      expect(hasButton('Members of Platform')).toBe(true)

      await click(button('Close'))
      await settle()

      expect(document.body.querySelector('[role="dialog"]')).toBeNull()
      expect(document.activeElement).toBe(document.body.querySelector('h1'))
    })

    it('closes the members of a space the user leaves, and drops its card and its sidebar link', async () => {
      let spaces = [PERSONAL, ATLAS, DESIGN, PLATFORM]
      const openSpace = (id: string) => {
        const info = [PERSONAL, ATLAS, DESIGN, PLATFORM].find(space => space.id === id)!
        const space = fakeSpace(info, [member(ME, info.role)], LISTED[id] ?? [])
        space.removeMember.mockImplementation(async () => {
          spaces = spaces.filter(listed => listed.id !== id)
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
      expect(cards().map(([name]) => name)).toEqual(['Atlas', 'Platform'])
      expect(sidebarLinkTo('design')).toBeNull()
      // The button the dialog was opened from went with the card, so the page's heading has
      // the focus.
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
      const openSpace = (id: string) => {
        const info = [PERSONAL, ATLAS, DESIGN, PLATFORM].find(space => space.id === id)!
        const space = fakeSpace(info, [member(ME, info.role)], LISTED[id] ?? [])
        space.removeMember.mockImplementation(async () => {
          spaces = spaces.filter(listed => listed.id !== id)
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

      expect(cards().map(([name]) => name)).toEqual(['Atlas', 'Platform'])
      expect(document.activeElement).toBe(search)
    })

    it('offers members for every team space, and none for the user’s own personal space', async () => {
      await renderPage()

      expect(['Atlas', 'Design', 'Platform'].map(name => hasButton(`Members of ${name}`)))
        .toEqual([true, true, true])
      // A personal space has no members besides its owner.
      expect(hasButton('Members of Personal')).toBe(false)
    })

    it('offers a new workspace in the personal space only', async () => {
      await renderPage()

      expect(link('New workspace in Personal').getAttribute('href')).toBe('/')
      // A new workspace in a team space is offered on that space's own page.
      expect([...document.body.querySelectorAll('a')].map(anchor => anchor.getAttribute('aria-label')))
        .not.toContain('New workspace in Platform')
    })

    it('creates a space from the page header, then lands on the space’s page', async () => {
      const { createSpace, listSpaces, router } = await renderPage()

      await click(button('New space'))
      await type(labeledInput('Name'), 'Field notes')
      await click(button('Create'))
      await settle()

      expect(createSpace).toHaveBeenCalledExactlyOnceWith('Field notes')
      expect(router.state.location.pathname).toBe('/spaces/created-4')
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
      const openSpace = vi.fn<(id: string) => unknown>((id) => {
        const info = [ATLAS, DESIGN, PLATFORM].find(space => space.id === id)!
        const space = fakeSpace(info, [member(ME, info.role)], LISTED[id])
        if (id === 'platform' && failing) space.listWorkspaces.mockRejectedValue(new Error('boom'))
        return space
      })
      await renderPage({ api: { openSpace } })

      expect(sections()).toEqual([['Personal', ['Solo notes']], ['Team spaces', []]])
      expect(cards()).toEqual([
        ['Atlas', 'Your role: Use · 1 workspace'],
        ['Design', 'Your role: Use · No workspaces yet'],
        ['Platform', 'Your role: Admin · Couldn’t load its workspaces'],
      ])
      expect(alerts()).toEqual(['Your role: Admin · Couldn’t load its workspaces'])

      failing = false
      await click(button('Try again to load Platform'))
      await settle()

      expect(alerts()).toEqual([])
      expect(hasButton('Try again to load Platform')).toBe(false)
      expect(cards().at(-1)).toEqual(['Platform', 'Your role: Admin · 2 workspaces'])
    })

    it('shows a listing being read again as busy until the read settles', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const again = deferred<SpaceWorkspaceInfo[]>()
      let platformReads = 0
      const openSpace = vi.fn<(id: string) => unknown>((id) => {
        const info = [ATLAS, DESIGN, PLATFORM].find(space => space.id === id)!
        const space = fakeSpace(info, [member(ME, info.role)], LISTED[id])
        if (id === 'platform') {
          space.listWorkspaces.mockImplementation(platformReads++ === 0
            ? async () => { throw new Error('boom') }
            : () => again.promise)
        }
        return space
      })
      await renderPage({ api: { openSpace } })

      await click(button('Try again to load Platform'))
      await settle()
      expect(isBusy(button('Try again to load Platform'))).toBe(true)

      await act(async () => again.resolve(LISTED.platform))
      await settle()
      expect(alerts()).toEqual([])
      expect(cards().at(-1)).toEqual(['Platform', 'Your role: Admin · 2 workspaces'])
    })

    it('shows a skeleton, and no section or card, until the list of spaces has been read', async () => {
      const list = deferred<SpaceInfo[]>()
      await renderPage({ api: { listSpaces: () => list.promise } })

      // Laid out before the list arrives, the user's workspaces would show under no space of theirs.
      expect(spacesSkeleton()).not.toBeNull()
      expect(sections()).toEqual([])

      await act(async () => { list.resolve([PERSONAL, ATLAS, DESIGN, PLATFORM]) })
      await settle()
      expect(spacesSkeleton()).toBeNull()
      expect(sections()).toEqual([['Personal', ['Solo notes']], ['Team spaces', []]])
      expect(cards().map(([name]) => name)).toEqual(['Atlas', 'Design', 'Platform'])
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
      expect(cards()).toEqual([])

      // A search puts its results in place of the sections, and leaves the alert above them.
      await type(searchField()!, 'road')
      expect(results()).toEqual([['In other spaces', 'Roadmap']])
      expect(alerts()).toEqual(['Couldn’t load your spaces.Try again'])
      await type(searchField()!, '')

      await click(button('Try again'))
      await settle()

      expect(alerts()).toEqual([])
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
      expect(isBusy(button('Try again'))).toBe(true)

      await act(async () => again.resolve([PERSONAL, ATLAS, DESIGN, PLATFORM]))
      await settle()
      expect(alerts()).toEqual([])
    })

    it('gives the search field the focus when the list of spaces is read on another try', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {})
      const listSpaces = vi.fn<AuthenticatedApi['listSpaces']>()
        .mockRejectedValueOnce(new Error('boom'))
        .mockResolvedValue([PERSONAL, ATLAS, DESIGN, PLATFORM])
      await renderPage({ api: { listSpaces } })
      const retry = button('Try again')
      retry.focus()

      await click(retry)
      await settle()

      // The button went with the alert, and the focus it had with it.
      expect(alerts()).toEqual([])
      expect(document.activeElement).toBe(searchField())
    })

    it('says so on the card of a space that no longer counts the user as a member, and reads the list of spaces again once', async () => {
      const openSpace = vi.fn<(id: string) => unknown>((id) => {
        const info = [ATLAS, DESIGN, PLATFORM].find(space => space.id === id)!
        return fakeSpace(info, id === 'design' ? [] : [member(ME, info.role)], LISTED[id])
      })
      // The list of spaces goes on answering with the space that refused the user.
      const { listSpaces } = await renderPage({ api: { openSpace } })

      expect(cards()[1]).toEqual(['Design', 'You are no longer a member of this space.'])
      expect(alerts()).toEqual(['You are no longer a member of this space.'])
      expect(listSpaces).toHaveBeenCalledTimes(2)

      await type(searchField()!, 'plan')
      await settle()
      await type(searchField()!, '')
      await settle()
      expect(cards()[1]).toEqual(['Design', 'You are no longer a member of this space.'])
      expect(listSpaces).toHaveBeenCalledTimes(2)
    })

    it('says nothing of a space that no longer counts the user as a member while a search is on', async () => {
      const openSpace = vi.fn<(id: string) => unknown>((id) => {
        const info = [ATLAS, DESIGN, PLATFORM].find(space => space.id === id)!
        return fakeSpace(info, id === 'design' ? [] : [member(ME, info.role)], LISTED[id])
      })
      await renderPage({ api: { openSpace } })

      // The space shows the user none of its workspaces, so no result is missing for a failure.
      await type(searchField()!, 'plan')
      expect(results()).toEqual([['Platform', 'Ada’s plan']])
      expect(alerts()).toEqual([])
      expect(hasButton('Try again to search every space')).toBe(false)

      await type(searchField()!, 'zzz')
      expect(alerts()).toEqual([])
      expect(nothingFound()).toBe('No workspaces found')
    })

    it('drops the card of a space that refused the user, shows their workspace recorded in it under In other spaces, and leaves the focus where it is', async () => {
      // The space's refusal has corrected the record the list of spaces is read from.
      const listSpaces = vi.fn<AuthenticatedApi['listSpaces']>()
        .mockResolvedValueOnce([PERSONAL, ATLAS, DESIGN, PLATFORM])
        .mockResolvedValue([PERSONAL, ATLAS, PLATFORM])
      const refusal = deferred<void>()
      const openSpace = vi.fn<(id: string) => unknown>((id) => {
        const info = [ATLAS, DESIGN, PLATFORM].find(space => space.id === id)!
        if (id !== 'design') return fakeSpace(info, [member(ME, info.role)], LISTED[id])
        const space = fakeSpace(DESIGN, [])
        space.listWorkspaces.mockImplementationOnce(async () => {
          await refusal.promise
          throw notAMember()
        })
        return space
      })
      await renderPage({
        gadgets: [...GADGETS, mine('w-old', 'Old plan', 'design')],
        api: { listSpaces, openSpace },
      })
      expect(cards().map(([name]) => name)).toEqual(['Atlas', 'Design', 'Platform'])
      expect(sections().map(([name]) => name)).toEqual(['Personal', 'Team spaces'])

      // Where the focus is when the page has just loaded.
      await act(async () => { (document.activeElement as HTMLElement | null)?.blur() })
      expect(document.activeElement).toBe(document.body)
      await act(async () => refusal.resolve())
      await settle()

      expect(cards().map(([name]) => name)).toEqual(['Atlas', 'Platform'])
      expect(sections().at(-1)).toEqual(['In other spaces', ['Old plan']])
      expect(alerts()).toEqual([])
      expect(listSpaces).toHaveBeenCalledTimes(2)
      // The card went by nothing the user did: the search field is there and has not taken the focus.
      expect(searchField()).not.toBeNull()
      expect(document.activeElement).toBe(document.body)
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

    it('shows the matching workspaces of every space as one list, each under the name of its space, in place of the sections and cards', async () => {
      await renderPage()

      const search = searchField()!
      await type(search, 'a')
      expect(results()).toEqual([['Platform', 'Roadmap'], ['Platform', 'Ada’s plan']])
      expect(document.body.querySelectorAll('section')).toHaveLength(0)
      // The rows' titles are third-level headings, which the list's own heading keeps in order.
      expect([...document.body.querySelectorAll('h2')].map(heading => heading.textContent))
        .toEqual(['Search results'])

      // In any case, and in the order the spaces are shown in.
      await type(search, 'R')
      expect(results()).toEqual([['Atlas', 'Brief'], ['Platform', 'Roadmap']])
      await type(search, 'O')
      expect(results()).toEqual([['Personal', 'Solo notes'], ['Platform', 'Roadmap']])

      await type(search, 'nothing')
      expect(results()).toEqual([])
      expect(nothingFound()).toBe('No workspaces found')
    })

    it('shows another member’s workspace among the results as a plain row that links to it', async () => {
      await renderPage()

      await type(searchField()!, 'plan')
      expect(results()).toEqual([['Platform', 'Ada’s plan']])
      const plain = rowOf('Ada’s plan')
      expect(plain.getAttribute('href')).toBe('/workspace/w-plan')
      expect(plain.textContent).toContain('Owned by Ada')
      expect(plain.textContent).toContain(`Created ${DAY.toLocaleDateString()}`)
      expect(plain.querySelector('button')).toBeNull()
    })

    it('describes each result by the space it is in', async () => {
      await renderPage({
        gadgets: [
          ...GADGETS,
          mine('w-old', 'Old plan', 'left-team'),
          { id: 'w-memo', title: 'Memo', created: DAY, lastActive: DAY, owner: ADA },
        ],
      })

      await type(searchField()!, 'o')
      expect(results().map(([, title]) => title))
        .toEqual(['Solo notes', 'Roadmap', 'Old plan', 'Memo'])
      expect(described('Solo notes')).toBe('Personal')
      expect(described('Roadmap')).toBe('Platform')
      expect(described('Old plan')).toBe('In other spaces')
      expect(described('Memo')).toBe('Shared with me')

      await type(searchField()!, 'b')
      // The workspace Ada shared with the user, which Atlas lists, and another member's.
      expect(described('Brief')).toBe('Atlas')
      await type(searchField()!, 'ada')
      expect(described('Ada’s plan')).toBe('Platform')
    })

    it('keeps the list’s actions on a result that is the user’s own', async () => {
      await renderPage()

      await type(searchField()!, 'road')
      expect(results()).toEqual([['Platform', 'Roadmap']])
      expect(await rowActions('Roadmap')).toContain('Move to space')
    })

    it('says that a space is still being read while a search is on, and not that nothing was found', async () => {
      const listing = deferred<SpaceWorkspaceInfo[]>()
      const openSpace = vi.fn<(id: string) => unknown>((id) => {
        const info = [ATLAS, DESIGN, PLATFORM].find(space => space.id === id)!
        const space = fakeSpace(info, [member(ME, info.role)], LISTED[id])
        if (id === 'platform') space.listWorkspaces.mockImplementation(() => listing.promise)
        return space
      })
      await renderPage({ api: { openSpace } })

      // Under the results there are, which lack what the space lists.
      await type(searchField()!, 'o')
      expect(results()).toEqual([['Personal', 'Solo notes'], ['Platform', 'Roadmap']])
      expect(document.body.querySelector('[role="status"]')?.textContent)
        .toBe('Loading the workspaces of your spaces…')

      await type(searchField()!, 'zzz')
      expect(document.body.querySelector('[role="status"]')?.textContent)
        .toBe('Loading the workspaces of your spaces…')
      expect(document.body.textContent).not.toContain('No workspaces found')

      await act(async () => listing.resolve(LISTED.platform))
      await settle()
      expect(document.body.querySelector('[role="status"]')).toBeNull()
      expect(nothingFound()).toBe('No workspaces found')
    })

    describe('with a space that could not be searched', () => {
      it('says which spaces could not be searched, and searches them again on request', async () => {
        const { answer } = await renderWithFailedListing()

        expect(alerts()).toEqual(['Couldn’t search Platform.Try again'])
        expect(results()).toEqual([])
        expect(nothingFound()).toBe('No workspaces found, but the results may be incomplete.')

        // Above the results there are, too, which lack what the space lists.
        await type(searchField()!, 'o')
        expect(results()).toEqual([['Personal', 'Solo notes'], ['Platform', 'Roadmap']])
        expect(alerts()).toEqual(['Couldn’t search Platform.Try again'])
        await type(searchField()!, 'plan')

        const retry = button('Try again to search every space')
        await click(retry)
        await settle()
        expect(isBusy(retry)).toBe(true)

        await answer(LISTED.platform)
        expect(results()).toEqual([['Platform', 'Ada’s plan']])
        expect(alerts()).toEqual([])
        expect(document.body.textContent).not.toContain('No workspaces found')
      })

      it('gives the search field the focus when every space has been searched on another try', async () => {
        const { answer } = await renderWithFailedListing()
        const retry = button('Try again to search every space')
        retry.focus()

        await click(retry)
        await answer(new Error('boom'))
        // The space still cannot be searched: the button is there to press again.
        expect(alerts()).toEqual(['Couldn’t search Platform.Try again'])
        expect(isBusy(retry)).toBe(false)
        expect(document.activeElement).toBe(retry)

        await click(retry)
        await answer(LISTED.platform)
        expect(alerts()).toEqual([])
        expect(document.activeElement).toBe(searchField())
      })

      it('names every space that could not be searched, and searches them all again on one request', async () => {
        vi.spyOn(console, 'error').mockImplementation(() => {})
        const again = {
          atlas: deferred<SpaceWorkspaceInfo[]>(),
          platform: deferred<SpaceWorkspaceInfo[]>(),
        }
        const reads = { atlas: 0, platform: 0 }
        const openSpace = vi.fn<(id: string) => unknown>((id) => {
          const info = [ATLAS, DESIGN, PLATFORM].find(space => space.id === id)!
          const space = fakeSpace(info, [member(ME, info.role)], LISTED[id])
          if (id === 'atlas' || id === 'platform') {
            space.listWorkspaces.mockImplementation(async () => {
              if (reads[id]++ === 0) throw new Error('boom')
              return again[id].promise
            })
          }
          return space
        })
        await renderPage({ api: { openSpace } })
        await type(searchField()!, 'plan')
        expect(alerts()).toEqual(['Couldn’t search Atlas, Platform.Try again'])

        const retry = button('Try again to search every space')
        await click(retry)
        await settle()
        expect(reads).toEqual({ atlas: 2, platform: 2 })

        // One of the two has been searched: the button is busy until the other has been read.
        await act(async () => again.atlas.resolve(LISTED.atlas))
        await settle()
        expect(alerts()).toEqual(['Couldn’t search Platform.Try again'])
        expect(isBusy(retry)).toBe(true)

        await act(async () => again.platform.resolve(LISTED.platform))
        await settle()
        expect(alerts()).toEqual([])
        expect(results()).toEqual([['Platform', 'Ada’s plan']])
      })
    })

    it('gives the sections and cards back when the search is cleared', async () => {
      await renderPage()

      await type(searchField()!, 'plan')
      expect(document.body.querySelectorAll('section')).toHaveLength(0)

      await type(searchField()!, '')
      expect(results()).toEqual([])
      expect(sections()).toEqual([['Personal', ['Solo notes']], ['Team spaces', []]])
      expect(cards().map(([name]) => name)).toEqual(['Atlas', 'Design', 'Platform'])
    })

    it('searches what a space lists when the user has no workspace of their own', async () => {
      await renderPage({ gadgets: [] })

      await type(searchField()!, 'plan')
      expect(results()).toEqual([['Platform', 'Ada’s plan']])
    })

    it('offers no search to a user with no workspace and no space but their personal one', async () => {
      await renderPage({ gadgets: [], api: { listSpaces: async () => [PERSONAL] } })

      expect(sections()).toEqual([['Personal', []]])
      expect(searchField()).toBeNull()
    })

    it('offers a user with no workspace the blueprints the deployment features, and not under search results', async () => {
      await renderPage({ gadgets: [], api: { listFeaturedBlueprints: async () => FEATURED } })
      expect(cards().map(([name]) => name)).toEqual(['Atlas', 'Design', 'Platform'])
      expect(offersBlueprints()).toBe(true)

      await type(searchField()!, 'plan')
      expect(results()).toEqual([['Platform', 'Ada’s plan']])
      expect(offersBlueprints()).toBe(false)
    })

    it('moves one of the user’s workspaces to the space chosen for it', async () => {
      const overseer = {
        moveToSpace: vi.fn<Overseer['moveToSpace']>(async () => {}),
        [Symbol.dispose]: vi.fn<() => void>(),
      }
      await renderPage({ api: { openWorkspace: () => overseer } })

      await click(rowOf('Solo notes').querySelector('button')!)
      await chooseMenuItem('Move to space')
      await chooseTarget('Design')
      await click(button('Move'))
      await settle()

      expect(overseer.moveToSpace).toHaveBeenCalledWith('design')
      expect(sections()[0]).toEqual(['Personal', []])
      expect(sectionNamed('Personal').textContent).toContain('No workspaces in your personal space yet.')
      expect(cards()[1]).toEqual(['Design', 'Your role: Use · 1 workspace'])
      // The row went with its menu, which the dialog would hand the focus back to: the workspace
      // is counted on its space's card.
      expect(document.activeElement).toBe(searchField())
    })

    it('reads a workspace’s space again after a move that failed, and shows the workspace where it is recorded', async () => {
      vi.spyOn(console, 'debug').mockImplementation(() => {})
      let recorded = GADGETS
      const listWorkspaces = vi.fn<AuthenticatedApi['listWorkspaces']>(async () => recorded)
      const overseer = {
        // The record is pointed at the space, which then cannot be reached.
        moveToSpace: vi.fn<Overseer['moveToSpace']>(async (spaceId) => {
          recorded = recorded.map(gadget =>
            (gadget.id === 'w-solo' ? { ...gadget, spaceId: spaceId ?? undefined } : gadget))
          throw new Error('Peer closed WebSocket')
        }),
        [Symbol.dispose]: vi.fn<() => void>(),
      }
      await renderPage({ api: { listWorkspaces, openWorkspace: () => overseer } })

      await click(rowOf('Solo notes').querySelector('button')!)
      await chooseMenuItem('Move to space')
      await chooseTarget('Design')
      await click(button('Move'))
      await settle()

      expect(alerts()).toEqual(['Couldn’t move the workspace. Try again.'])
      expect(listWorkspaces).toHaveBeenCalledTimes(2)
      const targets = [...document.body.querySelectorAll('[role="dialog"] label')]
        .map(label => label.textContent)
      expect(targets).toEqual(['Personal', 'Atlas', 'Design (current)', 'Platform'])
      expect(sections()[0]).toEqual(['Personal', []])
      expect(cards()[1]).toEqual(['Design', 'Your role: Use · 1 workspace'])

      // The row went with its menu, which the dialog would hand the focus back to.
      await click(button('Cancel'))
      await settle()
      expect(document.activeElement).toBe(searchField())
    })

    it('offers the move on the user’s own workspaces only', async () => {
      await renderPage()

      // Atlas lists the workspace Ada shared with the user, so it is a row only among results.
      await type(searchField()!, 'brief')
      expect(results()).toEqual([['Atlas', 'Brief']])
      const actions = await rowActions('Brief')
      expect(actions).toContain('Invite to workspace')
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

      const actions = await rowActions(title)
      expect(actions).toContain('Invite to workspace')
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
      // Each card's listing, and the open members dialog's space.
      expect(openSpace.mock.calls.map(([id]) => id).toSorted())
        .toEqual(['atlas', 'design', 'platform', 'platform'])
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
