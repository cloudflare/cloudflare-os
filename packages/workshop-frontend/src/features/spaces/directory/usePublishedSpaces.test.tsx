// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthenticatedApi, PublishedSpaceInfo } from '@gadgets/workshop-shared/api'
import { fakeApi, mount, person, unmountAll } from '../spacesTestUtils'
import { SEARCH_DEBOUNCE_MS, directoryQuery, usePublishedSpaces, type PublishedSpaces } from './usePublishedSpaces'

type Page = Awaited<ReturnType<AuthenticatedApi['listPublishedSpaces']>>

const team = (key: string, name: string): PublishedSpaceInfo => ({ key, name, kind: 'team' })
const ALICE = person('alice@example.com', 'Alice')
const ALICE_SPACE: PublishedSpaceInfo = { key: '~alice', name: 'Alice', kind: 'personal', owner: ALICE }
const PLATFORM = team('platform', 'Platform')
const DESIGN = team('design', 'Design')

// Waits `ms` of the faked clock, letting the reads it starts and their answers settle.
const wait = (ms = 0) => act(async () => { await vi.advanceTimersByTimeAsync(ms) })

describe('directoryQuery', () => {
  it('puts the query on one line, trimmed, within the server’s limit', () => {
    expect(directoryQuery('  plat\r\nform \n')).toBe('plat form')
    expect(directoryQuery(' \n ')).toBe('')
    expect(directoryQuery('x'.repeat(1500))).toHaveLength(1000)
    expect(directoryQuery(`${'x'.repeat(999)} y`)).toBe('x'.repeat(999))
  })
})

// Each call is answered when the test chooses, found by its query and cursor.
const answers = () => {
  type Call = { query?: string; cursor?: string; resolve: (page: Page) => void; reject: (err: Error) => void }
  const calls: Call[] = []
  const listPublishedSpaces = vi.fn<AuthenticatedApi['listPublishedSpaces']>((query, cursor) =>
    new Promise<Page>((resolve, reject) => { calls.push({ query, cursor, resolve, reject }) }))
  const callsFor = (query: string | undefined, cursor?: string) =>
    calls.filter(entry => entry.query === query && entry.cursor === cursor)
  const call = (query: string | undefined, cursor?: string) => {
    const [found] = callsFor(query, cursor)
    if (!found) throw new Error(`No call for “${query}” at “${cursor}”`)
    return found
  }
  return { listPublishedSpaces, call, calls: callsFor }
}

