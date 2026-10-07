// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, createRef, useEffect, useState, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRoute, type AnyRoute } from '@tanstack/react-router'
import type { RpcStub } from 'capnweb'
import {
  createOpenGadgetError,
  OPEN_GADGET_ERROR_CODES,
  type CollaboratorRole,
  type GadgetClient,
  type GadgetMetadata,
  type ObserverConfigCallback,
  type SpaceSyncJobInfo,
  type SpaceWorkspaceInfo,
  type WorkpieceId,
  type WorkpieceSummary,
  type WorkpiecesSubscriber,
} from '@gadgets/workshop-shared/api'
import type GadgetUIComponent from '../../../GadgetUI'
import type ShareModalComponent from '../../../ShareModal'
import {
  ME,
  button,
  click,
  fakeApi,
  hasButton,
  mountRouted,
  person,
  settle,
  unmountAll,
} from '../spacesTestUtils'
import {
  WorkspacePreviewPane,
  type WorkspacePreviewActions,
  type WorkspacePreviewPlace,
  type WorkspaceResync,
} from './WorkspacePreviewPane'

// What the pane hands the pieces it hosts, so the wiring can be asserted.
const seen = vi.hoisted(() => ({
  gadgetUi: null as ComponentProps<typeof GadgetUIComponent> | null,
  // How many times the gadget host mounted: a tab switch must remount it, not repoint it.
  gadgetUiMounts: 0,
  shareModal: null as ComponentProps<typeof ShareModalComponent> | null,
}))

// The gadget host opens an iframe and an RPC session; record what it was asked to show instead.
vi.mock('../../../GadgetUI', () => ({
  default: (props: ComponentProps<typeof GadgetUIComponent>) => {
    seen.gadgetUi = props
    useEffect(() => { seen.gadgetUiMounts += 1 }, [])
    return <div data-gadget-ui />
  },
}))
// The Share dialog has its own tests; the pane only opens it.
vi.mock('../../../ShareModal', () => ({
  default: (props: ComponentProps<typeof ShareModalComponent>) => {
    seen.shareModal = props
    return <div data-share-modal />
  },
}))

// jsdom implements neither ResizeObserver nor scrollIntoView; the tab strip's active indicator
// watches its tabs with one and reveals the clicked tab with the other.
vi.stubGlobal('ResizeObserver', class {
  observe() {}
  unobserve() {}
  disconnect() {}
})
Element.prototype.scrollIntoView ??= () => {}

const ADA = person('ada@example.com', 'Ada')
const DAY = new Date('2026-09-01T00:00:00Z')

const entry = (id: string, title: string, extra: Partial<SpaceWorkspaceInfo> = {}): SpaceWorkspaceInfo =>
  ({ id, title, owner: ADA, created: DAY, ...extra })

// Design's tree: Handbook > Onboarding > Checklist, with Onboarding not published.
const HANDBOOK = entry('w-handbook', 'Handbook', { slug: 'handbook', published: 'use' })
const ONBOARDING = entry('w-onboarding', 'Onboarding', { parentId: 'w-handbook' })
const CHECKLIST = entry('w-checklist', 'Checklist', {
  parentId: 'w-onboarding',
  slug: 'checklist',
  published: 'use',
  hiddenBy: 'w-onboarding',
})
const PLACE: WorkspacePreviewPlace = {
  space: { key: 'design', name: 'Design' },
  listing: [HANDBOOK, ONBOARDING, CHECKLIST],
}

const gadgetSummary = (id: number, title: string): WorkpieceSummary =>
  ({ id: id as WorkpieceId, type: 'gadget', title, commitId: 'a'.repeat(40) })

type FakeWorkspace = {
  metadata: GadgetMetadata
  gadgets: WorkpieceSummary[]
  /** Thrown by the metadata subscription in place of answering. */
  refusal?: Error
  /** Asks the viewer for connected accounts before refusing. */
  asksForAccounts?: boolean
}

type FakeGadgetStub = RpcStub<GadgetClient> & { dispose: ReturnType<typeof vi.fn<() => void>> }

type Open = {
  id: string
  dispose: ReturnType<typeof vi.fn<() => void>>
  gadgetStubs: Map<WorkpieceId, FakeGadgetStub>
}

