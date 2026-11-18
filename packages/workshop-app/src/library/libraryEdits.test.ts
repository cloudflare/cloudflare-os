import { describe, expect, it } from 'vitest'
import type { OutputSummary } from '@gadgets/workshop-shared/api'
import type { AsideItem } from '@/aside/asideItems'
import { mayChange, NO_EDITS, templatable, withDeletion, withEdits, withItemEdits, withoutRename, withRename } from './libraryEdits'

const grace = { type: 'user' as const, id: 'grace@example.com', name: 'Grace Hopper' }

const output = (workpieceId: number, title: string, more: Partial<OutputSummary> = {}): OutputSummary => ({
  workspaceId: 'notes',
  workpieceId,
  title,
  workspaceTitle: 'Notes',
  created: new Date(0),
  lastActive: new Date(0),
  ...more,
})

describe('mayChange', () => {
  it('lets whoever builds in its workspace change an output, and not whoever only uses it', () => {
    expect(mayChange(output(1, 'Mine'))).toBe(true)
    expect(mayChange(output(1, 'Built with'), { role: 'build' })).toBe(true)
    expect(mayChange(output(1, 'Used'), { role: 'use' })).toBe(false)
    // Listed, the user's own workspace says no role.
    expect(mayChange(output(1, 'Mine'), {})).toBe(true)
  })

  it('goes by the role kept for it where its workspace is not listed, and a shared one must say it', () => {
    expect(mayChange(output(1, 'Shared', { owner: grace, role: 'build' }))).toBe(true)
    expect(mayChange(output(1, 'Shared', { owner: grace, role: 'use' }))).toBe(false)
    expect(mayChange(output(1, 'Shared before roles', { owner: grace }))).toBe(false)
    // The list's is the newer word.
    expect(mayChange(output(1, 'Downgraded', { owner: grace, role: 'build' }), { role: 'use' })).toBe(false)
  })
})

describe('withEdits', () => {
  const outputs = [output(1, 'Q3 review'), output(2, 'Budget'), output(3, 'Runbook')]

  it('leaves out the deleted and renames the renamed, keeping the rest as they were', () => {
    const edits = withDeletion(withRename(NO_EDITS, outputs[0], 'Q3 platform review'), outputs[1])
    const shown = withEdits(outputs, edits)
    expect(shown.map(({ title }) => title)).toEqual(['Q3 platform review', 'Runbook'])
    expect(shown[1]).toBe(outputs[2])
    expect(NO_EDITS.deleted.size).toBe(0)
  })

  it('shows what it is read as once that is no longer the old title', () => {
    const edits = withRename(NO_EDITS, outputs[0], 'Q3 platform review')
    expect(withEdits([output(1, 'Quarterly review'), ...outputs.slice(1)], edits)[0].title).toBe('Quarterly review')
  })

  it('puts the old title back when the rename is taken back', () => {
    const edits = withoutRename(withRename(NO_EDITS, outputs[0], 'Q3 platform review'), outputs[0])
    expect(withEdits(outputs, edits)[0]).toBe(outputs[0])
  })
})

const item = (workpieceId: number, title: string): AsideItem => ({
  key: String(workpieceId),
  title,
  kind: 'output',
  output: { workspaceId: 'notes', workpieceId, type: 'gadget' },
})

describe('withItemEdits', () => {
  const file: AsideItem = { key: 'file-a', title: 'notes.txt', kind: 'file', file: { id: 'a', name: 'notes.txt', mimeType: 'text/plain', size: 1, workspaceId: 'notes' } }

  it('leaves out the deleted and renames the renamed, an untitled one by the title it is listed as', () => {
    const edits = withDeletion(withRename(withRename(NO_EDITS, output(1, 'Q3 review'), 'Q3 platform review'), output(3, ''), 'Runbook'), output(2, 'Budget'))
    const shown = withItemEdits([item(1, 'Q3 review'), item(2, 'Budget'), item(3, 'Untitled'), file], edits)
    expect(shown.map(({ title }) => title)).toEqual(['Q3 platform review', 'Runbook', 'notes.txt'])
  })

  it('shows the title read once it is no longer the one renamed from', () => {
    const edits = withRename(NO_EDITS, output(1, 'Q3 review'), 'Q3 platform review')
    expect(withItemEdits([item(1, 'Renamed elsewhere')], edits)[0].title).toBe('Renamed elsewhere')
  })
})

describe('templatable', () => {
  it('has what the user may change, by title, whatever it was made as, and not what they may only use', () => {
    const outputs = [
      output(1, 'Zebra counter'),
      output(2, 'Budget', { output: { id: 'spreadsheet', noun: 'Spreadsheet', plural: 'Spreadsheets', icon: 'table' } }),
      output(3, 'Atlas board', { owner: grace, role: 'build' }),
      output(4, 'Only used', { owner: grace, role: 'use' }),
      output(5, ''),
    ]
    // The untitled one by what it is called where it is listed.
    expect(templatable(outputs).map(({ title }) => title)).toEqual(['Atlas board', 'Budget', '', 'Zebra counter'])
  })
})
