// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoute, type AnyRoute } from '@tanstack/react-router'
import type { GadgetMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import type { WorkspacePreviewPane as WorkspacePreviewPaneComponent } from '../preview/WorkspacePreviewPane'
import {
  ME,
  fakeApi,
  fakeSpace,
  listingEntry,
  member,
  mountRouted,
  person,
  personalSpace,
  settle,
  teamSpace,
  unmountAll,
} from '../spacesTestUtils'
import { useSpaces } from '../useSpaces'
import { PersonalTree } from './PersonalTree'

const seen = vi.hoisted(() => ({
  pane: null as ComponentProps<typeof WorkspacePreviewPaneComponent> | null,
}))

// The preview has its own tests; here it shows which workspace it was given.
vi.mock('../preview/WorkspacePreviewPane', () => ({
  WorkspacePreviewPane: (props: ComponentProps<typeof WorkspacePreviewPaneComponent>) => {
    seen.pane = props
    return <section data-preview={props.workspace.id} />
  },
}))

afterEach(() => {
  unmountAll()
  seen.pane = null
  vi.restoreAllMocks()
})

const ADA = person('ada@example.com', 'Ada')
const PERSONAL = personalSpace(ME, 'admin')
const DESIGN = teamSpace('design', 'Design', 'build')
const DAY = new Date('2026-09-01T00:00:00Z')

const record = (id: string, title: string, fields: Partial<GadgetMetadataWithTimestamps> = {}) =>
  ({ id, title, created: DAY, lastActive: DAY, ...fields }) satisfies GadgetMetadataWithTimestamps

// What the personal space lists: Plans, with Trip under it.
const LISTING = [
  listingEntry('w-plans', 'Plans', ME, { position: 0 }),
  listingEntry('w-trip', 'Trip', ME, { parentId: 'w-plans', position: 0 }),
]

// What Design lists: the user's Brief, and Ada's board.
const DESIGN_LISTING = [
  listingEntry('w-design', 'Brief', ME, { position: 0 }),
  listingEntry('w-shared', 'Ada’s board', ADA, { position: 1 }),
]

// The user's records: the two listed, one of their personal space the listing does not have, one
// of theirs Design lists and one it does not, one in a space they have left, and one of Ada's
// shared with them.
const RECORDS = [
  record('w-plans', 'Plans'),
  record('w-trip', 'Trip'),
  record('w-secret', 'Payroll notes', { containsRestrictedData: true }),
  record('w-design', 'Brief', { spaceKey: 'design' }),
  record('w-private', 'Interview notes', { spaceKey: 'design', ownerInvitesOnly: true }),
  record('w-left', 'Old roadmap', { spaceKey: 'platform' }),
  record('w-shared', 'Ada’s board', { owner: ADA }),
]

const Page = () => <PersonalTree spaces={useSpaces()} />

// `designMembers` are Design's members as the space has them, which the user's list of spaces
// may not have caught up with; `designListing` is what Design lists at each read.
const render = async ({ designMembers = [member(ME, 'build')], designListing = DESIGN_LISTING } = {}) => {
  const listGadgets = vi.fn<() => Promise<GadgetMetadataWithTimestamps[]>>(async () => RECORDS)
  await mountRouted(fakeApi({
    listSpaces: async () => [PERSONAL, DESIGN],
    openSpace: (key: string) => (key === 'design'
      ? fakeSpace(DESIGN, designMembers, designListing)
      : fakeSpace(PERSONAL, [member(ME, 'admin')], LISTING)).stub,
    listGadgets,
  }), {
    at: '/workspaces',
    pages: (root: AnyRoute) => [createRoute({ getParentRoute: () => root, path: '/workspaces', component: Page })],
  })
  await settle()
  return { listGadgets }
}

const rowIds = () => [...document.body.querySelectorAll<HTMLElement>('[data-hierarchical-list-item]')]
  .map(item => item.dataset.itemId)
const unlistedGroup = () => [...document.body.querySelectorAll('section')]
  .find(section => section.querySelector('h2')?.textContent === 'Unlisted')

describe('PersonalTree', () => {
  it('shows the personal space’s tree', async () => {
    await render()

    expect(document.body.querySelector('[data-hierarchical-list]')?.getAttribute('aria-label')).toBe('Workspaces in Personal')
    expect(rowIds()).toEqual(['w-plans', 'w-trip'])
  })

  it('shows apart, as unlisted, the user’s own workspaces that no listing they can see shows, in any space', async () => {
    await render()

    const group = unlistedGroup()
    expect([...group!.querySelectorAll('button')].map(item => item.textContent))
      .toEqual(['Payroll notes', 'Interview notes', 'Old roadmap'])
    expect(group!.textContent).not.toContain('not used yet')
  })

  it('shows apart, as unlisted, the user’s own workspaces in a space that refuses them though their list of spaces has it', async () => {
    await render({ designMembers: [member(ADA, 'admin')] })

    expect([...unlistedGroup()!.querySelectorAll('button')].map(item => item.textContent))
      .toEqual(['Payroll notes', 'Brief', 'Interview notes', 'Old roadmap'])
  })

  it('reads the user’s records again with the listing', async () => {
    const { listGadgets } = await render()
    expect(listGadgets).toHaveBeenCalledTimes(1)

    await act(async () => { [...unlistedGroup()!.querySelectorAll('button')][0]!.click() })
    await act(async () => { seen.pane!.onPublicAccessChange?.(null) })
    await settle()

    expect(listGadgets).toHaveBeenCalledTimes(2)
  })

  it('reads every one of the user’s spaces again with the listing', async () => {
    const designListing = [DESIGN_LISTING[1]!]
    await render({ designListing })
    expect([...unlistedGroup()!.querySelectorAll('button')].map(item => item.textContent))
      .toEqual(['Payroll notes', 'Brief', 'Interview notes', 'Old roadmap'])

    // Brief comes to be listed by Design after a change made from its preview.
    designListing.unshift(DESIGN_LISTING[0]!)
    await act(async () => { [...unlistedGroup()!.querySelectorAll('button')][1]!.click() })
    await act(async () => { seen.pane!.onPublicAccessChange?.(null) })
    await settle()

    expect([...unlistedGroup()!.querySelectorAll('button')].map(item => item.textContent))
      .toEqual(['Payroll notes', 'Interview notes', 'Old roadmap'])
  })

  it('previews an unlisted workspace, with no place in the space', async () => {
    await render()

    const item = [...unlistedGroup()!.querySelectorAll('button')][0]!
    await act(async () => { item.click() })

    expect(document.body.querySelector<HTMLElement>('[data-preview]')?.dataset.preview).toBe('w-secret')
    expect(seen.pane?.place).toBeUndefined()
    expect(item.getAttribute('aria-current')).toBe('true')
  })
})
