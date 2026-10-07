// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoute, RouterProvider, type AnyRoute } from '@tanstack/react-router'
import type { AuthenticatedApi, PublishedSpaceInfo } from '@gadgets/workshop-shared/api'
import {
  ME,
  alerts,
  button,
  click,
  fakeApi,
  hasButton,
  mountRouted,
  person,
  settle,
  type,
  unmountAll,
} from '../spacesTestUtils'
import { SpaceDirectory } from './SpaceDirectory'
import { SEARCH_DEBOUNCE_MS } from './usePublishedSpaces'

type Page = Awaited<ReturnType<AuthenticatedApi['listPublishedSpaces']>>

const ALICE = person('alice@example.com', 'Alice')
const PLATFORM: PublishedSpaceInfo = { key: 'platform', name: 'Platform', kind: 'team' }
const ALICE_SPACE: PublishedSpaceInfo = { key: '~alice', name: 'Alice', kind: 'personal', owner: ALICE }
const MY_SPACE: PublishedSpaceInfo = { key: '~me', name: 'Me', kind: 'personal', owner: ME }

const pages = (root: AnyRoute) => [
  createRoute({ getParentRoute: () => root, path: '/explore', component: SpaceDirectory }),
]

const show = (listPublishedSpaces: AuthenticatedApi['listPublishedSpaces']) =>
  mountRouted(fakeApi({ listPublishedSpaces }), { at: '/explore', pages })

// The elements a screen reader is given as `role`, by the implicit roles this page relies on.
const ROLE_SELECTORS: Record<string, string> = {
  searchbox: 'input[type="search"]',
  list: 'ul',
  link: 'a[href]',
  status: '[role="status"]',
}

// The name a screen reader reads for `element`: its label, or else its text, with the text of
// separate elements kept apart as a browser keeps block-level text apart.
const accessibleName = (element: Element) => {
  const label = element.getAttribute('aria-label')
  if (label !== null) return label
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  const texts: string[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.trim()
    if (text) texts.push(text)
  }
  return texts.join(' ')
}

const byRole = (role: string, name?: string, within: ParentNode = document) =>
  [...within.querySelectorAll(ROLE_SELECTORS[role])]
    .filter(element => name === undefined || accessibleName(element) === name)

const searchBox = () => {
  const [input] = byRole('searchbox', 'Search spaces')
  if (!(input instanceof HTMLInputElement)) throw new Error('No search box')
  return input
}

const search = async (text: string) => {
  await type(searchBox(), text)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 10)) })
  await settle()
}

const spacesList = () => byRole('list', 'Spaces')[0]
const cards = () => {
  const list = spacesList()
  return list ? byRole('link', undefined, list) as HTMLAnchorElement[] : []
}
const card = (key: string) => {
  const found = cards().find(link => link.getAttribute('href') === `/spaces/${encodeURIComponent(key)}`)
  if (!found) throw new Error(`No card for “${key}”`)
  return found
}
const announced = () => {
  const [status] = byRole('status')
  expect(status?.getAttribute('aria-live')).toBe('polite')
  return status?.textContent
}
const busy = () => spacesList()?.closest('[aria-busy]')?.getAttribute('aria-busy')

// Pressing a button, which then loses its focus as a browser takes it from a button that is
// disabled, as these are while their read is under way. jsdom neither does that nor blurs a
// disabled control, so the focus goes before the press re-renders the button.
const press = (label: string) => act(async () => {
  const pressed = button(label)
  pressed.focus()
  pressed.click()
  pressed.blur()
})

// A read the test answers, or fails, when it chooses.
const pendingRead = () => {
  let resolve!: (page: Page) => void
  let reject!: (err: Error) => void
  const promise = new Promise<Page>((resolved, rejected) => {
    resolve = resolved
    reject = rejected
  })
  const answer = async (page: Page | Error) => {
    await act(async () => {
      if (page instanceof Error) reject(page)
      else resolve(page)
    })
    await settle()
  }
  return { promise, answer }
}

// Each further page is answered when the test chooses.
const pagesOnRequest = () => {
  let next = pendingRead()
  const listPublishedSpaces = vi.fn<AuthenticatedApi['listPublishedSpaces']>(async (_query, cursor) => {
    if (cursor === undefined) return { spaces: [ALICE_SPACE], cursor: 'c1' }
    return next.promise
  })
  const answer = (page: Page | Error) => {
    const current = next
    next = pendingRead()
    return current.answer(page)
  }
  return { listPublishedSpaces, answer }
}

