// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { BlueprintPublicInfo, PublicApi, SpaceSyncJobInfo, SpaceWorkspaceInfo } from '@gadgets/workshop-shared/api'
import type { SupportedResource } from '@gadgets/workshop-shared/gatekeeper'

const configurator = vi.hoisted(() => ({
  // What the configurator's form resolves to when the dialog collects it.
  collect: (): Promise<string> => Promise.resolve('https://docs.example.com/tree/handbook'),
  setReady: null as ((ready: boolean | null) => void) | null,
  // How many frames have been mounted, so a test can tell a new one has replaced the last.
  mounts: 0,
}))

const reportIssue = vi.hoisted(() => vi.fn<(site: string, caught: unknown, options?: object) => void>())
vi.mock('../../../errorReporting', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../errorReporting')>(),
  reportIssue,
}))

// The real host renders a sandboxed iframe; this one stands in for a configurator whose form the
// test fills in by saying whether its selection is ready.
vi.mock('../../../ResourceConfiguratorHost', async () => {
  const { useEffect } = await import('react')
  const ResourceConfiguratorHost = ({ frame, frameKey, loading, error, onCollectResourceUrlChange, onSelectionReadyChange, resourceUrlPattern }: {
    frame: { iframeHtml: string } | null
    frameKey: number | null
    loading: boolean
    error: string | null
    onCollectResourceUrlChange?: (collect: (() => Promise<string>) | null) => void
    onSelectionReadyChange?: (ready: boolean | null) => void
    resourceUrlPattern?: string
  }) => {
    const mounted = Boolean(frame && !loading)
    useEffect(() => {
      if (!mounted) return
      onCollectResourceUrlChange?.(() => configurator.collect())
      configurator.setReady = (ready) => onSelectionReadyChange?.(ready)
      configurator.mounts += 1
      onSelectionReadyChange?.(null)
      return () => {
        onCollectResourceUrlChange?.(null)
        configurator.setReady = null
      }
    }, [mounted, frameKey]) // eslint-disable-line react-hooks/exhaustive-deps
    if (loading) return <p>Loading configurator...</p>
    if (error) return <p>{error}</p>
    return mounted ? <div data-testid="configurator" data-frame={frame!.iframeHtml} data-pattern={resourceUrlPattern} /> : null
  }
  return { default: ResourceConfiguratorHost }
})

import {
  ME,
  alerts,
  button,
  click,
  deferred,
  fakeApi,
  hasButton,
  mount,
  settle,
  unmountAll,
} from '../spacesTestUtils'
import { RpcContext } from '../../../RpcContext'
import { StartSpaceSyncDialog } from './StartSpaceSyncDialog'
import type { SpaceSyncAccount } from './useSpaceSyncAccounts'

const DAY = new Date('2026-09-01T00:00:00Z')
const entry = (id: string, title: string, fields: Partial<SpaceWorkspaceInfo> = {}): SpaceWorkspaceInfo =>
  ({ id, title, owner: ME, created: DAY, published: 'use', ...fields })

// Handbook > (Onboarding > Checklist); Drafts (unpublished) > Ideas (held back by Drafts).
const HANDBOOK = entry('w-handbook', 'Handbook')
const ONBOARDING = entry('w-onboarding', 'Onboarding', { parentId: 'w-handbook' })
const CHECKLIST = entry('w-checklist', 'Checklist', { parentId: 'w-onboarding' })
const DRAFTS = entry('w-drafts', 'Drafts', { published: undefined })
const IDEAS = entry('w-ideas', 'Ideas', { parentId: 'w-drafts', hiddenBy: 'w-drafts' })
const LISTING = [HANDBOOK, ONBOARDING, CHECKLIST, DRAFTS, IDEAS]

const TREE: SupportedResource = { urlPattern: 'https://docs.example.com/tree/*', title: 'Document tree', description: '' }
const SINGLE: SupportedResource = { urlPattern: 'https://docs.example.com/doc/*', title: 'Single document', description: '' }

const account = (id: number, fields: Partial<SpaceSyncAccount> = {}): SpaceSyncAccount => ({
  id,
  label: `Account ${id}`,
  vendorName: 'Docs Hub',
  vendorId: 'docs',
  blueprintId: 'document',
  credentialsValid: true,
  resources: [TREE],
  ...fields,
})

const JOB: SpaceSyncJobInfo = {
  jobId: 'j1',
  accountId: 1,
  vendorId: 'docs',
  spaceKey: 'design',
  blueprintId: 'document',
  publication: 'use',
  status: 'running',
  progress: { done: 0, warnings: [] },
  created: DAY,
}

