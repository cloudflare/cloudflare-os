// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoute, type AnyRoute } from '@tanstack/react-router'
import type { RpcStub } from 'capnweb'
import type {
  BlueprintPublicInfo,
  ConnectedAccountsSubscriber,
  GadgetMetadata,
  GadgetMetadataWithTimestamps,
  OutputFormatOffer,
  PublicApi,
  SpaceMemberRole,
  SpaceSyncJobInfo,
  SpaceWorkspaceInfo,
} from '@gadgets/workshop-shared/api'
import { RpcContext } from '../../../RpcContext'
import type ShareModalComponent from '../../../ShareModal'
import type { WorkspacePreviewPane as WorkspacePreviewPaneComponent } from '../preview/WorkspacePreviewPane'
import {
  ME,
  button,
  chooseOption,
  click,
  fakeApi,
  fakeSpace,
  listingEntry,
  member,
  mountRouted,
  person,
  personalSpace,
  pressEscape,
  settle,
  teamSpace,
  unmountAll,
} from '../spacesTestUtils'
import { useSpaceSync } from '../sync/useSpaceSync'
import { useSpaceListings } from '../useSpaceListings'
import { SpaceTreeLayout } from './SpaceTreeLayout'

const seen = vi.hoisted(() => ({
  pane: null as ComponentProps<typeof WorkspacePreviewPaneComponent> | null,
  shareModal: null as ComponentProps<typeof ShareModalComponent> | null,
}))

// The preview has its own tests; here it shows which workspace it was given.
vi.mock('../preview/WorkspacePreviewPane', () => ({
  WorkspacePreviewPane: (props: ComponentProps<typeof WorkspacePreviewPaneComponent>) => {
    seen.pane = props
    return <section data-preview={props.workspace.id} />
  },
}))
// The Share dialog has its own tests; here it is only opened.
vi.mock('../../../ShareModal', () => ({
  default: (props: ComponentProps<typeof ShareModalComponent>) => {
    seen.shareModal = props
    return <div data-share-modal />
  },
}))

afterEach(() => {
  unmountAll()
  seen.pane = null
  seen.shareModal = null
  vi.restoreAllMocks()
})

const ADA = person('ada@example.com', 'Ada')

// Design's tree, in pre-order:
//   Handbook        (mine, published)
//   └─ Onboarding   (Ada's)
//      └─ Checklist (mine, published, hidden by Onboarding)
//   Budget          (Ada's)
const LISTING: SpaceWorkspaceInfo[] = [
  listingEntry('w-handbook', 'Handbook', ME, { position: 0, published: 'use', slug: 'handbook' }),
  listingEntry('w-onboarding', 'Onboarding', ADA, { parentId: 'w-handbook', position: 0 }),
  listingEntry('w-checklist', 'Checklist', ME, {
    parentId: 'w-onboarding',
    position: 0,
    published: 'use',
    hiddenBy: 'w-onboarding',
  }),
  listingEntry('w-budget', 'Budget', ADA, { position: 1 }),
]

// Design as a visitor finds it: Ada's Handbook is the one entry everyone signed in can see.
const VISITED_LISTING = LISTING.map(entry => (entry.id === 'w-handbook' ? { ...entry, owner: ADA } : entry))

const NOTE: OutputFormatOffer = {
  blueprintId: 'bp-note',
  output: { id: 'note', noun: 'Note', plural: 'Notes', icon: 'fileText' },
  description: 'A note.',
  requiresSetup: false,
}

const NOTE_BLUEPRINT: BlueprintPublicInfo = {
  id: 'bp-note',
  metadata: {
    title: 'Note',
    description: '',
    author: ME,
    created: new Date('2026-09-01T00:00:00Z'),
    version: 1,
    lastUpdated: new Date('2026-09-01T00:00:00Z'),
    bindings: {},
    publication: 'use',
  },
}

