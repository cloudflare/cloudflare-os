import { describe, expect, it, vi } from 'vitest'
import type { BlueprintUserSummary, OwnBlueprintsSubscriber } from '@gadgets/workshop-shared/api'
import { TemplateStore, type TemplatesApi } from './TemplateStore'

const own = (id: string, title: string, { pinned, version = 1 }: { pinned?: true; version?: number } = {}): BlueprintUserSummary => {
  const metadata = { title, description: '', author: { type: 'user' as const, id: 'ada@example.com', name: 'Ada' }, created: new Date(0), version, lastUpdated: new Date(0), bindings: {} }
  return { id, title, description: '', version, lastUpdated: new Date(0), pinned, metadata, source: { type: 'workspace', workspaceId: 'ws', workspaceTitle: 'Workspace' } }
}

// What a workspace opened for creating one is asked, and a gadget in it, each let go of as it is
// done with; how often the featured were read; and the listener the account was given for the
// user's own, with whether its lease was let go of.
const fakeApi = ({ featuredUnavailable = false } = {}) => {
  const disposed: string[] = []
  const created: [string | undefined, string | undefined][] = []
  const updated: [string, { updateCode?: boolean; title?: string; description?: string }][] = []
  const deleted: string[] = []
  const listeners: OwnBlueprintsSubscriber[] = []
  let reads = 0
  const api = {
    listFeaturedBlueprints: async () => {
      reads++
      if (featuredUnavailable) throw new Error('Unavailable')
      return []
    },
    listLibraryBlueprints: async () => [],
    subscribeToOwnBlueprints: async (listener: OwnBlueprintsSubscriber) => {
      listeners.push(listener)
      return { [Symbol.dispose]: () => disposed.push('own blueprints') }
    },
    listGatekeeperVendors: async () => [],
    setBlueprintPinned: async () => {},
    openWorkspace: (workspaceId: string) => ({
      getGadget: (workpieceId: number) => ({
        createBlueprint: async (title?: string, description?: string) => {
          created.push([title, description])
          return { id: 'tpl-1' }
        },
        [Symbol.dispose]: () => disposed.push(`gadget ${workpieceId}`),
      }),
      listBlueprints: async () => [{ id: 'tpl-1', title: 'Counter', description: '', version: 2, codeVersionDate: new Date(0), unpublishedChanges: { code: true as const } }],
      updateBlueprint: async (id: string, options: { updateCode?: boolean; updateBindings?: boolean; title?: string; description?: string }) => {
        updated.push([id, options])
      },
      deleteBlueprint: async (id: string) => {
        deleted.push(id)
      },
      [Symbol.dispose]: () => disposed.push(`workspace ${workspaceId}`),
    }),
  }
  return { api: api as unknown as TemplatesApi, created, updated, deleted, disposed, listeners, reads: () => reads }
}

const COUNTER = { workspaceId: 'ws', workpieceId: 7, title: 'Counter' }

const ready = (store: TemplateStore) => {
  const state = store.getSnapshot()
  if (state.status !== 'ready') throw new Error(`not ready: ${state.status}`)
  return state
}

