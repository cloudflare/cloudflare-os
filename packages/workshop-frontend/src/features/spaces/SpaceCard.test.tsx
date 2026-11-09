// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type {
  AiChatAuthorInfo,
  SpaceWorkspaceInfo,
  WorkspaceMetadataWithTimestamps,
} from '@gadgets/workshop-shared/api'
import type { WorkspaceRow, WorkspaceSection } from './groupWorkspaces'
import {
  button,
  click,
  deferred,
  fakeApi,
  hasButton,
  mountRouted,
  person,
  settle,
  subspace,
  teamSpace,
  unmountAll,
} from './spacesTestUtils'
import { SpaceCard } from './SpaceCard'
import type { SpaceListing } from './useSpaceListings'

type SpaceCardSection = Extract<WorkspaceSection, { kind: 'space' }>

const ADA = person('ada@example.com', 'Ada')
const DAY = new Date('2026-09-01T00:00:00Z')
const PLATFORM = teamSpace('platform', 'Platform')

const listingEntry = (id: string, title: string, owner: AiChatAuthorInfo): SpaceWorkspaceInfo =>
  ({ id, title, owner, created: DAY })

const rows = (count: number): WorkspaceRow[] => Array.from({ length: count }, (_, index) => {
  const id = `w-${index}`
  return { kind: 'listed', id, workspace: listingEntry(id, `Workspace ${index}`, ADA) }
})

const ownRow = (id: string): WorkspaceRow => {
  const gadget: WorkspaceMetadataWithTimestamps = { id, title: id, created: DAY, lastActive: DAY, spaceId: 'platform' }
  return { kind: 'record', id, gadget }
}

const renderCard = async (
  section: SpaceCardSection,
  onListingReload = vi.fn<(spaceId: string) => Promise<void>>(async () => {}),
) => {
  const onMembersOpen = vi.fn<(spaceId: string) => void>()
  const { router } = await mountRouted(fakeApi(), {
    at: '/workspaces',
    chrome: (
      <ul>
        <SpaceCard section={section} onMembersOpen={onMembersOpen} onListingReload={onListingReload} />
      </ul>
    ),
  })
  return { onMembersOpen, onListingReload, router }
}

// The card over a listing that failed, whose status is what the test's read answers once it
// settles, as the page's is what the space answers.
const ReloadableCard = ({ onReload }: { onReload: () => Promise<SpaceListing['status']> }) => {
  const [listing, setListing] = useState<SpaceListing['status']>('failed')
  return (
    <ul>
      <SpaceCard
        section={{ kind: 'space', space: PLATFORM, listing, rows: [] }}
        onMembersOpen={() => {}}
        onListingReload={async () => setListing(await onReload())}
      />
    </ul>
  )
}

const cardLink = () => document.body.querySelector<HTMLAnchorElement>('li a')!

const details = () => document.getElementById(cardLink().getAttribute('aria-describedby') ?? '')!

const textOf = (element: Element, attribute: string) =>
  document.getElementById(element.getAttribute(attribute) ?? '')?.textContent