/**
 * The layout for Design, at /spaces/design, for `ME` in `role` (undefined for a visitor) with
 * `records` as their own, over `listing` as the space gives it to them, read through the hook
 * the pages use.
 */
const render = async (
  role: SpaceMemberRole | undefined,
  {
    at = '/spaces/design',
    records = [] as GadgetMetadataWithTimestamps[],
    listing = LISTING,
  } = {},
) => {
  const space = fakeSpace(teamSpace('design', 'Design'), role ? [member(ME, role)] : [], listing)
  const overseerDispose = vi.fn<() => void>()
  const openGadget = vi.fn<(id: string) => unknown>((id) => ({
    getMetadata: async (): Promise<GadgetMetadata> => ({ id, title: 'Checklist', publicAccess: 'use' }),
    [Symbol.dispose]: overseerDispose,
  }))
  const newGadgetFromBlueprint = vi.fn<(id: string, bindings: object, options: object) => unknown>(() => ({
    getMetadata: async () => ({ id: 'w-new' }),
    [Symbol.dispose]: () => {},
  }))
  const reloads = vi.fn<() => void>()
  const publicApi = { getBlueprint: async () => NOTE_BLUEPRINT } as unknown as RpcStub<PublicApi>

  const Page = () => {
    const { listings, reload } = useSpaceListings(['design'])
    return (
      <RpcContext.Provider value={{ stub: publicApi, connectionLost: false }}>
        <SpaceTreeLayout
          space={{ key: 'design', kind: 'team', label: 'Design' }}
          role={role}
          listing={listings.design ?? { status: 'loading' }}
          onListingReload={() => {
            reloads()
            return reload('design')
          }}
        />
      </RpcContext.Provider>
    )
  }
  const mounted = await mountRouted(fakeApi({
    openSpace: () => space.stub,
    openGadget,
    newGadgetFromBlueprint,
    listOutputFormats: async () => [NOTE],
    listGadgets: async () => records,
  }), {
    at,
    pages: (root: AnyRoute) => [createRoute({ getParentRoute: () => root, path: '/spaces/$spaceKey', component: Page })],
  })
  await settle()
  return { ...mounted, space, openGadget, overseerDispose, newGadgetFromBlueprint, reloads }
}

const rowElements = () => [...document.body.querySelectorAll<HTMLElement>('[data-hierarchical-list-row]')]
const idOf = (row: HTMLElement) => row.closest<HTMLElement>('[data-hierarchical-list-item]')?.dataset.itemId
const row = (id: string) => {
  const found = rowElements().find(candidate => idOf(candidate) === id)
  if (!found) throw new Error(`No row for “${id}”`)
  return found
}
const titles = () => rowElements().map(candidate =>
  `${'  '.repeat(Number(candidate.dataset.depth))}${LISTING.find(entry => entry.id === idOf(candidate))?.title}`)

const previewed = () => document.body.querySelector<HTMLElement>('[data-preview]')?.dataset.preview

const select = (id: string) => act(async () => { row(id).click() })

const classes = (element: Element) => element.className.split(/\s+/)