describe('usePublishedSpaces', () => {
  let current: PublishedSpaces

  const Probe = ({ query }: { query: string }) => {
    current = usePublishedSpaces(query)
    return null
  }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    unmountAll()
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('makes no call while the flag is off', async () => {
    const listPublishedSpaces = vi.fn<AuthenticatedApi['listPublishedSpaces']>(async () => ({ spaces: [] }))
    await mount(<Probe query="" />, fakeApi({ listPublishedSpaces }, { spacesFlag: false }))
    await wait(SEARCH_DEBOUNCE_MS)

    expect(listPublishedSpaces).not.toHaveBeenCalled()
    expect(current.state).toEqual({ status: 'loading' })
  })

  it('reads the whole directory at once for a blank query', async () => {
    const listPublishedSpaces = vi.fn<AuthenticatedApi['listPublishedSpaces']>(async () => ({ spaces: [PLATFORM] }))
    await mount(<Probe query="  " />, fakeApi({ listPublishedSpaces }))
    await wait()

    expect(listPublishedSpaces).toHaveBeenCalledExactlyOnceWith(undefined)
    expect(current.state).toEqual({ status: 'ready', query: '', spaces: [PLATFORM], more: 'idle' })
    expect(current.searching).toBe(false)
  })

  it('searches once typing pauses, with the query trimmed, keeping the last results meanwhile', async () => {
    const listPublishedSpaces = vi.fn<AuthenticatedApi['listPublishedSpaces']>(async (query) => ({
      spaces: query === undefined ? [PLATFORM, DESIGN] : [PLATFORM],
    }))
    const { rerender } = await mount(<Probe query="" />, fakeApi({ listPublishedSpaces }))
    await wait()

    await rerender(<Probe query="p" />)
    await wait(SEARCH_DEBOUNCE_MS / 2)
    await rerender(<Probe query="pl" />)
    await wait(SEARCH_DEBOUNCE_MS / 2)
    await rerender(<Probe query=" pla " />)
    await wait(SEARCH_DEBOUNCE_MS - 1)

    expect(listPublishedSpaces).toHaveBeenCalledOnce()
    expect(current.searching).toBe(true)
    expect(current.state).toMatchObject({ status: 'ready', query: '', spaces: [PLATFORM, DESIGN] })

    await wait(1)
    expect(listPublishedSpaces).toHaveBeenCalledTimes(2)
    expect(listPublishedSpaces).toHaveBeenLastCalledWith('pla')
    expect(current.searching).toBe(false)
    expect(current.state).toMatchObject({ status: 'ready', query: 'pla', spaces: [PLATFORM] })
  })

  it('does not search again for a query that comes back to what was searched', async () => {
    const listPublishedSpaces = vi.fn<AuthenticatedApi['listPublishedSpaces']>(async () => ({ spaces: [] }))
    const { rerender } = await mount(<Probe query="design" />, fakeApi({ listPublishedSpaces }))
    await wait()
    await rerender(<Probe query="designs" />)
    await wait(SEARCH_DEBOUNCE_MS / 2)
    await rerender(<Probe query="design " />)
    await wait(SEARCH_DEBOUNCE_MS)

    expect(listPublishedSpaces).toHaveBeenCalledExactlyOnceWith('design')
    expect(current.searching).toBe(false)
  })

  it('never lets an answer to an earlier query replace a later one', async () => {
    const { listPublishedSpaces, call } = answers()
    const { rerender } = await mount(<Probe query="a" />, fakeApi({ listPublishedSpaces }))
    await wait()
    await rerender(<Probe query="b" />)
    await wait(SEARCH_DEBOUNCE_MS)

    call('b').resolve({ spaces: [DESIGN] })
    await wait()
    call('a').resolve({ spaces: [PLATFORM] })
    await wait()

    expect(current.state).toMatchObject({ status: 'ready', query: 'b', spaces: [DESIGN] })
    expect(current.searching).toBe(false)
  })

  it('is searching while a read for another query is pending, even once the typed one is shown again', async () => {
    const { listPublishedSpaces, call, calls } = answers()
    const { rerender } = await mount(<Probe query="a" />, fakeApi({ listPublishedSpaces }))
    await wait()
    call('a').resolve({ spaces: [PLATFORM] })
    await wait()
    await rerender(<Probe query="b" />)
    await wait(SEARCH_DEBOUNCE_MS)

    await rerender(<Probe query="a" />)
    expect(current.state).toMatchObject({ query: 'a', spaces: [PLATFORM] })
    expect(current.searching).toBe(true)

    await wait(SEARCH_DEBOUNCE_MS)
    call('b').resolve({ spaces: [DESIGN] })
    await wait()
    expect(current.state).toMatchObject({ query: 'a', spaces: [PLATFORM] })
    expect(current.searching).toBe(true)

    calls('a')[1].resolve({ spaces: [PLATFORM, ALICE_SPACE] })
    await wait()
    expect(current.state).toMatchObject({ query: 'a', spaces: [PLATFORM, ALICE_SPACE] })
    expect(current.searching).toBe(false)
  })

  it('shows the earlier query’s results until the later one answers, then only the later', async () => {
    const { listPublishedSpaces, call } = answers()
    const { rerender } = await mount(<Probe query="a" />, fakeApi({ listPublishedSpaces }))
    await wait()
    call('a').resolve({ spaces: [PLATFORM] })
    await wait()
    await rerender(<Probe query="b" />)
    await wait(SEARCH_DEBOUNCE_MS)

    expect(current.searching).toBe(true)
    expect(current.state).toMatchObject({ query: 'a', spaces: [PLATFORM] })

    call('b').resolve({ spaces: [] })
    await wait()
    expect(current.state).toMatchObject({ status: 'ready', query: 'b', spaces: [] })
  })

  it('reads page after page with the cursor, and only one at a time', async () => {
    const { listPublishedSpaces, call } = answers()
    await mount(<Probe query="team" />, fakeApi({ listPublishedSpaces }))
    await wait()
    call('team').resolve({ spaces: [DESIGN], cursor: 'c1' })
    await wait()

    act(() => current.loadMore())
    act(() => current.loadMore())
    expect(listPublishedSpaces).toHaveBeenCalledTimes(2)
    expect(listPublishedSpaces).toHaveBeenLastCalledWith('team', 'c1')
    expect(current.state).toMatchObject({ more: 'loading', spaces: [DESIGN] })

    call('team', 'c1').resolve({ spaces: [PLATFORM] })
    await wait()
    expect(current.state).toEqual({
      status: 'ready', query: 'team', spaces: [DESIGN, PLATFORM], cursor: undefined, more: 'idle',
    })

    act(() => current.loadMore())
    expect(listPublishedSpaces).toHaveBeenCalledTimes(2)
  })

  it('appends a page once when it is asked for twice before either call renders', async () => {
    const { listPublishedSpaces, call, calls } = answers()
    await mount(<Probe query="" />, fakeApi({ listPublishedSpaces }))
    await wait()
    call(undefined).resolve({ spaces: [DESIGN], cursor: 'c1' })
    await wait()

    act(() => {
      current.loadMore()
      current.loadMore()
    })
    const [first, second] = calls(undefined, 'c1')
    first.resolve({ spaces: [PLATFORM], cursor: 'c2' })
    await wait()
    second.resolve({ spaces: [ALICE_SPACE], cursor: 'c3' })
    await wait()

    expect(current.state).toEqual({
      status: 'ready', query: '', spaces: [DESIGN, PLATFORM], cursor: 'c2', more: 'idle',
    })
  })

  it('shows a space once when a later page lists it again', async () => {
    const { listPublishedSpaces, call } = answers()
    await mount(<Probe query="" />, fakeApi({ listPublishedSpaces }))
    await wait()
    call(undefined).resolve({ spaces: [DESIGN, PLATFORM], cursor: 'c1' })
    await wait()

    act(() => current.loadMore())
    // Renamed between the two reads, so it sorts after the cursor too.
    call(undefined, 'c1').resolve({ spaces: [{ ...PLATFORM, name: 'Platforms' }, ALICE_SPACE] })
    await wait()

    expect(current.state).toMatchObject({ spaces: [DESIGN, PLATFORM, ALICE_SPACE], cursor: undefined })
  })

  it('drops a page that continues a query since replaced', async () => {
    const { listPublishedSpaces, call } = answers()
    const { rerender } = await mount(<Probe query="a" />, fakeApi({ listPublishedSpaces }))
    await wait()
    call('a').resolve({ spaces: [DESIGN], cursor: 'c1' })
    await wait()
    act(() => current.loadMore())
    await rerender(<Probe query="b" />)
    await wait(SEARCH_DEBOUNCE_MS)
    // The same cursor as the page the earlier query continues, which does not make it that page.
    call('b').resolve({ spaces: [ALICE_SPACE], cursor: 'c1' })
    await wait()

    call('a', 'c1').resolve({ spaces: [PLATFORM] })
    await wait()
    expect(current.state).toEqual({
      status: 'ready', query: 'b', spaces: [ALICE_SPACE], cursor: 'c1', more: 'idle',
    })
  })

  it('shows nothing a replaced session read, and reads the directory again for the new one', async () => {
    const earlier = vi.fn<AuthenticatedApi['listPublishedSpaces']>(async () => ({ spaces: [DESIGN], cursor: 'c1' }))
    const { rerender } = await mount(<Probe query="" />, fakeApi({ listPublishedSpaces: earlier }))
    await wait()
    expect(current.state).toMatchObject({ spaces: [DESIGN] })

    const { listPublishedSpaces, call } = answers()
    await rerender(<Probe query="" />, fakeApi({ listPublishedSpaces }))
    expect(current.state).toEqual({ status: 'loading' })
    act(() => current.loadMore())
    expect(earlier).toHaveBeenCalledOnce()

    await wait()
    call(undefined).resolve({ spaces: [PLATFORM] })
    await wait()
    expect(current.state).toEqual({ status: 'ready', query: '', spaces: [PLATFORM], more: 'idle' })
  })

  it('drops a page that a replaced session reads', async () => {
    const earlier = answers()
    const { rerender } = await mount(<Probe query="" />, fakeApi({ listPublishedSpaces: earlier.listPublishedSpaces }))
    await wait()
    earlier.call(undefined).resolve({ spaces: [DESIGN], cursor: 'c1' })
    await wait()
    act(() => current.loadMore())

    const later = answers()
    await rerender(<Probe query="" />, fakeApi({ listPublishedSpaces: later.listPublishedSpaces }))
    await wait()
    // The same cursor as the page the earlier session continues, which does not make it that page.
    later.call(undefined).resolve({ spaces: [ALICE_SPACE], cursor: 'c1' })
    await wait()

    earlier.call(undefined, 'c1').resolve({ spaces: [PLATFORM] })
    await wait()
    expect(current.state).toEqual({
      status: 'ready', query: '', spaces: [ALICE_SPACE], cursor: 'c1', more: 'idle',
    })
  })

  it('reports a failed page, and reads it again on the next try', async () => {
    const { listPublishedSpaces, call } = answers()
    await mount(<Probe query="" />, fakeApi({ listPublishedSpaces }))
    await wait()
    call(undefined).resolve({ spaces: [DESIGN], cursor: 'c1' })
    await wait()

    act(() => current.loadMore())
    call(undefined, 'c1').reject(new Error('Overloaded'))
    await wait()
    expect(current.state).toMatchObject({ more: 'failed', spaces: [DESIGN], cursor: 'c1' })

    act(() => current.loadMore())
    expect(listPublishedSpaces).toHaveBeenCalledTimes(3)
    expect(current.state).toMatchObject({ more: 'loading' })
  })

  it('reports a failed first read, and reads it again on refresh', async () => {
    let fail = true
    const listPublishedSpaces = vi.fn<AuthenticatedApi['listPublishedSpaces']>(async () => {
      if (fail) throw new Error('Overloaded')
      return { spaces: [PLATFORM] }
    })
    await mount(<Probe query="plat" />, fakeApi({ listPublishedSpaces }))
    await wait()
    expect(current.state).toEqual({ status: 'failed', query: 'plat' })

    fail = false
    act(() => current.refresh())
    expect(current.searching).toBe(true)
    await wait()
    expect(listPublishedSpaces).toHaveBeenCalledTimes(2)
    expect(current.state).toMatchObject({ status: 'ready', query: 'plat', spaces: [PLATFORM] })
    expect(current.searching).toBe(false)
  })

  it('keeps what is shown while a refresh is read, then replaces it', async () => {
    let listed = [PLATFORM]
    const listPublishedSpaces = vi.fn<AuthenticatedApi['listPublishedSpaces']>(async () => ({ spaces: listed }))
    await mount(<Probe query="" />, fakeApi({ listPublishedSpaces }))
    await wait()

    listed = [DESIGN, PLATFORM]
    act(() => current.refresh())
    expect(current.state).toMatchObject({ spaces: [PLATFORM] })
    await wait()
    expect(current.state).toMatchObject({ spaces: [DESIGN, PLATFORM] })
  })
})
