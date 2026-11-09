import { describe, expect, it } from 'vitest'
import type { ActionLogEntry } from '@gadgets/workshop-shared/api'
import { externalFiles } from './externalFiles'

const DOC = 'application/vnd.google-apps.document'
const workspace = { id: 'w1', title: 'Planning' }

const base = (id: number, at: number) => ({
  id, gatekeeperId: 7, resourceTitle: 'Google Drive', createdAt: new Date(at), state: 'approved' as const,
})

const read = (id: number, at: number, fileId: string, title: string): ActionLogEntry => ({
  ...base(id, at), type: 'observation',
  description: { summary: 'Read', subject: {
    id: fileId, title, url: `https://docs.google.com/document/d/${fileId}/edit`, mediaType: DOC, role: 'read',
  } },
} as ActionLogEntry)

const creation = (id: number, at: number, state: 'pending' | 'approved' | 'rejected', url?: string): ActionLogEntry => ({
  ...base(id, at), type: 'action', state, creation: true, resourceTitle: 'Trip plan',
  ...(url ? { resourceUrl: url } : {}),
  description: { summary: 'Create a document' },
} as ActionLogEntry)

describe('externalFiles', () => {
  it('lists each file an entry names once, as of its latest entry, newest first', () => {
    const files = externalFiles([read(3, 300, 'a', 'Budget v2'), read(2, 200, 'b', 'Notes'), read(1, 100, 'a', 'Budget')], workspace)
    expect(files.map(f => [f.subjectId, f.title, f.kind])).toEqual([['a', 'Budget v2', 'document'], ['b', 'Notes', 'document']])
    expect(files[0]).toMatchObject({ workspaceId: 'w1', workspaceTitle: 'Planning', gatekeeperId: 7 })
  })

  it('lists a created file once it exists, and not before or if it never was', () => {
    const made = 'https://docs.google.com/document/d/new1/edit'
    expect(externalFiles([creation(1, 100, 'approved', made)], workspace))
      .toMatchObject([{ subjectId: 'new1', title: 'Trip plan', kind: 'document', mediaType: DOC }])
    expect(externalFiles([creation(1, 100, 'pending'), creation(2, 100, 'rejected')], workspace)).toEqual([])
  })

  it('leaves out what is not a file, such as an issue', () => {
    const issue = {
      ...base(1, 100), type: 'action', resourceTitle: 'Linear',
      description: { summary: 'Create issue', subject: { id: 'ENG-1', title: 'Bug', url: 'https://linear.app/x/issue/ENG-1', role: 'created' } },
    } as ActionLogEntry
    const createdIssue = { ...creation(2, 100, 'approved', 'https://linear.app/x/issue/ENG-2') }
    expect(externalFiles([issue, createdIssue], workspace)).toEqual([])
  })
})
