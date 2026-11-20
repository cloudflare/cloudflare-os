import { describe, expect, it } from 'vitest'
import type { AsideItem } from '@/aside/asideItems'
import { narrowList } from '@gadgets/ui'
import { libraryItemList } from './libraryItemList'

const item = (workpieceId: number, title: string, noun?: string): AsideItem => ({
  key: String(workpieceId),
  title,
  at: new Date(2026, 10, workpieceId),
  kind: 'output',
  output: { workspaceId: 'w', workpieceId, type: 'gadget', format: noun ? { noun, icon: 'fileText' } : undefined },
})

const ITEMS = [item(1, 'Roadmap', 'Document'), item(2, 'Launch tracker'), item(3, 'Launch slides', 'Slides')]
const spec = libraryItemList(ITEMS, ({ key }) => key === '2')
const left = (query: string, ...ids: string[]) =>
  narrowList(ITEMS, { query, searchText: spec.searchText, filters: spec.filters!.filter(({ id }) => ids.includes(id)) }).map(({ key }) => key)

describe('libraryItemList', () => {
  it('searches titles', () => {
    expect(left('launch')).toEqual(['2', '3'])
  })

  it('narrows to what asks something of the viewer, and to the kinds chosen', () => {
    expect(left('', 'waiting')).toEqual(['2'])
    expect(left('', 'type:App', 'type:Slides')).toEqual(['2', '3'])
  })

  it('has no filters for kinds until there is more than one', () => {
    const one = libraryItemList([item(1, 'Roadmap')], () => false)
    expect(one.filters!.map(({ id }) => id)).toEqual(['waiting'])
  })

  it('orders by when they were last active and by name', () => {
    const order = (id: string) => spec.orders.find((each) => each.id === id)!.arrange(ITEMS, 1).flatMap(({ entries }) => entries.map(({ value }) => value.key))
    expect(order('active')).toEqual(['3', '2', '1'])
    expect(order('name')).toEqual(['3', '2', '1'].toSorted((a, b) => ITEMS.find((i) => i.key === a)!.title.localeCompare(ITEMS.find((i) => i.key === b)!.title)))
  })
})
