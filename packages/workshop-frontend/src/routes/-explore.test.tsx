// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act } from 'react'
import { createRoute, RouterProvider, type AnyRoute } from '@tanstack/react-router'
import type { AuthenticatedApi, BlueprintPublicInfo } from '@gadgets/workshop-shared/api'
import type { UiFeatureFlags } from '@gadgets/workshop-shared/feature-flags'
import { ME, click, deferred, fakeApi, mountRouted, settle, type, unmountAll } from '../features/spaces/spacesTestUtils'
import { Route } from './explore'

const TODO: BlueprintPublicInfo = {
  id: 'todo',
  metadata: {
    title: 'Todo list',
    description: 'Tracks what is left to do.',
    author: ME,
    created: new Date('2026-09-01T00:00:00Z'),
    version: 1,
    lastUpdated: new Date('2026-09-01T00:00:00Z'),
    bindings: {},
  },
}

// The page as the app's route tree mounts it, hung from the test's root.
const pages = (root: AnyRoute) => [
  createRoute({
    getParentRoute: () => root,
    path: '/explore',
    component: Route.options.component,
    validateSearch: Route.options.validateSearch,
  }),
]

// The api of a session, whose flags arrive when `flags` resolves, if it is given.
const session = ({ spacesFlag = true, flags }: { spacesFlag?: boolean; flags?: Promise<UiFeatureFlags> } = {}) => {
  const listPublishedSpaces = vi.fn<AuthenticatedApi['listPublishedSpaces']>(async () => ({
    spaces: [{ key: 'platform', name: 'Platform', kind: 'team' }],
  }))
  const listFeaturedBlueprints = vi.fn<AuthenticatedApi['listFeaturedBlueprints']>(async () => [TODO])
  const api = fakeApi({
    listFeaturedBlueprints,
    listGatekeeperVendors: async () => [],
    listPublishedSpaces,
    ...(flags && { getUiFeatureFlags: () => flags }),
  }, { spacesFlag })
  return { api, listPublishedSpaces, listFeaturedBlueprints }
}

const show = (at: string, options: Parameters<typeof session>[0] = {}) => {
  const { api, ...calls } = session(options)
  return mountRouted(api, { at, pages }).then(mounted => ({ ...mounted, ...calls }))
}

const headings = () => [...document.querySelectorAll('h1')].map(heading => heading.textContent)
const tabs = () => [...document.querySelectorAll<HTMLElement>('[role="tab"]')]
const tab = (label: string) => {
  const found = tabs().find(candidate => candidate.textContent?.trim() === label)
  if (!found) throw new Error(`No “${label}” tab`)
  return found
}
const selectedTab = () =>
  tabs().find(candidate => candidate.getAttribute('aria-selected') === 'true')?.textContent?.trim()
const showsBlueprints = () => document.querySelector('a[aria-label="Open featured blueprint Todo list"]') !== null
const spacesSearch = () => document.querySelector<HTMLInputElement>('input[aria-label="Search spaces"]')
const showsSpaces = () => spacesSearch() !== null

describe('Explore', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('is the featured blueprints alone, with no tabs, while the spaces flag is off', async () => {
    const { listPublishedSpaces } = await show('/explore?tab=spaces', { spacesFlag: false })

    expect(headings()).toEqual(['Explore'])
    expect(tabs()).toEqual([])
    expect(showsBlueprints()).toBe(true)
    expect(document.body.textContent).toContain('Discover featured blueprints to use as starting points.')
    expect(showsSpaces()).toBe(false)
    expect(listPublishedSpaces).not.toHaveBeenCalled()
  })

  it('opens on the Blueprints tab under a single Explore heading', async () => {
    const { listPublishedSpaces } = await show('/explore')

    expect(tabs().map(candidate => candidate.textContent?.trim())).toEqual(['Blueprints', 'Spaces'])
    expect(selectedTab()).toBe('Blueprints')
    expect(headings()).toEqual(['Explore'])
    expect(showsBlueprints()).toBe(true)
    expect(listPublishedSpaces).not.toHaveBeenCalled()
  })

  it('switches tabs, keeping the chosen one in the URL', async () => {
    const { router, listPublishedSpaces } = await show('/explore')

    await click(tab('Spaces'))
    await settle()

    expect(router.state.location.search).toEqual({ tab: 'spaces' })
    expect(selectedTab()).toBe('Spaces')
    expect(showsSpaces()).toBe(true)
    expect(showsBlueprints()).toBe(false)
    expect(listPublishedSpaces).toHaveBeenCalled()
    expect(headings()).toEqual(['Explore'])

    await click(tab('Blueprints'))
    await settle()

    expect(router.state.location.search).toEqual({})
    expect(selectedTab()).toBe('Blueprints')
    expect(showsBlueprints()).toBe(true)
    expect(showsSpaces()).toBe(false)
  })

  it('opens a link to the Spaces tab on that tab', async () => {
    await show('/explore?tab=spaces')

    expect(selectedTab()).toBe('Spaces')
    expect(showsSpaces()).toBe(true)
    expect(document.querySelector('a[href="/spaces/platform"]')).not.toBeNull()
    expect(headings()).toEqual(['Explore'])
  })

  it('shows nothing until the flag is known, then reads the blueprints once', async () => {
    const flags = deferred<UiFeatureFlags>()
    const { listFeaturedBlueprints } = await show('/explore', { flags: flags.promise })
    expect(document.body.textContent).toBe('')

    await act(async () => flags.resolve({ spaces: true }))
    await settle()

    expect(selectedTab()).toBe('Blueprints')
    expect(showsBlueprints()).toBe(true)
    expect(listFeaturedBlueprints).toHaveBeenCalledOnce()
  })

  it('keeps the Spaces tab, its search and its focus while a replacing session loads its flags', async () => {
    const { router, rerender } = await show('/explore?tab=spaces')
    const typed = spacesSearch()!
    typed.focus()
    await type(typed, 'plat')

    const flags = deferred<UiFeatureFlags>()
    await rerender(<RouterProvider router={router} />, session({ flags: flags.promise }).api)
    expect(selectedTab()).toBe('Spaces')
    expect(spacesSearch()).toBe(typed)
    expect(document.activeElement).toBe(typed)

    await act(async () => flags.resolve({ spaces: true }))
    await settle()
    expect(spacesSearch()).toBe(typed)
    expect(typed.value).toBe('plat')
    expect(document.activeElement).toBe(typed)
  })

  it('takes a tab it does not know for the Blueprints tab', async () => {
    const { router } = await show('/explore?tab=bogus')

    expect(router.state.matches.at(-1)?.search).toEqual({ tab: undefined })
    expect(selectedTab()).toBe('Blueprints')
    expect(showsBlueprints()).toBe(true)
  })
})
