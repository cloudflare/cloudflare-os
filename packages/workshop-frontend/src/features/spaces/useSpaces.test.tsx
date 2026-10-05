// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthenticatedApi, SpaceInfo } from '@gadgets/workshop-shared/api'
import {
  ME,
  deferred,
  fakeApi,
  mount,
  personalSpace,
  settle,
  teamSpace,
  unmountAll,
} from './spacesTestUtils'
import { useSpaces, type Spaces } from './useSpaces'

const PERSONAL = personalSpace(ME, 'admin')
const PLATFORM = teamSpace('platform', 'Platform')

// Another component using the hook, beside the one a test reads.
const Reader = () => {
  useSpaces()
  return null
}

describe('useSpaces', () => {
  let current: Spaces

  const Probe = () => {
    current = useSpaces()
    return null
  }

  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('makes no call while the flag is off', async () => {
    const listSpaces = vi.fn<AuthenticatedApi['listSpaces']>(async () => [PERSONAL])
    await mount(<Probe />, fakeApi({ listSpaces }, { spacesFlag: false }))
    await settle()

    expect(current).toMatchObject({ enabled: false, spaces: [], loading: false, failed: false })
    await act(() => current.refresh())
    expect(listSpaces).not.toHaveBeenCalled()
  })

  it('loads the list once the flag is on, and again on refresh', async () => {
    let listed: SpaceInfo[] = [PERSONAL]
    const listSpaces = vi.fn<AuthenticatedApi['listSpaces']>(async () => listed)
    await mount(<Probe />, fakeApi({ listSpaces }))
    await settle()

    expect(current).toMatchObject({ enabled: true, spaces: [PERSONAL], loading: false, failed: false })
    expect(listSpaces).toHaveBeenCalledOnce()

    listed = [PERSONAL, PLATFORM]
    await act(() => current.refresh())
    expect(current.spaces).toEqual([PERSONAL, PLATFORM])
  })

  it('is one list for every component using it: one load, and a refresh by either reaches both', async () => {
    let other!: Spaces
    const Other = () => {
      other = useSpaces()
      return null
    }
    let listed: SpaceInfo[] = [PERSONAL]
    const listSpaces = vi.fn<AuthenticatedApi['listSpaces']>(async () => listed)
    await mount(<><Probe /><Other /></>, fakeApi({ listSpaces }))
    await settle()

    expect(listSpaces).toHaveBeenCalledOnce()
    expect(other.spaces).toEqual([PERSONAL])

    listed = [PERSONAL, PLATFORM]
    await act(() => other.refresh())
    expect(current.spaces).toEqual([PERSONAL, PLATFORM])
    expect(listSpaces).toHaveBeenCalledTimes(2)
  })

  it('loads the list again when another component starts using it', async () => {
    let listed: SpaceInfo[] = [PERSONAL]
    const listSpaces = vi.fn<AuthenticatedApi['listSpaces']>(async () => listed)
    const api = fakeApi({ listSpaces })
    const { rerender } = await mount(<Probe />, api)
    await settle()

    listed = [PERSONAL, PLATFORM]
    await rerender(<><Probe /><Reader /></>, api)
    await settle()

    expect(current.spaces).toEqual([PERSONAL, PLATFORM])
  })

  it('keeps the last list when a refresh fails, and reports a first load that fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const listSpaces = vi.fn<AuthenticatedApi['listSpaces']>(async () => [PERSONAL, PLATFORM])
    await mount(<Probe />, fakeApi({ listSpaces }))
    await settle()

    listSpaces.mockRejectedValueOnce(new Error('boom'))
    await act(() => current.refresh())
    expect(current).toMatchObject({ spaces: [PERSONAL, PLATFORM], loading: false, failed: true })

    await act(() => current.refresh())
    expect(current.failed).toBe(false)

    unmountAll()
    await mount(<Probe />, fakeApi({ listSpaces: async () => { throw new Error('boom') } }))
    await settle()
    expect(current).toMatchObject({ spaces: [], loading: false, failed: true })
  })

  it('keeps the newer of two loads when the older one settles last', async () => {
    const older = deferred<SpaceInfo[]>()
    const listSpaces = vi.fn<AuthenticatedApi['listSpaces']>(async () => [PERSONAL, PLATFORM])
      .mockImplementationOnce(() => older.promise)
    await mount(<Probe />, fakeApi({ listSpaces }))
    await settle()
    expect(current.loading).toBe(true)

    await act(() => current.refresh())
    await act(async () => older.resolve([PERSONAL]))
    await settle()

    expect(current.spaces).toEqual([PERSONAL, PLATFORM])
  })

  it('drops a load that settles after the session was replaced', async () => {
    const late = deferred<SpaceInfo[]>()
    const { rerender } = await mount(<Probe />, fakeApi({ listSpaces: () => late.promise }))
    await settle()

    await rerender(<Probe />, fakeApi({ listSpaces: async () => [PERSONAL, PLATFORM] }))
    await settle()
    await act(async () => late.resolve([PERSONAL]))
    await settle()

    expect(current).toMatchObject({ spaces: [PERSONAL, PLATFORM], loading: false })
  })

  it('reports the session before until a session that replaces it has its own flags and list', async () => {
    const { rerender } = await mount(<Probe />, fakeApi({ listSpaces: async () => [PERSONAL, PLATFORM] }))
    await settle()

    const flags = deferred<{ spaces: boolean }>()
    const list = deferred<SpaceInfo[]>()
    const listSpaces = vi.fn<AuthenticatedApi['listSpaces']>(() => list.promise)
    await rerender(<Probe />, fakeApi({ getUiFeatureFlags: () => flags.promise, listSpaces }))
    await settle()

    const held = { enabled: true, spaces: [PERSONAL, PLATFORM], loading: false, failed: false }
    expect(current).toMatchObject(held)
    // The new session is asked for nothing before its own flags say the flag is on.
    await act(() => current.refresh())
    expect(listSpaces).not.toHaveBeenCalled()

    await act(async () => flags.resolve({ spaces: true }))
    await settle()
    expect(current).toMatchObject(held)
    expect(listSpaces).toHaveBeenCalledOnce()

    await act(async () => list.resolve([PERSONAL]))
    await settle()
    expect(current).toMatchObject({ enabled: true, spaces: [PERSONAL], loading: false })
  })

  it('keeps the list of the session before when the first load of the one that replaces it fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { rerender } = await mount(<Probe />, fakeApi({ listSpaces: async () => [PERSONAL, PLATFORM] }))
    await settle()

    const listSpaces = vi.fn<AuthenticatedApi['listSpaces']>(async () => [PERSONAL])
      .mockRejectedValueOnce(new Error('boom'))
    await rerender(<Probe />, fakeApi({ listSpaces }))
    await settle()
    expect(current).toMatchObject({ enabled: true, spaces: [PERSONAL, PLATFORM], loading: false, failed: true })

    await act(() => current.refresh())
    expect(current).toMatchObject({ spaces: [PERSONAL], failed: false })
  })

  it('makes no call in a session that replaces one with the flag on and has it off', async () => {
    const { rerender } = await mount(<Probe />, fakeApi({ listSpaces: async () => [PERSONAL, PLATFORM] }))
    await settle()

    const listSpaces = vi.fn<AuthenticatedApi['listSpaces']>(async () => [PERSONAL])
    await rerender(<Probe />, fakeApi({ listSpaces }, { spacesFlag: false }))
    await settle()

    expect(current).toMatchObject({ enabled: false, spaces: [], loading: false })
    expect(listSpaces).not.toHaveBeenCalled()
  })
})
