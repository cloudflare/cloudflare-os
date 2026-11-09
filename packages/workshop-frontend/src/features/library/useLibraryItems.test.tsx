// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { LibraryItemRef, LibraryRemoval } from '@gadgets/workshop-shared/api'

const state = vi.hoisted(() => ({
  removals: [] as LibraryRemoval[],
  set: [] as [LibraryItemRef, boolean][],
  removed: [] as number[],
  toasts: [] as string[],
}))
const api = vi.hoisted(() => ({
  listLibraryRemovals: async () => state.removals,
  setLibraryRemoved: async (item: LibraryItemRef, removed: boolean) => { state.set.push([item, removed]) },
  openWorkspace: () => ({
    getGadget: (id: number) => ({ remove: async () => { state.removed.push(id) }, [Symbol.dispose]: () => {} }),
    [Symbol.dispose]: () => {},
  }),
}))
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => ({ authenticatedApi: api }) }))
vi.mock('@tanstack/react-router', () => ({ useNavigate: () => () => {} }))
vi.mock('@cloudflare/kumo', async importOriginal => ({
  ...await importOriginal<typeof import('@cloudflare/kumo')>(),
  useKumoToastManager: () => ({ add: ({ title }: { title: string }) => state.toasts.push(title) }),
}))

import { makeTestRoot } from '../../action-test-harness'
import type { MenuEntry } from '../../components/ContextMenu'
import type { ExternalFileSource } from './externalFiles'
import { useLibraryItems, type LibraryAppSource } from './useLibraryItems'
import type { LibraryItem } from './LibraryViews'

const testRoot = makeTestRoot()
afterEach(() => {
  testRoot.cleanup()
  Object.assign(state, { removals: [], set: [], removed: [], toasts: [] })
})

const app = (id: number, canDelete = true): LibraryAppSource =>
  ({ workspaceId: 'w', workpieceId: id, title: `App ${id}`, date: new Date(100), canDelete })
const doc = (subjectId: string, at: number): ExternalFileSource => ({
  workspaceId: 'w', gatekeeperId: 7, subjectId, title: `Doc ${subjectId}`, url: `https://docs.google.com/document/d/${subjectId}/edit`,
  kind: 'document', mediaType: 'application/vnd.google-apps.document', date: new Date(at),
})

let latest: ReturnType<typeof useLibraryItems>
const Harness = ({ apps, external }: { apps: LibraryAppSource[]; external: ExternalFileSource[] }) => {
  latest = useLibraryItems({ apps, files: [], external, favorites: [], starred: new Set(), showContext: false, origin: 'library' })
  return latest.dialogs
}
const render = async (apps: LibraryAppSource[], external: ExternalFileSource[] = []) => {
  await testRoot.render(<Harness apps={apps} external={external} />)
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}
const labels = (item: LibraryItem) =>
  (item.actions ?? []).flatMap((entry: MenuEntry) => entry === 'separator' ? [] : [entry.label])
const select = async (item: LibraryItem, label: string) => {
  const entry = item.actions!.find((e): e is Exclude<MenuEntry, 'separator'> => e !== 'separator' && e.label === label)!
  await act(async () => { entry.onSelect() })
}

describe('useLibraryItems, taking items out', () => {
  it('offers removal for everything, and deletion only for gadgets the user may delete', async () => {
    await render([app(1), app(2, false)], [doc('a', 100)])
    const [mine, theirs] = latest.appItems
    expect(labels(mine)).toEqual(expect.arrayContaining(['Remove from Library', 'Delete gadget…']))
    expect(labels(theirs)).toContain('Remove from Library')
    expect(labels(theirs)).not.toContain('Delete gadget…')
    expect(labels(latest.fileItems[0])).toEqual(['Preview', 'Open in Docs', 'Remove from Library'])
  })

  it('hides a removed item at once and records it', async () => {
    await render([app(1)], [doc('a', 100)])
    await select(latest.fileItems[0], 'Remove from Library')
    expect(latest.fileItems).toEqual([])
    expect(state.set).toEqual([[{ kind: 'external', workspaceId: 'w', subjectId: 'a' }, true]])
    expect(state.toasts).toEqual(['Removed “Doc a” from your Library'])
  })

  it('brings back a connected file worked on since it was removed, but not an app', async () => {
    state.removals = [
      { kind: 'external', workspaceId: 'w', subjectId: 'old', removed: new Date(200) },
      { kind: 'external', workspaceId: 'w', subjectId: 'new', removed: new Date(200) },
      { kind: 'app', workspaceId: 'w', workpieceId: 1, removed: new Date(50) },
    ]
    await render([app(1)], [doc('old', 150), doc('new', 300)])
    expect(latest.fileItems.map(item => item.title)).toEqual(['Doc new'])
    expect(latest.appItems).toEqual([])
  })

  it('deletes an app once confirmed', async () => {
    await render([app(1)])
    await select(latest.appItems[0], 'Delete gadget…')
    const confirm = [...document.querySelectorAll('button')].find(b => b.textContent === 'Delete')!
    await act(async () => { confirm.click() })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    expect(state.removed).toEqual([1])
    expect(latest.appItems).toEqual([])
    expect(state.toasts).toEqual(['Deleted “App 1”'])
  })
})
