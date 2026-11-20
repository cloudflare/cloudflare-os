import { expect, it } from 'vitest'
import { madeTemplatesOf } from './madeTemplates'

it('lists each template with its version, and says what each has to release', () => {
  expect(madeTemplatesOf([
    { id: 'a', title: 'Counter', description: 'Counts things', version: 3, unpublishedChanges: { code: true } },
    { id: 'b', title: 'Tally', description: '', version: 1 },
    { id: 'c', title: 'Notes', description: '', version: 2, unpublishedChanges: { bindings: true } },
  ])).toEqual([
    { id: 'a', title: 'Counter', description: 'Counts things', version: 3, changes: { code: true } },
    { id: 'b', title: 'Tally', description: '', version: 1 },
    { id: 'c', title: 'Notes', description: '', version: 2, changes: { bindings: true } },
  ])
})