// Workspaces by id, each opened as the test describes it; every open is recorded.
const fakeWorkspaces = (workspaces: Record<string, FakeWorkspace>) => {
  const opens: Open[] = []
  type OpenGadget = (id: string, shareKey: undefined, configureObservers: RpcStub<ObserverConfigCallback>) => unknown
  const openGadget = vi.fn<OpenGadget>((id, _shareKey, configureObservers) => {
    const workspace = workspaces[id]
    const open: Open = { id, dispose: vi.fn<() => void>(), gadgetStubs: new Map() }
    opens.push(open)
    return {
      subscribeToMetadata: async (callback: (metadata: GadgetMetadata) => void) => {
        if (workspace.asksForAccounts) {
          await Promise.resolve(configureObservers.configure([])).catch(() => {})
          throw new Error('To open this workspace you must connect an account for every service it uses.')
        }
        if (workspace.refusal) throw workspace.refusal
        callback(workspace.metadata)
        return { [Symbol.dispose]: () => {} }
      },
      subscribeToWorkpieces: async (subscriber: WorkpiecesSubscriber) => {
        for (const summary of workspace.gadgets) subscriber.entry(summary)
        subscriber.ready()
        return { [Symbol.dispose]: () => {} }
      },
      getGadget: (gadgetId: WorkpieceId) => {
        const dispose = vi.fn<() => void>()
        const stub = { gadgetId, dispose, [Symbol.dispose]: dispose } as unknown as FakeGadgetStub
        open.gadgetStubs.set(gadgetId, stub)
        return stub
      },
      [Symbol.dispose]: open.dispose,
    }
  })
  return { openGadget, opens }
}

const WORKSPACES: Record<string, FakeWorkspace> = {
  'w-checklist': {
    metadata: { id: 'w-checklist', title: 'Checklist', role: 'build', defaultGadgetId: 5 },
    gadgets: [gadgetSummary(3, 'Tasks'), gadgetSummary(5, 'Checklist')],
  },
  'w-handbook': {
    metadata: { id: 'w-handbook', title: 'Handbook', owner: ADA, role: 'use' },
    gadgets: [gadgetSummary(1, 'Handbook')],
  },
  'w-empty': {
    metadata: { id: 'w-empty', title: 'Empty', role: 'build' },
    gadgets: [],
  },
}

type PaneProps = ComponentProps<typeof WorkspacePreviewPane>

// The pane on a page whose props the test changes, as a tree's selection would.
const show = vi.hoisted(() => ({ set: null as ((props: PaneProps) => void) | null }))

const render = async (
  props: PaneProps,
  workspaces: Record<string, FakeWorkspace> = WORKSPACES,
  methods: Parameters<typeof fakeApi>[0] = {},
) => {
  const fake = fakeWorkspaces(workspaces)
  const Host = () => {
    const [current, setCurrent] = useState(props)
    useEffect(() => { show.set = setCurrent }, [])
    return <WorkspacePreviewPane {...current} />
  }
  const mounted = await mountRouted(fakeApi({ openGadget: fake.openGadget, ...methods }), {
    at: '/workspaces',
    pages: (root: AnyRoute) => [createRoute({ getParentRoute: () => root, path: '/workspaces', component: Host })],
  })
  return { ...mounted, ...fake }
}

const showProps = async (props: PaneProps) => {
  await act(async () => show.set!(props))
  await settle()
}

const pane = () => document.body.querySelector('section')!
const tabs = () => [...document.body.querySelectorAll<HTMLElement>('[role="tab"]')]
const link = (text: string) =>
  [...document.body.querySelectorAll('a')].find(anchor => anchor.textContent?.trim() === text)

const CHECKLIST_PROPS: PaneProps = { workspace: CHECKLIST, place: PLACE, actions: {} }

const resyncJob = (status: SpaceSyncJobInfo['status'], done = 0): SpaceSyncJobInfo => ({
  jobId: 'j-resync',
  accountId: 7,
  vendorId: 'docs',
  spaceKey: 'design',
  blueprintId: 'document',
  publication: 'use',
  status,
  progress: { done, total: 1, warnings: [] },
  created: new Date('2026-10-01T00:00:00Z'),
  ...(status !== 'running' && { finished: new Date('2026-10-01T00:01:00Z') }),
})

// A re-sync offered by a caller for whom a sync into the space is running when `syncRunning`.
const resyncFor = (syncRunning = false) => ({
  sourceName: 'Docs Hub',
  syncRunning,
  onStarted: vi.fn<(job: SpaceSyncJobInfo) => void>(),
}) satisfies WorkspaceResync

