// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { act } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ActionLogEntry } from '@gadgets/workshop-shared/api'
import { entry, makeTestRoot, pushEntry } from '../../action-test-harness'
import { ApproveControl } from './ApproveControl'
import { isPush, reviewsBeforeApproving } from './pushApproval'

const view = makeTestRoot()
afterEach(() => view.cleanup())

describe('isPush', () => {
  it('is an action that names the commits it sends', () => {
    expect(isPush(pushEntry(1))).toBe(true)
  })

  it('is not an action that names none', () => {
    expect(isPush(entry(1))).toBe(false)
    expect(isPush(entry(1, {
      description: { title: 'Push', description: '', implementsRevert: false, pushedCommits: [] },
    }))).toBe(false)
  })

  it('is neither an observation nor a hook binding', () => {
    expect(isPush(entry(1, { type: 'observation' }))).toBe(false)
    expect(isPush(entry(1, { type: 'bindHook' }))).toBe(false)
  })
})

describe('reviewsBeforeApproving', () => {
  it('holds for a push in a restricted workspace only', () => {
    expect(reviewsBeforeApproving(pushEntry(1), true)).toBe(true)
    expect(reviewsBeforeApproving(pushEntry(1), false)).toBe(false)
    expect(reviewsBeforeApproving(entry(1), true)).toBe(false)
  })

  it('reads a workspace whose mark is not known yet as unrestricted', () => {
    expect(reviewsBeforeApproving(pushEntry(1), undefined)).toBe(false)
  })
})

describe('ApproveControl', () => {
  const onApprove = vi.fn<() => void>()
  const onReviewPush = vi.fn<() => void>()
  afterEach(() => {
    onApprove.mockClear()
    onReviewPush.mockClear()
  })

  const show = (
    record: ActionLogEntry, restricted: boolean | undefined, disabled = false, variant?: 'quiet' | 'filled',
  ) => view.render(
    <ApproveControl
      record={record}
      restricted={restricted}
      variant={variant}
      disabled={disabled}
      describedBy="notice request"
      onApprove={onApprove}
      onReviewPush={onReviewPush}
    />,
  )
  const buttons = () => [...document.querySelectorAll('button')]
  const labels = () => buttons().map(button => button.textContent)
  const click = (label: string) => act(async () => buttons().find(button => button.textContent === label)!.click())

  it('is Approve alone for a request that is not a push, restricted or not', async () => {
    await show(entry(1), true)
    expect(labels()).toEqual(['Approve'])

    await click('Approve')
    expect(onApprove).toHaveBeenCalledTimes(1)
  })

  it('offers Review commits beside Approve for a push in an unrestricted workspace', async () => {
    await show(pushEntry(1), false)
    expect(labels()).toEqual(['Review commits', 'Approve'])

    await click('Review commits')
    expect(onReviewPush).toHaveBeenCalledTimes(1)
    expect(onApprove).not.toHaveBeenCalled()
    await click('Approve')
    expect(onApprove).toHaveBeenCalledTimes(1)
  })

  it('offers Review commits in place of Approve for a push in a restricted workspace', async () => {
    await show(pushEntry(1), true)
    expect(labels()).toEqual(['Review commits'])
    expect(buttons()[0].getAttribute('aria-describedby')).toBe('notice request')

    await click('Review commits')
    expect(onReviewPush).toHaveBeenCalledTimes(1)
    expect(onApprove).not.toHaveBeenCalled()
  })

  it('keeps Approve while the mark is not known yet', async () => {
    await show(pushEntry(1), undefined)
    expect(labels()).toEqual(['Review commits', 'Approve'])
  })

  // The brand fill is what marks the one control a blocking request is waiting on.
  const filled = () => buttons()
    .filter(button => button.classList.contains('bg-kumo-brand'))
    .map(button => button.textContent)

  it('fills Review commits where it stands in a filled Approve\'s place', async () => {
    await show(pushEntry(1), true, false, 'filled')
    expect(labels()).toEqual(['Review commits'])
    expect(filled()).toEqual(['Review commits'])
  })

  it('leaves Review commits quiet beside a filled Approve', async () => {
    await show(pushEntry(1), false, false, 'filled')
    expect(labels()).toEqual(['Review commits', 'Approve'])
    expect(filled()).toEqual(['Approve'])
  })

  it('fills nothing in the quiet variant', async () => {
    await show(pushEntry(1), true)
    expect(filled()).toEqual([])
    await show(pushEntry(1), false)
    expect(filled()).toEqual([])
  })

  it('disables every control it renders', async () => {
    await show(pushEntry(1), false, true)
    expect(buttons().map(button => button.disabled)).toEqual([true, true])

    await show(pushEntry(1), true, true)
    expect(buttons().map(button => button.disabled)).toEqual([true])
  })
})
