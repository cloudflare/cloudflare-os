/* eslint-disable react/react-in-jsx-scope */

// A gatekeeper's settings in Chromium: keyboard input and focus, which jsdom does not model.

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, expect, it } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import type { AdminResourceVendor } from '@gadgets/workshop-shared/api'
import { GatekeeperSettings } from './GatekeeperSettings'

type Setting = NonNullable<AdminResourceVendor['settings']>[number]

const PROVIDER: Setting = {
  id: 'provider', label: 'Search provider', help: 'Where web searches run.',
  options: [{ value: 'ceramic', label: 'Ceramic' }, { value: 'linkup', label: 'Linkup' }],
  defaultValue: 'ceramic', value: 'ceramic',
}

// Holds the settings as the admin page does: a pick shows at once, and `save` is its save.
const Panel = ({ save }: { save: Promise<void> }) => {
  const [settings, setSettings] = useState([PROVIDER])
  const [saving, setSaving] = useState(false)
  return (
    <>
      <GatekeeperSettings
        vendorName="Web Search"
        settings={settings}
        saving={saving}
        onChoose={(settingId, value) => {
          setSettings((shown) => shown.map((setting) => (
            setting.id === settingId ? { ...setting, value } : setting)))
          setSaving(true)
          void save.then(() => setSaving(false))
        }}
      />
      <button type="button">Next control</button>
    </>
  )
}

let root: Root | undefined
let container: HTMLElement | undefined

afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
})

/** Input as a user gives it, with the updates it causes applied before the next assertion. */
const input = (action: () => Promise<unknown>) => act(async () => { await action() })

it('keeps the keyboard focus on a select while its choice is saved, and after', async () => {
  const save = Promise.withResolvers<void>()
  container = document.body.appendChild(document.createElement('div'))
  root = createRoot(container)
  await act(async () => root?.render(<Panel save={save.promise} />))
  const select = page.getByRole('combobox', { name: 'Search provider for Web Search' })

  await input(() => userEvent.tab())
  await expect.element(select).toHaveFocus()
  await input(() => userEvent.keyboard('{Enter}'))
  await expect.element(page.getByRole('option', { name: 'Linkup' })).toBeVisible()
  await input(() => userEvent.keyboard('{ArrowDown}'))
  await input(() => userEvent.keyboard('{Enter}'))

  await expect.element(select).toHaveTextContent('Linkup')
  await expect.element(select).toHaveFocus()
  await act(async () => { save.resolve() })
  await expect.element(select).toHaveFocus()
  await input(() => userEvent.tab())
  await expect.element(page.getByRole('button', { name: 'Next control' })).toHaveFocus()
})
