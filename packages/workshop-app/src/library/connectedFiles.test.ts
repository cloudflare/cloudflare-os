import { describe, expect, it } from 'vitest'
import type { ActionLogEntry } from '@gadgets/workshop-shared/api'
import { connectedFiles } from './connectedFiles'

const DOC = 'application/vnd.google-apps.document'

const base = (id: number, at: number) => ({
  id, gatekeeperId: 7, resourceTitle: 'Google Drive', createdAt: new Date(at), state: 'approved' as const,
})

const read = (id: number, at: number, fileId: string, title: string): ActionLogEntry => ({
  ...base(id, at), type: 'observation',
  description: { title: 'Read', description: 'Read it', subject: {
    id: fileId, title, url: `https://docs.google.com/document/d/${fileId}/edit`, mediaType: DOC, role: 'read',
  } },
} as ActionLogEntry)

const creation = (id: number, at: number, state: 'pending' | 'approved' | 'rejected', url?: string): ActionLogEntry => ({
  ...base(id, at), type: 'action', state, creation: true, resourceTitle: 'Trip plan', chatId: 3,
  ...(url ? { resourceUrl: url } : {}),
  description: { title: 'Create a document', description: '', implementsRevert: false, autoApprovable: false },
} as ActionLogEntry)

describe('connectedFiles', () => {
  it('lists each file an entry names once, as of its latest entry, latest first', () => {
    const files = connectedFiles([read(3, 300, 'a', 'Budget v2'), read(2, 200, 'b', 'Notes'), read(1, 100, 'a', 'Budget')], 'w1')
    expect(files.map((file) => [file.subjectId, file.title, file.kind])).toEqual([['a', 'Budget v2', 'document'], ['b', 'Notes', 'document']])
    expect(files[0]).toMatchObject({ workspaceId: 'w1', gatekeeperId: 7, at: new Date(300) })
  })

  it('lists a made file once it is made, with the chat it was made in, and not before or if it never was', () => {
    const made = 'https://docs.google.com/document/d/new1/edit'
    expect(connectedFiles([creation(1, 100, 'approved', made)], 'w1')).toMatchObject([{ subjectId: 'new1', title: 'Trip plan', kind: 'document', chatId: 3 }])
    expect(connectedFiles([creation(1, 100, 'pending', made), creation(2, 100, 'rejected', made)], 'w1')).toEqual([])
  })

  it('leaves out what is not a file, such as an issue', () => {
    const issue = {
      ...base(1, 100), type: 'action', resourceTitle: 'Linear',
      description: { title: 'Create issue', description: '', implementsRevert: false, autoApprovable: false, subject: { id: 'ENG-1', title: 'Bug', url: 'https://linear.app/x/issue/ENG-1', role: 'created' } },
    } as ActionLogEntry
    expect(connectedFiles([issue, creation(2, 100, 'approved', 'https://linear.app/x/issue/ENG-2')], 'w1')).toEqual([])
  })
})
