/* eslint-disable react/react-in-jsx-scope */
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { SpaceInfo } from '@gadgets/workshop-shared/api'
import { Route as WorkspacesRoute } from '../../routes/workspaces'
import type { WorkspaceRow, WorkspaceSection } from './groupWorkspaces'
import {
  ME,
  deferred,
  fakeApi,
  fakeSpace,
  member,
  mountRouted,
  person,
  personalSpace,
  teamSpace,
  unmountAll,
} from './spacesTestUtils'
import { TeamSpaceCards } from './TeamSpaceCards'
import type { SpaceListing } from './useSpaceListings'
import '../../styles.css'

vi.mock('../../components/PersonAvatar', () => ({
  PersonAvatar: () => <span data-testid="avatar" />,
}))

type TeamSpaceSection = Extract<WorkspaceSection, { kind: 'space' }>

const ADA = person('ada@example.com', 'Ada')
const DAY = new Date('2026-09-01T00:00:00Z')
const LONG_NAME = 'Platform engineering and developer experience '.repeat(5).trim()

const rows = (count: number): WorkspaceRow[] => Array.from({ length: count }, (_, index) => {
  const id = `w-${index}`
  return { kind: 'listed', id, workspace: { id, title: `Workspace ${index}`, owner: ADA, created: DAY } }
})

// A card that counts, one whose listing failed, one whose space refused the user, and one with a
// name far longer than a card is wide.
const SECTIONS: TeamSpaceSection[] = [
  { kind: 'space', space: teamSpace('platform', 'Platform'), listing: 'ready', rows: rows(12) },
  { kind: 'space', space: teamSpace('atlas', 'Atlas'), listing: 'failed', rows: [] },
  { kind: 'space', space: teamSpace('design', 'Design', 'use'), listing: 'refused', rows: [] },
  { kind: 'space', space: teamSpace('long', LONG_NAME, 'build'), listing: 'ready', rows: [] },
]

const input = (action: () => Promise<unknown>) => act(async () => { await action() })

// The cards over listings whose status is what the test's read answers once it settles, as the
// page's is what the space answers.
const ReloadableCards = ({ onReload, onMembersOpen }: {
  onReload: () => Promise<SpaceListing['status']>
  onMembersOpen: (spaceId: string) => void
}) => {
  const [reread, setReread] = useState<Record<string, SpaceListing['status']>>({})
  return (
    <TeamSpaceCards
      sections={SECTIONS.map(section => ({ ...section, listing: reread[section.space.id] ?? section.listing }))}
      onMembersOpen={onMembersOpen}
      onListingReload={async (spaceId) => {
        const listing = await onReload()
        setReread(known => ({ ...known, [spaceId]: listing }))
      }}
    />
  )
}

// The cards in a list `width` pixels wide, which is what the workspaces page gives them beside
// the sidebar and inside its own margins; the window stays as wide as it is.
const render = async (width: number, onReload: () => Promise<SpaceListing['status']> = async () => 'failed') => {
  const onMembersOpen = vi.fn<(spaceId: string) => void>()
  const { router } = await mountRouted(fakeApi(), {
    at: '/workspaces',
    chrome: (
      <div style={{ width }}>
        <ReloadableCards onReload={onReload} onMembersOpen={onMembersOpen} />
      </div>
    ),
  })
  return { onMembersOpen, router }
}

const cardLink = (name: string) => page.getByRole('link', { name, exact: true })
const tryAgain = (name: string) => page.getByRole('button', { name: `Try again to load ${name}` })
const membersOf = (name: string) => page.getByRole('button', { name: `Members of ${name}` })

const cardOf = (name: string) => cardLink(name).element().closest('li')!
const named = (name: string, attribute: string) =>
  document.getElementById(cardLink(name).element().getAttribute(attribute)!)!

// The ids of the cards' spaces, row by row as the cards are laid out.
const cardRows = () => {
  const rowsByTop = new Map<number, string[]>()
  for (const card of document.querySelectorAll('li')) {
    const { top } = card.getBoundingClientRect()
    const id = card.querySelector('a')!.getAttribute('href')!.replace('/spaces/', '')
    rowsByTop.set(top, [...(rowsByTop.get(top) ?? []), id])
  }
  return [...rowsByTop.entries()].toSorted(([above], [below]) => above - below).map(([, ids]) => ids)
}

// Whether `inner` lies within `outer`, to the half pixel a browser rounds a box by.
const isInside = (inner: Element, outer: Element) => {
  const box = inner.getBoundingClientRect()
  const around = outer.getBoundingClientRect()
  return box.left >= around.left - 0.5 && box.right <= around.right + 0.5
    && box.top >= around.top - 0.5 && box.bottom <= around.bottom + 0.5
}

