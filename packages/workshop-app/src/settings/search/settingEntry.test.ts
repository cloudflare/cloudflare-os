import { describe, expect, it, vi } from 'vitest'
import { GearIcon } from '@phosphor-icons/react'
import type { SearchPage } from '@/blocks/SearchDialog'
import type { ChoiceSetting, TextSetting, ToggleSetting } from '../settingDefinition'
import { settingEntry } from './settingEntry'

const shared = { section: 'preferences', description: '', icon: GearIcon } as const

const toggle = (overrides: Partial<ToggleSetting> = {}): ToggleSetting => ({ ...shared, kind: 'toggle', title: 'Auto-open outputs', checked: true, set: vi.fn<ToggleSetting['set']>(), ...overrides })
const choice = (overrides: Partial<ChoiceSetting> = {}): ChoiceSetting => ({
  ...shared,
  kind: 'choice',
  title: 'Theme',
  value: 'light',
  options: [{ id: 'light', label: 'Light' }, { id: 'dark', label: 'Dark' }],
  placeholder: 'System',
  set: vi.fn<ChoiceSetting['set']>(),
  ...overrides,
})
const text = (overrides: Partial<TextSetting> = {}): TextSetting => ({ ...shared, kind: 'text', title: 'Display name', value: 'Ada', placeholder: 'Name', set: vi.fn<TextSetting['set']>(async () => {}), ...overrides })

const ok = () => {}
const down = () => {
  throw new Error('Not connected.')
}

describe('settingEntry', () => {
  it('offers nothing for a setting that is not there yet, or a choice with nothing to choose', () => {
    expect(settingEntry(toggle({ soon: true }), ok)).toBeUndefined()
    expect(settingEntry(choice({ options: [] }), ok)).toBeUndefined()
  })

  it('lists a setting under the part of the page it is in', () => {
    expect(settingEntry(toggle(), ok)?.group).toBe('Preferences')
  })

  it('flips a switch in place, showing what it is now as a switch, and stays open to show it', async () => {
    const setting = toggle()
    const entry = settingEntry(setting, ok)!
    expect(entry.on).toBe(true)
    expect(entry.detail).toBeUndefined()
    expect(entry.keepOpen).toBe(true)
    await entry.onSelect()
    expect(setting.set).toHaveBeenCalledWith(false)
  })

  it('shows a switch that is off as off, and no switch for a choice or a line of text', () => {
    expect(settingEntry(toggle({ checked: false }), ok)?.on).toBe(false)
    expect(settingEntry(choice(), ok)?.on).toBeUndefined()
    expect(settingEntry(text(), ok)?.on).toBeUndefined()
  })

  it('goes on from a choice to a page of its options, the one set marked, and sets the one chosen', async () => {
    const setting = choice()
    const entry = settingEntry(setting, ok)!
    expect(entry.detail).toBe('Light')
    // Found by the names of its options, so that typing "dark" finds the theme.
    expect(entry.keywords).toContain('Dark')
    const page = (await entry.onSelect()) as Extract<SearchPage, { kind: 'list' }>
    expect(page.kind).toBe('list')
    expect(page.entries.map(({ title, detail }) => [title, detail])).toEqual([['Light', 'Current'], ['Dark', undefined]])
    await page.entries[1].onSelect()
    expect(setting.set).toHaveBeenCalledWith('dark')
  })

  it('goes on from a line of text to a page to type it in, starting from what it is', async () => {
    const setting = text()
    const entry = settingEntry(setting, ok)!
    expect(entry.title).toBe('Change display name')
    const page = (await entry.onSelect()) as Extract<SearchPage, { kind: 'text' }>
    expect(page).toMatchObject({ kind: 'text', initial: 'Ada', placeholder: 'Name' })
    await page.onSubmit('Grace')
    expect(setting.set).toHaveBeenCalledWith('Grace')
  })

  it('changes nothing the server keeps while the connection is down, and says so', async () => {
    const remote = toggle({ remote: true })
    expect(() => settingEntry(remote, down)!.onSelect()).toThrow('Not connected.')
    expect(remote.set).not.toHaveBeenCalled()

    const page = (await settingEntry(text({ remote: true }), down)!.onSelect()) as Extract<SearchPage, { kind: 'text' }>
    await expect(page.onSubmit('Grace')).rejects.toThrow('Not connected.')

    // A setting of this device's is not held up by it.
    const local = toggle()
    await settingEntry(local, down)!.onSelect()
    expect(local.set).toHaveBeenCalled()
  })

  it('lists a choice whose options are still being read, without its value, and says so if it is chosen', () => {
    const entry = settingEntry(choice({ options: [], unavailable: { status: 'loading' } }), ok)!
    expect(entry.title).toBe('Theme')
    expect(entry.detail).toBeUndefined()
    expect(() => entry.onSelect()).toThrow('Still loading')
  })

  it('lists a choice whose options could not be read as unavailable, and reads them again when it is chosen, saying why', () => {
    const retry = vi.fn<() => void>()
    const entry = settingEntry(choice({ options: [], unavailable: { status: 'failed', message: 'Couldn’t load models: Offline', retry } }), ok)!
    expect(entry.detail).toBe('Unavailable')
    expect(() => entry.onSelect()).toThrow('Couldn’t load models: Offline. Trying again.')
    expect(retry).toHaveBeenCalledOnce()
  })
})
