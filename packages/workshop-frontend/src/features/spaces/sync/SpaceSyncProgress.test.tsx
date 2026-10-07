// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SpaceSyncJobInfo } from '@gadgets/workshop-shared/api'
import {
  alerts,
  button,
  click,
  deferred,
  fakeApi,
  hasButton,
  mount,
  settle,
  unmountAll,
} from '../spacesTestUtils'
import { formatFullTimestamp } from '../../../utils/formatTimestamp'
import { SpaceSyncProgress } from './SpaceSyncProgress'

const CREATED = new Date('2026-10-01T09:00:00Z')
const FINISHED = new Date('2026-10-01T09:05:00Z')

const job = (fields: Partial<SpaceSyncJobInfo> = {}): SpaceSyncJobInfo => ({
  jobId: 'j1',
  accountId: 1,
  vendorId: 'docs',
  spaceKey: 'design',
  blueprintId: 'document',
  publication: 'use',
  status: 'running',
  progress: { done: 3, total: 12, warnings: [] },
  created: CREATED,
  ...fields,
})

type Cancel = (jobId: string) => Promise<void>

const STARTED = `Docs Hub started ${formatFullTimestamp(CREATED)}`
const CANCEL = `Cancel sync from ${STARTED}`
const region = () => document.body.querySelector(`section[aria-label="Sync from ${STARTED}"]`)!
const announcement = () => document.body.querySelector('[role="status"]')?.textContent

const render = async (shown: SpaceSyncJobInfo, cancelSpaceSync = vi.fn<Cancel>(async () => {})) => {
  const onCancelled = vi.fn<() => void>()
  const onDismiss = vi.fn<() => void>()
  const api = fakeApi({ cancelSpaceSync })
  const progress = (of: SpaceSyncJobInfo) =>
    <SpaceSyncProgress job={of} sourceName="Docs Hub" onCancelled={onCancelled} onDismiss={onDismiss} />
  const view = await mount(progress(shown), api)
  return {
    cancelSpaceSync,
    onCancelled,
    onDismiss,
    show: (next: SpaceSyncJobInfo) => view.rerender(progress(next)),
  }
}

