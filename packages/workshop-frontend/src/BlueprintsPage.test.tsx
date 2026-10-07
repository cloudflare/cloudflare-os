// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoute, type AnyRoute } from '@tanstack/react-router'
import type { AuthenticatedApi, BlueprintPublicInfo } from '@gadgets/workshop-shared/api'
import { ME, fakeApi, hasButton, mountRouted, unmountAll } from './features/spaces/spacesTestUtils'
import BlueprintsPage from './BlueprintsPage'

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

const api = () => fakeApi({
  listFeaturedBlueprints: vi.fn<AuthenticatedApi['listFeaturedBlueprints']>(async () => [TODO]),
  listGatekeeperVendors: vi.fn<AuthenticatedApi['listGatekeeperVendors']>(async () => []),
})

const show = (showHeader?: boolean) => mountRouted(api(), {
  at: '/explore',
  pages: (root: AnyRoute) => [
    createRoute({
      getParentRoute: () => root,
      path: '/explore',
      component: () => <BlueprintsPage {...(showHeader !== undefined && { showHeader })} />,
    }),
  ],
})

const headings = () => [...document.querySelectorAll('h1')].map(heading => heading.textContent)
const featured = () => [...document.querySelectorAll('a[aria-label^="Open featured blueprint"]')]
  .map(link => link.getAttribute('aria-label'))

describe('BlueprintsPage', () => {
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('is its own page by default, headed Explore, listing the featured blueprints', async () => {
    await show()

    expect(headings()).toEqual(['Explore'])
    expect(featured()).toEqual(['Open featured blueprint Todo list'])
    expect(hasButton('Grid view')).toBe(true)
  })

  it('leaves the heading to its host without its header, and keeps the view toggle', async () => {
    await show(false)

    expect(headings()).toEqual([])
    expect(featured()).toEqual(['Open featured blueprint Todo list'])
    expect(hasButton('Grid view')).toBe(true)
    expect(hasButton('List view')).toBe(true)
  })
})