const menuItems = async (id: string) => {
  await act(async () => {
    row(id).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  return [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

// The "More actions" button beside a row, which opens the row's menu.
const actionsButton = (id: string) => {
  const found = row(id).parentElement?.querySelector<HTMLButtonElement>(':scope > [data-hierarchical-list-row-actions]')
  if (!found) throw new Error(`No actions button for “${id}”`)
  return found
}

// Opens the row's menu from its "More actions" button, focusing the button as a press would.
const openActions = async (id: string) => {
  const trigger = actionsButton(id)
  await act(async () => {
    trigger.focus()
    trigger.click()
  })
  return [...document.body.querySelectorAll<HTMLElement>('[role="menuitem"]')]
}

const labels = (items: HTMLElement[]) => items.map(item => item.textContent)

// Chooses `label` from the menu the row's "More actions" button opens.
const chooseAction = async (id: string, label: string) => {
  const item = (await openActions(id)).find(candidate => candidate.textContent === label)
  if (!item) throw new Error(`No “${label}” in the menu of “${id}”`)
  await act(async () => { item.click() })
  await settle()
}

const dialogTitle = () => document.body.querySelector('[role="dialog"] h2')?.textContent

describe('SpaceTreeLayout', () => {
  it('names the tree and the region it is in apart, and asks for a selection until there is one', async () => {
    await render('build')

    expect(document.body.querySelector('aside')?.getAttribute('aria-label')).toBe('Browse workspaces')
    expect(document.body.querySelector('aside [data-hierarchical-list]')?.getAttribute('aria-label'))
      .toBe('Workspaces in Design')
    expect(titles()).toEqual(['Handbook', '  Onboarding', '    Checklist', 'Budget'])
    expect(previewed()).toBeUndefined()
    expect(document.body.textContent).toContain('Select a workspace to preview it here.')
  })

  it('previews the selected workspace in its place in the space, keeping the selection in the URL', async () => {
    const { router } = await render('build')

    await select('w-checklist')
    expect(previewed()).toBe('w-checklist')
    expect(seen.pane?.place?.space).toEqual({ key: 'design', name: 'Design' })
    expect(seen.pane?.place?.listing.map(entry => entry.id)).toContain('w-checklist')
    expect(router.state.location.search).toMatchObject({ selected: 'w-checklist' })

    await select('w-budget')
    expect(previewed()).toBe('w-budget')
    await act(async () => router.history.back())
    await settle()
    expect(previewed()).toBe('w-checklist')
  })

  it('opens the preview a link names', async () => {
    await render('build', { at: '/spaces/design?selected=w-handbook' })

    expect(previewed()).toBe('w-handbook')
  })

  it('gives every row a "More actions" button, opening what the space lets the member do with the entry', async () => {
    await render('build')

    expect(actionsButton('w-checklist').getAttribute('aria-label')).toBe('More actions for Checklist')
    expect(row('w-checklist').contains(actionsButton('w-checklist'))).toBe(false)
    expect(labels(await openActions('w-checklist')))
      .toEqual(['Open', 'New child workspace', 'Move…', 'Change address', 'Share'])
    await pressEscape()
    // Ada's: a member who is not an admin may add under it but neither move nor share it.
    expect(labels(await openActions('w-budget'))).toEqual(['Open', 'New child workspace'])
    await pressEscape()
    // The same menu as the row's own.
    expect(labels(await menuItems('w-budget'))).toEqual(['Open', 'New child workspace'])
  })

  it('offers Share on another’s entry only where the user’s own records say it was shared with them to build', async () => {
    await render('build', {
      records: [
        record('w-budget', 'Budget', { owner: ADA, role: 'build' }),
        record('w-onboarding', 'Onboarding', { owner: ADA, role: 'use' }),
      ],
    })

    expect(labels(await openActions('w-budget'))).toEqual(['Open', 'New child workspace', 'Share'])
    await pressEscape()
    expect(labels(await openActions('w-onboarding'))).toEqual(['Open', 'New child workspace'])
  })

  it('opens each dialog from the row’s menu, giving the focus back to its button as the dialog closes', async () => {
    await render('build')

    for (const [label, title] of [
      ['New child workspace', 'New child workspace'],
      ['Move…', 'Move “Checklist”'],
      ['Change address', 'Change address'],
    ]) {
      await chooseAction('w-checklist', label)
      expect(dialogTitle()).toBe(title)
      await pressEscape()
      await settle()
      expect(document.body.querySelector('[role="dialog"]')).toBeNull()
      expect(document.activeElement).toBe(actionsButton('w-checklist'))
    }
  })

  it('gives the focus back to the row when the dialog was opened from the row’s own menu', async () => {
    await render('build')

    row('w-checklist').focus()
    const move = (await menuItems('w-checklist')).find(item => item.textContent === 'Move…')!
    await act(async () => { move.click() })
    await settle()
    expect(dialogTitle()).toBe('Move “Checklist”')
    await pressEscape()
    await settle()

    expect(document.activeElement).toBe(row('w-checklist'))
  })

  it('moves a workspace from the dialog by its anchor, then reads the listing again', async () => {
    const { space, reloads } = await render('build')

    await chooseAction('w-checklist', 'Move…')
    await chooseOption('Parent', 'Top of the space')
    await chooseOption('Position', 'After Handbook')
    await click(button('Move'))
    await settle()

    expect(space.moveWorkspace).toHaveBeenCalledWith('w-checklist', null, 'w-budget')
    expect(reloads).toHaveBeenCalled()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(titles()).toEqual(['Handbook', '  Onboarding', 'Checklist', 'Budget'])
  })

  it('keeps the focus on an entry moved from its menu’s dialog to a new parent, and says where it went', async () => {
    await render('admin')

    row('w-onboarding').focus()
    const move = (await menuItems('w-onboarding')).find(item => item.textContent === 'Move…')!
    await act(async () => { move.click() })
    await chooseOption('Parent', 'Top of the space')
    await click(button('Move'))
    await settle()

    expect(titles()).toEqual(['Handbook', 'Budget', 'Onboarding', '  Checklist'])
    expect(document.activeElement).toBe(row('w-onboarding'))
    expect(document.body.querySelector('[role="status"].sr-only')?.textContent)
      .toBe('Onboarding moved to position 3 in Workspaces in Design.')
  })

  it('asks for no anchor when the dialog places the workspace last', async () => {
    const { space } = await render('admin')

    await chooseAction('w-handbook', 'Move…')
    await chooseOption('Position', 'After Budget')
    await click(button('Move'))
    await settle()

    expect(space.moveWorkspace).toHaveBeenCalledWith('w-handbook', null)
  })

  it('creates a child workspace under the entry, then reads the listing again and previews it', async () => {
    const { newGadgetFromBlueprint, reloads, router } = await render('build')

    await select('w-onboarding')
    await chooseAction('w-onboarding', 'New child workspace')
    await click(button('Create'))
    await settle()

    expect(newGadgetFromBlueprint).toHaveBeenCalledWith('bp-note', {}, {
      spaceKey: 'design',
      parentId: 'w-onboarding',
      publish: true,
    })
    expect(reloads).toHaveBeenCalled()
    expect(router.state.location.search).toMatchObject({ selected: 'w-new' })
    expect(previewed()).toBe('w-new')
    // The focus goes back to where the dialog was opened from.
    expect(document.activeElement).toBe(actionsButton('w-onboarding'))
  })

  it('reads the listing again until it shows a new workspace, which its space registers apart', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { space, reloads } = await render('build')
      const listed = space.listWorkspaces.getMockImplementation()!

      await chooseAction('w-onboarding', 'New child workspace')
      await click(button('Create'))
      await settle()
      const readsAfterCreating = reloads.mock.calls.length

      // Registered only after the read that followed the creation.
      space.listWorkspaces.mockImplementation(async () => [
        ...await listed(),
        listingEntry('w-new', 'New note', ME, { parentId: 'w-onboarding', position: 1 }),
      ])
      await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
      await settle()
      expect(reloads.mock.calls.length).toBe(readsAfterCreating + 1)
      expect(rowElements().map(idOf)).toContain('w-new')

      // Shown, it is read for no more.
      for (let second = 0; second < 5; second++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
        await settle()
      }
      expect(reloads.mock.calls.length).toBe(readsAfterCreating + 1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('stops reading the listing again for a new workspace it never shows', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { reloads } = await render('build')

      await chooseAction('w-onboarding', 'New child workspace')
      await click(button('Create'))
      await settle()
      const readsAfterCreating = reloads.mock.calls.length

      for (let second = 0; second < 10; second++) {
        await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
        await settle()
      }
      expect(reloads.mock.calls.length).toBe(readsAfterCreating + 5)
    } finally {
      vi.useRealTimers()
    }
  })

  it('shares the user’s own entry from the tree’s menu', async () => {
    const { openGadget, overseerDispose } = await render('build')

    await chooseAction('w-checklist', 'Share')

    expect(openGadget).toHaveBeenCalledWith('w-checklist')
    expect(seen.shareModal?.metadata.id).toBe('w-checklist')

    await act(async () => seen.shareModal!.onClose())
    expect(document.body.querySelector('[data-share-modal]')).toBeNull()
    expect(overseerDispose).toHaveBeenCalled()
  })

  it('lets the stacked layout grow with the page below md, so the preview is never cut off', async () => {
    await render('build', { at: '/spaces/design?selected=w-handbook' })

    // jsdom lays nothing out, so this reads the classes that decide it: a height is fixed, and
    // overflow clipped by it, only from md up.
    const layout = document.body.querySelector('aside')!.parentElement!
    expect(classes(layout)).not.toContain('h-full')
    expect(classes(layout)).toContain('md:h-full')
    const preview = document.body.querySelector('[data-preview]')!.parentElement!
    expect(classes(preview)).not.toContain('flex-1')
    expect(classes(preview)).toContain('md:flex-1')
  })

  it('gives a visitor a read-only tree, whose rows offer only to open the workspace', async () => {
    const { space, router } = await render(undefined, { listing: VISITED_LISTING })

    // The space shows a visitor only Handbook, the one entry everyone signed in can see.
    expect(titles()).toEqual(['Handbook'])
    expect(rowElements().some(candidate => candidate.draggable)).toBe(false)
    expect(labels(await menuItems('w-handbook'))).toEqual(['Open'])
    await pressEscape()
    expect(labels(await openActions('w-handbook'))).toEqual(['Open'])
    await pressEscape()

    await select('w-handbook')
    expect(previewed()).toBe('w-handbook')
    await chooseAction('w-handbook', 'Open')
    expect(router.state.location.pathname).toBe('/spaces/design/handbook')
    expect(space.moveWorkspace).not.toHaveBeenCalled()
  })

  it('offers a visitor Share on an entry shared with them to build', async () => {
    await render(undefined, {
      listing: VISITED_LISTING,
      records: [record('w-handbook', 'Handbook', { owner: ADA, role: 'build' })],
    })

    expect(labels(await openActions('w-handbook'))).toEqual(['Open', 'Share'])
  })
})

const DAY = new Date('2026-09-01T00:00:00Z')
const BUILDER: SpaceMemberRole = 'build'

const record = (id: string, title: string, fields: Partial<GadgetMetadataWithTimestamps> = {}) =>
  ({ id, title, created: DAY, lastActive: DAY, spaceKey: 'design', ...fields }) satisfies GadgetMetadataWithTimestamps

const syncJob = (jobId: string, status: SpaceSyncJobInfo['status']): SpaceSyncJobInfo => ({
  jobId,
  accountId: 7,
  vendorId: 'docs',
  spaceKey: 'design',
  blueprintId: 'document',
  publication: 'use',
  status,
  progress: { done: 0, warnings: [] },
  created: DAY,
})

// The user's connected accounts: 7 can sync into a space, 8 cannot.
const subscribeConnectedAccounts = (subscriber: ConnectedAccountsSubscriber) => {
  subscriber.add(7, { displayName: 'Work docs', avatar: { url: 'https://docs.example.com/a' },
    providesSpaceSync: { blueprintId: 'document', importMethods: ['importSnapshot'] } },
  { displayName: 'Docs Hub', url: 'https://docs.example.com/' }, [], true, 'docs')
  subscriber.add(8, { displayName: 'Tracker', avatar: { url: 'https://tracker.example.com/a' } },
    { displayName: 'Tracker', url: 'https://tracker.example.com/' }, [], true, 'tracker')
  subscriber.ready()
  return Object.assign(Promise.resolve({ [Symbol.dispose]() {} }), { [Symbol.dispose]() {} })
}

type SyncedSpace = { key: string; kind: 'team' | 'personal'; label: string }
const DESIGN: SyncedSpace = { key: 'design', kind: 'team', label: 'Design' }
const MINE: SyncedSpace = { key: personalSpace(ME, 'admin').key, kind: 'personal', label: 'Personal' }

// The space's tree for a builder, with the syncs into it the page follows.
const SyncingPage = ({ space }: { space: SyncedSpace }) => {
  const { listings, reload } = useSpaceListings([space.key])
  return (
    <SpaceTreeLayout
      space={space}
      role={BUILDER}
      listing={listings[space.key] ?? { status: 'loading' }}
      onListingReload={() => reload(space.key)}
      sync={useSpaceSync(space.key, true)}
    />
  )
}

// The space `synced` (Design unless given), for a builder whose records are `records`, with
// `jobs` as their syncs into it.
const renderSyncing = async (
  records: GadgetMetadataWithTimestamps[],
  jobs: () => SpaceSyncJobInfo[] = () => [],
  synced: SyncedSpace = DESIGN,
) => {
  const info = synced.kind === 'team' ? teamSpace(synced.key, synced.label) : personalSpace(ME, 'admin')
  const space = fakeSpace(info, [member(ME, synced.kind === 'team' ? BUILDER : 'admin')], LISTING)
  const listGadgets = vi.fn<() => Promise<GadgetMetadataWithTimestamps[]>>(async () => records)
  const listSpaceSyncJobs = vi.fn<(spaceKey?: string) => Promise<SpaceSyncJobInfo[]>>(async () => jobs())
  const resyncWorkspace = vi.fn<(id: string) => Promise<SpaceSyncJobInfo>>(async () => syncJob('j-resync', 'running'))
  await mountRouted(fakeApi({
    openSpace: () => space.stub,
    listGadgets,
    listSpaceSyncJobs,
    resyncWorkspace,
    subscribeConnectedAccounts,
  }), {
    at: `/spaces/${synced.key}`,
    pages: (root: AnyRoute) => [createRoute({
      getParentRoute: () => root,
      path: '/spaces/$spaceKey',
      component: () => <SyncingPage space={synced} />,
    })],
  })
  await settle()
  return { listGadgets, listSpaceSyncJobs, resyncWorkspace }
}

const RESYNC = 'Re-sync from source'

// Whether the row's menu offers a re-sync.
const offersResync = async (id: string) => {
  const offered = labels(await openActions(id)).includes(RESYNC)
  await pressEscape()
  return offered
}

describe('SpaceTreeLayout, for a space the user can sync into', () => {
  it('offers the owner of a workspace a sync created a re-sync, named by the account’s vendor', async () => {
    const { resyncWorkspace } = await renderSyncing([record('w-handbook', 'Handbook', { syncedFrom: { accountId: 7 } })])

    expect(labels(await openActions('w-handbook')))
      .toEqual(['Open', 'New child workspace', 'Move…', 'Change address', 'Share', RESYNC])
    await pressEscape()
    await chooseAction('w-handbook', RESYNC)
    expect(dialogTitle()).toBe('Re-sync “Handbook” from Docs Hub?')

    await click(button('Replace from source'))
    await settle()
    expect(resyncWorkspace).toHaveBeenCalledExactlyOnceWith('w-handbook')
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(actionsButton('w-handbook'))
  })

  it('offers no re-sync of a workspace no sync created, or synced by an account that can no longer sync', async () => {
    await renderSyncing([
      record('w-handbook', 'Handbook'),
      record('w-checklist', 'Checklist', { syncedFrom: { accountId: 8 } }),
    ])

    expect(await offersResync('w-handbook')).toBe(false)
    expect(await offersResync('w-checklist')).toBe(false)
  })

  it('offers no re-sync to anyone but the owner, nor of a workspace in another space', async () => {
    await renderSyncing([
      record('w-onboarding', 'Onboarding', { owner: ADA, syncedFrom: { accountId: 7 } }),
      record('w-checklist', 'Checklist', { spaceKey: 'platform', syncedFrom: { accountId: 7 } }),
    ])

    expect(await offersResync('w-onboarding')).toBe(false)
    expect(await offersResync('w-checklist')).toBe(false)
  })

  it('offers a re-sync in the personal space, whose records name no space', async () => {
    await renderSyncing([
      record('w-handbook', 'Handbook', { spaceKey: undefined, syncedFrom: { accountId: 7 } }),
      record('w-checklist', 'Checklist', { syncedFrom: { accountId: 7 } }),
    ], undefined, MINE)

    expect(await offersResync('w-handbook')).toBe(true)
    // A workspace of a team space's is re-synced there.
    expect(await offersResync('w-checklist')).toBe(false)
  })

  it('offers no re-sync in a team space of a workspace whose record puts it in the personal space', async () => {
    await renderSyncing([record('w-handbook', 'Handbook', { spaceKey: undefined, syncedFrom: { accountId: 7 } })])

    expect(await offersResync('w-handbook')).toBe(false)
  })

  it('tells the preview a sync it follows has ended, and the re-sync whether one is running', async () => {
    let jobs = [syncJob('j1', 'running')]
    await renderSyncing([record('w-handbook', 'Handbook', { syncedFrom: { accountId: 7 } })], () => jobs)
    await select('w-handbook')
    expect(seen.pane?.syncEndedKey).toBe('')
    await chooseAction('w-handbook', RESYNC)
    expect(button('Replace from source').disabled).toBe(true)

    jobs = [{ ...syncJob('j1', 'done'), finished: DAY }]
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await settle()

    expect(seen.pane?.syncEndedKey).toBe('j1')
    expect(button('Replace from source').disabled).toBe(false)
  })

  it('keeps the re-sync dialog up, and gives the focus back as it closes, when the records read again no longer offer it', async () => {
    const ended = (jobId: string) => ({ ...syncJob(jobId, 'done'), finished: DAY })
    let jobs = [syncJob('j2', 'running'), syncJob('j1', 'running')]
    let records = [record('w-handbook', 'Handbook', { syncedFrom: { accountId: 7 } })]
    const { listGadgets } = await renderSyncing([], () => jobs)
    listGadgets.mockImplementation(async () => records)
    // The records are read again as each followed sync ends: the first read had nothing.
    jobs = [syncJob('j2', 'running'), ended('j1')]
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await settle()
    await chooseAction('w-handbook', RESYNC)
    expect(dialogTitle()).toBe('Re-sync “Handbook” from Docs Hub?')

    records = []
    jobs = [ended('j2'), ended('j1')]
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await settle()
    expect(listGadgets).toHaveBeenCalledTimes(3)
    expect(dialogTitle()).toBe('Re-sync “Handbook” from Docs Hub?')

    await click(button('Cancel'))
    await settle()
    expect(document.body.querySelector('[role="dialog"]')).toBeNull()
    expect(document.activeElement).toBe(actionsButton('w-handbook'))
  })

  it('reads the user’s records again once a sync it follows has ended', async () => {
    let jobs = [syncJob('j1', 'running')]
    const { listGadgets } = await renderSyncing([], () => jobs)
    expect(listGadgets).toHaveBeenCalledTimes(1)

    // The running sync is read again when the page is shown again, and has ended by then.
    jobs = [{ ...syncJob('j1', 'done'), finished: DAY }]
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
    await act(async () => { document.dispatchEvent(new Event('visibilitychange')) })
    await settle()

    expect(listGadgets).toHaveBeenCalledTimes(2)
  })
})
