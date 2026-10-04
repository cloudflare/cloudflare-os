import { describe, expect, it } from 'vitest'
import type { AiChatMessage, BlueprintMerge, FileAtCommit } from '@gadgets/workshop-shared/api'
import type { ChatContentSnapshot } from '../code/otClient'
import {
  findConflictMarkerLine,
  findUnresolvedConflicts,
  listConflictedFiles,
} from './mergeConflicts'

type ChangesMessage = Extract<AiChatMessage, { type: 'changes' }>

const changes = (sequence: number, over: Partial<ChangesMessage>): AiChatMessage => ({
  chatId: 1,
  sequence,
  timestamp: new Date(0),
  author: { type: 'user', id: 'dev', name: 'Dev' },
  type: 'changes',
  ...over,
})

const blueprintMerge = (gadgetId: number, conflictPaths: string[]): BlueprintMerge => ({
  gadgetId,
  blueprintId: 'blueprint',
  title: 'Trip planner',
  version: 2,
  commitId: 'release',
  kind: 'merge',
  baseCommit: 'base',
  conflictPaths,
})

const allPending = (messages: AiChatMessage[]) =>
  new Map(messages.map(message => [message.sequence, 'pending' as const]))

const CONFLICTED = [
  'const a = 1',
  '<<<<<<< this gadget',
  'const b = 2',
  '||||||| base',
  'const b = 0',
  '=======',
  'const b = 3',
  '>>>>>>> blueprint',
  '',
].join('\n')

describe('listConflictedFiles', () => {
  it('takes a blueprint merge’s paths as paths within its gadget', () => {
    const messages = [
      changes(0, { blueprintMerges: [blueprintMerge(4, ['client.js', 'lib/dates.js'])] }),
    ]
    expect(listConflictedFiles(messages, allPending(messages))).toEqual([
      { workpieceId: 4, path: 'client.js' },
      { workpieceId: 4, path: 'lib/dates.js' },
    ])
  })

  it('takes a mainline merge’s paths from its gadgets', () => {
    const messages = [
      changes(0, {
        mainlineMerge: {
          conflictPaths: ['PLANNER/lib/dates.js', 'SERVER/api.js'],
          gadgets: [
            { gadgetId: 4, baseCommit: 'b', chatCommit: 's', conflictPaths: ['lib/dates.js'] },
            { gadgetId: 9, baseCommit: 'b', chatCommit: 's', conflictPaths: ['api.js'] },
          ],
        },
        pins: [
          { gadgetId: 4, baseCommit: 'm4', mergedCommit: 'h4' },
          { gadgetId: 9, baseCommit: 'm9', mergedCommit: 'h9' },
        ],
      }),
    ]
    expect(listConflictedFiles(messages, allPending(messages))).toEqual([
      { workpieceId: 4, path: 'lib/dates.js' },
      { workpieceId: 9, path: 'api.js' },
    ])
  })

  it('finds the gadget of a mainline merge recorded as a change by the file it wrote', () => {
    const messages = [
      changes(0, {
        mainlineMerge: { conflictPaths: ['PLANNER/lib/dates.js'] },
        change: {
          4: [['lib/dates.js', { set: CONFLICTED }], ['client.js', { set: 'merged cleanly' }]],
          9: [['server.js', { set: 'merged cleanly' }]],
        },
      }),
    ]
    expect(listConflictedFiles(messages, allPending(messages))).toEqual([
      { workpieceId: 4, path: 'lib/dates.js' },
    ])
  })

  it('lists a file once however many merges conflicted in it', () => {
    const messages = [
      changes(0, { blueprintMerges: [blueprintMerge(4, ['client.js'])] }),
      changes(1, {
        mainlineMerge: { conflictPaths: ['PLANNER/client.js'] },
        change: { 4: [['client.js', { set: CONFLICTED }]] },
      }),
    ]
    expect(listConflictedFiles(messages, allPending(messages))).toEqual([
      { workpieceId: 4, path: 'client.js' },
    ])
  })

  it('leaves out merges that were reverted or already accepted', () => {
    const messages = [
      changes(0, { blueprintMerges: [blueprintMerge(4, ['accepted.js'])] }),
      changes(1, { blueprintMerges: [blueprintMerge(4, ['reverted.js'])] }),
      changes(2, { blueprintMerges: [blueprintMerge(4, ['proposed.js'])] }),
    ]
    const status = new Map([[0, 'merged'], [1, 'reverted'], [2, 'pending']] as const)
    expect(listConflictedFiles(messages, status)).toEqual([{ workpieceId: 4, path: 'proposed.js' }])
  })
})