describe('SpaceSyncProgress', () => {
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('shows a running job’s progress as a meter that reads out the count', async () => {
    await render(job())

    const meter = region().querySelector('[role="meter"]')!
    expect(meter.getAttribute('aria-valuenow')).toBe('3')
    expect(meter.getAttribute('aria-valuemax')).toBe('12')
    expect(meter.getAttribute('aria-valuetext')).toBe('3 of 12 items synced')
    expect(region().textContent).toContain('Running')
    expect(region().textContent).toContain(`Started ${formatFullTimestamp(CREATED)}`)
  })

  it('claims nothing of how the workspaces are published, which a re-sync leaves as it was', async () => {
    await render(job({ publication: 'build' }))

    expect(region().textContent).not.toContain('published')
  })

  it('counts what it has synced when the total is unknown', async () => {
    await render(job({ progress: { done: 7, warnings: [] } }))

    expect(region().querySelector('[role="meter"]')).toBeNull()
    expect(region().textContent).toContain('7 items synced so far')
  })

  it('keeps the warnings folded away until asked for', async () => {
    await render(job({ progress: { done: 1, total: 2, warnings: ['Skipped an attachment', 'Skipped a macro'] } }))

    const trigger = button('2 warnings')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    await click(trigger)

    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect([...region().querySelectorAll('li')].map(item => item.textContent))
      .toEqual(['Skipped an attachment', 'Skipped a macro'])
  })

  it('shows why a job failed and when it finished, with nothing to cancel', async () => {
    await render(job({ status: 'failed', error: 'The source refused access.', finished: FINISHED }))

    expect(region().textContent).toContain('Failed')
    expect(region().textContent).toContain('The source refused access.')
    expect(region().textContent).toContain(`Finished ${formatFullTimestamp(FINISHED)}`)
    expect(hasButton(CANCEL)).toBe(false)
  })

  it('cancels a running job and tells the caller to read it again', async () => {
    const pending = deferred<void>()
    const { cancelSpaceSync, onCancelled } = await render(job(), vi.fn<Cancel>(() => pending.promise))

    await click(button(CANCEL))
    expect(cancelSpaceSync).toHaveBeenCalledWith('j1')
    // Named for what it is doing, as it reads.
    const cancelling = button(`Cancelling sync from ${STARTED}`)
    expect(cancelling.disabled).toBe(true)
    expect(cancelling.textContent).toBe('Cancelling…')
    expect(onCancelled).not.toHaveBeenCalled()

    pending.resolve()
    await settle()
    expect(onCancelled).toHaveBeenCalledOnce()
  })

  it('keeps the focus in the progress once Cancel goes with the job it cancelled', async () => {
    const { show } = await render(job())
    button(CANCEL).focus()

    await click(button(CANCEL))
    await settle()
    await show(job({ status: 'cancelled', finished: FINISHED }))

    expect(hasButton(CANCEL)).toBe(false)
    expect(document.activeElement).toBe(region())
  })

  it('offers to dismiss a job only once it has ended', async () => {
    const { onDismiss, show } = await render(job())
    expect(hasButton(`Dismiss sync from ${STARTED}`)).toBe(false)

    await show(job({ status: 'done', finished: FINISHED }))
    await click(button(`Dismiss sync from ${STARTED}`))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('says so when the cancel is refused, and lets it be tried again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { onCancelled } = await render(job(), vi.fn<Cancel>().mockRejectedValueOnce(new Error('No such job.')))

    await click(button(CANCEL))
    await settle()

    expect(alerts()).toEqual(['No such job.'])
    expect(onCancelled).not.toHaveBeenCalled()
    expect(button(CANCEL).disabled).toBe(false)
  })

  it('announces how a job already ended when first shown ended, such as one that failed to start', async () => {
    await render(job({ status: 'failed', error: 'The source refused access.', finished: FINISHED }))

    expect(announcement()).toBe('Sync from Docs Hub failed. The source refused access.')
  })

  it('announces a change of status, but not that a job first shown is running', async () => {
    const { show } = await render(job())
    expect(announcement()).toBe('')

    await show(job({ progress: { done: 5, total: 12, warnings: [] } }))
    expect(announcement()).toBe('')

    await show(job({ status: 'done', progress: { done: 12, total: 12, warnings: [] }, finished: FINISHED }))
    expect(announcement()).toBe('Sync from Docs Hub is done: 12 items synced.')
  })

  it('names each job for when it started, so that two from one source can be told apart', async () => {
    const earlier = new Date('2026-09-30T09:00:00Z')
    await mount(
      <>
        <SpaceSyncProgress job={job({ jobId: 'j1', status: 'done', created: earlier, finished: FINISHED })} sourceName="Docs Hub" onCancelled={() => {}} />
        <SpaceSyncProgress job={job({ jobId: 'j2' })} sourceName="Docs Hub" onCancelled={() => {}} />
      </>,
      fakeApi(),
    )

    expect([...document.body.querySelectorAll('section')].map(section => section.getAttribute('aria-label'))).toEqual([
      `Sync from Docs Hub started ${formatFullTimestamp(earlier)}`,
      `Sync from ${STARTED}`,
    ])
  })

  it('announces a failure with its reason, and starts afresh for another job', async () => {
    const { show } = await render(job())
    await show(job({ status: 'failed', error: 'Quota exceeded.', finished: FINISHED }))
    expect(announcement()).toBe('Sync from Docs Hub failed. Quota exceeded.')

    await show(job({ jobId: 'j2' }))
    expect(announcement()).toBe('')
    await show(job({ jobId: 'j3', status: 'cancelled', finished: FINISHED }))
    expect(announcement()).toBe('Sync from Docs Hub was cancelled.')
  })
})
