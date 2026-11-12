// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RpcStub } from 'capnweb'
import type { AiChatAuthorInfo, AuthenticatedApi } from '@gadgets/workshop-shared/api'
import {
  cacheModels,
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
const api = { getPreferredModel, setPreferredModel } as unknown as RpcStub<AuthenticatedApi>

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
  getPreferredModel.mockResolvedValue(null)
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
    expect(setPreferredModel).toHaveBeenLastCalledWith(null)

    await syncSelectedModel(api)

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

  it("keeps the browser's choice when the server can't be reached", async () => {
    persistSelectedModel(api, 'sonnet')
    getPreferredModel.mockRejectedValue(new Error('offline'))

    await expect(syncSelectedModel(api)).resolves.toBeUndefined()

    expect(getStoredSelectedModel(MODELS)).toBe('sonnet')
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