describe('findConflictMarkerLine', () => {
  it('finds the line that opens a conflict', () => {
    expect(findConflictMarkerLine(CONFLICTED)).toBe(2)
  })

  it('finds a closing marker left behind on its own', () => {
    expect(findConflictMarkerLine('const b = 3\n>>>>>>> blueprint\n')).toBe(2)
    expect(findConflictMarkerLine('>>>>>>> blueprint\n')).toBe(1)
  })

  it('takes nothing else for a marker', () => {
    expect(findConflictMarkerLine('const a = 1\n')).toBeUndefined()
    // Not at the start of a line, not followed by a label, and a Markdown heading's underline.
    expect(findConflictMarkerLine('  <<<<<<< this gadget\n')).toBeUndefined()
    expect(findConflictMarkerLine('<<<<<<<\n>>>>>>>\n')).toBeUndefined()
    expect(findConflictMarkerLine('Title\n=======\n')).toBeUndefined()
  })
})

// The chat's content for gadget 4, which is pinned at the merge commit.
const snapshot = (texts: Record<string, string | null>): ChatContentSnapshot =>
  (gadgetId, path) => gadgetId === 4 ? texts[path] : undefined
const pinnedAtMerge = (gadgetId: number) => gadgetId === 4 ? 'merge' : undefined

describe('findUnresolvedConflicts', () => {
  const files = [
    { workpieceId: 4, path: 'client.js' },
    { workpieceId: 4, path: 'lib/dates.js' },
    { workpieceId: 4, path: 'removed.js' },
  ]

  // The merge commit the gadget is pinned at, as the server would answer for it.
  const MERGE_FILES: Record<string, string> = {
    'client.js': CONFLICTED, 'lib/dates.js': CONFLICTED, 'removed.js': CONFLICTED,
  }
  const reads: { commitId: string; paths: readonly string[] }[] = []
  const readFiles = async (commitId: string, paths: readonly string[]) => {
    reads.push({ commitId, paths })
    return new Map(paths.map((path): [string, FileAtCommit] => {
      const text = commitId === 'merge' ? MERGE_FILES[path] : undefined
      return [path, text === undefined ? { kind: 'absent' } : { kind: 'text', text }]
    }))
  }

  it('reports the listed files that still hold a marker', async () => {
    const content =
      snapshot({ 'client.js': 'resolved\n', 'lib/dates.js': CONFLICTED, 'removed.js': null })
    expect(await findUnresolvedConflicts(files, content, pinnedAtMerge, readFiles)).toEqual([
      { workpieceId: 4, path: 'lib/dates.js', line: 2 },
    ])
  })

  it('reports nothing once every marker is gone', async () => {
    const content =
      snapshot({ 'client.js': 'resolved\n', 'lib/dates.js': 'resolved\n', 'removed.js': null })
    expect(await findUnresolvedConflicts(files, content, pinnedAtMerge, readFiles)).toEqual([])
  })

  // A merge that is a commit wrote its markers there, not into the chat's content, so a file
  // nobody has opened since holds them only at the pin's base.
  it('reads a file the chat has not touched from the commit it is pinned at', async () => {
    reads.length = 0
    const content = snapshot({ 'client.js': 'resolved\n', 'removed.js': null })
    expect(await findUnresolvedConflicts(files, content, pinnedAtMerge, readFiles)).toEqual([
      { workpieceId: 4, path: 'lib/dates.js', line: 2 },
    ])
    expect(reads).toEqual([{ commitId: 'merge', paths: ['lib/dates.js'] }])

    expect(await findUnresolvedConflicts(
      files,
      snapshot({ 'client.js': 'resolved\n', 'lib/dates.js': 'resolved\n', 'removed.js': null }),
      pinnedAtMerge, readFiles)).toEqual([])
  })

  // A marker in a file no merge reported is the file's own text, such as a guide to git.
  it('does not look in files that no merge listed', async () => {
    const content = snapshot({ 'docs/git.md': CONFLICTED, 'removed.js': null })
    expect(await findUnresolvedConflicts(files, content, () => undefined, readFiles)).toEqual([])
  })
})
