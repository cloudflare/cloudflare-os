// @vitest-environment jsdom
/* eslint-disable react/react-in-jsx-scope */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { MAX_GLOBAL_INSTRUCTIONS_LENGTH } from '@gadgets/workshop-shared/api'
import { GlobalInstructionsSettings } from './GlobalInstructionsSettings'

const get = vi.fn<() => Promise<string>>()
const set = vi.fn<(value: string) => Promise<void>>()
let auth: {
  authenticatedApi: object
  currentUser: { id: string } | null
  isCurrentUserConfirmed: boolean
}
vi.mock('../../AuthContext', () => ({ useAuthenticatedApi: () => auth }))
let container: HTMLDivElement
let root: Root
const render = () => act(async () => { root.render(<GlobalInstructionsSettings />) })
const button = (text: string) => [...container.querySelectorAll('button')]
  .find(b => b.textContent === text)!
const edit = (value: string) => act(async () => {
  const textarea = container.querySelector('textarea')!
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(textarea, value)
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
})

beforeEach(() => {
  get.mockReset().mockResolvedValue('Be concise.')
  set.mockReset().mockResolvedValue(undefined)
  auth = {
    authenticatedApi: { getOwnGlobalInstructions: get, setOwnGlobalInstructions: set },
    currentUser: { id: 'alice' }, isCurrentUserConfirmed: true,
  }
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})
afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
})

it('loads, saves, discards edits, and requires confirmation before clearing saved defaults', async () => {
  await render()
  expect(container.querySelector('textarea')?.value).toBe('Be concise.')
  await edit('Use British English.')
  await act(async () => button('Save instructions').click())
  expect(set).toHaveBeenLastCalledWith('Use British English.')
  await edit('Unsaved text')
  await act(async () => button('Discard edits').click())
  expect(container.querySelector('textarea')?.value).toBe('Use British English.')
  await act(async () => button('Clear saved instructions').click())
  expect(set).toHaveBeenCalledTimes(1)
  await act(async () => button('Cancel').click())
  expect(container.querySelector('textarea')?.value).toBe('Use British English.')
  await act(async () => button('Clear saved instructions').click())
  await act(async () => button('Confirm clear').click())
  expect(set).toHaveBeenLastCalledWith('')
  expect(container.querySelector('textarea')?.value).toBe('')
})

it('keeps failed edits and rejects an over-limit paste without silently truncating it', async () => {
  await render()
  const oversized = 'x'.repeat(MAX_GLOBAL_INSTRUCTIONS_LENGTH + 1)
  await edit(oversized)
  expect(container.querySelector('textarea')?.value).toBe(oversized)
  expect(button('Save instructions').disabled).toBe(true)
  expect(set).not.toHaveBeenCalled()
  set.mockRejectedValueOnce(new Error('private error detail'))
  await edit('Keep this edit')
  await act(async () => button('Save instructions').click())
  expect(container.querySelector('textarea')?.value).toBe('Keep this edit')
  expect(container.querySelector('[role="alert"]')?.textContent).toContain('Your edits are still here')
  expect(container.textContent).not.toContain('private error detail')
})

it('does not show a stale account document while a new session is being confirmed', async () => {
  let resolveOld!: (value: string) => void
  get.mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve }))
  await render()
  auth = { ...auth, isCurrentUserConfirmed: false }
  await render()
  expect(container.querySelector('textarea')).toBeNull()
  await act(async () => resolveOld('Alice private defaults'))
  get.mockResolvedValue('Bob private defaults')
  auth = { ...auth, currentUser: { id: 'bob' }, isCurrentUserConfirmed: true }
  await render()
  expect(container.querySelector('textarea')?.value).toBe('Bob private defaults')
  expect(container.textContent).not.toContain('Alice private defaults')
})

it('does not render an editable blank document after a failed read, and can retry', async () => {
  get.mockRejectedValueOnce(new Error('read failed'))
  await render()
  expect(container.querySelector('textarea')).toBeNull()
  expect(set).not.toHaveBeenCalled()
  await act(async () => button('Retry loading instructions').click())
  expect(container.querySelector('textarea')?.value).toBe('Be concise.')
})
