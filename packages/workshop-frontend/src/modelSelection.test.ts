// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AiChatAuthorInfo, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import {
  cacheModels,
  forgetModelSelection,
  getCachedModels,
  getStoredSelectedModel,
  NO_AGENT_OPTION_VALUE,
  persistSelectedModel,
  syncSelectedModel,
} from './modelSelection'

const OPUS: AiChatAuthorInfo = { type: 'agent', id: 'opus', name: 'Opus' }
const SONNET: AiChatAuthorInfo = { type: 'agent', id: 'sonnet', name: 'Sonnet' }
const MODELS = [OPUS, SONNET]

const getPreferredModel = vi.fn<() => Promise<string | null>>()
const setPreferredModel = vi.fn<(id: string | null) => Promise<void>>()
const whoami = vi.fn<() => Promise<AiChatAuthorInfo>>()
const api = { getPreferredModel, setPreferredModel, whoami } as unknown as RpcStub<AuthenticatedApi>

/** Lets the save of a pick just made land, so that a sync after it finds nothing left to save. */
const saved = () => new Promise(resolve => setTimeout(resolve))

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  getPreferredModel.mockResolvedValue(null)
  whoami.mockResolvedValue({ type: 'user', id: 'alice', name: 'Alice' })
  setPreferredModel.mockResolvedValue(undefined)
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('syncSelectedModel', () => {
  it("starts a browser that remembers no model on the user's preferred one", async () => {
    getPreferredModel.mockResolvedValue('sonnet')

    await syncSelectedModel(api)

    expect(getStoredSelectedModel('alice', MODELS)).toBe('sonnet')
    expect(setPreferredModel).not.toHaveBeenCalled()
  })

  it('follows a model picked in another browser', async () => {
    persistSelectedModel(api, 'alice', 'opus')
    await saved()
    getPreferredModel.mockResolvedValue('sonnet')

    await syncSelectedModel(api)

    expect(getStoredSelectedModel('alice', MODELS)).toBe('sonnet')
  })

  it('saves a choice made before picks were saved for the user, once', async () => {
    localStorage.setItem('lastSelectedModel', 'sonnet')
    getPreferredModel.mockResolvedValue('opus')

    await syncSelectedModel(api)

    expect(setPreferredModel).toHaveBeenCalledExactlyOnceWith('sonnet')
    expect(getStoredSelectedModel('alice', MODELS)).toBe('sonnet')

    await syncSelectedModel(api)

    expect(setPreferredModel).toHaveBeenCalledOnce()
    expect(getStoredSelectedModel('alice', MODELS)).toBe('opus')
  })

  it("takes the user's preferred model when the earlier choice is refused", async () => {
    localStorage.setItem('lastSelectedModel', 'retired')
    setPreferredModel.mockRejectedValue(new Error('No such model: retired'))
    getPreferredModel.mockResolvedValue('sonnet')

    await syncSelectedModel(api)

    expect(getStoredSelectedModel('alice', MODELS)).toBe('sonnet')
  })

  it('keeps "No agent" in the browser that chose it', async () => {
    persistSelectedModel(api, 'alice', null)
    await saved()

    await syncSelectedModel(api)

    expect(setPreferredModel).toHaveBeenLastCalledWith(null)

    expect(localStorage.getItem('lastSelectedModel:alice')).toBe(NO_AGENT_OPTION_VALUE)
    expect(getStoredSelectedModel('alice', MODELS)).toBeNull()
  })

  it('keeps a model picked while the preference was being fetched', async () => {
    persistSelectedModel(api, 'alice', 'opus')
    await saved()
    let answer!: (preferred: string | null) => void
    getPreferredModel.mockReturnValue(new Promise(resolve => { answer = resolve }))

    const syncing = syncSelectedModel(api)
    persistSelectedModel(api, 'alice', 'sonnet')
    answer('opus')
    await syncing

    expect(getStoredSelectedModel('alice', MODELS)).toBe('sonnet')
  })

  it('saves a pick again when saving it failed, rather than replacing it', async () => {
    setPreferredModel.mockRejectedValueOnce(new Error('offline'))
    persistSelectedModel(api, 'alice', 'sonnet')
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled())
    getPreferredModel.mockResolvedValue('opus')

    await syncSelectedModel(api)

    expect(setPreferredModel).toHaveBeenLastCalledWith('sonnet')
    expect(getStoredSelectedModel('alice', MODELS)).toBe('sonnet')
  })

  it('saves a pick again when its save fails with a sync already under way', async () => {
    setPreferredModel.mockRejectedValueOnce(new Error('offline'))
    getPreferredModel.mockResolvedValue('opus')
    persistSelectedModel(api, 'alice', 'sonnet')

    await syncSelectedModel(api)

    expect(setPreferredModel).toHaveBeenCalledTimes(2)
    expect(getStoredSelectedModel('alice', MODELS)).toBe('sonnet')
    await syncSelectedModel(api)
    expect(setPreferredModel).toHaveBeenCalledTimes(2)
  })

  it('leaves a pick unsaved when only an earlier pick of the same model was saved', async () => {
    const saves: { resolve: () => void; reject: (err: Error) => void }[] = []
    setPreferredModel.mockImplementation(() => new Promise<void>((resolve, reject) => {
      saves.push({ resolve, reject })
    }))
    const nextSave = async () => {
      const index = saves.length
      await vi.waitFor(() => expect(saves.length).toBeGreaterThan(index))
    }
    persistSelectedModel(api, 'alice', 'sonnet')
    persistSelectedModel(api, 'alice', 'opus')
    persistSelectedModel(api, 'alice', 'sonnet')
    await vi.waitFor(() => expect(saves.length).toBe(1))
    saves[0].resolve()
    await nextSave()
    saves[1].resolve()
    await nextSave()
    saves[2].reject(new Error('offline'))
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled())
    setPreferredModel.mockReset()
    setPreferredModel.mockResolvedValue(undefined)
    getPreferredModel.mockResolvedValue('opus')

    await syncSelectedModel(api)

    expect(setPreferredModel).toHaveBeenCalledExactlyOnceWith('sonnet')
    expect(getStoredSelectedModel('alice', MODELS)).toBe('sonnet')
  })

  it('keeps a pick made before the user was confirmed, as during a reconnect', async () => {
    persistSelectedModel(api, 'alice', 'sonnet')
    await saved()

    persistSelectedModel(api, undefined, null)
    await syncSelectedModel(api)

    expect(setPreferredModel).toHaveBeenLastCalledWith(null)
    expect(getStoredSelectedModel('alice', MODELS)).toBeNull()
  })

  it('keeps a model picked away from and back to while the preference was being fetched', async () => {
    persistSelectedModel(api, 'alice', 'opus')
    await saved()
    let answer!: (preferred: string | null) => void
    getPreferredModel.mockReturnValue(new Promise(resolve => { answer = resolve }))

    const syncing = syncSelectedModel(api)
    persistSelectedModel(api, 'alice', 'sonnet')
    persistSelectedModel(api, 'alice', 'opus')
    await vi.waitFor(() => expect(getPreferredModel).toHaveBeenCalled())
    answer('sonnet')
    await syncing

    expect(getStoredSelectedModel('alice', MODELS)).toBe('opus')
  })

  it('keeps a model picked in another tab while the preference was being fetched', async () => {
    persistSelectedModel(api, 'alice', 'opus')
    await saved()
    let answer!: (preferred: string | null) => void
    getPreferredModel.mockReturnValue(new Promise(resolve => { answer = resolve }))

    const syncing = syncSelectedModel(api)
    await vi.waitFor(() => expect(getPreferredModel).toHaveBeenCalled())
    // The other tab shares this browser's storage, but not this page's state.
    localStorage.setItem('lastSelectedModel:alice', 'sonnet')
    answer('opus')
    await syncing

    expect(getStoredSelectedModel('alice', MODELS)).toBe('sonnet')
  })

  it("keeps the browser's choice when the server can't be reached", async () => {
    persistSelectedModel(api, 'alice', 'sonnet')
    await saved()
    getPreferredModel.mockRejectedValue(new Error('offline'))

    await expect(syncSelectedModel(api)).resolves.toBe('alice')

    expect(getStoredSelectedModel('alice', MODELS)).toBe('sonnet')
  })
})

