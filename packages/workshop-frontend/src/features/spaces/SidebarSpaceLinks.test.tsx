// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AuthenticatedApi, SpaceInfo } from '@gadgets/workshop-shared/api'
import {
  SidebarWorkspacesLists,
  SidebarWorkspacesProvider,
} from '../../components/AppShell/SidebarWorkspaces'
import {
  ME,
  button,
  click,
  fakeApi,
  hasButton,
  mountRouted,
  person,
  personalSpace,
  teamSpace,
  unmountAll,
} from './spacesTestUtils'

const SPACES = [
  personalSpace(ME, 'admin'),
  personalSpace(person('ada@example.com', 'Ada'), 'use'),
  teamSpace('design', 'Design', 'use'),
  teamSpace('platform', 'Platform'),
]

// The sidebar's lists as the shell renders them, over a user with no workspaces.
const renderSidebar = async (
  { spaces = SPACES, spacesFlag = true, collapsed = false, at = '/' }: {
    spaces?: SpaceInfo[]
    spacesFlag?: boolean
    collapsed?: boolean
    at?: string
  } = {},
) => {
  const listSpaces = vi.fn<AuthenticatedApi['listSpaces']>(async () => spaces)
  await mountRouted(fakeApi({ listGadgets: async () => [], listSpaces }, { spacesFlag }), {
    at,
    chrome: (
      <SidebarWorkspacesProvider>
        <SidebarWorkspacesLists collapsed={collapsed} />
      </SidebarWorkspacesProvider>
    ),
  })
  return { listSpaces }
}

const spaceLinks = () => [...document.body.querySelectorAll<HTMLAnchorElement>('a[href^="/workspaces?"]')]

describe('the sidebar’s Spaces section', () => {
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('links each of the user’s spaces but their own personal one to its section of the page', async () => {
    await renderSidebar()

    expect(hasButton('Spaces')).toBe(true)
    expect(spaceLinks().map(link => [link.textContent, link.getAttribute('href')])).toEqual([
      ['AAda’s personal space', '/workspaces?space=%7Eada'],
      ['DDesign', '/workspaces?space=design'],
      ['PPlatform', '/workspaces?space=platform'],
    ])
  })

  it('collapses with its sibling sections', async () => {
    await renderSidebar()

    await click(button('Spaces'))

    expect(spaceLinks()).toEqual([])
    expect(hasButton('Spaces')).toBe(true)
  })

  it('names each space by its link alone in the collapsed rail', async () => {
    await renderSidebar({ collapsed: true })

    expect(spaceLinks().map(link => [link.getAttribute('aria-label'), link.title, link.textContent]))
      .toEqual([
        ['Ada’s personal space', 'Ada’s personal space', 'A'],
        ['Design', 'Design', 'D'],
        ['Platform', 'Platform', 'P'],
      ])
  })

  it('is absent when the user has no space but their own personal one', async () => {
    await renderSidebar({ spaces: [personalSpace(ME, 'admin')] })

    expect(hasButton('Recent workspaces')).toBe(true)
    expect(hasButton('Spaces')).toBe(false)
    expect(spaceLinks()).toEqual([])
  })

  it('is absent, and asks for no spaces, while the flag is off', async () => {
    const { listSpaces } = await renderSidebar({ spacesFlag: false })

    expect(hasButton('Recent workspaces')).toBe(true)
    expect(hasButton('Spaces')).toBe(false)
    expect(spaceLinks()).toEqual([])
    expect(listSpaces).not.toHaveBeenCalled()

    unmountAll()
    await renderSidebar({ spacesFlag: false, collapsed: true })
    expect(document.body.querySelectorAll('a')).toHaveLength(0)
  })
})
