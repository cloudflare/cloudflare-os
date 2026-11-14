import { describe, expect, it } from 'vitest'
import type { FavoriteItem, OutputSummary } from '@gadgets/workshop-shared/api'
import { favoriteKey, libraryEntries, libraryGroups, removalKey, type LibrarySources, type WorkspaceFile } from './libraryEntries'
import type { ConnectedFile } from './connectedFiles'

const now = new Date(2026, 10, 14, 12)
const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 60 * 60 * 1000)

const output = (workpieceId: number, title: string, hours: number, workspaceId = 'w1'): OutputSummary => ({
  workspaceId,
  workpieceId,
  title,
  workspaceTitle: 'Home',
  created: hoursAgo(hours + 1),
  lastActive: hoursAgo(hours),
}) as OutputSummary

const file = (id: string, name: string, hours: number): WorkspaceFile => ({
  workspaceId: 'w1',
  workspaceTitle: 'Home',
  chatId: 3,
  id,
  name,
  mimeType: 'application/pdf',
  size: 10,
  attached: hoursAgo(hours),
})

const connected = (subjectId: string, hours: number): ConnectedFile => ({
  workspaceId: 'w1',
  gatekeeperId: 2,
  subjectId,
  title: 'Plan',
  url: `https://docs.google.com/document/d/${subjectId}/edit`,
  kind: 'document',
  at: hoursAgo(hours),
})

const sources = (overrides: Partial<LibrarySources> = {}): LibrarySources => ({
  outputs: [],
  files: [],
  connected: [],
  favorites: [],
  removals: new Map(),
  builds: new Set(),
  ...overrides,
})

describe('libraryEntries', () => {
  it('lists gadgets and files latest first, with what can be done with each', () => {
    const { gadgets, files } = libraryEntries(sources({
      outputs: [output(1, 'Old', 30), output(2, 'New', 1)],
      files: [file('a', 'a.pdf', 5)],
      connected: [connected('doc', 2)],
      builds: new Set(['w1']),
    }))
    expect(gadgets.map((entry) => entry.title)).toEqual(['New', 'Old'])
    expect(gadgets[0]).toMatchObject({ section: 'gadget', canDelete: true, item: { kind: 'output', key: '2' } })
    expect(files.map((entry) => entry.item.kind)).toEqual(['connected', 'file'])
    expect(files[0]).toMatchObject({ canDelete: false, removal: { kind: 'external', subjectId: 'doc' } })
    expect(files[1]).toMatchObject({ chatId: 3, favorite: { kind: 'file', fileId: 'a', mimeType: 'application/pdf' } })
  })

  it('leaves out what was taken out, unless a connected file was worked on since', () => {
    const removals = new Map([
      [removalKey({ kind: 'app', workspaceId: 'w1', workpieceId: 1 }), hoursAgo(0)],
      [removalKey({ kind: 'external', workspaceId: 'w1', subjectId: 'again' }), hoursAgo(10)],
      [removalKey({ kind: 'external', workspaceId: 'w1', subjectId: 'gone' }), hoursAgo(1)],
    ])
    const { gadgets, files } = libraryEntries(sources({
      outputs: [output(1, 'Removed', 5), output(2, 'Kept', 5)],
      connected: [connected('again', 2), connected('gone', 5)],
      removals,
    }))
    expect(gadgets.map((entry) => entry.title)).toEqual(['Kept'])
    expect(files.map((entry) => entry.removal)).toEqual([{ kind: 'external', workspaceId: 'w1', subjectId: 'again' }])
  })

  it('keeps a starred item the listings do not have, from what starring it recorded', () => {
    const favorites: FavoriteItem[] = [
      { kind: 'file', workspaceId: 'w9', chatId: 1, fileId: 'f', title: 'Far.pdf', mimeType: 'application/pdf', starred: hoursAgo(3) },
      { kind: 'chat', workspaceId: 'w1', chatId: 1, title: 'A chat', starred: hoursAgo(2) },
      { kind: 'app', workspaceId: 'w1', workpieceId: 2, title: 'Old name', starred: hoursAgo(1) },
    ]
    const { favorites: starred, gadgets } = libraryEntries(sources({ outputs: [output(2, 'Listed', 5)], favorites }))
    expect(starred.map((entry) => entry.title)).toEqual(['Far.pdf', 'Listed'])
    expect(starred.every((entry) => entry.starred)).toBe(true)
    expect(gadgets[0].starred).toBe(true)
  })

  it('knows starred and removed items by the server’s keys', () => {
    expect(favoriteKey({ kind: 'file', workspaceId: 'w', chatId: 1, fileId: 'f' })).toBe('w:file:1:f')
    expect(removalKey({ kind: 'external', workspaceId: 'w', subjectId: 's' })).toBe('w:external:s')
  })
})

describe('libraryGroups', () => {
  const favorites: FavoriteItem[] = [{ kind: 'app', workspaceId: 'w1', workpieceId: 3, title: 'Zeta', starred: hoursAgo(1) }]
  const entries = libraryEntries(sources({
    outputs: [output(1, 'beta', 1), output(2, 'Alpha', 2), output(3, 'Zeta', 3), output(4, 'Older', 24 * 20)],
    files: [file('a', 'notes.pdf', 4)],
    favorites,
  }))

  it('leads with what is starred, then groups the rest by when', () => {
    const groups = libraryGroups(entries, { tab: 'gadgets', sort: 'recent' }, now)
    expect(groups.map((group) => group.label)).toEqual(['Starred', 'Today', 'October'])
    expect(groups[1].rows.map((row) => row.entry.title)).toEqual(['beta', 'Alpha'])
  })

  it('puts the rest in one group by name when asked', () => {
    const groups = libraryGroups(entries, { tab: 'gadgets', sort: 'name' }, now)
    expect(groups.map((group) => group.label)).toEqual(['Starred', 'A to Z'])
    expect(groups[1].rows.map((row) => row.entry.title)).toEqual(['Alpha', 'beta', 'Older'])
  })

  it('shows favorites, then what was worked on last, across gadgets and files', () => {
    const groups = libraryGroups(entries, { tab: 'favorites', sort: 'recent' }, now)
    expect(groups.map((group) => group.label)).toEqual(['Starred', 'Recent'])
    expect(groups[1].rows.map((row) => row.entry.title)).toEqual(['beta', 'Alpha', 'notes.pdf', 'Older'])
  })

  it('keeps what has every word searched for, in its name or its workspace’s', () => {
    expect(libraryGroups(entries, { tab: 'files', sort: 'recent', query: 'NOTES home' }, now)).toHaveLength(1)
    expect(libraryGroups(entries, { tab: 'files', sort: 'recent', query: 'nothing' }, now)).toEqual([])
  })
})