describe('TeamSpaceCards in a browser', () => {
  // One window for every width of the list: the columns follow the list, not the window.
  beforeEach(() => page.viewport(1280, 900))

  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it.each([
    [296, [['platform'], ['atlas'], ['design'], ['long']]],
    [428, [['platform'], ['atlas'], ['design'], ['long']]],
    [560, [['platform'], ['atlas'], ['design'], ['long']]],
    [684, [['platform', 'atlas'], ['design', 'long']]],
    [816, [['platform', 'atlas'], ['design', 'long']]],
  ])('lays the cards out by the room the list has, none wider than it: %i pixels', async (width, layout) => {
    await render(width)

    expect(cardRows()).toEqual(layout)
    // A list narrower than the room a card wants beside another gives a card its own width.
    const list = document.querySelector('section')!.parentElement!
    expect(list.getBoundingClientRect().width).toBe(width)
    expect([...document.querySelectorAll('li')].map(card => isInside(card, list))).toEqual([true, true, true, true])
  })

  it.each([296, 366, 428, 560, 684, 816])('shows a counted, a failed and a refused card’s details in full in a list %i pixels wide', async (width) => {
    await render(width)

    expect(named('Platform', 'aria-describedby').textContent).toBe('Your role: Admin · 12 workspaces')
    expect(named('Atlas', 'aria-describedby').textContent).toBe('Your role: Admin · Couldn’t load its workspaces')
    expect(named('Design', 'aria-describedby').textContent).toBe('You are no longer a member of this space.')
    for (const name of ['Platform', 'Atlas', 'Design']) {
      const details = named(name, 'aria-describedby')
      expect(details.scrollWidth).toBeLessThanOrEqual(details.clientWidth)
      expect(isInside(details, cardOf(name))).toBe(true)
    }
    // Every button of the three cards: `Try again` on the failed one, and each card's members.
    const controls = ['Platform', 'Atlas', 'Design'].flatMap(name =>
      [...cardOf(name).querySelectorAll('button')].map(control => isInside(control, cardOf(name))))
    expect(controls).toEqual([true, true, true, true])
  })

  it.each([366, 816])('keeps a long name inside its card in a list %i pixels wide', async (width) => {
    await render(width)

    const name = named(LONG_NAME, 'aria-labelledby')
    expect(name.scrollWidth).toBeGreaterThan(name.clientWidth)
    expect(isInside(name, cardOf(LONG_NAME))).toBe(true)
    expect(isInside(membersOf(LONG_NAME).element(), cardOf(LONG_NAME))).toBe(true)
  })

  it('reaches the card’s buttons from its link by keyboard, and neither follows the other', async () => {
    const { onMembersOpen, router } = await render(816)

    await act(async () => { (cardLink('Atlas').element() as HTMLElement).focus() })
    await input(() => userEvent.tab())
    await expect.element(tryAgain('Atlas')).toHaveFocus()
    await input(() => userEvent.tab())
    await expect.element(membersOf('Atlas')).toHaveFocus()

    await input(() => userEvent.keyboard('{Enter}'))
    expect(onMembersOpen).toHaveBeenCalledExactlyOnceWith('atlas')
    expect(router.state.location.pathname).toBe('/workspaces')

    await act(async () => { (cardLink('Atlas').element() as HTMLElement).focus() })
    await input(() => userEvent.keyboard('{Enter}'))
    await expect.poll(() => router.state.location.pathname).toBe('/spaces/atlas')
  })

  it('keeps the focus on Try again while the listing is read again and when the read fails, and gives it to the card’s link when the read works', async () => {
    let read = deferred<SpaceListing['status']>()
    await render(816, () => read.promise)

    await input(() => userEvent.click(tryAgain('Atlas')))
    await expect.element(tryAgain('Atlas')).toHaveAttribute('aria-disabled', 'true')
    await expect.element(tryAgain('Atlas')).toHaveFocus()

    await act(async () => read.resolve('failed'))
    await expect.element(tryAgain('Atlas')).not.toHaveAttribute('aria-disabled')
    await expect.element(tryAgain('Atlas')).toHaveFocus()

    read = deferred()
    await input(() => userEvent.keyboard('{Enter}'))
    await expect.element(tryAgain('Atlas')).toHaveAttribute('aria-disabled', 'true')
    await act(async () => read.resolve('ready'))
    await expect.element(tryAgain('Atlas')).not.toBeInTheDocument()
    await expect.element(cardLink('Atlas')).toHaveFocus()
  })
})

// The page for a member of Atlas and Platform, with the members of Platform opened from its
// card by keyboard. `drop` has the list of spaces answer without Platform from then on.
const openMembers = async () => {
  let spaces: SpaceInfo[] = [personalSpace(ME), teamSpace('atlas', 'Atlas'), teamSpace('platform', 'Platform')]
  await mountRouted(
    fakeApi({
      listWorkspaces: async () => [],
      listFeaturedBlueprints: async () => [],
      listSpaces: async () => spaces,
      openSpace: (id: string) => {
        const info = spaces.find(space => space.id === id)!
        return fakeSpace(info, [member(ME, info.role)])
      },
    }),
    {
      at: '/workspaces',
      pages: root => [WorkspacesRoute.update({
        id: '/workspaces',
        path: '/workspaces',
        getParentRoute: () => root,
      } as never)],
    },
  )
  await expect.element(membersOf('Platform')).toBeVisible()
  await act(async () => membersOf('Platform').element().focus())
  await input(() => userEvent.keyboard('{Enter}'))
  await expect.element(page.getByRole('list', { name: 'Members' })).toBeVisible()
  return { drop: () => { spaces = spaces.filter(space => space.id !== 'platform') } }
}

describe('a card’s members on the workspaces page, in a browser', () => {
  beforeEach(() => page.viewport(1280, 900))

  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('hands the focus back to the card’s button when the members close', async () => {
    await openMembers()

    await input(() => userEvent.keyboard('{Escape}'))

    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
    await expect.element(membersOf('Platform')).toHaveFocus()
  })

  it('gives the page’s heading the focus when the members close on a space that has dropped the user', async () => {
    const { drop } = await openMembers()

    drop()
    await input(() => userEvent.keyboard('{Escape}'))

    await expect.element(cardLink('Platform')).not.toBeInTheDocument()
    await expect.element(page.getByRole('heading', { name: 'Workspaces', level: 1 })).toHaveFocus()
  })
})