// The blueprint the accounts sync with, published by default as `publication` declares.
const documentBlueprint = (publication?: BlueprintPublicInfo['metadata']['publication']): BlueprintPublicInfo => ({
  id: 'document',
  metadata: {
    title: 'Document',
    description: '',
    author: ME,
    created: DAY,
    version: 1,
    lastUpdated: DAY,
    bindings: {},
    ...(publication && { publication }),
  },
})

type GetBlueprint = (id: string) => Promise<BlueprintPublicInfo | null>

type StartConfigurator = (accountId: number, pattern: string) => Promise<{ iframeHtml: string; ui: Disposable }>
type StartSync = (accountId: number, spaceKey: string, options: { resourceUrl: string; parentId?: string }) =>
  Promise<SpaceSyncJobInfo>

// Each configurator started is a frame named for its account and type, with a disposer to check.
function configurators() {
  const frames: { iframeHtml: string; ui: { [Symbol.dispose]: ReturnType<typeof vi.fn> } }[] = []
  const startResourceConfigurator = vi.fn<StartConfigurator>(async (accountId, pattern) => {
    const frame = { iframeHtml: `${accountId} ${pattern}`, ui: { [Symbol.dispose]: vi.fn<() => void>() } }
    frames.push(frame)
    return frame
  })
  return { frames, startResourceConfigurator }
}

const render = async ({
  accounts = [account(1)],
  defaultParentId,
  syncRunning = false,
  startSpaceSync = vi.fn<StartSync>(async () => JOB),
  startResourceConfigurator = configurators().startResourceConfigurator,
  getBlueprint = vi.fn<GetBlueprint>(async () => documentBlueprint()),
}: {
  accounts?: SpaceSyncAccount[]
  defaultParentId?: string
  syncRunning?: boolean
  startSpaceSync?: ReturnType<typeof vi.fn<StartSync>>
  startResourceConfigurator?: ReturnType<typeof vi.fn<StartConfigurator>>
  getBlueprint?: ReturnType<typeof vi.fn<GetBlueprint>>
} = {}) => {
  const publicApi = { getBlueprint } as unknown as RpcStub<PublicApi>
  const onClose = vi.fn<() => void>()
  const onStarted = vi.fn<(job: SpaceSyncJobInfo) => void>()
  const view = await mount(
    <RpcContext.Provider value={{ stub: publicApi, connectionLost: false }}>
      <StartSpaceSyncDialog
        space={{ key: 'design', name: 'Design' }}
        listing={LISTING}
        accounts={accounts}
        defaultParentId={defaultParentId}
        syncRunning={syncRunning}
        onClose={onClose}
        onStarted={onStarted}
      />
    </RpcContext.Provider>,
    fakeApi({ startSpaceSync, startResourceConfigurator }),
  )
  await settle()
  return { ...view, onClose, onStarted, startSpaceSync, startResourceConfigurator, getBlueprint }
}

const dialog = () => document.body.querySelector('[role="dialog"]')!
const shownConfigurator = () => document.body.querySelector<HTMLElement>('[data-testid="configurator"]')
const selectionReady = () => act(async () => configurator.setReady?.(true))

// The radio group the dialog labels `legend`, by the fieldset's own label.
const group = (legend: string) => [...dialog().querySelectorAll('fieldset')]
  .find(fieldset => document.getElementById(fieldset.getAttribute('aria-labelledby') ?? '')?.textContent === legend)
const choiceLabels = (legend: string) => [...group(legend)!.querySelectorAll('label')]
  .filter(label => label.querySelector('[role="radio"]'))
// Each choice's text: its label, followed by its description when it has one.
const choices = (legend: string) => choiceLabels(legend).map(label => label.textContent)
const checked = (legend: string) => choiceLabels(legend)
  .find(label => label.querySelector('[role="radio"]')!.getAttribute('aria-checked') === 'true')?.textContent
// The choice's label, which is what a pointer lands on. jsdom has no PointerEvent, which the
// radio itself forwards its clicks with.
const choose = (legend: string, name: string) =>
  click(choiceLabels(legend).find(label => label.textContent?.startsWith(name))!)

// The list of places to go under is what holds their six choices, one each.
const isParentList = (element: Element) => element.children.length === 6
  && [...element.children].every(child => child.querySelectorAll('[role="radio"]').length === 1)
const isParentOption = (element: Element) => element.parentElement !== null && isParentList(element.parentElement)

