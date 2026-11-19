import { describe, expect, it, vi } from 'vitest'
import type { OutputSummary } from '@gadgets/workshop-shared/api'
import { searchMatches } from '@/blocks/searchMatches'
import { libraryEntries } from './libraryEntries'

const output = (workspaceId: string, workpieceId: number, title: string, workspaceTitle: string, noun?: string) =>
  ({ workspaceId, workpieceId, title, workspaceTitle, output: noun ? { noun, icon: 'fileText' } : undefined }) as unknown as OutputSummary

const outputs = [
  output('garden', 1, 'Tip jar', 'Garden planning'),
  output('garden', 2, 'Q3 plan', 'Garden planning', 'Document'),
  output('launch', 3, 'Tip jar', 'Launch readiness'),
  output('launch', 4, '', ''),
]
const build = (onOpen = vi.fn<(output: OutputSummary) => void>()) => ({ onOpen, entries: libraryEntries(outputs, onOpen) })

describe('libraryEntries', () => {
  it('has an entry for each output, in the order given, titled as it is and with its workspace at its end', () => {
    expect(build().entries.map(({ title, detail }) => [title, detail])).toEqual([
      ['Tip jar', 'Garden planning'],
      ['Q3 plan', 'Garden planning'],
      ['Tip jar', 'Launch readiness'],
      ['Untitled', 'Untitled workspace'],
    ])
  })

  it('tells apart outputs that share a title, which keys by workspace as well', () => {
    const keys = build().entries.map(({ key }) => key)
    expect(new Set(keys).size).toBe(4)
    expect(keys[0]).not.toBe(keys[2])
  })

  it('is found by its title and by what kind it is, an app where it has no format', () => {
    const { entries } = build()
    expect(searchMatches('tip', entries).map(({ detail }) => detail)).toEqual(['Garden planning', 'Launch readiness'])
    expect(searchMatches('document', entries).map(({ title }) => title)).toEqual(['Q3 plan'])
    expect(searchMatches('app', entries).map(({ title }) => title)).toEqual(['Tip jar', 'Tip jar', 'Untitled'])
  })

  it('hands the output chosen to be opened', async () => {
    const { entries, onOpen } = build()
    await entries[2].onSelect()
    expect(onOpen).toHaveBeenCalledExactlyOnceWith(outputs[2])
  })
})
