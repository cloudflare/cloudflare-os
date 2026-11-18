import { expect, it } from 'vitest'
import { madeTemplatesOf } from './madeTemplates'

it('lists each template with its version, and says which have changes to release', () => {
  expect(madeTemplatesOf([
    { id: 'a', title: 'Counter', description: 'Counts things', version: 3, unpublishedChanges: true },
    { id: 'b', title: 'Tally', description: '', version: 1 },
  ])).toEqual([
    { id: 'a', title: 'Counter', description: 'Counts things', version: 3, changes: true },
    { id: 'b', title: 'Tally', description: '', version: 1 },
  ])
})
