import { describe, expect, it } from 'vitest'
import type { FavoriteItem, OutputSummary } from '@gadgets/workshop-shared/api'
import { favoriteKey, libraryEntries, libraryGroups, recentOrder, removalKey, type LibraryEntry, type LibraryGroup, type LibrarySources, type WorkspaceFile } from './libraryEntries'
import { formatActivity } from '@/workspaces/formatActivity'
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
    expect(gadgets[0]).toMatchObject({ section: 'gadget', builds: true, item: { kind: 'output', key: '2' } })
    expect(files.map((entry) => entry.item.kind)).toEqual(['connected', 'file'])
    expect(files[0]).toMatchObject({ builds: false, removal: { kind: 'external', subjectId: 'doc' } })
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

  it('stars a connected file by its subject, showing it starred only while it is listed', () => {
    const favorites: FavoriteItem[] = [
      { kind: 'external', workspaceId: 'w1', subjectId: 'doc', title: 'Plan', starred: hoursAgo(1) },
      { kind: 'external', workspaceId: 'w1', subjectId: 'unlisted', title: 'Gone', starred: hoursAgo(1) },
    ]
    const { files, favorites: starred } = libraryEntries(sources({ connected: [connected('doc', 2)], favorites }))
    expect(files[0]).toMatchObject({ starred: true, favorite: { kind: 'external', workspaceId: 'w1', subjectId: 'doc', title: 'Plan' } })
    expect(starred.map((entry) => entry.title)).toEqual(['Plan'])
  })

  it('knows starred and removed items by the server’s keys', () => {
    expect(favoriteKey({ kind: 'file', workspaceId: 'w', chatId: 1, fileId: 'f' })).toBe('w:file:1:f')
    expect(favoriteKey({ kind: 'external', workspaceId: 'w', subjectId: 's' })).toBe('w:external:s')
    expect(removalKey({ kind: 'external', workspaceId: 'w', subjectId: 's' })).toBe('w:external:s')
  })
})

// As an order arranges them: one group, keeping the order they came in.
const asGiven = (rest: LibraryEntry[]) => (rest.length > 0 ? [{ key: 'all', label: 'All', entries: rest.map((value) => ({ value })) }] : [])
const titles = (group: LibraryGroup) => group.rows.map((row) => row.entry.title)

describe('libraryGroups', () => {
  const favorites: FavoriteItem[] = [{ kind: 'app', workspaceId: 'w1', workpieceId: 3, title: 'Zeta', starred: hoursAgo(1) }]
  const entries = libraryEntries(sources({
    outputs: [output(1, 'beta', 1), output(2, 'Alpha', 2), output(3, 'Zeta', 3), output(4, 'Older', 24 * 20)],
    files: [file('a', 'notes.pdf', 4)],
    favorites,
  }))

  it('leads with what is starred, in the user’s order, then the rest as the order arranges them', () => {
    const groups = libraryGroups(entries.gadgets, { starOrder: [], arrange: asGiven, orderId: 'active', now })
    expect(groups.map(({ key, label }) => [key, label])).toEqual([['starred', 'Starred'], ['active:all', 'All']])
    expect(titles(groups[1])).toEqual(['beta', 'Alpha', 'Older'])
    expect(groups[1].rows[0].time).toBe(formatActivity(hoursAgo(1), now))
  })

  it('takes the starred it is given, as Recent has some that are not listed', () => {
    const groups = libraryGroups(entries.files, { starred: entries.favorites, starOrder: [], arrange: asGiven, orderId: 'recent', now })
    expect(titles(groups[0])).toEqual(['Zeta'])
  })

  it('leads with what waits on the viewer to approve, out of the groups it would be in, but not what they only use, nor for files', () => {
    const waiting = libraryEntries(sources({
      outputs: [
        { ...output(1, 'beta', 1), waiting: 2 },
        output(2, 'Alpha', 2),
        { ...output(3, 'Zeta', 3), waiting: 1 },
        { ...output(4, 'Shared', 4), waiting: 5, role: 'use' },
      ],
      favorites,
    }))
    expect(waiting.gadgets.map(({ title, waiting: count }) => [title, count])).toEqual([['beta', 2], ['Alpha', undefined], ['Zeta', 1], ['Shared', undefined]])
    const groups = libraryGroups(waiting.gadgets, { starred: waiting.favorites, starOrder: [], arrange: asGiven, orderId: 'active', now })
    expect(groups[0]).toMatchObject({ key: 'waiting', label: 'Needs approval' })
    expect(titles(groups[0])).toEqual(['beta', 'Zeta'])
    // Zeta, starred, is shown once, where it waits.
    expect(groups.slice(1).flatMap(titles)).not.toContain('Zeta')
    expect(libraryGroups(waiting.gadgets, { waiting: false, starOrder: [], arrange: asGiven, orderId: 'active', now }).some((group) => group.key === 'waiting')).toBe(false)
  })
})

describe('recentOrder', () => {
  it('puts what waits first, then the starred in the user’s order, then the rest latest first', () => {
    const favorites: FavoriteItem[] = [
      { kind: 'app', workspaceId: 'w1', workpieceId: 3, title: 'Zeta', starred: hoursAgo(1) },
      { kind: 'app', workspaceId: 'w1', workpieceId: 4, title: 'Older', starred: hoursAgo(2) },
    ]
    const entries = libraryEntries(sources({
      outputs: [output(1, 'beta', 5), { ...output(2, 'Alpha', 9), waiting: 1 }, output(3, 'Zeta', 3), output(4, 'Older', 24 * 20), output(5, 'Gamma', 1)],
      favorites,
    }))
    const keyOf = (title: string) => entries.favorites.find((entry) => entry.title === title)!.key
    const { waiting, stars, rest } = recentOrder(entries.gadgets, { starred: entries.favorites, starOrder: [keyOf('Older'), keyOf('Zeta')] })
    expect([waiting, stars, rest].map((part) => part.map(({ title }) => title))).toEqual([['Alpha'], ['Older', 'Zeta'], ['Gamma', 'beta']])
  })
})
