import { expect, it } from 'vitest'
import { publishStateOf } from './publishState'

it('is unpublished while the workspace has no templates', () => {
  expect(publishStateOf([])).toBe('unpublished')
})

it('has changes when any template has changes to publish', () => {
  expect(publishStateOf([{}, { unpublishedChanges: true }])).toBe('changes')
})

it('is published when every template is as published', () => {
  expect(publishStateOf([{}, {}])).toBe('published')
})
