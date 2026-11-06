// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { deferred, makeTestRoot } from '../../action-test-harness'
import { WorkspaceConnectionRow } from './WorkspaceConnectionRow'
vi.mock('../../errorReporting', () => ({ reportIssue: () => {} }))

vi.mock('../../components/DeleteConfirmationDialog', () => ({
  default: ({ open, title, description, isDeleting, confirmLabel, onConfirm, onOpenChange }: {
    open: boolean; title: string; description: React.ReactNode; isDeleting: boolean;
    confirmLabel: string; onConfirm: () => void; onOpenChange: (open: boolean) => void
  }) => open ? <dialog open>
    <h2>{title}</h2>{description}
    <button disabled={isDeleting} onClick={onConfirm}>{confirmLabel}</button>
    <button onClick={() => onOpenChange(false)}>Close dialog</button>
  </dialog> : null,
}))

const root = makeTestRoot()
afterEach(() => root.cleanup())

it('confirms workspace-wide removal, blocks duplicate submission and closing, and keeps failures visible', async () => {
  const reply = deferred<void>()
  const remove = vi.fn<(id: number) => Promise<void>>(() => reply.promise)
  await root.render(<WorkspaceConnectionRow
    connection={{ target: 15, resourceTitle: 'Private sheet', resourceUrl: 'https://example.com/sheet', alwaysAvailable: false, awaitingApproval: false }}
    vendor={undefined} expanded onRemoveConnection={remove}
  />)
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Remove Private sheet from workspace"]')!.click())
  expect(remove).not.toHaveBeenCalled()
  const dialog = document.querySelector('dialog')!
  const submit = dialog.querySelector<HTMLButtonElement>('button')!
  await act(async () => { submit.click(); submit.click() })
  expect(remove).toHaveBeenCalledTimes(1)
  expect(submit.disabled).toBe(true)
  await act(async () => dialog.querySelectorAll<HTMLButtonElement>('button')[1].click())
  expect(document.querySelector('dialog')).not.toBeNull()
  await reply.reject(new Error('Offline'))
  expect(document.querySelector('[role="alert"]')).not.toBeNull()
  expect(document.querySelector('a')?.href).toBe('https://example.com/sheet')
  expect(submit.disabled).toBe(false)

  remove.mockImplementation(async () => {})
  await act(async () => submit.click())
  expect(remove).toHaveBeenCalledTimes(2)
  expect(document.querySelector('dialog')).toBeNull()
})