const openDialog = () => document.body.querySelector('[role="dialog"]')
const syncProgress = () => document.body.querySelector('section[aria-label^="Sync from"]')

describe('WorkspacePreviewPane', () => {
  beforeEach(() => {
    seen.gadgetUi = null
    seen.gadgetUiMounts = 0
    seen.shareModal = null
  })

  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('shows the workspace’s place in the space, its title and its default gadget, with no chat or editor', async () => {
    const { opens } = await render(CHECKLIST_PROPS)

    expect(pane().getAttribute('aria-label')).toBe('Preview of Checklist')
    expect(pane().querySelector('h2')?.textContent).toBe('Checklist')
    const trail = pane().querySelector('nav[aria-label="Breadcrumb"]')!
    expect([...trail.querySelectorAll('li')].map(item => item.textContent)).toEqual(['Design', 'Handbook', 'Onboarding', 'Checklist'])
    expect(link('Design')?.getAttribute('href')).toBe('/spaces/design')
    expect(link('Handbook')?.getAttribute('href')).toBe('/spaces/design/handbook')
    // An entry with no address yet is reached by its id.
    expect(link('Onboarding')?.getAttribute('href')).toBe('/workspace/w-onboarding')
    expect(trail.querySelector('[aria-current]')?.textContent).toBe('Checklist')
    expect(link('Open')?.getAttribute('href')).toBe('/spaces/design/checklist')

    expect(seen.gadgetUi?.gadget).toBe(opens[0].gadgetStubs.get(5))
    expect(seen.gadgetUi?.chatId).toBeUndefined()
    expect(seen.gadgetUi?.onConsoleLog).toBeUndefined()
    expect(document.body.textContent).not.toContain('chat')
  })

  it('gives the caller its region, which can take the focus', async () => {
    const region = createRef<HTMLElement>()
    await render({ ...CHECKLIST_PROPS, ref: region })

    expect(region.current).toBe(pane())
    act(() => region.current?.focus())
    expect(document.activeElement).toBe(pane())
  })

  it('says which workspace above keeps a published one from being visible', async () => {
    await render(CHECKLIST_PROPS)

    expect(pane().textContent).toContain('Not visible to others until “Onboarding” is published')
  })

  it('says a workspace above keeps it from being visible when the listing does not hold that one', async () => {
    await render({ ...CHECKLIST_PROPS, place: { ...PLACE, listing: [HANDBOOK, CHECKLIST] } })

    expect(pane().textContent).toContain('Not visible to others until a workspace above it is published')
  })

  it('offers the other gadgets as tabs, remounting the host and disposing the stub it leaves', async () => {
    const { opens } = await render(CHECKLIST_PROPS)

    expect(tabs().map(tab => tab.textContent)).toEqual(['Checklist', 'Tasks'])
    expect(tabs()[0].getAttribute('aria-selected')).toBe('true')
    const mountsBefore = seen.gadgetUiMounts

    await click(tabs()[1])
    await settle()
    expect(seen.gadgetUi?.gadget).toBe(opens[0].gadgetStubs.get(3))
    expect(seen.gadgetUiMounts).toBe(mountsBefore + 1)
    expect(opens[0].gadgetStubs.get(5)!.dispose).toHaveBeenCalledTimes(1)
  })

  it('starts afresh for another workspace, letting go of everything the last one held', async () => {
    const { opens } = await render(CHECKLIST_PROPS)
    await click(tabs()[1])
    await settle()

    await showProps({ workspace: HANDBOOK, place: PLACE, actions: {} })
    expect(opens.map(open => open.id)).toEqual(['w-checklist', 'w-handbook'])
    expect(opens[0].dispose).toHaveBeenCalledTimes(1)
    expect(opens[0].gadgetStubs.get(3)!.dispose).toHaveBeenCalledTimes(1)
    expect(pane().querySelector('h2')?.textContent).toBe('Handbook')
    expect(tabs()).toEqual([])
    expect(seen.gadgetUi?.gadget).toBe(opens[1].gadgetStubs.get(1))
  })

  it('lets go of the workspace when it unmounts', async () => {
    const { opens, unmount } = await render(CHECKLIST_PROPS)
    await unmount()

    expect(opens[0].dispose).toHaveBeenCalledTimes(1)
    expect(opens[0].gadgetStubs.get(5)!.dispose).toHaveBeenCalledTimes(1)
  })

  it('offers the actions the caller allows, and calls them', async () => {
    const actions: Required<WorkspacePreviewActions> = {
      onNewChild: vi.fn<() => void>(),
      onMove: vi.fn<() => void>(),
      onAddressChange: vi.fn<() => void>(),
    }
    await render({ ...CHECKLIST_PROPS, actions })

    await click(button('New child workspace'))
    await click(button('Move…'))
    await click(button('Change address'))
    expect(actions.onNewChild).toHaveBeenCalledTimes(1)
    expect(actions.onMove).toHaveBeenCalledTimes(1)
    expect(actions.onAddressChange).toHaveBeenCalledTimes(1)
  })

  it('offers no action the caller withholds, and no Share to a viewer who may only use the workspace', async () => {
    await render({ workspace: HANDBOOK, place: PLACE, actions: {} })

    for (const label of ['New child workspace', 'Move…', 'Change address', 'Share']) {
      expect(hasButton(label)).toBe(false)
    }
    expect(link('Open')?.getAttribute('href')).toBe('/spaces/design/handbook')
  })

  it('opens the Share dialog on the previewed workspace, passing the publication change on', async () => {
    const onPublicAccessChange = vi.fn<(role: CollaboratorRole | null) => void>()
    await render({ ...CHECKLIST_PROPS, onPublicAccessChange })

    await click(button('Share'))
    expect(seen.shareModal?.metadata.id).toBe('w-checklist')
    expect(seen.shareModal?.currentUser).toEqual(ME)
    seen.shareModal!.onPublicAccessChange!('use')
    expect(onPublicAccessChange).toHaveBeenCalledWith('use')
  })

  it('says so when the workspace has no gadgets', async () => {
    await render({ workspace: entry('w-empty', 'Empty'), place: undefined, actions: {} })

    expect(pane().textContent).toContain('This workspace has no gadgets yet.')
    expect(seen.gadgetUi).toBeNull()
  })

  it('shows a workspace no space lists without a trail, opening at its id', async () => {
    await render({ workspace: entry('w-empty', 'Empty'), place: undefined, actions: {} })

    expect(pane().querySelector('nav[aria-label="Breadcrumb"]')).toBeNull()
    expect(link('Open')?.getAttribute('href')).toBe('/workspace/w-empty')
  })

  it('sends a workspace that needs connected accounts chosen to the workspace itself', async () => {
    await render(CHECKLIST_PROPS, { 'w-checklist': { ...WORKSPACES['w-checklist'], asksForAccounts: true } })

    const status = pane().querySelector('[role="status"]')
    expect(status?.textContent).toContain('Open the workspace to finish setting it up')
    expect(link('Open the workspace')?.getAttribute('href')).toBe('/spaces/design/checklist')
    expect(hasButton('Try again')).toBe(false)
    expect(seen.gadgetUi).toBeNull()
  })

  it('tells a visitor a workspace is not visible yet without naming the one that hides it', async () => {
    const refusal = createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceNotVisible)
    await render(
      { workspace: CHECKLIST, place: { ...PLACE, listing: [CHECKLIST] }, actions: {} },
      { 'w-checklist': { ...WORKSPACES['w-checklist'], refusal } },
    )

    const status = pane().querySelector('[role="status"]')!
    expect(status.textContent).toContain('This workspace isn’t visible yet')
    expect(status.textContent).not.toContain('Onboarding')
    expect(seen.gadgetUi).toBeNull()
    // The focus stays where the viewer is, rather than moving to the notice.
    expect(document.activeElement).toBe(document.body)
  })

  it('tells a viewer without access so, and opens the workspace again when asked', async () => {
    const workspaces: Record<string, FakeWorkspace> = {
      'w-checklist': {
        ...WORKSPACES['w-checklist'],
        refusal: createOpenGadgetError(OPEN_GADGET_ERROR_CODES.workspaceAccessDenied),
      },
    }
    const { opens } = await render(CHECKLIST_PROPS, workspaces)
    expect(pane().querySelector('[role="status"]')?.textContent).toContain('You don’t have access to this workspace')

    delete workspaces['w-checklist'].refusal
    await click(button('Try again'))
    await settle()
    expect(opens).toHaveLength(2)
    expect(opens[0].dispose).toHaveBeenCalledTimes(1)
    expect(seen.gadgetUi?.gadget).toBe(opens[1].gadgetStubs.get(5))
  })
  describe('re-syncing a workspace from its source', () => {

    it('is not offered without a re-sync from the caller', async () => {
      await render(CHECKLIST_PROPS)

      expect(hasButton('Re-sync from source')).toBe(false)
    })

    it('asks for confirmation, saying what is replaced, before re-syncing', async () => {
      const resyncWorkspace = vi.fn<(id: string) => Promise<SpaceSyncJobInfo>>(async () => resyncJob('running'))
      const resync = resyncFor()
      await render({ ...CHECKLIST_PROPS, resync }, WORKSPACES, { resyncWorkspace })

      await click(button('Re-sync from source'))
      expect(openDialog()?.textContent).toContain('Re-sync “Checklist” from Docs Hub?')
      expect(openDialog()?.textContent).toContain('all of its comments will be replaced from Docs Hub')
      expect(resyncWorkspace).not.toHaveBeenCalled()

      await click(button('Replace from source'))
      await settle()
      expect(resyncWorkspace).toHaveBeenCalledWith('w-checklist')
      expect(resync.onStarted).toHaveBeenCalledWith(resyncJob('running'))
      expect(openDialog()).toBeNull()
    })

    it('makes no call when the confirmation is cancelled', async () => {
      const resyncWorkspace = vi.fn<(id: string) => Promise<SpaceSyncJobInfo>>(async () => resyncJob('running'))
      await render({ ...CHECKLIST_PROPS, resync: resyncFor() }, WORKSPACES, { resyncWorkspace })

      await click(button('Re-sync from source'))
      await click(button('Cancel'))
      await settle()

      expect(openDialog()).toBeNull()
      expect(resyncWorkspace).not.toHaveBeenCalled()
    })

    it('leaves the re-sync’s progress to the caller, which shows it with the space’s other syncs', async () => {
      const resyncWorkspace = vi.fn<(id: string) => Promise<SpaceSyncJobInfo>>(async () => resyncJob('running'))
      const resync = resyncFor()
      await render({ ...CHECKLIST_PROPS, resync }, WORKSPACES, { resyncWorkspace })
      await click(button('Re-sync from source'))
      await click(button('Replace from source'))
      await settle()

      expect(resync.onStarted).toHaveBeenCalledWith(resyncJob('running'))
      expect(syncProgress()).toBeNull()
    })

    it('cannot be confirmed while a sync into the space is running', async () => {
      const resyncWorkspace = vi.fn<(id: string) => Promise<SpaceSyncJobInfo>>()
      await render(
        { ...CHECKLIST_PROPS, resync: resyncFor(true) },
        WORKSPACES,
        { resyncWorkspace },
      )

      await click(button('Re-sync from source'))

      expect(button('Replace from source').disabled).toBe(true)
      expect(openDialog()?.textContent).toContain('A sync into this space is already running.')
    })
  })

  describe('once a sync into the space has ended', () => {
    it('opens the preview again, to show what the source replaced', async () => {
      const { opens } = await render({ ...CHECKLIST_PROPS, syncEndedKey: '' })
      expect(opens).toHaveLength(1)

      await showProps({ ...CHECKLIST_PROPS, syncEndedKey: 'j1' })
      expect(opens).toHaveLength(2)
      expect(opens[0].dispose).toHaveBeenCalledTimes(1)
      expect(seen.gadgetUi?.gadget).toBe(opens[1].gadgetStubs.get(5))

      await showProps({ ...CHECKLIST_PROPS, syncEndedKey: 'j1' })
      expect(opens).toHaveLength(2)
    })

    it('opens it again also for a preview shown afresh while the sync ran', async () => {
      const { opens } = await render({ ...CHECKLIST_PROPS, syncEndedKey: '' })
      await showProps({ workspace: HANDBOOK, place: PLACE, actions: {}, syncEndedKey: '' })
      await showProps({ ...CHECKLIST_PROPS, syncEndedKey: '' })
      expect(opens).toHaveLength(3)

      await showProps({ ...CHECKLIST_PROPS, syncEndedKey: 'j1' })
      expect(opens).toHaveLength(4)
    })
  })
})
