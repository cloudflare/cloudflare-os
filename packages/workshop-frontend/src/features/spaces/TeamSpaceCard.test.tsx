// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GadgetMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import type { WorkspaceRow, WorkspaceSection } from './groupWorkspaces'
import {
  button,
  click,
  deferred,
  fakeApi,
  hasButton,
  listingEntry,
  mountRouted,
  person,
  settle,
  teamSpace,
  unmountAll,
} from './spacesTestUtils'
import { TeamSpaceCard } from './TeamSpaceCard'

type SpaceCardSection = Extract<WorkspaceSection, { kind: 'space' }>

const ADA = person('ada@example.com', 'Ada')
const DAY = new Date('2026-09-01T00:00:00Z')

const rows = (count: number): WorkspaceRow[] => Array.from({ length: count }, (_, index) => {
  const id = `w-${index}`
  return { kind: 'listed', id, workspace: listingEntry(id, `Workspace ${index}`, ADA) }
})

const ownRow = (id: string): WorkspaceRow => {
  const gadget: GadgetMetadataWithTimestamps = { id, title: id, created: DAY, lastActive: DAY, spaceKey: 'platform' }
  return { kind: 'record', id, gadget }
}

const renderCard = async (
  section: SpaceCardSection,
  onListingReload = vi.fn<(spaceKey: string) => Promise<void>>(async () => {}),
) => {
  const onMembersOpen = vi.fn<(spaceKey: string) => void>()
  const { router } = await mountRouted(fakeApi(), {
    at: '/workspaces',
    chrome: (
      <ul>
        <TeamSpaceCard section={section} onMembersOpen={onMembersOpen} onListingReload={onListingReload} />
      </ul>
    ),
  })
  return { onMembersOpen, router }
}

const cardLink = () => document.body.querySelector('li a')!

const textOf = (element: Element, attribute: string) =>
  document.getElementById(element.getAttribute(attribute) ?? '')?.textContent

describe('TeamSpaceCard', () => {
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

    await click(cardLink() as HTMLElement)
    await settle()
    expect(router.state.location.pathname).toBe('/spaces/platform')
  })

  it.each([
    [1, 'Your role: Use · 1 workspace'],
    [0, 'Your role: Use · No workspaces yet'],
  ])('counts %i workspaces as such', async (count, details) => {
    await renderCard({ kind: 'space', space: teamSpace('atlas', 'Atlas', 'use'), listing: 'ready', rows: rows(count) })

    expect(textOf(cardLink(), 'aria-describedby')).toBe(details)
  })

  it('counts nothing while the listing is loading', async () => {
    // The user's own workspace in the space is all that is known of it then.
    await renderCard({ kind: 'space', space: teamSpace('platform', 'Platform'), listing: 'loading', rows: [ownRow('w-mine')] })

    expect(textOf(cardLink(), 'aria-describedby')).toBe('Your role: Admin')
    expect(hasButton('Try again to load Platform')).toBe(false)
  })

  it('says the listing could not be read in place of a count, and reads it again beside the link', async () => {
    const reload = deferred<void>()
    const onListingReload = vi.fn<(spaceKey: string) => Promise<void>>(() => reload.promise)
    const { router } = await renderCard(
      { kind: 'space', space: teamSpace('platform', 'Platform'), listing: 'failed', rows: [ownRow('w-mine')] },
      onListingReload,
    )

    expect(textOf(cardLink(), 'aria-describedby')).toBe('Your role: Admin · Couldn’t load its workspaces')
    const retry = button('Try again to load Platform')
    expect(cardLink().contains(retry)).toBe(false)
    await click(retry)
    expect(onListingReload).toHaveBeenCalledExactlyOnceWith('platform')
    expect(button('Try again to load Platform').disabled).toBe(true)
    expect(router.state.location.pathname).toBe('/workspaces')

    await act(async () => reload.resolve())
    expect(button('Try again to load Platform').disabled).toBe(false)
  })

  it('says so when the space no longer counts the user as a member', async () => {
    await renderCard({ kind: 'space', space: teamSpace('design', 'Design', 'use'), listing: 'refused', rows: [] })

    expect(textOf(cardLink(), 'aria-describedby')).toBe('You are no longer a member of this space.')
  })

  it('opens the space’s members from its settings, beside the link and without following it', async () => {
    const { onMembersOpen, router } = await renderCard({
      kind: 'space',
      space: teamSpace('platform', 'Platform'),
      listing: 'ready',
      rows: [],
    })

    const settings = button('Space settings for Platform')
    expect(cardLink().contains(settings)).toBe(false)
    await click(settings)
    await settle()

    expect(onMembersOpen).toHaveBeenCalledExactlyOnceWith('platform')
    expect(router.state.location.pathname).toBe('/workspaces')
  })
})
