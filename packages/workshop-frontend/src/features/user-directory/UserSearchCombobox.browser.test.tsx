/* eslint-disable react/react-in-jsx-scope */
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { RpcStub } from 'capnweb'
import type { AuthenticatedApi, UserDirectoryRecord } from '@gadgets/workshop-shared/api'
import { UserSearchCombobox } from './UserSearchCombobox'

vi.mock('../../components/PersonAvatar', () => ({ PersonAvatar: () => null }))

let root: Root | undefined
let container: HTMLElement | undefined
const input = (action: () => Promise<unknown>) => act(async () => { await action() })

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

it.each([
  { name: 'directory results', results: [{ id: 'ada@example.com', name: 'Ada Lovelace' }] },
  { name: 'exact identifier fallback', results: [] },
])('Tabs past $name without losing focus or selecting a person', async ({ results }) => {
  const onSelect = vi.fn<(user: UserDirectoryRecord) => void>()
  const onSubmit = vi.fn<() => void>()
  const search = async (): Promise<UserDirectoryRecord[]> => results
  const Harness = () => {
    const [value, setValue] = useState('')
    return <>
      <UserSearchCombobox authenticatedApi={{} as RpcStub<AuthenticatedApi>}
        value={value} onValueChange={setValue} selected={false} inputName="people"
        search={search} onSelect={onSelect} onSubmit={onSubmit} />
      <button type="button">Next control</button>
    </>
  }
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => root!.render(<Harness />))
  const combobox = page.getByRole('combobox', { name: 'Search people' })
  await input(() => userEvent.fill(combobox, 'ada'))
  await expect.element(page.getByRole('option', { name: 'Select exact username or email: ada' })).toBeVisible()
  await input(() => userEvent.keyboard('{ArrowDown}'))
  await expect.element(combobox).toHaveFocus()
  await input(() => userEvent.tab())
  await expect.element(page.getByRole('button', { name: 'Next control' })).toHaveFocus()
  await expect.element(combobox).toHaveAttribute('aria-expanded', 'false')
  expect(onSelect).not.toHaveBeenCalled()
  expect(onSubmit).not.toHaveBeenCalled()
})
