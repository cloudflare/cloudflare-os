import { describe, expect, it, vi } from 'vitest'
import { modelChoiceSettings } from './modelChoiceSettings'
import type { ModelSettings, ModelSettingsState } from './useModelSettings'

const model = (id: string, name: string) => ({ id, name }) as ModelSettings['models'][number]
const models = [model('a', 'Alpha'), model('b', 'Beta')]

const settingsFor = (preferred: string | null, quick: string | null) => {
  const setPreferred = vi.fn<(id: string) => Promise<void>>(async () => {})
  const setQuick = vi.fn<(id: string | null) => Promise<void>>(async () => {})
  const state = { status: 'ready', models, preferred, quick } as ModelSettingsState
  return { setPreferred, setQuick, ...modelChoiceSettings(state, { setPreferred, setQuick }) }
}

describe('modelChoiceSettings', () => {
  it('answers with the first model until one is chosen, or when the one chosen is no longer offered', () => {
    expect(settingsFor(null, null).defaultModel.value).toBe('a')
    expect(settingsFor('gone', null).defaultModel.value).toBe('a')
    expect(settingsFor('b', null).defaultModel.value).toBe('b')
  })

  it('offers no choice for the default model where there are no models', () => {
    const state = { status: 'ready', models: [], preferred: null, quick: null } as unknown as ModelSettingsState
    const { defaultModel } = modelChoiceSettings(state, { setPreferred: async () => {}, setQuick: async () => {} })
    expect(defaultModel.options).toEqual([])
    expect(defaultModel.value).toBe('')
    expect(defaultModel.unavailable).toBeUndefined()
  })

  it('lets the quick model be none, which is kept as no model', async () => {
    const { quickModel, setQuick } = settingsFor(null, 'b')
    expect(quickModel.options.map(({ label }) => label)).toEqual(['None', 'Alpha', 'Beta'])
    await quickModel.set(quickModel.options[0].id)
    expect(setQuick).toHaveBeenCalledWith(null)
    await quickModel.set('a')
    expect(setQuick).toHaveBeenLastCalledWith('a')
  })

  it('shows no quick model as none, and one that is no longer offered by its id', () => {
    const none = settingsFor(null, null).quickModel
    expect(none.options.find(({ id }) => id === none.value)?.label).toBe('None')
    const gone = settingsFor(null, 'gone').quickModel
    expect(gone.options.some(({ id }) => id === gone.value)).toBe(false)
    expect(gone.placeholder).toBe('gone')
  })

  it('is there before the models are read, with nothing to choose from, and says they are being read', () => {
    const { defaultModel, quickModel } = modelChoiceSettings({ status: 'loading' }, { setPreferred: async () => {}, setQuick: async () => {} })
    for (const setting of [defaultModel, quickModel]) {
      expect(setting.unavailable).toEqual({ status: 'loading' })
      expect(setting.title).toMatch(/model/)
    }
    expect(defaultModel.options).toEqual([])
  })

  it('says why the models could not be read, with the way to read them again', () => {
    const retry = vi.fn<() => void>()
    const { defaultModel } = modelChoiceSettings({ status: 'failed', message: 'Offline.', retry }, { setPreferred: async () => {}, setQuick: async () => {} })
    expect(defaultModel.unavailable).toMatchObject({ status: 'failed', message: 'Couldn’t load models: Offline' })
    expect(defaultModel.unavailable?.status === 'failed' && defaultModel.unavailable.retry).toBe(retry)
  })
})
