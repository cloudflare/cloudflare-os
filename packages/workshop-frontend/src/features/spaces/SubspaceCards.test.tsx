// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, useState } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  alerts,
  button,
  click,
  deferred,
  fakeApi,
  hasButton,
  mountRouted,
  subspace,
  unmountAll,
} from './spacesTestUtils'
import { SubspaceCards } from './SubspaceCards'
import type { SubspaceListing } from './useSubspaces'

const INFRA = subspace('infra', 'Infra')
const OPS = subspace('ops', 'Ops')
const RETRY = 'Try again to load the sub-spaces of Platform'

const renderCards = async (listing: SubspaceListing, onReload = vi.fn<() => Promise<void>>(async () => {})) => {
  const onMembersOpen = vi.fn<(spaceId: string) => void>()
  const onFocusLost = vi.fn<() => void>()
  await mountRouted(fakeApi(), {
    at: '/workspaces',
    chrome: (
      <main>
        <SubspaceCards
          label="Platform"
          listing={listing}
          onMembersOpen={onMembersOpen}
          onReload={onReload}
          onFocusLost={onFocusLost}
        />
      </main>
    ),
  })
  return { onMembersOpen, onReload, onFocusLost }
}

// The cards over a read that failed, whose next state is what the test's read answers once it
// settles, as a page's is what the space answers.
const ReloadableCards = ({ onReload, onFocusLost }: {
  onReload: () => Promise<SubspaceListing>
  onFocusLost: () => void
}) => {
  const [listing, setListing] = useState<SubspaceListing>({ status: 'failed' })
  return (
    <SubspaceCards
      label="Platform"
      listing={listing}
      onMembersOpen={() => {}}
      onReload={async () => setListing(await onReload())}
      onFocusLost={onFocusLost}
    />
  )
}

const renderReloadable = async () => {
  let read = deferred<SubspaceListing>()
  const onFocusLost = vi.fn<() => void>()
  await mountRouted(fakeApi(), {
    at: '/workspaces',
    chrome: (
      <main>
        <ReloadableCards onReload={() => read.promise} onFocusLost={onFocusLost} />
      </main>
    ),
  })
  const retry = button(RETRY)
  retry.focus()
  return {
    retry,
    onFocusLost,
    // Presses `Try again` and answers the read it starts.
    tryAgain: async (listing: SubspaceListing) => {
      read = deferred()
      await click(retry)
      await act(async () => read.resolve(listing))
    },
  }
}

const content = () => document.body.querySelector('main')!

describe('SubspaceCards', () => {
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('shows a card for each sub-space, in the order read, in a list named for the space', async () => {
    const { onMembersOpen } = await renderCards({ status: 'ready', subspaces: [OPS, INFRA] })

    const lists = content().querySelectorAll('ul')
    expect(lists).toHaveLength(1)
    expect(lists[0].getAttribute('aria-label')).toBe('Sub-spaces of Platform')
    const links = [...lists[0].querySelectorAll(':scope > li a')]
    expect(links.map(link => [link.textContent, link.getAttribute('href')]))
      .toEqual([['Ops', '/spaces/ops'], ['Infra', '/spaces/infra']])

    await click(button('Members of Infra'))
    expect(onMembersOpen).toHaveBeenCalledExactlyOnceWith('infra')
  })

  it.each<[string, SubspaceListing]>([
    ['for a space with no sub-space', { status: 'ready', subspaces: [] }],
    ['while the sub-spaces are being read', { status: 'loading' }],
    ['for a space that refuses the user', { status: 'refused' }],
  ])('shows nothing %s', async (_, listing) => {
    await renderCards(listing)

    expect(content().innerHTML).toBe('')
  })

  it('says that the sub-spaces could not be read, and reads them again once from a button that stays enabled and marked busy', async () => {
    const reload = deferred<void>()
    const { onReload } = await renderCards({ status: 'failed' }, vi.fn<() => Promise<void>>(() => reload.promise))

    expect(alerts()).toEqual(['Couldn’t load the sub-spaces of Platform.Try again'])
    expect(content().querySelector('ul')).toBeNull()
    const retry = button(RETRY)
    await click(retry)
    expect(retry.disabled).toBe(false)
    expect(retry.getAttribute('aria-disabled')).toBe('true')
    await click(retry)
    expect(onReload).toHaveBeenCalledOnce()

    await act(async () => reload.resolve())
    expect(retry.hasAttribute('aria-disabled')).toBe(false)
  })

  it('gives the first card’s link the focus Try again had once the cards replace it, and does not call onFocusLost', async () => {
    const { tryAgain, onFocusLost } = await renderReloadable()

    await tryAgain({ status: 'ready', subspaces: [INFRA, OPS] })

    expect(hasButton(RETRY)).toBe(false)
    expect(document.activeElement).toBe(content().querySelector('a'))
    expect(document.activeElement?.textContent).toBe('Infra')
    expect(onFocusLost).not.toHaveBeenCalled()
  })

  it('calls onFocusLost when another try finds no sub-space', async () => {
    const { tryAgain, onFocusLost } = await renderReloadable()

    await tryAgain({ status: 'ready', subspaces: [] })

    expect(content().innerHTML).toBe('')
    expect(onFocusLost).toHaveBeenCalledOnce()
  })

  it('leaves the focus on Try again when the sub-spaces cannot be read again', async () => {
    const { retry, tryAgain, onFocusLost } = await renderReloadable()

    await tryAgain({ status: 'failed' })

    expect(document.activeElement).toBe(retry)
    expect(retry.hasAttribute('aria-disabled')).toBe(false)
    expect(onFocusLost).not.toHaveBeenCalled()
  })
})
