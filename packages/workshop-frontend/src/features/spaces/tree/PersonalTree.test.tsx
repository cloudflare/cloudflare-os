// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoute, type AnyRoute } from '@tanstack/react-router'
import type {
  ConnectedAccountsSubscriber,
  GadgetMetadataWithTimestamps,
  SpaceSyncJobInfo,
} from '@gadgets/workshop-shared/api'
import type { WorkspacePreviewPane as WorkspacePreviewPaneComponent } from '../preview/WorkspacePreviewPane'
import type { StartSpaceSyncDialog as StartSpaceSyncDialogComponent } from '../sync/StartSpaceSyncDialog'
import {
  ME,
  button,
  click,
  fakeApi,
  hasButton,
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
  syncDialog: null as ComponentProps<typeof StartSpaceSyncDialogComponent> | null,
}))

// The preview has its own tests; here it shows which workspace it was given.
vi.mock('../preview/WorkspacePreviewPane', () => ({
  WorkspacePreviewPane: (props: ComponentProps<typeof WorkspacePreviewPaneComponent>) => {
    seen.pane = props
    return <section data-preview={props.workspace.id} />
  },
}))

// The sync dialog has its own tests; here it shows what it was opened with.
vi.mock('../sync/StartSpaceSyncDialog', () => ({
  StartSpaceSyncDialog: (props: ComponentProps<typeof StartSpaceSyncDialogComponent>) => {
    seen.syncDialog = props
    return <div data-sync-dialog={props.space.key} />
  },
}))

afterEach(() => {
  unmountAll()
  sessionStorage.clear()
  seen.pane = null
  seen.syncDialog = null
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

const SYNC = { blueprintId: 'document', importMethods: ['importSnapshot'] }

// The user's connected accounts, given to the subscription as the backend replays them: one
// that can sync into a space unless `syncs` is false.
const accountsSubscription = ({ syncs = true } = {}) => (subscriber: ConnectedAccountsSubscriber) => {
  subscriber.add(7, { displayName: 'Work docs', avatar: { url: 'https://docs.example.com/a' }, ...(syncs && { providesSpaceSync: SYNC }) },
    { displayName: 'Docs Hub', url: 'https://docs.example.com/' }, [], true, 'docs')
  subscriber.ready()
  return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), { [Symbol.dispose]() {} })
}

const syncJob = (jobId: string, status: SpaceSyncJobInfo['status']): SpaceSyncJobInfo => ({
  jobId,
  accountId: 7,
  vendorId: 'docs',
  spaceKey: PERSONAL.key,
  blueprintId: 'document',
  publication: 'use',
  status,
  progress: { done: 0, warnings: [] },
  created: DAY,
  ...(status !== 'running' && { finished: DAY }),
})

// `designMembers` are Design's members as the space has them, which the user's list of spaces
// may not have caught up with; `designListing` is what Design lists at each read. `syncs` says
// whether the user has an account that can sync into a space, and `jobs` are their syncs into
// the personal space at each read.
const render = async ({
  designMembers = [member(ME, 'build')],
  designListing = DESIGN_LISTING,
  syncs = false,
  jobs = () => [] as SpaceSyncJobInfo[],
  at = '/workspaces',
} = {}) => {
  const listGadgets = vi.fn<() => Promise<GadgetMetadataWithTimestamps[]>>(async () => RECORDS)
  const listSpaceSyncJobs = vi.fn<(spaceKey?: string) => Promise<SpaceSyncJobInfo[]>>(async () => jobs())
  const personal = fakeSpace(PERSONAL, [member(ME, 'admin')], LISTING)
  await mountRouted(fakeApi({
    listSpaces: async () => [PERSONAL, DESIGN],
    openSpace: (key: string) => (key === 'design' ? fakeSpace(DESIGN, designMembers, designListing) : personal).stub,
    listGadgets,
    listSpaceSyncJobs,
    subscribeConnectedAccounts: accountsSubscription({ syncs }),
  }), {
    at,
    pages: (root: AnyRoute) => [createRoute({ getParentRoute: () => root, path: '/workspaces', component: Page })],
  })
  await settle()
  return { listGadgets, listSpaceSyncJobs, personal }
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

const SYNC_BUTTON = 'Sync from Docs Hub into Personal'
const progress = () => document.body.querySelector('section[aria-label^="Sync from Docs Hub"]')
// A running sync is read again when the page is shown again.
const showPageAgain = async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
  await settle()
}

