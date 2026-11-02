// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ReactNode } from 'react'
import { TooltipProvider } from '@cloudflare/kumo'
import { afterEach, describe, expect, it } from 'vitest'
import { ListedWorkspaceRow } from './ListedWorkspaceRow'
import { PublishedIndicator } from './PublishedIndicator'
import { VisitedSpace } from './VisitedSpace'
import { fakeApi, listingEntry, mount, mountRouted, person, unmountAll } from './spacesTestUtils'

const ADA = person('ada@example.com', 'Ada')
const PUBLISHED_BUILD = 'Published to everyone signed in · can build'

const indicators = () =>
  [...document.querySelectorAll<HTMLElement>('[role="img"]')].map(element => element.getAttribute('aria-label'))

// Points at the indicator labelled `label` and returns what its tooltip then says. jsdom fires
// none of the events a real pointer does on its own, so each one the tooltip may listen to is sent.
const tooltipOf = async (label: string) => {
  const indicator = document.querySelector<HTMLElement>(`[role="img"][aria-label="${label}"]`)
  if (!indicator) throw new Error(`No indicator labelled ${label}`)
  await act(async () => {
    const Pointer = window.PointerEvent ?? MouseEvent
    indicator.dispatchEvent(new Pointer('pointerover', { bubbles: true, pointerType: 'mouse' } as PointerEventInit))
    indicator.dispatchEvent(new Pointer('pointerenter', { pointerType: 'mouse' } as PointerEventInit))
    indicator.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    indicator.dispatchEvent(new MouseEvent('mouseenter'))
    indicator.dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  return document.querySelector('.kumo-tooltip-popup')?.textContent
}

const renderIndicator = (ui: ReactNode) =>
  mount(<TooltipProvider delay={0}>{ui}</TooltipProvider>, fakeApi())

// The rows are rendered beside a page, as chrome, since their links need a router.
const renderRows = (rows: ReactNode) => mountRouted(fakeApi(), { at: '/workspaces', chrome: rows })

describe('PublishedIndicator', () => {
  afterEach(unmountAll)

  it('names the role a workspace is published with, as its accessible name and its tooltip', async () => {
    await renderIndicator(<PublishedIndicator access="build" />)
    expect(indicators()).toEqual([PUBLISHED_BUILD])
    expect(await tooltipOf(PUBLISHED_BUILD)).toBe(PUBLISHED_BUILD)
  })

  it('names the role "use" too', async () => {
    await renderIndicator(<PublishedIndicator access="use" />)
    expect(indicators()).toEqual(['Published to everyone signed in · can use'])
  })

  it('names the unpublished workspace that holds a publication back', async () => {
    const text = "Published, but not visible until 'Handbook' is published"
    await renderIndicator(<PublishedIndicator access="use" heldBack={{ blockerTitle: 'Handbook' }} />)
    expect(indicators()).toEqual([text])
    expect(await tooltipOf(text)).toBe(text)
  })

  it('says a workspace above it holds the publication back when that one is not known', async () => {
    const text = 'Published, but not visible until a workspace above it is published'
    await renderIndicator(<PublishedIndicator access="build" heldBack={{ blockerTitle: undefined }} />)
    expect(indicators()).toEqual([text])
    expect(await tooltipOf(text)).toBe(text)
  })

  it('is not a tab stop, since the rows it sits in are links and buttons', async () => {
    await renderIndicator(<PublishedIndicator access="build" />)
    const indicator = document.querySelector<HTMLElement>('[role="img"]')
    expect(indicator?.tabIndex).toBe(-1)
    expect(indicator?.closest('button')).toBeNull()
  })
})

describe('ListedWorkspaceRow', () => {
  afterEach(unmountAll)

  it('shows the indicator in place of a text badge', async () => {
    await renderRows(
      <>
        <ListedWorkspaceRow workspace={listingEntry('w1', 'Notes', ADA, { published: 'build' })} listing={undefined} />
        <ListedWorkspaceRow
          workspace={listingEntry('w2', 'Brief', ADA, { published: 'use', hiddenBy: 'w0' })}
          listing={{ address: undefined, heldBack: { blockerTitle: 'Handbook' }, onAddressChange: undefined }}
        />
        <ListedWorkspaceRow workspace={listingEntry('w3', 'Draft', ADA)} listing={undefined} />
      </>,
    )
    expect(indicators()).toEqual([
      PUBLISHED_BUILD,
      "Published, but not visible until 'Handbook' is published",
    ])
    expect(document.body.textContent).not.toContain('Published')
  })
})

describe('VisitedSpace', () => {
  afterEach(unmountAll)

  it('lists, as its tree does, only the published workspaces no unpublished one above holds back', async () => {
    // A listing read while the user was still a member holds the unpublished parent and the
    // published child it holds back, which a visitor must see neither of.
    await renderRows(
      <VisitedSpace
        space={{ key: 'team', kind: 'team' }}
        label="Team"
        listing={{
          status: 'ready',
          asMember: false,
          workspaces: [
            listingEntry('w0', 'Handbook', ADA),
            listingEntry('w1', 'Brief', ADA, { published: 'use', parentId: 'w0', hiddenBy: 'w0' }),
            listingEntry('w2', 'Notes', ADA, { published: 'build' }),
          ],
        }}
        onListingReload={async () => {}}
      />,
    )
    expect(indicators()).toEqual([PUBLISHED_BUILD])
    expect(document.body.textContent).toContain('Notes')
    expect(document.body.textContent).not.toContain('Brief')
    expect(document.body.textContent).not.toContain('Handbook')
  })
})