describe('StartSpaceSyncDialog', () => {
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
    configurator.collect = () => Promise.resolve('https://docs.example.com/tree/handbook')
    reportIssue.mockClear()
  })

  it('is named for the source and says, before anything starts, how synced workspaces are published', async () => {
    await render()

    const labelledBy = dialog().getAttribute('aria-labelledby')!
    expect(document.getElementById(labelledBy)?.textContent).toBe('Sync from Docs Hub')
    expect(group('Account')).toBeUndefined()
    expect(dialog().textContent).toContain('Through your account Account 1 (Docs Hub).')
    const note = dialog().querySelector('[role="note"]')!.textContent
    expect(note).toContain('Every workspace this sync creates will be published to everyone signed in, who can use them.')
    expect(note).toContain('They are your own copies')
    expect(note).toContain('Items restricted in Docs Hub are skipped.')
  })

  it('says, before anything starts, when everyone signed in can also build on the synced workspaces', async () => {
    const { getBlueprint } = await render({ getBlueprint: vi.fn<GetBlueprint>(async () => documentBlueprint('build')) })

    expect(getBlueprint).toHaveBeenCalledWith('document')
    expect(dialog().querySelector('[role="note"]')!.textContent)
      .toContain('published to everyone signed in, who can use and build on them.')
  })

  it('cannot start until it has read how the synced workspaces are published', async () => {
    const pending = deferred<BlueprintPublicInfo | null>()
    await render({ getBlueprint: vi.fn<GetBlueprint>(() => pending.promise) })
    await selectionReady()
    expect(button('Start sync').disabled).toBe(true)

    await act(async () => pending.resolve(documentBlueprint()))
    expect(button('Start sync').disabled).toBe(false)
  })

  it('cannot start when how the synced workspaces are published could not be read', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await render({ getBlueprint: vi.fn<GetBlueprint>().mockRejectedValue(new Error('boom')) })
    await selectionReady()

    expect(button('Start sync').disabled).toBe(true)
    expect(dialog().textContent).toContain('so the sync can’t be started')
  })

  it('says that syncing a source again replaces what was written in the workspaces it created', async () => {
    await render()

    expect(dialog().querySelector('[role="note"]')!.textContent).toContain(
      'Syncing a source again replaces the content and all the comments of the workspaces it created before, including every edit and comment made in them since',
    )
  })

  it('starts the sync from the picked source under the default parent, once the source is chosen', async () => {
    const { startSpaceSync, startResourceConfigurator, onStarted } = await render({ defaultParentId: 'w-onboarding' })

    expect(startResourceConfigurator).toHaveBeenCalledWith(1, TREE.urlPattern)
    expect(shownConfigurator()?.dataset.pattern).toBe(TREE.urlPattern)
    expect(checked('Place under')).toBe('Onboarding, under Handbook')
    expect(button('Start sync').disabled).toBe(true)

    await selectionReady()
    expect(button('Start sync').disabled).toBe(false)
    await click(button('Start sync'))
    await settle()

    expect(startSpaceSync).toHaveBeenCalledWith(1, 'design', {
      resourceUrl: 'https://docs.example.com/tree/handbook',
      parentId: 'w-onboarding',
    })
    expect(onStarted).toHaveBeenCalledWith(JOB)
  })

  it('offers the top of the space and every entry, in tree order, and sends no parent for the top', async () => {
    const { startSpaceSync } = await render({ defaultParentId: 'w-checklist' })

    // Each entry is named with the entries above it too, so that two of one title differ.
    expect(choices('Place under')).toEqual([
      'Top of the space',
      'Handbook',
      'Onboarding, under Handbook',
      'Checklist, under Handbook / Onboarding',
      'Drafts',
      'Ideas, under Drafts',
    ])
    await choose('Place under', 'Top of the space')
    await selectionReady()
    await click(button('Start sync'))
    await settle()

    expect(startSpaceSync.mock.calls[0][2]).toEqual({ resourceUrl: 'https://docs.example.com/tree/handbook' })
  })

  it('scrolls the list of places to the one preselected, and nothing else', async () => {
    // Laid out as jsdom cannot: the list shows two rows of its six.
    const ROW = 30
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const top = isParentOption(this) ? 100 + [...this.parentElement!.children].indexOf(this) * ROW : 100
      const height = isParentOption(this) ? ROW : isParentList(this) ? 2 * ROW : 0
      return { top, bottom: top + height, left: 0, right: 0, width: 0, height, x: 0, y: top, toJSON: () => ({}) }
    })
    await render({ defaultParentId: 'w-ideas' })

    const list = [...group('Place under')!.querySelectorAll('div')].find(isParentList)!
    expect(list.scrollTop).toBe(5 * ROW)
    expect([...dialog().querySelectorAll('*')].filter(element => element !== list && element.scrollTop !== 0)).toEqual([])
  })

  it('starts at the top when the default parent is not in the listing', async () => {
    await render({ defaultParentId: 'w-gone' })

    expect(checked('Place under')).toBe('Top of the space')
  })

  it('says which unpublished entry keeps the synced workspaces from others', async () => {
    await render({ defaultParentId: 'w-drafts' })
    expect(dialog().textContent).toContain('“Drafts” isn’t published, so others won’t see them until it is.')

    await choose('Place under', 'Ideas')
    expect(dialog().textContent).toContain('“Drafts” isn’t published, so others won’t see them until it is.')

    await choose('Place under', 'Handbook')
    expect(dialog().textContent).not.toContain('isn’t published')
  })

  it('lets the user choose among several accounts, and starts the chosen one’s configurator in place of the first', async () => {
    const { frames, startResourceConfigurator } = configurators()
    await render({
      accounts: [account(1), account(2, { label: 'Personal', vendorName: 'Notes Cloud' })],
      startResourceConfigurator,
    })
    expect(choices('Account')).toEqual(['Account 1Docs Hub', 'PersonalNotes Cloud'])
    expect(checked('Account')).toBe('Account 1Docs Hub')
    expect(shownConfigurator()?.dataset.frame).toBe(`1 ${TREE.urlPattern}`)

    await choose('Account', 'Personal')
    await settle()

    expect(startResourceConfigurator).toHaveBeenLastCalledWith(2, TREE.urlPattern)
    expect(shownConfigurator()?.dataset.frame).toBe(`2 ${TREE.urlPattern}`)
    expect(frames[0].ui[Symbol.dispose]).toHaveBeenCalledOnce()
    expect(frames[1].ui[Symbol.dispose]).not.toHaveBeenCalled()
    const labelledBy = dialog().getAttribute('aria-labelledby')!
    expect(document.getElementById(labelledBy)?.textContent).toBe('Sync from Notes Cloud')
  })

  it('offers every choice inline, never in a popup the configurator above it could cover', async () => {
    await render({ accounts: [account(1, { resources: [TREE, SINGLE] }), account(2)] })

    expect(choices('Account')).toHaveLength(2)
    expect(choices('Source type')).toEqual(['Document tree', 'Single document'])
    expect(choices('Place under')).toHaveLength(6)
    expect(dialog().querySelector('[role="combobox"], [aria-haspopup="listbox"]')).toBeNull()
  })

  it('lets the user choose the type of source when the account offers several', async () => {
    const { startResourceConfigurator } = configurators()
    await render({ accounts: [account(1, { resources: [TREE, SINGLE] })], startResourceConfigurator })

    await choose('Source type', 'Single document')
    await settle()

    expect(startResourceConfigurator).toHaveBeenLastCalledWith(1, SINGLE.urlPattern)
    expect(shownConfigurator()?.dataset.pattern).toBe(SINGLE.urlPattern)
  })

  it('needs a fresh choice in a new configurator before it can start', async () => {
    await render({ accounts: [account(1, { resources: [TREE, SINGLE] })] })
    await selectionReady()
    expect(button('Start sync').disabled).toBe(false)

    await choose('Source type', 'Single document')
    await settle()

    expect(button('Start sync').disabled).toBe(true)
  })

  it('never lets a ready signal from a configurator it replaced enable Start', async () => {
    await render({ accounts: [account(1, { resources: [TREE, SINGLE] })] })
    const replaced = configurator.setReady!
    const mountsBefore = configurator.mounts

    await choose('Source type', 'Single document')
    await settle()
    expect(configurator.mounts).toBe(mountsBefore + 1)
    await act(async () => replaced(true))

    expect(button('Start sync').disabled).toBe(true)
    await selectionReady()
    expect(button('Start sync').disabled).toBe(false)
  })

  it('never shows a configurator that resolves after the account changed, and disposes it', async () => {
    const first = deferred<{ iframeHtml: string; ui: Disposable }>()
    const late = { iframeHtml: 'late', ui: { [Symbol.dispose]: vi.fn<() => void>() } }
    const startResourceConfigurator = vi.fn<StartConfigurator>()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue({ iframeHtml: 'second', ui: { [Symbol.dispose]() {} } })
    await render({ accounts: [account(1), account(2, { label: 'Personal' })], startResourceConfigurator })

    await choose('Account', 'Personal')
    await settle()
    first.resolve(late)
    await settle()

    expect(shownConfigurator()?.dataset.frame).toBe('second')
    expect(late.ui[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('disposes its configurator when it closes', async () => {
    const { frames, startResourceConfigurator } = configurators()
    const { unmount } = await render({ startResourceConfigurator })
    await unmount()

    expect(frames[0].ui[Symbol.dispose]).toHaveBeenCalledOnce()
  })

  it('shows why the configurator could not start, with nothing to start', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    await render({
      startResourceConfigurator: vi.fn<StartConfigurator>().mockRejectedValue(new Error('The account was revoked.')),
    })

    expect(dialog().textContent).toContain('The account was revoked.')
    expect(button('Start sync').disabled).toBe(true)
    expect(reportIssue).toHaveBeenCalledWith('gatekeeper.configurator-start', expect.any(Error), { gatekeeperVendorId: 'docs' })
  })

  it('starts a configurator that failed to start again when asked', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const startResourceConfigurator = vi.fn<StartConfigurator>()
      .mockRejectedValueOnce(new Error('Try later.'))
      .mockResolvedValue({ iframeHtml: 'retried', ui: { [Symbol.dispose]() {} } })
    await render({ startResourceConfigurator })
    expect(dialog().textContent).toContain('Try later.')

    await click(button('Try again'))
    await settle()

    expect(startResourceConfigurator).toHaveBeenCalledTimes(2)
    expect(shownConfigurator()?.dataset.frame).toBe('retried')
    expect(hasButton('Try again')).toBe(false)
    await selectionReady()
    expect(button('Start sync').disabled).toBe(false)
  })

  it('shows the server’s refusal of the start inline, and lets the user try again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { onStarted } = await render({
      startSpaceSync: vi.fn<StartSync>().mockRejectedValueOnce(new Error('You already have a sync running into this space.')),
    })
    await selectionReady()

    await click(button('Start sync'))
    await settle()

    expect(alerts()).toEqual(['You already have a sync running into this space.'])
    expect(onStarted).not.toHaveBeenCalled()
    expect(button('Start sync').disabled).toBe(false)
  })

  it('shows a configurator that gives no source inline', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    configurator.collect = () => Promise.reject(new Error('Choose a document tree first.'))
    const { startSpaceSync } = await render()
    await selectionReady()

    await click(button('Start sync'))
    await settle()

    expect(alerts()).toEqual(['Choose a document tree first.'])
    expect(startSpaceSync).not.toHaveBeenCalled()
  })

  it('stays open while the start is in flight, with every choice held', async () => {
    const pending = deferred<SpaceSyncJobInfo>()
    const { onClose } = await render({
      accounts: [account(1, { resources: [TREE, SINGLE] }), account(2)],
      startSpaceSync: vi.fn<StartSync>(() => pending.promise),
    })
    await selectionReady()
    await click(button('Start sync'))

    expect(button('Starting…').disabled).toBe(true)
    expect(button('Cancel').disabled).toBe(true)
    expect(group('Account')!.disabled).toBe(true)
    expect(group('Source type')!.disabled).toBe(true)
    expect(group('Place under')!.disabled).toBe(true)
    expect(onClose).not.toHaveBeenCalled()
    pending.resolve(JOB)
    await settle()
  })

  it('offers nothing to start while a sync into the space is running', async () => {
    await render({ syncRunning: true })
    await selectionReady()

    expect(button('Start sync').disabled).toBe(true)
    expect(dialog().textContent).toContain('A sync into this space is already running.')
  })

  it('asks for an account with expired credentials to be reconnected, and starts no configurator for it', async () => {
    const { startResourceConfigurator } = await render({ accounts: [account(1, { credentialsValid: false })] })

    expect(dialog().textContent).toContain('This account needs to be reconnected from Connections')
    expect(startResourceConfigurator).not.toHaveBeenCalled()
    expect(button('Start sync').disabled).toBe(true)
  })

  it('prefers an account that can sync over one that needs reconnecting', async () => {
    const { startResourceConfigurator } = await render({
      accounts: [account(1, { credentialsValid: false }), account(2, { label: 'Personal' })],
    })

    expect(checked('Account')).toBe('PersonalDocs Hub')
    expect(choices('Account')[0]).toBe('Account 1Docs Hub, needs reconnecting')
    expect(startResourceConfigurator).toHaveBeenCalledWith(2, TREE.urlPattern)
  })

  it('says so when the account has been granted nothing it can sync', async () => {
    const { startResourceConfigurator } = await render({ accounts: [account(1, { resources: [] })] })

    expect(dialog().textContent).toContain('hasn’t been granted access to anything it can sync')
    expect(startResourceConfigurator).not.toHaveBeenCalled()
  })
})
