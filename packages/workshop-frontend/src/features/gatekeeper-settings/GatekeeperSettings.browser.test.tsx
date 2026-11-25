/* eslint-disable react/react-in-jsx-scope */

// A gatekeeper's settings in Chromium: keyboard input and focus, which jsdom does not model.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { SettingsPanel, webSearchSettings } from './gatekeeperSettingsTestHarness'

let root: Root | undefined
let container: HTMLElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

/** Input as a user gives it, with the updates it causes applied before the next assertion. */
const input = (action: () => Promise<unknown>) => act(async () => { await action() })

it('keeps the keyboard focus on a select while its pick is saved, and lets the next select take one after', async () => {
  const save = Promise.withResolvers<void>()
  const onSave = vi.fn<(settingId: string, value: string) => Promise<void>>(() => save.promise)
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => root?.render(
    <SettingsPanel initial={webSearchSettings('exa')} onSave={onSave} />))
  const provider = page.getByRole('combobox', { name: 'Search provider for Web Search' })
  const fallback = page.getByRole('combobox', { name: 'Fallback search provider for Web Search' })

  // Exa is the option before the last, so one step down reaches "The model's provider".
  await input(() => userEvent.tab())
  await expect.element(provider).toHaveFocus()
  await input(() => userEvent.keyboard('{Enter}'))
  await expect.element(page.getByRole('option', { name: 'The model’s provider' })).toBeVisible()
  await input(() => userEvent.keyboard('{ArrowDown}'))
  await input(() => userEvent.keyboard('{Enter}'))

  await expect.element(provider).toHaveTextContent('The model’s provider')
  await expect.element(provider).toHaveFocus()
  await expect.element(fallback).toBeDisabled()

  await act(async () => { save.resolve() })
  await expect.element(provider).toHaveFocus()
  await input(() => userEvent.tab())
  await expect.element(fallback).toHaveFocus()
  await input(() => userEvent.keyboard('{Enter}'))
  await expect.element(page.getByRole('option', { name: 'Ceramic' })).toBeVisible()
  await input(() => userEvent.keyboard('{ArrowDown}'))
  await input(() => userEvent.keyboard('{Enter}'))
  expect(onSave.mock.calls).toEqual([['provider', 'model'], ['fallback', 'ceramic']])
})
