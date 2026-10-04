import { describe, expect, it } from 'vitest'
import type { AiChatMessage, BlueprintMerge } from '@gadgets/workshop-shared/api'
import type { CodeContent } from '@gadgets/workshop-shared/code-change'
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

  it('finds a mainline merge’s gadget by the file its change wrote', () => {
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

describe('findUnresolvedConflicts', () => {
  const files = [
    { workpieceId: 4, path: 'client.js' },
    { workpieceId: 4, path: 'lib/dates.js' },
    { workpieceId: 4, path: 'removed.js' },
  ]

  it('reports the listed files that still hold a marker', () => {
    const content: CodeContent = new Map([
      [4, new Map([['client.js', 'resolved\n'], ['lib/dates.js', CONFLICTED]])],
    ])
    expect(findUnresolvedConflicts(files, content)).toEqual([
      { workpieceId: 4, path: 'lib/dates.js', line: 2 },
    ])
  })

  it('reports nothing once every marker is gone', () => {
    const content: CodeContent = new Map([
      [4, new Map([['client.js', 'resolved\n'], ['lib/dates.js', 'resolved\n']])],
    ])
    expect(findUnresolvedConflicts(files, content)).toEqual([])
  })

  // A marker in a file no merge reported is the file's own text, such as a guide to git.
  it('does not look in files that no merge listed', () => {
    const content: CodeContent = new Map([[4, new Map([['docs/git.md', CONFLICTED]])]])
    expect(findUnresolvedConflicts(files, content)).toEqual([])
  })
})
