// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act, type ComponentProps } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createRoute, type AnyRoute } from '@tanstack/react-router'
import type { RpcStub } from 'capnweb'
import type {
  BlueprintPublicInfo,
  GadgetMetadata,
  OutputFormatOffer,
  PublicApi,
  SpaceMemberRole,
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
  settle,
  teamSpace,
  unmountAll,
} from '../spacesTestUtils'
import { useSpaceListings } from '../useSpaceListings'
import { SpaceTreeLayout } from './SpaceTreeLayout'

const seen = vi.hoisted(() => ({
  pane: null as ComponentProps<typeof WorkspacePreviewPaneComponent> | null,
  shareModal: null as ComponentProps<typeof ShareModalComponent> | null,
}))

// The preview has its own tests; here it shows which workspace it was given, and offers the
// header actions it was handed as buttons, which is the path to the dialogs it shares with the
// tree's menu. Like the real one, it starts afresh for each workspace and hands over its region.
vi.mock('../preview/WorkspacePreviewPane', () => {
  type PaneProps = ComponentProps<typeof WorkspacePreviewPaneComponent>
  const Pane = ({ ref, workspace, actions }: PaneProps) => {
    const { onNewChild, onMove, onAddressChange } = actions
    return (
      <section ref={ref} tabIndex={-1} data-preview={workspace.id}>
        {onNewChild && <button type="button" onClick={onNewChild}>New child workspace</button>}
        {onMove && <button type="button" onClick={onMove}>Move…</button>}
        {onAddressChange && <button type="button" onClick={onAddressChange}>Change address</button>}
      </section>
    )
  }
  return {
    WorkspacePreviewPane: (props: PaneProps) => {
      seen.pane = props
      return <Pane key={props.workspace.id} {...props} />
    },
  }
})
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
 * The layout for Design, at /spaces/design, for `ME` in `role` (undefined for a visitor), over the
 * listing as the space gives it to them, read through the hook the pages use.
 */
const render = async (role: SpaceMemberRole | undefined, { at = '/spaces/design' } = {}) => {
  const space = fakeSpace(teamSpace('design', 'Design'), role ? [member(ME, role)] : [], LISTING)
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

  it('offers in the preview what the space lets the member do with the entry', async () => {
    await render('build')

    await select('w-checklist')
    expect(Object.keys(seen.pane!.actions).toSorted()).toEqual(['onAddressChange', 'onMove', 'onNewChild'])
    // Ada's: a member who is not an admin may add under it but not move it.
    await select('w-budget')
    expect(Object.keys(seen.pane!.actions)).toEqual(['onNewChild'])
  })

  it('moves the selected workspace from the dialog by its anchor, then reads the listing again', async () => {
    const { space, reloads } = await render('build')

    await select('w-checklist')
    await click(button('Move…'))
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

    await select('w-handbook')
    await click(button('Move…'))
    await chooseOption('Position', 'After Budget')
    await click(button('Move'))
    await settle()

    expect(space.moveWorkspace).toHaveBeenCalledWith('w-handbook', null)
  })

  it('creates a child workspace under the selected entry, then reads the listing again and previews it', async () => {
    const { newGadgetFromBlueprint, reloads, router } = await render('build')

    await select('w-onboarding')
    await click(button('New child workspace'))
    await settle()
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
    // The button the focus was on went with the last preview; the new one takes it.
    expect(document.activeElement).toBe(document.body.querySelector('[data-preview="w-new"]'))
  })

  it('reads the listing again until it shows a new workspace, which its space registers apart', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      const { space, reloads } = await render('build')
      const listed = space.listWorkspaces.getMockImplementation()!

      await select('w-onboarding')
      await click(button('New child workspace'))
      await settle()
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

      await select('w-onboarding')
      await click(button('New child workspace'))
      await settle()
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

    const share = (await menuItems('w-checklist')).find(item => item.textContent === 'Share')!
    await act(async () => { share.click() })
    await settle()

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

  it('gives a visitor a read-only tree and a preview with no member actions', async () => {
    const { space } = await render(undefined)

    // The space shows a visitor only Handbook, the one entry everyone signed in can see.
    expect(titles()).toEqual(['Handbook'])
    expect(rowElements().some(candidate => candidate.draggable)).toBe(false)
    expect((await menuItems('w-handbook')).map(item => item.textContent)).toEqual(['Open'])

    await act(async () => { document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })) })
    await select('w-handbook')
    expect(previewed()).toBe('w-handbook')
    expect(seen.pane?.actions).toEqual({})
    expect(space.moveWorkspace).not.toHaveBeenCalled()
  })
})