describe('SpaceCard', () => {
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('links to the space’s page, named by the space and described by the user’s role and its count', async () => {
    const { router } = await renderCard({
      kind: 'space',
      space: teamSpace('platform', 'Platform', 'build'),
      listing: 'ready',
      rows: [ownRow('w-mine'), ...rows(2)],
    })

    expect(cardLink().getAttribute('href')).toBe('/spaces/platform')
    expect(textOf(cardLink(), 'aria-labelledby')).toBe('Platform')
    expect(textOf(cardLink(), 'aria-describedby')).toBe('Your role: Build · 3 workspaces')

    await click(cardLink())
    await settle()
    expect(router.state.location.pathname).toBe('/spaces/platform')
  })

  it.each([
    [1, 'Your role: Use · 1 workspace'],
    [0, 'Your role: Use · No workspaces yet'],
  ])('counts %i workspaces as such', async (count, text) => {
    await renderCard({ kind: 'space', space: teamSpace('atlas', 'Atlas', 'use'), listing: 'ready', rows: rows(count) })

    expect(details().textContent).toBe(text)
  })

  it('counts nothing and names no role while the listing is loading', async () => {
    // The user's own workspace in the space is all that is known of it then, and the role the
    // section carries is the one the list of spaces has.
    await renderCard({ kind: 'space', space: PLATFORM, listing: 'loading', rows: [ownRow('w-mine')] })

    expect(details().textContent).toBe('')
    expect(hasButton('Try again to load Platform')).toBe(false)
  })

  it('says the listing could not be read in place of a count, and reads it again beside the link', async () => {
    const { onListingReload, router } = await renderCard(
      { kind: 'space', space: PLATFORM, listing: 'failed', rows: [ownRow('w-mine')] },
    )

    expect(details().textContent).toBe('Couldn’t load its workspaces')
    const retry = button('Try again to load Platform')
    expect(cardLink().contains(retry)).toBe(false)
    await click(retry)
    await settle()

    expect(onListingReload).toHaveBeenCalledExactlyOnceWith('platform')
    expect(router.state.location.pathname).toBe('/workspaces')
  })

  it('says so when the space no longer counts the user as a member', async () => {
    await renderCard({ kind: 'space', space: teamSpace('design', 'Design', 'use'), listing: 'refused', rows: [] })

    expect(details().textContent).toBe('You are no longer a member of this space.')
    expect(hasButton('Try again to load Design')).toBe(false)
  })

  it('opens the space’s members from its button, beside the link and without following it', async () => {
    const { onMembersOpen, router } = await renderCard({ kind: 'space', space: PLATFORM, listing: 'ready', rows: [] })

    const members = button('Members of Platform')
    expect(cardLink().contains(members)).toBe(false)
    await click(members)
    await settle()

    expect(onMembersOpen).toHaveBeenCalledExactlyOnceWith('platform')
    expect(router.state.location.pathname).toBe('/workspaces')
  })

  it.each([
    ['failed', true],
    ['refused', true],
    ['loading', false],
    ['ready', false],
  ] as const)('announces a listing that failed or refused, and no other: %s', async (listing, announced) => {
    await renderCard({ kind: 'space', space: PLATFORM, listing, rows: [] })

    expect(details().getAttribute('role')).toBe(announced ? 'alert' : null)
    expect(document.body.querySelectorAll('[role="alert"]')).toHaveLength(announced ? 1 : 0)
  })

  it('announces the failure of a listing that was being read by an element of its own', async () => {
    const read = deferred<SpaceListing['status']>()
    await mountRouted(fakeApi(), { at: '/workspaces', chrome: <ReloadableCard onReload={() => read.promise} /> })
    const failure = details()
    expect(failure.getAttribute('role')).toBe('alert')

    await click(button('Try again to load Platform'))
    await act(async () => read.resolve('ready'))

    // An alert is announced when it is inserted, so the count is not the alert with its role taken off.
    expect(details().textContent).toBe('Your role: Admin · No workspaces yet')
    expect(details()).not.toBe(failure)
    expect(failure.isConnected).toBe(false)
  })

  it('leaves Try again enabled and marked busy while the listing is read again, and reads it once', async () => {
    const reload = deferred<void>()
    const { onListingReload } = await renderCard(
      { kind: 'space', space: PLATFORM, listing: 'failed', rows: [] },
      vi.fn<(spaceId: string) => Promise<void>>(() => reload.promise),
    )
    const retry = button('Try again to load Platform')

    await click(retry)
    expect(retry.disabled).toBe(false)
    expect(retry.getAttribute('aria-disabled')).toBe('true')
    await click(retry)
    expect(onListingReload).toHaveBeenCalledOnce()

    await act(async () => reload.resolve())
    expect(retry.hasAttribute('aria-disabled')).toBe(false)
  })

  it('gives the card’s link the focus when the listing is read on another try, and leaves it on the button when the read fails again', async () => {
    let read = deferred<SpaceListing['status']>()
    await mountRouted(fakeApi(), { at: '/workspaces', chrome: <ReloadableCard onReload={() => read.promise} /> })
    const retry = button('Try again to load Platform')
    retry.focus()

    await click(retry)
    await act(async () => read.resolve('failed'))
    expect(document.activeElement).toBe(retry)

    read = deferred()
    await click(retry)
    await act(async () => read.resolve('ready'))
    expect(hasButton('Try again to load Platform')).toBe(false)
    expect(document.activeElement).toBe(cardLink())
  })

  it('says the role the section carries only once the listing has been read', async () => {
    await renderCard({ kind: 'space', space: PLATFORM, listing: 'loading', rows: [] })
    expect(document.body.textContent).not.toContain('Your role')
    unmountAll()

    await renderCard({ kind: 'space', space: PLATFORM, listing: 'ready', rows: [] })
    expect(details().textContent).toBe('Your role: Admin · No workspaces yet')
  })

  describe('of a sub-space', () => {
    const ID = 'c'.repeat(64)

    const renderSubspaceCard = async () => {
      const onMembersOpen = vi.fn<(spaceId: string) => void>()
      const { router } = await mountRouted(fakeApi(), {
        at: '/workspaces',
        chrome: (
          <ul>
            <SpaceCard subspace={subspace(ID, 'Infra')} onMembersOpen={onMembersOpen} />
          </ul>
        ),
      })
      return { onMembersOpen, router }
    }

    it('shows a sub-space by its name alone, linking to its page', async () => {
      await renderSubspaceCard()

      const links = document.body.querySelectorAll('a')
      expect(links).toHaveLength(1)
      expect(textOf(cardLink(), 'aria-labelledby')).toBe('Infra')
      expect(cardLink().getAttribute('href')).toBe(`/spaces/${ID}`)
      expect(cardLink().hasAttribute('aria-describedby')).toBe(false)
      expect(cardLink().textContent).toBe('Infra')
      expect(document.body.textContent).not.toMatch(/Your role/)
      expect(hasButton('Try again')).toBe(false)
    })

    it('opens a sub-space’s members from its button, without following the link', async () => {
      const { onMembersOpen, router } = await renderSubspaceCard()

      const members = button('Members of Infra')
      expect(cardLink().contains(members)).toBe(false)
      await click(members)
      await settle()

      expect(onMembersOpen).toHaveBeenCalledExactlyOnceWith(ID)
      expect(router.state.location.pathname).toBe('/workspaces')
    })
  })
})
