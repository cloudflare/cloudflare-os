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

    expect(getStoredSelectedModel(MODELS)).toBe('sonnet')
    expect(setPreferredModel).not.toHaveBeenCalled()
  })

  it('follows a model picked in another browser', async () => {
    persistSelectedModel(api, 'opus')
    getPreferredModel.mockResolvedValue('sonnet')

    await syncSelectedModel(api)

    expect(getStoredSelectedModel(MODELS)).toBe('sonnet')
  })

  it('saves a choice made before picks were saved for the user, once', async () => {
    localStorage.setItem('lastSelectedModel', 'sonnet')
    getPreferredModel.mockResolvedValue('opus')

    await syncSelectedModel(api)

    expect(setPreferredModel).toHaveBeenCalledExactlyOnceWith('sonnet')
    expect(getStoredSelectedModel(MODELS)).toBe('sonnet')

    await syncSelectedModel(api)

    expect(setPreferredModel).toHaveBeenCalledOnce()
    expect(getStoredSelectedModel(MODELS)).toBe('opus')
  })

  it("takes the user's preferred model when the earlier choice is refused", async () => {
    localStorage.setItem('lastSelectedModel', 'retired')
    setPreferredModel.mockRejectedValue(new Error('No such model: retired'))
    getPreferredModel.mockResolvedValue('sonnet')

    await syncSelectedModel(api)

    expect(getStoredSelectedModel(MODELS)).toBe('sonnet')
  })

  it('keeps "No agent" in the browser that chose it', async () => {
    persistSelectedModel(api, null)

    await syncSelectedModel(api)

    expect(setPreferredModel).toHaveBeenLastCalledWith(null)

    expect(localStorage.getItem('lastSelectedModel')).toBe(NO_AGENT_OPTION_VALUE)
    expect(getStoredSelectedModel(MODELS)).toBeNull()
  })

  it('keeps a model picked while the preference was being fetched', async () => {
    persistSelectedModel(api, 'opus')
    let answer!: (preferred: string | null) => void
    getPreferredModel.mockReturnValue(new Promise(resolve => { answer = resolve }))

    const syncing = syncSelectedModel(api)
    persistSelectedModel(api, 'sonnet')
    answer('opus')
    await syncing

    expect(getStoredSelectedModel(MODELS)).toBe('sonnet')
  })

  it('saves a pick again when saving it failed, rather than replacing it', async () => {
    setPreferredModel.mockRejectedValueOnce(new Error('offline'))
    persistSelectedModel(api, 'sonnet')
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled())
    getPreferredModel.mockResolvedValue('opus')

    await syncSelectedModel(api)

    expect(setPreferredModel).toHaveBeenLastCalledWith('sonnet')
    expect(getStoredSelectedModel(MODELS)).toBe('sonnet')
  })

  it('keeps a model picked away from and back to while the preference was being fetched', async () => {
    persistSelectedModel(api, 'opus')
    let answer!: (preferred: string | null) => void
    getPreferredModel.mockReturnValue(new Promise(resolve => { answer = resolve }))

    const syncing = syncSelectedModel(api)
    persistSelectedModel(api, 'sonnet')
    persistSelectedModel(api, 'opus')
    await vi.waitFor(() => expect(getPreferredModel).toHaveBeenCalled())
    answer('sonnet')
    await syncing

    expect(getStoredSelectedModel(MODELS)).toBe('opus')
  })

  it('keeps a model picked in another tab while the preference was being fetched', async () => {
    persistSelectedModel(api, 'opus')
    let answer!: (preferred: string | null) => void
    getPreferredModel.mockReturnValue(new Promise(resolve => { answer = resolve }))

    const syncing = syncSelectedModel(api)
    await vi.waitFor(() => expect(getPreferredModel).toHaveBeenCalled())
    // The other tab shares this browser's storage, but not this page's state.
    localStorage.setItem('lastSelectedModel', 'sonnet')
    answer('opus')
    await syncing

    expect(getStoredSelectedModel(MODELS)).toBe('sonnet')
  })

  it("keeps the browser's choice when the server can't be reached", async () => {
    persistSelectedModel(api, 'sonnet')
    getPreferredModel.mockRejectedValue(new Error('offline'))

    await expect(syncSelectedModel(api)).resolves.toBeUndefined()

    expect(getStoredSelectedModel(MODELS)).toBe('sonnet')
  })
})

describe('a browser shared between users', () => {
  it("drops another user's unsaved choice and models instead of saving them", async () => {
    await syncSelectedModel(api)
    cacheModels(MODELS)
    setPreferredModel.mockRejectedValueOnce(new Error('offline'))
    persistSelectedModel(api, 'sonnet')
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled())
    setPreferredModel.mockClear()

    whoami.mockResolvedValue({ type: 'user', id: 'bob', name: 'Bob' })
    getPreferredModel.mockResolvedValue('opus')
    await syncSelectedModel(api)

    expect(setPreferredModel).not.toHaveBeenCalled()
    expect(getStoredSelectedModel(MODELS)).toBe('opus')
    expect(getCachedModels()).toEqual([])
  })

  it('still saves an unsaved choice for the user who made it', async () => {
    await syncSelectedModel(api)
    setPreferredModel.mockRejectedValueOnce(new Error('offline'))
    persistSelectedModel(api, 'sonnet')
    await vi.waitFor(() => expect(console.error).toHaveBeenCalled())

    await syncSelectedModel(api)

    expect(setPreferredModel).toHaveBeenLastCalledWith('sonnet')
  })

  it('forgets everything on sign-out', () => {
    cacheModels(MODELS)
    persistSelectedModel(api, 'sonnet')

    forgetModelSelection()

    expect(getCachedModels()).toEqual([])
    expect(getStoredSelectedModel(MODELS)).toBe('opus')
  })
})

describe('getCachedModels', () => {
  it('returns the models last cached, so a picker can start on them', () => {
    expect(getCachedModels()).toEqual([])

    cacheModels(MODELS)

    expect(getCachedModels()).toEqual(MODELS)
  })

  it('returns none when the cache is unreadable', () => {
    localStorage.setItem('cachedModels', '{not json')

    expect(getCachedModels()).toEqual([])
  })
})

describe('cacheModels', () => {
  it('leaves a full or blocked storage to the caller as no failure', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => { throw new Error('quota') })

    expect(() => cacheModels(MODELS)).not.toThrow()
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

    persistSelectedModel(api, 'sonnet')
    persistSelectedModel(api, null)
    await vi.waitFor(() => expect(setPreferredModel).toHaveBeenCalledOnce())
    finishFirst()

    await vi.waitFor(() => expect(saved).toEqual(['sonnet', null]))
  })
})
