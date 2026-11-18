import { describe, expect, it } from 'vitest'
import { TemplateStore, type TemplatesApi } from './TemplateStore'

// What a workspace opened for publishing is asked, and a gadget in it, each let go of as it is
// done with; and how often the templates were read.
const fakeApi = () => {
  const disposed: string[] = []
  const created: [string | undefined, string | undefined][] = []
  const updated: [string, { updateCode?: boolean }][] = []
  let reads = 0
  const api = {
    listFeaturedBlueprints: async () => [],
    listLibraryBlueprints: async () => [],
    listOwnBlueprints: async () => {
      reads++
      return []
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
      listBlueprints: async () => [{ id: 'tpl-1', title: 'Counter', description: '', version: 2, codeVersionDate: new Date(0), unpublishedChanges: true as const }],
      updateBlueprint: async (id: string, options: { updateCode?: boolean }) => {
        updated.push([id, options])
      },
      [Symbol.dispose]: () => disposed.push(`workspace ${workspaceId}`),
    }),
  }
  return { api: api as unknown as TemplatesApi, created, updated, disposed, reads: () => reads }
}

const COUNTER = { workspaceId: 'ws', workpieceId: 7, title: 'Counter' }

describe('TemplateStore publishing', () => {
  it('publishes a gadget under the title and what it is for that were given, else its own title, and reads the templates again', async () => {
    const { api, created, disposed, reads } = fakeApi()
    const store = new TemplateStore()
    store.connect(api, null)
    expect(await store.publish(COUNTER, { title: '  Tally  ', description: ' Counts things ' })).toBe('tpl-1')
    await store.publish(COUNTER, { title: ' ', description: '' })
    expect(created).toEqual([['Tally', 'Counts things'], ['Counter', undefined]])
    expect(reads()).toBe(3)
    expect(disposed).toEqual(['gadget 7', 'workspace ws', 'gadget 7', 'workspace ws'])
  })

  it('lists what a workspace has published, and publishes a gadget’s changes to one of them', async () => {
    const { api, updated, disposed, reads } = fakeApi()
    const store = new TemplateStore()
    store.connect(api, null)
    expect((await store.publishedFrom('ws')).map(({ id, unpublishedChanges }) => [id, unpublishedChanges])).toEqual([['tpl-1', true]])
    await store.publishChanges('ws', 'tpl-1')
    expect(updated).toEqual([['tpl-1', { updateCode: true }]])
    expect(reads()).toBe(2)
    expect(disposed).toEqual(['workspace ws', 'workspace ws'])
  })

  it('refuses to publish before it is connected', async () => {
    await expect(new TemplateStore().publish(COUNTER)).rejects.toThrow('Not connected.')
  })
})