describe('a browser shared between users', () => {
  const asBob = () => whoami.mockResolvedValue({ type: 'user', id: 'bob', name: 'Bob' })

  it("neither shows nor saves another user's unsaved choice and models", async () => {
    cacheModels('alice', MODELS)
    setPreferredModel.mockRejectedValueOnce(new Error('offline'))
    persistSelectedModel(api, 'alice', 'sonnet')
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled())
    setPreferredModel.mockClear()

    expect(getStoredSelectedModel('bob', MODELS)).toBe('opus')
    expect(getCachedModels('bob')).toEqual([])

    asBob()
    await expect(syncSelectedModel(api)).resolves.toBe('bob')

    expect(setPreferredModel).not.toHaveBeenCalled()
  })

  it('shows and saves nothing until the user is confirmed', async () => {
    cacheModels('alice', MODELS)
    persistSelectedModel(api, 'alice', 'sonnet')
    await saved()

    expect(getStoredSelectedModel(undefined, MODELS)).toBe('opus')
    expect(getCachedModels(undefined)).toEqual([])

    persistSelectedModel(api, undefined, 'opus')
    cacheModels(undefined, [OPUS])
    await saved()

    expect(setPreferredModel).toHaveBeenLastCalledWith('opus')
    expect(getStoredSelectedModel('alice', MODELS)).toBe('sonnet')
    expect(getCachedModels('alice')).toEqual(MODELS)
  })

  it("keeps only the latest user's entries", async () => {
    cacheModels('alice', MODELS)
    persistSelectedModel(api, 'alice', 'sonnet')
    await saved()

    cacheModels('bob', [OPUS])

    expect(Object.keys(localStorage)).toEqual(['cachedModels:bob'])
  })

  it('forgets everything on sign-out', async () => {
    cacheModels('alice', MODELS)
    persistSelectedModel(api, 'alice', 'sonnet')
    await saved()

    forgetModelSelection()

    expect(localStorage.length).toBe(0)
  })
})

