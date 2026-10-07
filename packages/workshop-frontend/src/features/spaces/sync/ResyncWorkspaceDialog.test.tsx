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
  mount,
  pressEscape,
  settle,
  unmountAll,
} from '../spacesTestUtils'
import { ResyncWorkspaceDialog } from './ResyncWorkspaceDialog'

const JOB: SpaceSyncJobInfo = {
  jobId: 'j1',
  accountId: 1,
  vendorId: 'docs',
  spaceKey: 'design',
  blueprintId: 'document',
  publication: 'use',
  status: 'running',
  progress: { done: 0, warnings: [] },
  created: new Date('2026-10-01T09:00:00Z'),
}

type Resync = (workspaceId: string) => Promise<SpaceSyncJobInfo>

const render = async (resyncWorkspace: Resync, syncRunning = false) => {
  const onClose = vi.fn<() => void>()
  const onStarted = vi.fn<(job: SpaceSyncJobInfo) => void>()
  await mount(
    <ResyncWorkspaceDialog
      workspace={{ id: 'w-roadmap', title: 'Roadmap' }}
      sourceName="Docs Hub"
      syncRunning={syncRunning}
      onClose={onClose}
      onStarted={onStarted}
    />,
    fakeApi({ resyncWorkspace }),
  )
  return { onClose, onStarted }
}

const dialog = () => document.body.querySelector('[role="dialog"]')!

describe('ResyncWorkspaceDialog', () => {
  afterEach(() => {
    unmountAll()
    vi.restoreAllMocks()
  })

  it('is named for the workspace and its source, and warns that everything, comments included, is replaced', async () => {
    const resyncWorkspace = vi.fn<Resync>(async () => JOB)
    await render(resyncWorkspace)

    const labelledBy = dialog().getAttribute('aria-labelledby')!
    expect(document.getElementById(labelledBy)?.textContent).toBe('Re-sync “Roadmap” from Docs Hub?')
    // Read out as the dialog opens, as its description.
    const description = document.getElementById(dialog().getAttribute('aria-describedby')!)?.textContent
    expect(description).toContain('content and all of its comments will be replaced from Docs Hub')
    expect(description).toContain('every edit and comment made here since it was synced')
    expect(description).toContain('This can’t be undone.')
    expect(resyncWorkspace).not.toHaveBeenCalled()
  })

  it('starts the re-sync only once confirmed, and hands back the job', async () => {
    const pending = deferred<SpaceSyncJobInfo>()
    const resyncWorkspace = vi.fn<Resync>(() => pending.promise)
    const { onStarted, onClose } = await render(resyncWorkspace)

    await click(button('Replace from source'))
    expect(resyncWorkspace).toHaveBeenCalledWith('w-roadmap')
    expect(button('Starting…').disabled).toBe(true)

    // Closing would orphan the call, so the dialog stays until it settles.
    await pressEscape()
    expect(onClose).not.toHaveBeenCalled()

    pending.resolve(JOB)
    await settle()
    expect(onStarted).toHaveBeenCalledWith(JOB)
  })

  it('shows the server’s refusal and lets the user try again', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const resyncWorkspace = vi.fn<Resync>()
      .mockRejectedValueOnce(new Error('The account that synced this workspace is no longer connected.'))
    const { onStarted } = await render(resyncWorkspace)

    await click(button('Replace from source'))
    await settle()

    expect(alerts()).toEqual(['The account that synced this workspace is no longer connected.'])
    expect(onStarted).not.toHaveBeenCalled()
    expect(button('Replace from source').disabled).toBe(false)
  })

  it('offers nothing to start while a sync into the space is running', async () => {
    const resyncWorkspace = vi.fn<Resync>(async () => JOB)
    await render(resyncWorkspace, true)

    expect(button('Replace from source').disabled).toBe(true)
    expect(dialog().textContent).toContain('A sync into this space is already running.')
  })

  it('closes without starting anything when cancelled', async () => {
    const resyncWorkspace = vi.fn<Resync>(async () => JOB)
    const { onClose } = await render(resyncWorkspace)

    await click(button('Cancel'))

    expect(onClose).toHaveBeenCalledOnce()
    expect(resyncWorkspace).not.toHaveBeenCalled()
  })
})
