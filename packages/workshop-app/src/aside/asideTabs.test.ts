import { describe, expect, it } from 'vitest'
import { closeTab, openTab, selectTab, type AsideItem, type AsideTabs } from './asideTabs'

const item = (key: string, title = key.toUpperCase()): AsideItem => ({
  key,
  title,
  kind: 'file',
  file: { id: key, name: title, mimeType: 'text/plain', size: 0 },
})
const tabs = (keys: string[], activeKey: string): AsideTabs => ({ items: keys.map((key) => item(key)), activeKey })

describe('asideTabs', () => {
  it('opens after what is open already, and shows what it opened', () => {
    expect(openTab(undefined, item('a'))).toEqual(tabs(['a'], 'a'))
    expect(openTab(tabs(['a', 'b'], 'a'), item('c'))).toEqual(tabs(['a', 'b', 'c'], 'c'))
  })

  it('shows what is open already where it is, under the title it has now', () => {
    const renamed = item('a', 'Renamed')
    expect(openTab(tabs(['a', 'b'], 'b'), renamed)).toEqual({ items: [renamed, item('b')], activeKey: 'a' })
  })

  it('selects only what is open', () => {
    expect(selectTab(tabs(['a', 'b'], 'a'), 'b')).toEqual(tabs(['a', 'b'], 'b'))
    expect(selectTab(tabs(['a', 'b'], 'a'), 'c')).toEqual(tabs(['a', 'b'], 'a'))
  })

  it('shows the next one when the one shown is closed, or the one before when it was last', () => {
    expect(closeTab(tabs(['a', 'b', 'c'], 'b'), 'b')).toEqual(tabs(['a', 'c'], 'c'))
    expect(closeTab(tabs(['a', 'b', 'c'], 'c'), 'c')).toEqual(tabs(['a', 'b'], 'b'))
  })

  it('keeps showing the same one when another is closed', () => {
    expect(closeTab(tabs(['a', 'b', 'c'], 'c'), 'a')).toEqual(tabs(['b', 'c'], 'c'))
  })

  it('leaves nothing open when the only one is closed', () => {
    expect(closeTab(tabs(['a'], 'a'), 'a')).toBeUndefined()
  })
})