describe('storage that fails', () => {
  it('still saves a pick and reads the preference', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('full', 'QuotaExceededError')
    })

    persistSelectedModel(api, 'alice', 'sonnet')
    await syncSelectedModel(api)
    setItem.mockRestore()

    expect(setPreferredModel).toHaveBeenCalledExactlyOnceWith('sonnet')
    expect(getPreferredModel).toHaveBeenCalled()
  })
})

describe('getCachedModels', () => {
  it('returns the models last cached, so a picker can start on them', () => {
    expect(getCachedModels('alice')).toEqual([])

    cacheModels('alice', MODELS)

    expect(getCachedModels('alice')).toEqual(MODELS)
  })

  it('returns none when the cache is unreadable', () => {
    localStorage.setItem('cachedModels:alice', '{not json')

    expect(getCachedModels('alice')).toEqual([])
  })
})

describe('cacheModels', () => {
  it('leaves a full or blocked storage to the caller as no failure', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('quota') })

    expect(() => cacheModels('alice', MODELS)).not.toThrow()
  })
})

describe('persistSelectedModel', () => {
  it('saves picks in the order they were made, however long each save takes', async () => {
    const saved: (string | null)[] = []
    let finishFirst!: () => void
    setPreferredModel.mockImplementationOnce(id => new Promise(resolve => {
      finishFirst = () => { saved.push(id); resolve() }
    }))
    setPreferredModel.mockImplementation(async id => { saved.push(id) })

    persistSelectedModel(api, 'alice', 'sonnet')
    persistSelectedModel(api, 'alice', null)
    await vi.waitFor(() => expect(setPreferredModel).toHaveBeenCalledOnce())
    finishFirst()

    await vi.waitFor(() => expect(saved).toEqual(['sonnet', null]))
  })
})