describe('PersonalTree, syncing into the personal space', () => {
  it('is offered above the tree with an account that can sync into a space', async () => {
    const { listSpaceSyncJobs } = await render({ syncs: true })

    expect(hasButton(SYNC_BUTTON)).toBe(true)
    expect(button(SYNC_BUTTON).textContent).toBe('Sync from Docs Hub')
    // Read only once the list of spaces has the personal space.
    expect(listSpaceSyncJobs.mock.calls).toEqual([[PERSONAL.key]])
  })

  it('is not offered without such an account', async () => {
    const { listSpaceSyncJobs } = await render({ syncs: false, jobs: () => [syncJob('j1', 'running')] })

    expect(hasButton(SYNC_BUTTON)).toBe(false)
    // A job is never shown, or read, without an account that could have started one.
    expect(listSpaceSyncJobs).not.toHaveBeenCalled()
    expect(progress()).toBeNull()
  })

  it('opens the dialog for the personal space, under the entry selected in the tree', async () => {
    await render({ syncs: true, at: '/workspaces?selected=w-trip' })

    await click(button(SYNC_BUTTON))

    expect(seen.syncDialog?.space).toEqual({ key: PERSONAL.key, name: 'Personal' })
    expect(seen.syncDialog?.defaultParentId).toBe('w-trip')
    expect(seen.syncDialog?.listing.map(entry => entry.id)).toEqual(['w-plans', 'w-trip'])
    expect(seen.syncDialog?.syncRunning).toBe(false)
  })

  it('follows a sync once it has started, showing its progress', async () => {
    let jobs: SpaceSyncJobInfo[] = []
    const { listSpaceSyncJobs } = await render({ syncs: true, jobs: () => jobs })
    const readsOfPersonal = () => listSpaceSyncJobs.mock.calls.filter(([key]) => key === PERSONAL.key).length
    expect(readsOfPersonal()).toBe(1)
    await click(button(SYNC_BUTTON))

    jobs = [syncJob('j1', 'running')]
    await act(async () => { seen.syncDialog!.onStarted(syncJob('j1', 'running')) })
    await settle()

    expect(document.body.querySelector('[data-sync-dialog]')).toBeNull()
    expect(readsOfPersonal()).toBe(2)
    expect(progress()?.textContent).toContain('Running')
  })

  it('tells the dialog a sync is running, which the server would refuse a second of', async () => {
    await render({ syncs: true, jobs: () => [syncJob('j1', 'running')] })

    await click(button(SYNC_BUTTON))

    expect(seen.syncDialog?.syncRunning).toBe(true)
  })

  it('reads the personal space’s listing again once a sync has ended, and keeps how it ended in view', async () => {
    let jobs = [syncJob('j1', 'running')]
    const { personal } = await render({ syncs: true, jobs: () => jobs })
    const reads = personal.listWorkspaces.mock.calls.length

    jobs = [syncJob('j1', 'done')]
    await showPageAgain()

    expect(personal.listWorkspaces.mock.calls.length).toBe(reads + 1)
    expect(progress()?.textContent).toContain('Done')
  })

  it('shows no sync that ended long before it was opened', async () => {
    await render({ syncs: true, jobs: () => [syncJob('j1', 'done')] })

    expect(progress()).toBeNull()
  })

  it('shows how a sync that ended shortly before it was opened ended, until it is dismissed', async () => {
    const ended = { ...syncJob('j1', 'failed'), finished: new Date() }
    await render({ syncs: true, jobs: () => [ended] })
    expect(progress()?.textContent).toContain('Failed')

    await click(button('Dismiss'))
    expect(progress()).toBeNull()
  })
})