describe('SpaceDirectory', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('shows each listed space as a link to its page, named with its kind', async () => {
    await show(async () => ({ spaces: [ALICE_SPACE, MY_SPACE, PLATFORM] }))

    expect(cards().map(accessibleName)).toEqual([
      'Alice Alice’s personal space',
      'Me Your personal space',
      'Platform Team space',
    ])
    expect(announced()).toBe('3 spaces')
    expect(busy()).toBe('false')
    // Arriving results leave alone a page the user has not yet put focus on.
    expect(document.activeElement).toBe(document.body)
  })

  it('opens a space’s page from its card', async () => {
    const { router } = await show(async () => ({ spaces: [PLATFORM] }))

    await click(card('platform'))
    await settle()

    expect(router.state.location.pathname).toBe('/spaces/platform')
  })

  it('searches the directory with what is typed in the labelled search box', async () => {
    const listPublishedSpaces = vi.fn<AuthenticatedApi['listPublishedSpaces']>(async query => ({
      spaces: query === undefined ? [ALICE_SPACE, PLATFORM] : [PLATFORM],
    }))
    await show(listPublishedSpaces)

    await search('  plat ')

    expect(listPublishedSpaces).toHaveBeenLastCalledWith('plat')
    expect(cards().map(accessibleName)).toEqual(['Platform Team space'])
    expect(announced()).toBe('1 space')
  })

  it('keeps the earlier results, busy and dimmed and unannounced, while a newer search is read', async () => {
    const read = pendingRead()
    await show(async query => query === undefined ? { spaces: [ALICE_SPACE, PLATFORM] } : read.promise)

    await search('plat')

    expect(cards()).toHaveLength(2)
    expect(busy()).toBe('true')
    expect(spacesList()?.className).toContain('opacity-60')
    expect(announced()).toBe('')

    await read.answer({ spaces: [PLATFORM] })
    expect(cards()).toHaveLength(1)
    expect(busy()).toBe('false')
    expect(spacesList()?.className).not.toContain('opacity-60')
    expect(announced()).toBe('1 space')
  })

  it('says when nothing is published yet, and when nothing matches', async () => {
    await show(async () => ({ spaces: [] }))
    expect(document.body.textContent).toContain('No spaces have published workspaces yet')
    expect(announced()).toBe('No spaces have published workspaces yet')

    await search('nothing')
    expect(document.body.textContent).toContain('No spaces match')
    expect(document.body.textContent).not.toContain('No spaces have published workspaces yet')
    expect(announced()).toBe('No spaces match')
  })

  it('offers to try again after a failed read', async () => {
    let fail = true
    await show(async () => {
      if (fail) throw new Error('Overloaded')
      return { spaces: [PLATFORM] }
    })
    expect(alerts()).toEqual([expect.stringContaining('Couldn’t load the spaces.')])

    fail = false
    await click(button('Try again'))
    await settle()

    expect(alerts()).toEqual([])
    expect(cards()).toHaveLength(1)
  })

  it('announces a read that fails again when tried again', async () => {
    const read = pendingRead()
    let failed = false
    await show(async () => {
      if (!failed) {
        failed = true
        throw new Error('Overloaded')
      }
      return read.promise
    })
    expect(alerts()).toEqual(['Couldn’t load the spaces.'])

    await click(button('Try again'))
    expect(alerts()).toEqual([''])

    await read.answer(new Error('Overloaded'))
    expect(alerts()).toEqual(['Couldn’t load the spaces.'])
  })

  it('loads more while the directory has another page', async () => {
    const listPublishedSpaces = vi.fn<AuthenticatedApi['listPublishedSpaces']>(async (_query, cursor) =>
      cursor === undefined ? { spaces: [ALICE_SPACE], cursor: 'next' } : { spaces: [PLATFORM] })
    await show(listPublishedSpaces)
    expect(announced()).toBe('1 space, more available')

    await click(button('Load more'))
    await settle()

    expect(listPublishedSpaces).toHaveBeenLastCalledWith(undefined, 'next')
    expect(cards()).toHaveLength(2)
    expect(hasButton('Load more')).toBe(false)
    expect(announced()).toBe('2 spaces')
  })

  it('says when a further page could not be read, and reads it on the next try', async () => {
    let fail = true
    await show(async (_query, cursor) => {
      if (cursor === undefined) return { spaces: [ALICE_SPACE], cursor: 'next' }
      if (fail) throw new Error('Overloaded')
      return { spaces: [PLATFORM] }
    })

    await click(button('Load more'))
    await settle()
    expect(alerts()).toEqual(['Couldn’t load more spaces.'])
    expect(cards()).toHaveLength(1)

    fail = false
    await click(button('Load more'))
    await settle()
    expect(alerts()).toEqual([])
    expect(cards()).toHaveLength(2)
  })

  describe('focus', () => {
    it('gives the first card the last page adds the focus Load more had, as that button goes', async () => {
      const { listPublishedSpaces, answer } = pagesOnRequest()
      await show(listPublishedSpaces)

      const more = button('Load more')
      more.focus()
      await click(more)
      await answer({ spaces: [PLATFORM, MY_SPACE] })

      expect(hasButton('Load more')).toBe(false)
      expect(document.activeElement).toBe(card('platform'))
    })

    it('gives a page’s first card the focus Load more lost, or the button back when the page failed', async () => {
      const { listPublishedSpaces, answer } = pagesOnRequest()
      await show(listPublishedSpaces)

      await press('Load more')
      await answer(new Error('Overloaded'))
      expect(alerts()).toEqual(['Couldn’t load more spaces.'])
      expect(document.activeElement).toBe(button('Load more'))

      await press('Load more')
      await answer({ spaces: [PLATFORM], cursor: 'c2' })
      expect(document.activeElement).toBe(card('platform'))
    })

    it('gives the last card the focus Load more had when the final page adds no new space', async () => {
      const { listPublishedSpaces, answer } = pagesOnRequest()
      await show(listPublishedSpaces)

      await press('Load more')
      await answer({ spaces: [ALICE_SPACE] })

      expect(hasButton('Load more')).toBe(false)
      expect(document.activeElement).toBe(card('~alice'))
    })

    it('gives no focus to the results of a search typed after a page was read', async () => {
      const more = pendingRead()
      await show(async (query, cursor) => {
        if (query !== undefined) return { spaces: [PLATFORM, MY_SPACE] }
        return cursor === undefined ? { spaces: [ALICE_SPACE], cursor: 'c1' } : more.promise
      })

      await press('Load more')
      await more.answer({ spaces: [PLATFORM] })
      expect(document.activeElement).toBe(card('platform'))

      searchBox().focus()
      await type(searchBox(), 'x')
      searchBox().blur()
      await act(async () => { await new Promise(resolve => setTimeout(resolve, SEARCH_DEBOUNCE_MS + 10)) })
      await settle()

      expect(cards()).toHaveLength(2)
      expect(document.activeElement).toBe(document.body)
    })

    it('gives no focus to what a session that replaced this one reads', async () => {
      const { listPublishedSpaces, answer } = pagesOnRequest()
      const { router, rerender } = await show(listPublishedSpaces)

      await press('Load more')
      await answer({ spaces: [PLATFORM] })
      expect(document.activeElement).toBe(card('platform'))

      await rerender(<RouterProvider router={router} />, fakeApi({
        listPublishedSpaces: async () => ({ spaces: [PLATFORM, MY_SPACE] }),
      }))
      await settle()

      expect(cards()).toHaveLength(2)
      expect(cards()).not.toContain(document.activeElement)
    })

    it('leaves focus the user has moved elsewhere while a page is read', async () => {
      const { listPublishedSpaces, answer } = pagesOnRequest()
      await show(listPublishedSpaces)

      await press('Load more')
      searchBox().focus()
      await answer({ spaces: [PLATFORM] })

      expect(document.activeElement).toBe(searchBox())
    })

    it('gives the search box the focus Try again had once the read succeeds, and the button back while it fails', async () => {
      let read = pendingRead()
      let failed = false
      await show(async () => {
        if (!failed) {
          failed = true
          throw new Error('Overloaded')
        }
        return read.promise
      })

      await press('Try again')
      await read.answer(new Error('Overloaded'))
      expect(alerts()).toEqual([expect.stringContaining('Couldn’t load the spaces.')])
      expect(document.activeElement).toBe(button('Try again'))

      read = pendingRead()
      await press('Try again')
      await read.answer({ spaces: [PLATFORM] })
      expect(alerts()).toEqual([])
      expect(document.activeElement).toBe(searchBox())
    })
  })
})