describe('TemplateStore keeping the user’s own', () => {
  it('lists those the user created whole, from their account, and keeps them as it says each changes', async () => {
    const { api, listeners } = fakeApi()
    const store = new TemplateStore()
    store.connect(api)
    await vi.waitFor(() => expect(listeners).toHaveLength(1))
    // Not ready until both the account and the reads have answered.
    expect(store.getSnapshot().status).toBe('loading')
    await listeners[0].snapshot([own('a', 'Counter', { pinned: true })])
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('ready'))
    expect(ready(store).templates.map(({ id, mine, metadata }) => [id, mine, metadata.title])).toEqual([['a', true, 'Counter']])
    expect(ready(store).stars).toEqual(['a'])

    // Released again, and a new one created, which is the latest.
    await listeners[0].updated('a', own('a', 'Counter', { pinned: true, version: 2 }))
    await listeners[0].updated('b', own('b', 'Tally'))
    expect(ready(store).templates.map(({ id, metadata }) => [id, metadata.version])).toEqual([['b', 1], ['a', 2]])

    await listeners[0].updated('a', null)
    expect(ready(store).templates.map(({ id }) => id)).toEqual(['b'])
  })

  it('keeps the owner’s unpublished changes even if the catalogue cannot be read', async () => {
    const { api, listeners, reads } = fakeApi({ featuredUnavailable: true })
    const store = new TemplateStore()
    const seen: Array<readonly BlueprintUserSummary[] | undefined> = []
    store.subscribe(() => seen.push(store.getOwnSnapshot()))
    store.connect(api)
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('failed'))

    const template = own('a', 'Counter')
    await listeners[0].snapshot([template])
    await listeners[0].updated('a', { ...template, unpublishedChanges: { bindings: true } })
    await listeners[0].updated('a', null)

    expect(seen.slice(-3)).toEqual([[template], [{ ...template, unpublishedChanges: { bindings: true } }], []])
    expect(reads()).toBe(1)
  })

  it('keeps the stars as shown while one of the user’s own changes', async () => {
    const { api, listeners } = fakeApi()
    const store = new TemplateStore()
    store.connect(api)
    await vi.waitFor(() => expect(listeners).toHaveLength(1))
    await listeners[0].snapshot([own('a', 'Counter')])
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('ready'))
    store.setStars(['a'])
    await listeners[0].updated('a', own('a', 'Counter', { version: 2 }))
    expect(ready(store).stars).toEqual(['a'])
  })

  it('subscribes again over a new connection, letting go of the old, and ignores what the old is told', async () => {
    const first = fakeApi()
    const second = fakeApi()
    const store = new TemplateStore()
    store.connect(first.api)
    await vi.waitFor(() => expect(first.listeners).toHaveLength(1))
    store.connect(second.api)
    await vi.waitFor(() => expect(second.listeners).toHaveLength(1))
    await vi.waitFor(() => expect(first.disposed).toEqual(['own blueprints']))
    await second.listeners[0].snapshot([own('b', 'Tally')])
    await first.listeners[0].snapshot([own('a', 'Counter')])
    await vi.waitFor(() => expect(store.getSnapshot().status).toBe('ready'))
    expect(ready(store).templates.map(({ id }) => id)).toEqual(['b'])
  })
})

describe('TemplateStore creating', () => {
  it('creates a template from a gadget under the title and what it is for that were given, else its own title', async () => {
    const { api, created, disposed } = fakeApi()
    const store = new TemplateStore()
    store.connect(api)
    expect(await store.create(COUNTER, { title: '  Tally  ', description: ' Counts things ' })).toBe('tpl-1')
    await store.create(COUNTER, { title: ' ', description: '' })
    expect(created).toEqual([['Tally', 'Counts things'], ['Counter', undefined]])
    expect(disposed).toEqual(['gadget 7', 'workspace ws', 'gadget 7', 'workspace ws'])
  })

  it('lists what a workspace has made, and releases code as a template’s next version and bindings alone otherwise, reading the featured again', async () => {
    const { api, updated, disposed, reads } = fakeApi()
    const store = new TemplateStore()
    store.connect(api)
    expect((await store.createdFrom('ws')).map(({ id, unpublishedChanges }) => [id, unpublishedChanges])).toEqual([['tpl-1', { code: true }]])
    await store.release('ws', 'tpl-1', { code: true, bindings: true })
    await store.release('ws', 'tpl-1', { bindings: true })
    expect(updated).toEqual([['tpl-1', { updateCode: true }], ['tpl-1', { updateBindings: true }]])
    expect(reads()).toBe(3)
    expect(disposed).toEqual(['workspace ws', 'workspace ws', 'workspace ws'])
  })

  it('changes a template’s title and what it is for without releasing its code', async () => {
    const { api, updated, disposed, reads } = fakeApi()
    const store = new TemplateStore()
    store.connect(api)
    await store.update('ws', 'tpl-1', { title: 'Tally', description: 'Counts things' })
    expect(updated).toEqual([['tpl-1', { title: 'Tally', description: 'Counts things' }]])
    expect(reads()).toBe(2)
    expect(disposed).toEqual(['workspace ws'])
  })

  it('deletes a template from its workspace', async () => {
    const { api, deleted, disposed } = fakeApi()
    const store = new TemplateStore()
    store.connect(api)
    await store.remove('ws', 'tpl-1')
    expect(deleted).toEqual(['tpl-1'])
    expect(disposed).toEqual(['workspace ws'])
  })

  it('refuses to create before it is connected', async () => {
    await expect(new TemplateStore().create(COUNTER)).rejects.toThrow('Not connected.')
  })
})
