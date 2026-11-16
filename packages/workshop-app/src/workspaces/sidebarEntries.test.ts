import { describe, expect, it } from 'vitest'
import type { UnreadThread, WorkspaceMetadataWithTimestamps } from '@gadgets/workshop-shared/api'
import { sidebarEntries } from './sidebarEntries'

const day = (n: number) => new Date(2026, 10, n, 10)
const workspace = (id: string, title: string, lastActive: Date): WorkspaceMetadataWithTimestamps => ({ id, title, created: day(1), lastActive })
const thread = (workspaceId: string, chatId: number, chatTitle: string, at: Date, rest: Partial<UnreadThread> = {}): UnreadThread => ({
  workspaceId, chatId, chatTitle, latestActivityAt: at, latestSequence: 1, unreadMessageCount: 0, readThroughSequence: 1, ...rest,
})

const WORKSPACES = [{ ...workspace('w', 'Platform', day(9)), kind: 'workspace' as const }, workspace('e', 'Empty', day(7))]

describe('sidebarEntries', () => {
  it('lists each chat on its own row, named with its workspace, most recent first, and a workspace with no chats as one row', () => {
    const entries = sidebarEntries(WORKSPACES, [thread('w', 1, 'Jira dashboard', day(8)), thread('w', 2, '', day(10), { unreadMessageCount: 3 })])
    expect(entries.map(({ key, title, workspaceTitle, unread }) => [key, title, workspaceTitle, unread])).toEqual([
      ['chat:w/2', 'Untitled chat', 'Platform', true],
      ['chat:w/1', 'Jira dashboard', 'Platform', false],
      ['workspace:e', 'Empty', 'Empty', false],
    ])
  })

  it('says which chats are in a named workspace, and which are on their own', () => {
    const entries = sidebarEntries([...WORKSPACES, workspace('c', 'Meeting brief', day(6))], [thread('w', 1, 'Jira dashboard', day(8)), thread('c', 0, 'Meeting brief', day(6))])
    expect(entries.map(({ key, named }) => [key, named])).toEqual([['chat:w/1', true], ['workspace:e', false], ['chat:c/0', false]])
  })

  it('leaves out archived and unjoined chats, unless one is open, agent-started ones even then, and chats of workspaces not listed', () => {
    const threads = [
      thread('w', 1, 'Archived', day(8), { archived: true }),
      thread('w', 2, 'Someone else’s', day(8), { unjoined: true }),
      thread('w', 3, 'Daily digest run', day(8), { spawnerName: 'Daily digest' }),
      thread('gone', 4, 'Elsewhere', day(8)),
    ]
    expect(sidebarEntries(WORKSPACES, threads).map(({ key }) => key)).toEqual(['workspace:w', 'workspace:e'])
    expect(sidebarEntries(WORKSPACES, threads, { workspaceId: 'w', chatId: 1 }).map(({ key }) => key)).toEqual(['chat:w/1', 'workspace:e'])
    expect(sidebarEntries(WORKSPACES, threads, { workspaceId: 'w', chatId: 3 }).map(({ key }) => key)).toEqual(['workspace:w', 'workspace:e'])
  })
})
