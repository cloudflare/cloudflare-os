/* eslint-disable react/react-in-jsx-scope */
import { act, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { deferred, fakeApi, mountRouted, subspace, unmountAll } from './spacesTestUtils'
import { SubspaceCards } from './SubspaceCards'
import type { SubspaceListing } from './useSubspaces'
import '../../styles.css'

const LONG_NAME = 'Platform engineering and developer experience '.repeat(5).trim()
const SUBSPACES = [subspace('infra', 'Infra'), subspace('ops', 'Ops'), subspace('long', LONG_NAME)]

const input = (action: () => Promise<unknown>) => act(async () => { await action() })

// The cards over a read whose next state is what the test's read answers once it settles, as a
// page's is what the space answers.
const ReloadableCards = ({ initial, onReload, onMembersOpen }: {
  initial: SubspaceListing
  onReload: () => Promise<SubspaceListing>
  onMembersOpen: (spaceId: string) => void
}) => {
  const [listing, setListing] = useState(initial)
  return (
    <SubspaceCards
      label="Platform"
      listing={listing}
      onMembersOpen={onMembersOpen}
      onReload={async () => setListing(await onReload())}
      onFocusLost={() => {}}
    />
  )
}

// The cards in a list `width` pixels wide, which is what a page gives them beside the sidebar
// and inside its own margins; the window stays as wide as it is.
const render = async (
  width: number,
  initial: SubspaceListing = { status: 'ready', subspaces: SUBSPACES },
  onReload: () => Promise<SubspaceListing> = async () => initial,
) => {
  const onMembersOpen = vi.fn<(spaceId: string) => void>()
  const { router } = await mountRouted(fakeApi(), {
    at: '/workspaces',
    chrome: (
      <div style={{ width }}>
        <ReloadableCards initial={initial} onReload={onReload} onMembersOpen={onMembersOpen} />
      </div>
    ),
  })
  return { onMembersOpen, router }
}

const cardLink = (name: string) => page.getByRole('link', { name, exact: true })
const membersOf = (name: string) => page.getByRole('button', { name: `Members of ${name}` })
const tryAgain = () => page.getByRole('button', { name: 'Try again to load the sub-spaces of Platform' })
const cardOf = (name: string) => cardLink(name).element().closest('li')!

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

describe('SubspaceCards in a browser', () => {
  // One window for every width of the list: the columns follow the list, not the window.
  beforeEach(() => page.viewport(1280, 900))

  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it.each([
    [816, [['infra', 'ops'], ['long']]],
    [428, [['infra'], ['ops'], ['long']]],
  ])('lays the cards out side by side where the list is wide enough for two, and one under another where it is not: %i pixels', async (width, layout) => {
    await render(width)

    expect(cardRows()).toEqual(layout)
    const list = page.getByRole('list', { name: 'Sub-spaces of Platform' }).element()
    expect(list.getBoundingClientRect().width).toBe(width)
    expect([...document.querySelectorAll('li')].map(card => isInside(card, list))).toEqual([true, true, true])
  })

  it.each([428, 816])('cuts a name longer than its card and keeps the members button inside the card: %i pixels', async (width) => {
    await render(width)

    const link = cardLink(LONG_NAME).element()
    const name = document.getElementById(link.getAttribute('aria-labelledby')!)!
    expect(name.scrollWidth).toBeGreaterThan(name.clientWidth)
    expect(isInside(name, cardOf(LONG_NAME))).toBe(true)
    expect(isInside(membersOf(LONG_NAME).element(), cardOf(LONG_NAME))).toBe(true)
  })

  it('reaches a card’s link and then its members button by Tab, and opens the members with Enter', async () => {
    const { onMembersOpen, router } = await render(816)

    await input(() => userEvent.tab())
    await expect.element(cardLink('Infra')).toHaveFocus()
    await input(() => userEvent.tab())
    await expect.element(membersOf('Infra')).toHaveFocus()
    await input(() => userEvent.tab())
    await expect.element(cardLink('Ops')).toHaveFocus()

    await input(() => userEvent.tab({ shift: true }))
    await input(() => userEvent.keyboard('{Enter}'))
    expect(onMembersOpen).toHaveBeenCalledExactlyOnceWith('infra')
    expect(router.state.location.pathname).toBe('/workspaces')
  })

  it('keeps the focus on Try again while the sub-spaces are read again, then moves it to the first card’s link', async () => {
    const read = deferred<SubspaceListing>()
    await render(816, { status: 'failed' }, () => read.promise)

    await input(() => userEvent.tab())
    await expect.element(tryAgain()).toHaveFocus()
    await input(() => userEvent.keyboard('{Enter}'))
    await expect.element(tryAgain()).toHaveAttribute('aria-disabled', 'true')
    await expect.element(tryAgain()).toHaveFocus()

    await act(async () => read.resolve({ status: 'ready', subspaces: SUBSPACES }))
    await expect.element(tryAgain()).not.toBeInTheDocument()
    await expect.element(cardLink('Infra')).toHaveFocus()
    expect(document.activeElement).not.toBe(document.body)
  })
})
